import { randomUUID } from 'node:crypto';
import { deals, memories } from './db.js';
import { findEmail, guessEmail, type EmailResult } from './emailfinder.js';
import { learnDomainPattern } from './patternlearner.js';
import type { AppConfig } from './config.js';
import type { BigDogBrain } from './brain.js';
import type { Prospect, Deal } from './types.js';

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Find a contact's email from name + domain. First learns the company's email
 * format (web anchor or site scrape, cached), then SMTP-verifies where possible.
 * The learned pattern means even un-verifiable domains get a confident address.
 */
export async function findContactEmail(
  input: { name?: string; firstName?: string; lastName?: string; domain: string },
  brain?: BigDogBrain,
  opts: { verify?: boolean } = {},
): Promise<EmailResult & { learnedSource?: string }> {
  let first = input.firstName ?? '';
  let last = input.lastName ?? '';
  if (!first && input.name) {
    const parts = input.name.trim().split(/\s+/);
    first = parts[0] ?? '';
    last = parts.slice(1).join(' ');
  }
  const domain = domainFromUrl(input.domain) ?? input.domain;
  const learned = await learnDomainPattern(domain, brain).catch(() => null);
  // verify=false (default for bulk) skips the slow SMTP probe — pattern only.
  const result =
    opts.verify === false
      ? guessEmail(first, last, domain, learned?.patternKey)
      : await findEmail({ firstName: first, lastName: last, domain, learnedKey: learned?.patternKey });
  return { ...result, learnedSource: learned?.source };
}

// ── CSV lead-list import + bulk enrichment ──────────────────────────────
const HEADER_MAP: Record<string, string> = {
  name: 'name', 'full name': 'name', contact: 'name', 'contact name': 'name',
  first: 'first', firstname: 'first', 'first name': 'first', 'given name': 'first',
  last: 'last', lastname: 'last', 'last name': 'last', surname: 'last', 'family name': 'last',
  company: 'company', organization: 'company', organisation: 'company', account: 'company', employer: 'company',
  domain: 'domain', 'email domain': 'domain',
  website: 'website', url: 'website', site: 'website', web: 'website', 'company website': 'website',
  title: 'title', 'job title': 'title', role: 'title', position: 'title',
  email: 'email', 'email address': 'email', 'work email': 'email',
  linkedin: 'linkedin', 'linkedin url': 'linkedin',
};

/** Minimal RFC-ish CSV parser (handles quotes, commas, escaped quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const t = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length < 2) return [];

  const headers = nonEmpty[0]!.map((h) => HEADER_MAP[h.trim().toLowerCase()] ?? h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (r[i] ?? '').trim()));
    return obj;
  });
}

export interface EnrichedRow {
  name: string;
  title: string;
  company: string;
  domain: string;
  email: string;
  confidence: string;
  method: string;
}

async function resolveDomain(row: Record<string, string>, brain?: BigDogBrain, cache?: Map<string, string>): Promise<string> {
  if (row.domain) return domainFromUrl(row.domain) ?? row.domain;
  if (row.website) return domainFromUrl(row.website) ?? '';
  if (row.email && row.email.includes('@')) return row.email.split('@')[1] ?? '';
  if (row.company && brain?.live) {
    const key = row.company.toLowerCase();
    if (cache?.has(key)) return cache.get(key)!;
    const d = await brain.companyDomain(row.company).catch(() => '');
    cache?.set(key, d);
    return d;
  }
  return '';
}

/** Enrich a parsed lead list: fill in each contact's email (learned-pattern by default). */
export async function enrichRows(
  rows: Record<string, string>[],
  brain: BigDogBrain | undefined,
  opts: { verify?: boolean; limit?: number } = {},
): Promise<EnrichedRow[]> {
  const limit = Math.min(opts.limit ?? (opts.verify ? 20 : 100), 200);
  const domainCache = new Map<string, string>();
  const out: EnrichedRow[] = [];

  for (const row of rows.slice(0, limit)) {
    const name = row.name || [row.first, row.last].filter(Boolean).join(' ');
    const company = row.company || '';
    const base: EnrichedRow = { name, title: row.title || '', company, domain: '', email: row.email || '', confidence: '', method: '' };

    if (row.email && row.email.includes('@')) {
      base.domain = row.email.split('@')[1] ?? '';
      base.confidence = 'provided';
      base.method = 'email already in list';
      out.push(base);
      continue;
    }
    const domain = await resolveDomain(row, brain, domainCache);
    base.domain = domain;
    if (!name || !domain) {
      base.confidence = 'skipped';
      base.method = !domain ? 'no domain (add a domain/website column, or use Claude to resolve)' : 'no contact name';
      out.push(base);
      continue;
    }
    const r = await findContactEmail({ name, domain }, brain, { verify: opts.verify });
    base.email = r.email;
    base.confidence = r.confidence;
    base.method = r.method;
    out.push(base);
  }
  return out;
}

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
  organization?: { name?: string; primary_domain?: string; website_url?: string };
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
      domain: p.organization?.primary_domain ?? domainFromUrl(p.organization?.website_url) ?? '',
      email,
      linkedin: p.linkedin_url ?? '',
      location: [p.city, p.state, p.country].filter(Boolean).join(', '),
      source: 'apollo',
      notes: email ? '' : 'Email locked on free tier — enrich or verify before outreach.',
    } satisfies Prospect;
  });
}
