// ─────────────────────────────────────────────────────────────────────────────
// Cortex sync — the link that makes Big Dog part of the nervous system.
//
// Every customer in the CRM (deal + relationship memory + recent threads) is
// pushed into Cortex as a grounded, per-customer record. Cortex then answers any
// question about that real customer STRICTLY from this data and refuses when it's
// not there — so no AI (Clon, Buildo, or Big Dog itself) can hallucinate about
// what the company is actually doing with its real customers.
//
// Owner/tenant-scoped by the Cortex token (each Big Dog user's customers go to
// their own private corpus). No-op unless CORTEX_URL + CORTEX_TOKEN are set.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from './db.js';

const slug = (s: string): string =>
  (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'unknown';

interface DealRow {
  id: string; title: string; contactName: string; contactEmail: string;
  company: string; stage: string; value: number; notes: string; nextStep: string; updatedAt: string;
}

const FREE_MAIL = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com']);
// Fetched once per process to avoid re-hitting the same site every tick.
const fetchedDomains = new Set<string>();

function cortexEnv(): { url: string; token: string } | null {
  const url = (process.env.CORTEX_URL || '').replace(/\/$/, '');
  const token = process.env.CORTEX_TOKEN || '';
  return url && token ? { url, token } : null;
}

async function pushToCortex(env: { url: string; token: string }, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${env.url}/cortex/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Spin up grounded Cortex endpoints for the EXTERNAL resources Big Dog needs to
// sell: each customer company's website (so Big Dog can answer "what does this
// company do / what do they care about" from real source, not a guess). LinkedIn
// profile pages are intentionally NOT scraped here — LinkedIn blocks automated
// access and it violates their ToS; use Big Dog's lead-research brief or an
// Apollo/permitted data source and feed that in instead.
export async function ingestResourcesToCortex(): Promise<{ sites: number; skipped?: boolean }> {
  const env = cortexEnv();
  if (!env) return { sites: 0, skipped: true };
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT contactEmail, company FROM deals').all() as { contactEmail: string; company: string }[];
  let sites = 0;
  for (const r of rows) {
    const domain = (r.contactEmail || '').split('@')[1]?.toLowerCase().trim();
    if (!domain || FREE_MAIL.has(domain) || fetchedDomains.has(domain)) continue;
    fetchedDomains.add(domain);
    try {
      const res = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; BigDog/1.0)' } });
      if (!res.ok) continue;
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
      if (text.length < 80) continue;
      const ok = await pushToCortex(env, {
        source: 'web-customer', subject: `company-${slug(r.company || domain)}`,
        text: `WEBSITE ${domain}${r.company ? ` (${r.company})` : ''}: ${text}`,
        refId: `web-${domain}`, replace: true,
      });
      if (ok) sites++;
    } catch {
      /* site blocked/unreachable — skip */
    }
  }
  return { sites };
}

export async function syncCustomersToCortex(): Promise<{ synced: number; skipped?: boolean }> {
  const url = (process.env.CORTEX_URL || '').replace(/\/$/, '');
  const token = process.env.CORTEX_TOKEN || '';
  if (!url || !token) return { synced: 0, skipped: true };

  const db = getDb();
  const deals = db.prepare('SELECT * FROM deals ORDER BY updatedAt DESC LIMIT 500').all() as DealRow[];
  let n = 0;
  for (const d of deals) {
    if (!d.contactEmail) continue;
    const mems = (db.prepare('SELECT content FROM memories WHERE lower(contactEmail)=lower(?) ORDER BY createdAt DESC LIMIT 20')
      .all(d.contactEmail) as { content: string }[]).map((m) => m.content).filter(Boolean);
    const subs = (db.prepare('SELECT subject FROM messages WHERE dealId=? ORDER BY date DESC LIMIT 12')
      .all(d.id) as { subject: string }[]).map((m) => m.subject).filter(Boolean);
    const text = [
      `CUSTOMER: ${d.contactName || d.contactEmail} <${d.contactEmail}>${d.company ? ' @ ' + d.company : ''}.`,
      `Deal: "${d.title || 'untitled'}" — stage: ${d.stage || 'unknown'}${d.value ? `, value: $${d.value}` : ''}.`,
      d.nextStep ? `Next step: ${d.nextStep}.` : '',
      d.notes ? `Notes: ${d.notes}.` : '',
      mems.length ? `Relationship memory: ${mems.join(' | ')}.` : '',
      subs.length ? `Recent threads: ${subs.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
    try {
      const res = await fetch(`${url}/cortex/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'bigdog-crm', subject: `customer-${slug(d.contactEmail)}`, text, refId: `bigdog-deal-${d.id}`, replace: true }),
      });
      if (res.ok) n++;
    } catch {
      /* transient — retry next tick */
    }
  }
  return { synced: n };
}
