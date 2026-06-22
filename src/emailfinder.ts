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
}

const PROBE_FROM = 'verify@bigdog.local';

function clean(s: string): string {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
}

/** Common corporate email patterns, ordered roughly by real-world prevalence. */
export function candidateLocals(first: string, last: string): string[] {
  const f = clean(first);
  const l = clean(last);
  const fi = f[0] ?? '';
  const li = l[0] ?? '';
  const out = [
    l ? `${f}.${l}` : f,
    l ? `${f}${l}` : f,
    l ? `${fi}${l}` : f,
    f,
    l ? `${f}_${l}` : f,
    l ? `${fi}.${l}` : f,
    l ? `${f}${li}` : f,
    l ? `${l}.${f}` : l,
    l ? `${l}${f}` : l,
  ];
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
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<Record<string, number>> {
  const port = opts.port ?? 25;
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise((resolve) => {
    const results: Record<string, number> = {};
    let buf = '';
    let stage = 0; // 0 greeting, 1 EHLO, 2 MAIL, 3 RCPT loop, 4 quit
    let idx = 0;

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    const done = () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(results);
    };
    socket.on('timeout', done);
    socket.on('error', done);
    socket.on('close', () => resolve(results));

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

export interface FindEmailInput {
  firstName: string;
  lastName: string;
  domain: string;
  host?: string; // override MX lookup (used in tests)
  port?: number;
  knownPattern?: string; // a known-good local-part to try first
}

export async function findEmail(input: FindEmailInput): Promise<EmailResult> {
  const { firstName, lastName, domain } = input;
  const locals = candidateLocals(firstName, lastName);
  if (input.knownPattern && !locals.includes(input.knownPattern)) locals.unshift(input.knownPattern);
  const candidates = locals.map((l) => `${l}@${domain}`);
  const best = candidates[0] ?? `${clean(firstName)}@${domain}`;

  const host = input.host ?? (await mxHost(domain));
  if (!host) {
    return { email: best, confidence: 'unverified', method: 'no MX record for domain', candidates };
  }

  // One probe to a random address: tests reachability AND catch-all in one shot.
  const random = `zz-bigdog-${Date.now().toString(36)}@${domain}`;
  const pre = await smtpProbe(host, [random], { port: input.port });
  if (!(random in pre)) {
    return {
      email: best,
      confidence: 'unverified',
      method: 'SMTP probe blocked or unreachable (port 25)',
      candidates,
    };
  }
  if (classify(pre[random]) === 'valid') {
    return { email: best, confidence: 'guess', method: 'catch-all domain (accepts all addresses)', candidates };
  }

  // Verify the real candidates over one session.
  const codes = await smtpProbe(host, candidates.slice(0, 6), { port: input.port });
  for (const email of candidates) {
    if (classify(codes[email]) === 'valid') {
      return { email, confidence: 'verified', method: 'SMTP RCPT verified (mailbox exists)', candidates };
    }
  }
  return { email: best, confidence: 'unverified', method: 'best-pattern guess (could not verify)', candidates };
}
