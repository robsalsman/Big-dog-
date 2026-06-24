import { settingsStore } from './db.js';

/**
 * Pluggable email-verification API — gives hard "valid/invalid" verification
 * over HTTPS, so it works even when the VPS blocks outbound SMTP (port 25).
 * Bring your own key from any of the common providers (most have free tiers),
 * or point at a custom endpoint.
 */

export interface VerifySettings {
  provider: 'off' | 'reoon' | 'zerobounce' | 'hunter' | 'abstract' | 'custom';
  apiKey: string;
  customUrl: string; // for 'custom': a URL template with {email} and {key}
}

const KEYS: (keyof VerifySettings)[] = ['provider', 'apiKey', 'customUrl'];

export const VERIFY_PROVIDERS = [
  { id: 'reoon', label: 'Reoon (free tier)' },
  { id: 'zerobounce', label: 'ZeroBounce' },
  { id: 'hunter', label: 'Hunter.io' },
  { id: 'abstract', label: 'AbstractAPI' },
  { id: 'custom', label: 'Custom endpoint' },
];

export function loadVerifySettings(): VerifySettings {
  return {
    provider: (settingsStore.get('verify.provider') as VerifySettings['provider']) || (process.env.EMAIL_VERIFY_PROVIDER as VerifySettings['provider']) || 'off',
    apiKey: settingsStore.get('verify.apiKey') || process.env.EMAIL_VERIFY_KEY || '',
    customUrl: settingsStore.get('verify.customUrl') || process.env.EMAIL_VERIFY_URL || '',
  };
}

export function saveVerifySettings(p: Partial<Record<keyof VerifySettings, unknown>>): void {
  for (const k of KEYS) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    settingsStore.set(`verify.${k}`, String(v).trim());
  }
}

export function verifierConfigured(s: VerifySettings = loadVerifySettings()): boolean {
  if (s.provider === 'off' || !s.provider) return false;
  if (s.provider === 'custom') return !!s.customUrl;
  return !!s.apiKey;
}

export function publicVerify(s: VerifySettings = loadVerifySettings()) {
  return { configured: verifierConfigured(s), provider: s.provider, keySet: !!s.apiKey, customUrl: s.customUrl, providers: VERIFY_PROVIDERS };
}

export type VerifyStatus = 'valid' | 'invalid' | 'catch-all' | 'unknown';

function buildUrl(s: VerifySettings, email: string): string {
  const e = encodeURIComponent(email);
  const k = encodeURIComponent(s.apiKey);
  switch (s.provider) {
    case 'reoon': return `https://emailverifier.reoon.com/api/v1/verify?email=${e}&key=${k}&mode=power`;
    case 'zerobounce': return `https://api.zerobounce.net/v2/validate?api_key=${k}&email=${e}`;
    case 'hunter': return `https://api.hunter.io/v2/email-verifier?email=${e}&api_key=${k}`;
    case 'abstract': return `https://emailvalidation.abstractapi.com/v1/?api_key=${k}&email=${e}`;
    case 'custom': return s.customUrl.replace(/\{email\}/g, e).replace(/\{key\}/g, k);
    default: return '';
  }
}

function normalize(s: VerifySettings, data: any): VerifyStatus {
  try {
    switch (s.provider) {
      case 'reoon': {
        const st = String(data.status || '').toLowerCase();
        if (st === 'valid' || data.is_safe_to_send === true) return 'valid';
        if (st === 'invalid' || st === 'disposable' || st === 'spamtrap') return 'invalid';
        return 'unknown';
      }
      case 'zerobounce': {
        const st = String(data.status || '').toLowerCase();
        if (st === 'valid') return 'valid';
        if (st === 'catch-all') return 'catch-all';
        if (['invalid', 'do_not_mail', 'abuse', 'spamtrap'].includes(st)) return 'invalid';
        return 'unknown';
      }
      case 'hunter': {
        const d = data.data || {};
        const result = String(d.result || '').toLowerCase();
        const status = String(d.status || '').toLowerCase();
        if (result === 'deliverable' || status === 'valid') return 'valid';
        if (status === 'accept_all' || result === 'risky') return 'catch-all';
        if (result === 'undeliverable' || status === 'invalid') return 'invalid';
        return 'unknown';
      }
      case 'abstract': {
        const del = String(data.deliverability || '').toUpperCase();
        if (del === 'DELIVERABLE') return data.is_catchall_email?.value ? 'catch-all' : 'valid';
        if (del === 'UNDELIVERABLE') return 'invalid';
        return 'unknown';
      }
      case 'custom': {
        // Heuristic: look for common fields.
        const flat = JSON.stringify(data).toLowerCase();
        if (/"(status|result|deliverability|state)"\s*:\s*"(valid|deliverable|ok|true)"/.test(flat) || data.valid === true || data.is_valid === true) return 'valid';
        if (/catch.?all|accept.?all/.test(flat)) return 'catch-all';
        if (/"(status|result|deliverability|state)"\s*:\s*"(invalid|undeliverable|false)"/.test(flat) || data.valid === false) return 'invalid';
        return 'unknown';
      }
      default: return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

export async function verifyAddress(email: string, s: VerifySettings = loadVerifySettings()): Promise<{ status: VerifyStatus; provider: string }> {
  if (!verifierConfigured(s)) return { status: 'unknown', provider: 'none' };
  const url = buildUrl(s, email);
  if (!url) return { status: 'unknown', provider: s.provider };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { status: 'unknown', provider: s.provider };
    const data = await res.json();
    return { status: normalize(s, data), provider: s.provider };
  } catch {
    return { status: 'unknown', provider: s.provider };
  }
}

export async function testVerifier(s: VerifySettings = loadVerifySettings()): Promise<{ ok: boolean; detail: string }> {
  if (!verifierConfigured(s)) return { ok: false, detail: 'Pick a provider and add your key.' };
  const r = await verifyAddress('support@github.com', s); // a known-deliverable address
  if (r.status === 'unknown') return { ok: false, detail: 'No clear result — check the key/endpoint.' };
  return { ok: true, detail: `Verifier working (${r.provider}) — test returned "${r.status}".` };
}
