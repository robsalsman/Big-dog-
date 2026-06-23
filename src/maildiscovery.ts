import { promises as dns } from 'node:dns';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

/**
 * Mailbox autodiscovery — the user gives Big Dog only an email + password and we
 * figure out the IMAP/SMTP servers, exactly the way Thunderbird/Outlook do:
 *   1. Mozilla ISPDB (covers most providers, incl. IONOS, Gmail, etc.)
 *   2. The domain's own autoconfig file (.well-known / autoconfig.<domain>)
 *   3. DNS SRV records (_imaps._tcp / _submission._tcp)
 *   4. Known-provider lookup from the domain's MX host
 *   5. A sensible guess (imap.<domain> / smtp.<domain>)
 * If a password is supplied we verify candidates by actually logging in and
 * return the first that works.
 */

export interface DiscoveredConfig {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  username: string;
  source: string;
  verified: boolean;
}

const TIMEOUT = 6000;

function domainOf(email: string): string {
  return (email.split('@')[1] || '').toLowerCase().trim();
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

// Mozilla autoconfig XML → {imap, smtp}. Picks the first imap + first smtp server.
function parseAutoconfig(xml: string, email: string): Partial<DiscoveredConfig> | null {
  if (!xml || !/<clientConfig/i.test(xml)) return null;
  const grab = (type: 'imap' | 'smtp') => {
    const tag = type === 'imap' ? 'incomingServer' : 'outgoingServer';
    const re = new RegExp(`<${tag}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const block = xml.match(re)?.[1];
    if (!block) return null;
    const host = block.match(/<hostname>\s*([^<]+?)\s*<\/hostname>/i)?.[1];
    const port = Number(block.match(/<port>\s*(\d+)\s*<\/port>/i)?.[1]);
    const socket = (block.match(/<socketType>\s*([^<]+?)\s*<\/socketType>/i)?.[1] || '').toUpperCase();
    if (!host || !port) return null;
    return { host, port, secure: socket === 'SSL' || port === 993 || port === 465 };
  };
  const imap = grab('imap');
  const smtp = grab('smtp');
  if (!imap || !smtp) return null;
  return { imap, smtp, username: email };
}

async function tryAutoconfigSources(email: string, domain: string): Promise<{ cfg: Partial<DiscoveredConfig>; source: string } | null> {
  const urls: Array<[string, string]> = [
    [`https://autoconfig.thunderbird.net/v1.1/${domain}`, 'ispdb'],
    [`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`, 'autoconfig'],
    [`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`, 'well-known'],
  ];
  for (const [url, source] of urls) {
    const cfg = parseAutoconfig(await fetchText(url), email);
    if (cfg) return { cfg, source };
  }
  return null;
}

async function trySrv(domain: string, email: string): Promise<Partial<DiscoveredConfig> | null> {
  try {
    const [imapRecs, subRecs] = await Promise.all([
      dns.resolveSrv(`_imaps._tcp.${domain}`).catch(() => []),
      dns.resolveSrv(`_submission._tcp.${domain}`).catch(() => []),
    ]);
    const imap = imapRecs.filter((r) => r.name && r.name !== '.')[0];
    const sub = subRecs.filter((r) => r.name && r.name !== '.')[0];
    if (!imap || !sub) return null;
    return {
      imap: { host: imap.name, port: imap.port || 993, secure: (imap.port || 993) === 993 },
      smtp: { host: sub.name, port: sub.port || 587, secure: (sub.port || 587) === 465 },
      username: email,
    };
  } catch {
    return null;
  }
}

// Known providers keyed by a substring of the domain's MX host.
const MX_PROVIDERS: Array<{ match: RegExp; cfg: Omit<DiscoveredConfig, 'username' | 'verified' | 'source'>; name: string }> = [
  { name: 'ionos', match: /ionos|kundenserver|1and1|perfora|ui-dns/i, cfg: { imap: { host: 'imap.ionos.com', port: 993, secure: true }, smtp: { host: 'smtp.ionos.com', port: 587, secure: false } } },
  { name: 'google', match: /google|googlemail|aspmx/i, cfg: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } } },
  { name: 'microsoft', match: /outlook|office365|microsoft|protection\.outlook|hotmail/i, cfg: { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } } },
  { name: 'zoho', match: /zoho/i, cfg: { imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 465, secure: true } } },
  { name: 'fastmail', match: /fastmail|messagingengine/i, cfg: { imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 465, secure: true } } },
  { name: 'icloud', match: /icloud|me\.com|apple/i, cfg: { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } } },
  { name: 'yahoo', match: /yahoo|yahoodns/i, cfg: { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } } },
  { name: 'protonmail', match: /protonmail|proton\.me/i, cfg: { imap: { host: '127.0.0.1', port: 1143, secure: false }, smtp: { host: '127.0.0.1', port: 1025, secure: false } } },
];

async function tryMxProvider(domain: string, email: string): Promise<{ cfg: Partial<DiscoveredConfig>; source: string } | null> {
  try {
    const mx = await dns.resolveMx(domain).catch(() => []);
    const host = mx.sort((a, b) => a.priority - b.priority)[0]?.exchange?.toLowerCase();
    if (!host) return null;
    const p = MX_PROVIDERS.find((p) => p.match.test(host));
    if (!p) return null;
    return { cfg: { ...p.cfg, username: email }, source: `mx:${p.name}` };
  } catch {
    return null;
  }
}

function guessFromDomain(domain: string, email: string): Partial<DiscoveredConfig> {
  return {
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 465, secure: true },
    username: email,
  };
}

async function verifyImap(host: string, port: number, secure: boolean, user: string, pass: string): Promise<boolean> {
  const client = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false, connectionTimeout: 8000, greetingTimeout: 8000 });
  try {
    await client.connect();
    await client.logout().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function verifySmtp(host: string, port: number, secure: boolean, user: string, pass: string): Promise<boolean> {
  const t = nodemailer.createTransport({ host, port, secure, auth: { user, pass }, connectionTimeout: 8000, greetingTimeout: 8000 });
  try {
    await t.verify();
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover (and, with a password, verify) the mail server config for an address.
 * Returns the best candidate; `verified` is true only when a login succeeded.
 */
export async function discoverMailConfig(
  email: string,
  password?: string,
): Promise<{ ok: boolean; config?: DiscoveredConfig; tried: string[]; detail?: string }> {
  const domain = domainOf(email);
  if (!domain) return { ok: false, tried: [], detail: 'Enter a full email address.' };

  // Build an ordered list of candidates, best source first.
  const candidates: Array<{ cfg: Partial<DiscoveredConfig>; source: string }> = [];
  const auto = await tryAutoconfigSources(email, domain);
  if (auto) candidates.push(auto);
  const srv = await trySrv(domain, email);
  if (srv) candidates.push({ cfg: srv, source: 'srv' });
  const mx = await tryMxProvider(domain, email);
  if (mx) candidates.push(mx);
  candidates.push({ cfg: guessFromDomain(domain, email), source: 'guess' });

  // De-dupe by host pair.
  const seen = new Set<string>();
  const ordered = candidates.filter((c) => {
    const k = `${c.cfg.imap?.host}|${c.cfg.smtp?.host}`;
    if (seen.has(k) || !c.cfg.imap || !c.cfg.smtp) return false;
    seen.add(k);
    return true;
  });
  const tried = ordered.map((c) => `${c.source}:${c.cfg.imap!.host}`);

  if (!ordered.length) return { ok: false, tried, detail: 'Could not determine mail servers for that domain.' };

  // No password → return the top candidate unverified (user can Test before saving).
  if (!password) {
    const top = ordered[0]!;
    return { ok: true, tried, config: { imap: top.cfg.imap!, smtp: top.cfg.smtp!, username: email, source: top.source, verified: false } };
  }

  // With a password → verify candidates, return the first that logs in.
  for (const c of ordered) {
    const { imap, smtp } = c.cfg as DiscoveredConfig;
    const imapOk = await verifyImap(imap.host, imap.port, imap.secure, email, password);
    if (!imapOk) continue;
    // IMAP is the must-have; probe SMTP but don't fail discovery if only SMTP is off.
    let s = smtp;
    let smtpOk = await verifySmtp(smtp.host, smtp.port, smtp.secure, email, password);
    if (!smtpOk && smtp.port === 587) {
      const alt = { ...smtp, port: 465, secure: true };
      if (await verifySmtp(alt.host, alt.port, alt.secure, email, password)) { s = alt; smtpOk = true; }
    } else if (!smtpOk && smtp.port === 465) {
      const alt = { ...smtp, port: 587, secure: false };
      if (await verifySmtp(alt.host, alt.port, alt.secure, email, password)) { s = alt; smtpOk = true; }
    }
    return { ok: true, tried, config: { imap, smtp: s, username: email, source: c.source, verified: true } };
  }

  // Nothing logged in — hand back the best guess so the user can adjust.
  const top = ordered[0]!;
  return {
    ok: false,
    tried,
    config: { imap: top.cfg.imap!, smtp: top.cfg.smtp!, username: email, source: top.source, verified: false },
    detail: 'Found likely servers but the login was rejected — check the password (some hosts need an app-specific password).',
  };
}
