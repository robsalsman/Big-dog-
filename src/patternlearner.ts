import { patterns, type DomainPattern } from './db.js';
import { inferPatternKey } from './emailfinder.js';
import { ensureBrowser, pageHtml } from './browser.js';
import type { BigDogBrain } from './brain.js';

/**
 * Learn a company's email format so even un-verifiable domains get a
 * high-confidence address — the trick paid tools use. Two free signals:
 *   1. A name+email anchor from the web (model with web access) → exact pattern.
 *   2. Scrape the company site for a real personal email → structural pattern.
 * Whatever it learns is cached per domain.
 */

const FRESH_DAYS = 30;
const SCRAPE_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/team', '/company'];

// Generic/role mailboxes never reveal a personal pattern — ignore them.
const ROLE = new Set([
  'info', 'sales', 'support', 'hello', 'hi', 'contact', 'admin', 'careers', 'jobs',
  'press', 'media', 'marketing', 'billing', 'help', 'team', 'office', 'hr', 'legal',
  'privacy', 'security', 'noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster',
  'mail', 'enquiries', 'inquiries', 'general', 'accounts', 'orders', 'newsletter',
]);

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BigDog/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/** Scrape a company's public pages for any email addresses at its own domain. */
export async function scrapeDomainEmails(domain: string, baseUrl?: string): Promise<string[]> {
  const base = (baseUrl ?? `https://${domain}`).replace(/\/$/, '');
  const re = new RegExp(`[a-z0-9._%+-]+@${domain.replace(/\./g, '\\.')}`, 'gi');
  const seen = new Set<string>();
  const useBrowser = await ensureBrowser(); // upgrade JS-rendered pages when available
  for (const path of SCRAPE_PATHS) {
    let html = await fetchText(base + path);
    // Plain fetch missed it? A real browser can render emails injected by JS.
    if (!html && useBrowser) html = await pageHtml(base + path);
    for (const m of html.matchAll(re)) seen.add(m[0].toLowerCase());
    if (seen.size >= 15) break;
  }
  return [...seen];
}

/** Infer a pattern key from a personal email local-part alone (separator-based formats). */
export function structuralKey(localPart: string): string | null {
  const local = localPart.toLowerCase();
  if (local.includes('_')) return 'first_last';
  if (local.includes('.')) {
    const [a, b] = local.split('.');
    if (!a || !b) return null;
    if (a.length === 1) return 'f.last';
    if (b.length === 1) return 'first.l';
    return 'first.last';
  }
  return null; // no separator → ambiguous, don't guess
}

function isFresh(p: DomainPattern): boolean {
  return Date.now() - new Date(p.updatedAt).getTime() < FRESH_DAYS * 86_400_000;
}

export interface LearnResult {
  patternKey: string;
  sample: string;
  source: string;
}

/** Learn (and cache) a domain's email pattern. Returns null if it can't be determined. */
export async function learnDomainPattern(domain: string, brain?: BigDogBrain): Promise<LearnResult | null> {
  const d = domain.toLowerCase().replace(/^www\./, '');
  const cached = patterns.get(d);
  if (cached && cached.patternKey && isFresh(cached)) {
    return { patternKey: cached.patternKey, sample: cached.sample, source: cached.source };
  }

  // 1. Best signal: a real (name, email) pair found on the web → exact pattern.
  if (brain) {
    const anchor = await brain.knownEmail(d).catch(() => null);
    if (anchor?.email && anchor.name) {
      const parts = anchor.name.trim().split(/\s+/);
      const key = inferPatternKey(anchor.email.split('@')[0] ?? '', parts[0] ?? '', parts.slice(1).join(' '));
      if (key) {
        patterns.set(d, key, anchor.email, 'web-anchor');
        return { patternKey: key, sample: anchor.email, source: 'web-anchor' };
      }
    }
  }

  // 2. Fallback: scrape the site for a personal address → structural pattern.
  const emails = await scrapeDomainEmails(d);
  for (const email of emails) {
    const local = email.split('@')[0] ?? '';
    if (ROLE.has(local) || /^[0-9]+$/.test(local)) continue;
    const key = structuralKey(local);
    if (key) {
      patterns.set(d, key, email, 'site-scrape');
      return { patternKey: key, sample: email, source: 'site-scrape' };
    }
  }

  return null;
}
