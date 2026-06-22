import { settingsStore } from './db.js';
import { selectProvider, type LLMProvider } from './llm/provider.js';
import type { AppConfig } from './config.js';

/**
 * Runtime LLM settings — so anyone can run Big Dog and just drop in their own
 * Claude or ChatGPT key (or point at a local Ollama) from the dashboard, no
 * .env editing. Stored locally in the SQLite DB; env vars seed the defaults.
 */
export interface Settings {
  provider: 'anthropic' | 'openai' | 'ollama' | 'auto';
  anthropicKey: string;
  anthropicModel: string;
  openaiKey: string;
  openaiModel: string;
  openaiBaseUrl: string;
  ollamaHost: string;
  ollamaModel: string;
}

const STRING_KEYS: (keyof Settings)[] = [
  'provider',
  'anthropicKey',
  'anthropicModel',
  'openaiKey',
  'openaiModel',
  'openaiBaseUrl',
  'ollamaHost',
  'ollamaModel',
];

function defaultsFromEnv(cfg: AppConfig): Settings {
  return {
    provider: cfg.provider,
    anthropicKey: cfg.anthropicKey ?? '',
    anthropicModel: cfg.model,
    openaiKey: cfg.openaiKey ?? '',
    openaiModel: cfg.openaiModel,
    openaiBaseUrl: cfg.openaiBaseUrl,
    ollamaHost: cfg.ollamaHost,
    ollamaModel: cfg.ollamaModel,
  };
}

/** Stored settings override env defaults. */
export function loadSettings(cfg: AppConfig): Settings {
  return { ...defaultsFromEnv(cfg), ...settingsStore.all() } as Settings;
}

/** Persist only the fields provided (empty strings are ignored, so keys aren't wiped). */
export function saveSettings(partial: Partial<Record<keyof Settings, unknown>>): void {
  for (const key of STRING_KEYS) {
    const v = partial[key];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s === '') continue;
    settingsStore.set(key, s);
  }
}

export function buildProvider(s: Settings): LLMProvider {
  return selectProvider({
    provider: s.provider,
    anthropicKey: s.anthropicKey || undefined,
    anthropicModel: s.anthropicModel,
    openaiKey: s.openaiKey || undefined,
    openaiModel: s.openaiModel,
    openaiBaseUrl: s.openaiBaseUrl,
    ollamaHost: s.ollamaHost,
    ollamaModel: s.ollamaModel,
  });
}

/** Never return raw keys to the client — just whether one is set + last 4. */
export function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 8 ? '••••' : `••••${k.slice(-4)}`;
}

export function publicSettings(s: Settings) {
  return {
    provider: s.provider,
    anthropicKeySet: !!s.anthropicKey,
    anthropicKeyHint: maskKey(s.anthropicKey),
    anthropicModel: s.anthropicModel,
    openaiKeySet: !!s.openaiKey,
    openaiKeyHint: maskKey(s.openaiKey),
    openaiModel: s.openaiModel,
    ollamaHost: s.ollamaHost,
    ollamaModel: s.ollamaModel,
  };
}

/** Quick liveness test of a provider — used by the Settings "Test" button. */
export async function testProvider(p: LLMProvider): Promise<{ ok: boolean; detail: string }> {
  if (!p.live) return { ok: false, detail: 'No key/model configured for this backend.' };
  if (p.ping) {
    const reachable = await p.ping();
    if (!reachable) return { ok: false, detail: 'Backend unreachable or key rejected.' };
  }
  try {
    const out = await p.complete({ system: 'You are a connection test.', user: 'Reply with just: READY', maxTokens: 20 });
    return out ? { ok: true, detail: `OK — ${p.label}` } : { ok: false, detail: 'Empty response from backend.' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
