import { randomUUID } from 'node:crypto';
import { deals, memories } from './db.js';
import type { AppConfig } from './config.js';
import type { BigDogBrain } from './brain.js';
import type { Prospect, Deal } from './types.js';

/**
 * Lead generation, ZoomInfo-style — pluggable so you're never locked in.
 *   web    : free, no signup. Uses Big Dog's web access to find + enrich from public data.
 *   apollo : opt-in free-tier API (apollo.io) for structured people/company search.
 * There is no open-source ZoomInfo (the data is proprietary); this gets you the
 * search → enrich → drop-into-pipeline workflow with free backends.
 */
export async function findProspects(criteria: string, cfg: AppConfig, brain: BigDogBrain): Promise<Prospect[]> {
  const useApollo = cfg.prospectProvider === 'apollo' || (cfg.prospectProvider === 'auto' && !!cfg.apolloKey);
  if (useApollo && cfg.apolloKey) {
    return apolloSearch(cfg.apolloKey, criteria);
  }
  return brain.prospect(criteria);
}

export function activeProvider(cfg: AppConfig): { name: string; ready: boolean } {
  if (cfg.prospectProvider === 'apollo' || (cfg.prospectProvider === 'auto' && cfg.apolloKey)) {
    return { name: 'apollo', ready: !!cfg.apolloKey };
  }
  return { name: 'web', ready: true };
}

/** Turn a sourced prospect into a pipeline deal + a memory note. */
export function saveProspectAsDeal(p: Prospect): Deal {
  const now = new Date().toISOString();
  const deal: Deal = {
    id: randomUUID().slice(0, 16),
    title: `${p.company || p.name} — new opportunity`,
    contactName: p.name,
    contactEmail: p.email,
    company: p.company,
    stage: 'new',
    value: null,
    notes: [p.title, p.location, p.linkedin, p.notes].filter(Boolean).join(' · '),
    nextStep: p.email ? 'Open the conversation' : 'Find contact details, then reach out',
    nextStepDue: null,
    createdAt: now,
    updatedAt: now,
    lastActivity: now,
  };
  deals.upsert(deal);
  if (p.email) {
    memories.add(p.email, `Sourced via ${p.source} prospecting: ${p.title} at ${p.company}. ${p.notes}`.trim());
  }
  return deal;
}

// ── Apollo.io (free-tier API) ───────────────────────────────────────────
interface ApolloPerson {
  name?: string;
  title?: string;
  email?: string;
  linkedin_url?: string;
  city?: string;
  state?: string;
  country?: string;
  organization?: { name?: string };
}

async function apolloSearch(apiKey: string, criteria: string): Promise<Prospect[]> {
  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': apiKey },
    body: JSON.stringify({ q_keywords: criteria, page: 1, per_page: 10 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`apollo ${res.status}: ${await res.text().catch(() => '')}`);

  const data = (await res.json()) as { people?: ApolloPerson[] };
  return (data.people ?? []).map((p) => {
    const email = p.email && !/not_unlocked|email_not/i.test(p.email) ? p.email : '';
    return {
      name: p.name ?? '',
      title: p.title ?? '',
      company: p.organization?.name ?? '',
      email,
      linkedin: p.linkedin_url ?? '',
      location: [p.city, p.state, p.country].filter(Boolean).join(', '),
      source: 'apollo',
      notes: email ? '' : 'Email locked on free tier — enrich or verify before outreach.',
    } satisfies Prospect;
  });
}
