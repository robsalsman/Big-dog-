import net from 'node:net';
import { resolveMx } from 'node:dns/promises';

/**
 * Free email finder + verifier — the same engine Hunter.io/Apollo charge for.
 *   1. permute candidate addresses from name + domain (common B2B patterns)
 *   2. find the domain's mail server (MX)
 *   3. probe each candidate with an SMTP RCPT TO check — no email is ever sent
 *   4. detect catch-all domains (which accept everything, so can't be verified)
 *
 * Honest limits: SMTP verification needs outbound port 25 (often blocked by
 * ISPs/clouds), and Gmail/Microsoft 365 deliberately defeat probing. When it
 * can't verify, we return the best-pattern GUESS clearly labelled unverified —
 * never a false "verified".
 */

export type Confidence = 'verified' | 'guess' | 'unverified';

export interface EmailResult {
  email: string;
  confidence: Confidence;
  method: string;
  candidates: string[];
  pattern?: string; // the learned pattern key applied, if any
}

// The MAIL FROM we announce during an SMTP RCPT probe. Many mail servers reject
// probes from a non-routable sender (e.g. a `.local` domain) via sender callout,
// so this must be a REAL, resolvable address on a domain you control — ideally
// one whose A/MX records and the VPS's reverse-DNS (PTR) line up. Set
// PROBE_FROM (or fall back to the deploy hostname) on a box with port 25 open.
const PROBE_FROM =
  process.env.PROBE_FROM ||
  (process.env.PUBLIC_HOSTNAME ? `verify@${process.env.PUBLIC_HOSTNAME}` : 'verify@bigdog.builda.company');

export function clean(s: string): string {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
}

/** Named corporate email patterns. Keys are stable identifiers we can learn + cache. */
export const PATTERNS: Record<string, (f: string, l: string) => string> = {
  'first.last': (f, l) => (l ? `${f}.${l}` : f),
  firstlast: (f, l) => (l ? `${f}${l}` : f),
  flast: (f, l) => (l ? `${f[0] ?? ''}${l}` : f),
  first: (f) => f,
  first_last: (f, l) => (l ? `${f}_${l}` : f),
  'f.last': (f, l) => (l ? `${f[0] ?? ''}.${l}` : f),
  firstl: (f, l) => (l ? `${f}${l[0] ?? ''}` : f),
  'first.l': (f, l) => (l ? `${f}.${l[0] ?? ''}` : f),
  'last.first': (f, l) => (l ? `${l}.${f}` : f),
  lastfirst: (f, l) => (l ? `${l}${f}` : f),
  'f.l': (f, l) => (l ? `${f[0] ?? ''}.${l[0] ?? ''}` : f),
};

// Ordered roughly by real-world prevalence (drives candidate-guess order).
const PATTERN_ORDER = Object.keys(PATTERNS);

/** Render a pattern key into a local-part for a given name. */
export function renderLocal(key: string, first: string, last: string): string {
  const fn = PATTERNS[key];
  return fn ? fn(clean(first), clean(last)) : '';
}

/** Given a known email local-part and the person's name, deduce the pattern key. */
export function inferPatternKey(localPart: string, first: string, last: string): string | null {
  const target = localPart.toLowerCase();
  const f = clean(first);
  const l = clean(last);
  for (const key of PATTERN_ORDER) {
    if (PATTERNS[key]!(f, l) === target) return key;
  }
  return null;
}

/** Common corporate email patterns, ordered roughly by real-world prevalence. */
export function candidateLocals(first: string, last: string): string[] {
  const f = clean(first);
  const l = clean(last);
  const out = PATTERN_ORDER.map((k) => PATTERNS[k]!(f, l));
  return out.filter((v, i, a) => v && v.length > 1 && a.indexOf(v) === i);
}

export async function mxHost(domain: string): Promise<string | null> {
  try {
    const records = await resolveMx(domain);
    if (!records.length) return null;
    records.sort((a, b) => a.priority - b.priority);
    return records[0]?.exchange ?? null;
  } catch {
    return null;
  }
}

/**
 * Open one SMTP session and RCPT-probe a list of recipients. Returns each
 * recipient's SMTP reply code (or absent if the session failed/blocked).
 */
function smtpProbe(
  host: string,
  recipients: string[],
  opts: { port?: number; timeoutMs?: number; hardCapMs?: number } = {},
): Promise<Record<string, number>> {
  const port = opts.port ?? 25;
  const timeoutMs = opts.timeoutMs ?? 8000;
  // Absolute ceiling on the whole session — the per-step idle timeout resets on
  // every server reply, so a tarpit that drip-answers each RCPT could otherwise
  // hold the socket open indefinitely. A legit server answers in well under this.
  const hardCapMs = opts.hardCapMs ?? timeoutMs;

  return new Promise((resolve) => {
    const results: Record<string, number> = {};
    let buf = '';
    let stage = 0; // 0 greeting, 1 EHLO, 2 MAIL, 3 RCPT loop, 4 quit
    let idx = 0;

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    let hardTimer: NodeJS.Timeout | undefined;
    const done = () => {
      if (hardTimer) clearTimeout(hardTimer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(results);
    };
    hardTimer = setTimeout(done, hardCapMs);
    socket.on('timeout', done);
    socket.on('error', done);
    socket.on('close', () => { if (hardTimer) clearTimeout(hardTimer); resolve(results); });

    const send = (line: string) => socket.write(line + '\r\n');

    const handle = (code: number) => {
      switch (stage) {
        case 0:
          if (code !== 220) return done();
          send('EHLO bigdog.local');
          stage = 1;
          break;
        case 1:
          if (code >= 400) return done();
          send(`MAIL FROM:<${PROBE_FROM}>`);
          stage = 2;
          break;
        case 2:
          if (code >= 400) return done();
          send(`RCPT TO:<${recipients[idx]}>`);
          stage = 3;
          break;
        case 3:
          results[recipients[idx] as string] = code;
          idx++;
          if (idx >= recipients.length) {
            send('QUIT');
            stage = 4;
          } else {
            send(`RCPT TO:<${recipients[idx]}>`);
          }
          break;
        default:
          done();
      }
    };

    socket.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const m = line.match(/^(\d{3})([ -])/);
        if (!m) continue;
        if (m[2] === '-') continue; // multiline continuation
        handle(Number(m[1]));
      }
    });
  });
}

function classify(code: number | undefined): 'valid' | 'invalid' | 'unknown' {
  if (code === undefined) return 'unknown';
  if (code === 250 || code === 251) return 'valid';
  if ([550, 551, 553, 554, 501, 502].includes(code)) return 'invalid';
  return 'unknown';
}

/** Build an address from patterns WITHOUT any SMTP probe — for fast bulk enrichment. */
export function guessEmail(firstName: string, lastName: string, domain: string, learnedKey?: string): EmailResult {
  const locals = candidateLocals(firstName, lastName);
  const learnedLocal = learnedKey ? renderLocal(learnedKey, firstName, lastName) : '';
  const ordered = learnedLocal ? [learnedLocal, ...locals.filter((l) => l !== learnedLocal)] : locals;
  const candidates = ordered.map((l) => `${l}@${domain}`);
  const best = (learnedLocal ? `${learnedLocal}@${domain}` : candidates[0]) ?? `${clean(firstName)}@${domain}`;
  return {
    email: best,
    confidence: learnedKey ? 'guess' : 'unverified',
    method: learnedKey ? `learned company pattern (${learnedKey})` : 'best-pattern guess (not verified)',
    candidates,
    pattern: learnedKey,
  };
}

export interface FindEmailInput {
  firstName: string;
  lastName: string;
  domain: string;
  host?: string; // override MX lookup (used in tests)
  port?: number;
  learnedKey?: string; // a learned company pattern key to try first / fall back to
}

export async function findEmail(input: FindEmailInput): Promise<EmailResult> {
  const { firstName, lastName, domain, learnedKey } = input;
  let locals = candidateLocals(firstName, lastName);
  const learnedLocal = learnedKey ? renderLocal(learnedKey, firstName, lastName) : '';
  // Always try the learned company pattern first (even if it's also a standard guess).
  if (learnedLocal) locals = [learnedLocal, ...locals.filter((l) => l !== learnedLocal)];
  const candidates = locals.map((l) => `${l}@${domain}`);
  // With a learned company pattern, the learned address is the best bet; else the top guess.
  const best = (learnedLocal ? `${learnedLocal}@${domain}` : candidates[0]) ?? `${clean(firstName)}@${domain}`;
  const learnedNote = learnedKey ? ` learned company pattern (${learnedKey})` : '';
  // Learned pattern lifts unverifiable results from "unverified" up to "guess".
  const unverifiedConf: Confidence = learnedKey ? 'guess' : 'unverified';

  const host = input.host ?? (await mxHost(domain));
  if (!host) {
    return {
      email: best,
      confidence: unverifiedConf,
      method: learnedKey ? `${learnedNote.trim()}; no MX to verify` : 'no MX record for domain',
      candidates,
      pattern: learnedKey,
    };
  }

  // One probe to a random address: tests reachability AND catch-all in one shot.
  const random = `zz-bigdog-${Date.now().toString(36)}@${domain}`;
  const pre = await smtpProbe(host, [random], { port: input.port });
  if (!(random in pre)) {
    return {
      email: best,
      confidence: unverifiedConf,
      method: learnedKey ? `${learnedNote.trim()}; SMTP probe blocked (port 25)` : 'SMTP probe blocked or unreachable (port 25)',
      candidates,
      pattern: learnedKey,
    };
  }
  if (classify(pre[random]) === 'valid') {
    return {
      email: best,
      confidence: 'guess',
      method: learnedKey ? `catch-all domain; using${learnedNote}` : 'catch-all domain (accepts all addresses)',
      candidates,
      pattern: learnedKey,
    };
  }

  // Verify the real candidates over one session (learned address is tried first).
  const codes = await smtpProbe(host, candidates.slice(0, 6), { port: input.port });
  for (const email of candidates) {
    if (classify(codes[email]) === 'valid') {
      return { email, confidence: 'verified', method: 'SMTP RCPT verified (mailbox exists)', candidates, pattern: learnedKey };
    }
  }
  return {
    email: best,
    confidence: unverifiedConf,
    method: learnedKey ? `${learnedNote.trim()}; unconfirmed by SMTP` : 'best-pattern guess (could not verify)',
    candidates,
    pattern: learnedKey,
  };
}
