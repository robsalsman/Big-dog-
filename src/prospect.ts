import { randomUUID } from 'node:crypto';
import { deals, memories, contacts } from './db.js';
import { findEmail, guessEmail, mxHost, type EmailResult } from './emailfinder.js';
import { verifierConfigured, verifyAddress } from './emailverify.js';
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

  // Hard verification via an external API (works even when SMTP/port-25 is
  // blocked). Upgrades to "verified", corrects to a valid sibling candidate, or
  // marks invalid — used everywhere email finding happens.
  if (verifierConfigured() && result.email) {
    const candidates = [result.email, ...(result.candidates ?? []).filter((c) => c !== result.email)].slice(0, 5);
    let marked = false;
    for (const cand of candidates) {
      const v = await verifyAddress(cand).catch(() => null);
      if (!v) continue;
      if (v.status === 'valid') { result.email = cand; result.confidence = 'verified'; result.method = `API-verified (${v.provider})`; marked = true; break; }
      if (v.status === 'catch-all' && !marked) { result.confidence = 'guess'; result.method = `catch-all domain (${v.provider})`; marked = true; }
      // 'invalid' on the primary → keep trying siblings; 'unknown' → leave as-is.
      if (cand === result.email && v.status === 'invalid' && result.confidence !== 'verified') { result.confidence = 'unverified'; result.method = `API: address not deliverable (${v.provider})`; }
    }
  }
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
  const { headers, rows } = parseCsvRaw(text);
  if (!rows.length) return [];
  return applyMap(rows, deterministicMap(headers));
}

/** Low-level CSV parse — keeps the original header names, one object per row. */
export function parseCsvRaw(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const grid: string[][] = [];
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
    else if (c === '\n') { row.push(field); grid.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); grid.push(row); }
  const nonEmpty = grid.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length < 2) return { headers: [], rows: [] };
  const headers = nonEmpty[0]!.map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (r[i] ?? '').trim()));
    return obj;
  });
  return { headers, rows };
}

function deterministicMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const c = HEADER_MAP[h.trim().toLowerCase()];
    if (c) map[h] = c;
  }
  return map;
}

function applyMap(rows: Record<string, string>[], map: Record<string, string>): Record<string, string>[] {
  return rows.map((r) => {
    const o: Record<string, string> = {};
    for (const [h, v] of Object.entries(r)) {
      const c = map[h];
      if (c && v) o[c] = v;
    }
    return o;
  });
}

const CANON_FIELDS = ['name', 'first', 'last', 'company', 'domain', 'website', 'title', 'email', 'linkedin'];

/**
 * Normalize an arbitrary CSV export into canonical lead rows. It maps the obvious
 * headers itself and — when a model is live — asks Claude to map the leftover
 * columns by reading the header names + a few sample values, so messy CRM/Pardot
 * exports with dozens of columns just work. Returns the rows + the mapping used.
 */
export async function normalizeCsv(
  text: string,
  brain?: BigDogBrain,
): Promise<{ rows: Record<string, string>[]; mapping: Record<string, string>; headers: string[] }> {
  const { headers, rows } = parseCsvRaw(text);
  if (!rows.length) return { rows: [], mapping: {}, headers: [] };
  const map = deterministicMap(headers);

  // If we're still missing essentials (a name, or any way to reach them), let
  // the model interpret the columns we didn't recognize.
  const have = new Set(Object.values(map));
  const lacksName = !have.has('name') && !(have.has('first') && have.has('last'));
  const lacksReach = !have.has('email') && !have.has('domain') && !have.has('website') && !have.has('company');
  const unmapped = headers.filter((h) => !map[h]);
  if (brain?.live && unmapped.length && (lacksName || lacksReach)) {
    const samples = unmapped.map((h) => ({ header: h, values: rows.map((r) => r[h] ?? '').filter(Boolean).slice(0, 3) }));
    const llm = await brain.mapCsvColumns(unmapped, samples).catch(() => ({} as Record<string, string>));
    for (const [h, c] of Object.entries(llm)) {
      if (CANON_FIELDS.includes(c) && headers.includes(h) && !map[h]) map[h] = c;
    }
  }
  return { rows: applyMap(rows, map), mapping: map, headers };
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
  const raw = useApollo && cfg.apolloKey ? await apolloSearch(cfg.apolloKey, criteria) : await brain.prospect(criteria);
  return verifyProspects(raw, brain);
}

/**
 * Verify each prospect up front so only contactable leads are shown. For a
 * person + domain, learn the company's email pattern and SMTP-verify the address;
 * for a provided (often role) address, confirm the domain can receive mail. Drop
 * anyone we can't confirm a deliverable address for — they can't be campaigned.
 */
async function verifyProspects(list: Prospect[], brain: BigDogBrain): Promise<Prospect[]> {
  const out: Prospect[] = [];
  // Cap concurrency — each lead does pattern-learning + an SMTP probe.
  const CHUNK = 4;
  for (let i = 0; i < list.length; i += CHUNK) {
    const batch = await Promise.all(list.slice(i, i + CHUNK).map((p) => verifyOne(p, brain).catch(() => null)));
    for (const r of batch) if (r) out.push(r);
  }
  return out;
}

async function verifyOne(p: Prospect, brain: BigDogBrain): Promise<Prospect | null> {
  const domain = p.domain ? domainFromUrl(p.domain) ?? p.domain : (p.email && p.email.includes('@') ? p.email.split('@')[1]! : '');
  if (!domain) return null;
  const parts = (p.name || '').trim().split(/\s+/).filter(Boolean);
  const useApi = verifierConfigured(); // HTTPS verifier works even with port 25 blocked

  // Prefer a confirmed personal address. With an API verifier, skip the (blocked)
  // SMTP probe and let the API confirm; otherwise fall back to the SMTP probe.
  if (parts.length >= 2) {
    const r = await findContactEmail({ name: p.name, domain }, brain, { verify: !useApi }).catch(() => null);
    if (r && r.email && (r.confidence === 'verified' || r.confidence === 'guess')) {
      const status = r.confidence === 'verified' ? 'verified' : 'deliverable';
      const mark = status === 'verified' ? '✓ verified' : '✓ deliverable (pattern)';
      return { ...p, email: r.email, verifyStatus: status, notes: `${p.notes ? p.notes + ' · ' : ''}${mark} — ${r.method}` };
    }
  }

  // Otherwise judge a provided (role/company) address.
  if (p.email && p.email.includes('@')) {
    if (useApi) {
      const v = await verifyAddress(p.email).catch(() => null);
      if (v?.status === 'valid') return { ...p, verifyStatus: 'verified', notes: `${p.notes ? p.notes + ' · ' : ''}✓ verified (${v.provider})` };
      if (v?.status === 'catch-all') return { ...p, verifyStatus: 'catch-all', notes: `${p.notes ? p.notes + ' · ' : ''}✓ deliverable — catch-all (${v.provider})` };
      if (v?.status === 'invalid') return null;
      // 'unknown' → fall through to the MX check below
    }
    const host = await mxHost(p.email.split('@')[1]!).catch(() => null);
    if (host) return { ...p, verifyStatus: 'deliverable', notes: `${p.notes ? p.notes + ' · ' : ''}✓ company address — domain accepts mail` };
  }
  return null; // couldn't confirm a deliverable address → drop
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
    notes: [p.verifyStatus ? `[${p.verifyStatus}]` : '', p.title, p.location, p.linkedin, p.notes].filter(Boolean).join(' · '),
    nextStep: p.email ? 'Open the conversation' : 'Find contact details, then reach out',
    nextStepDue: null,
    createdAt: now,
    updatedAt: now,
    lastActivity: now,
  };
  deals.upsert(deal);
  if (p.email) {
    memories.add(p.email, `Sourced via ${p.source} prospecting: ${p.title} at ${p.company}. ${p.notes}`.trim());
    contacts.save({ email: p.email, name: p.name, company: p.company, title: p.title });
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
