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
