import { settingsStore } from './db.js';
import type { AppConfig } from './config.js';
import type { Owner } from './types.js';

/**
 * The owner profile (name, voice, signature) that drives the "clone of you"
 * persona. Seeded from config/accounts.json, overridable + persisted in-app —
 * including a voice profile learned from your real emails.
 */
const KEYS: (keyof Owner)[] = ['name', 'title', 'company', 'signature', 'voiceNotes'];

export function loadOwner(cfg: AppConfig): Owner {
  const o: Owner = { ...cfg.owner };
  for (const k of KEYS) {
    const v = settingsStore.get(`owner.${k}`);
    if (v != null && v !== '') o[k] = v;
  }
  return o;
}

export function saveOwner(partial: Partial<Record<keyof Owner, unknown>>): void {
  for (const k of KEYS) {
    const v = partial[k];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s.trim() === '') continue;
    settingsStore.set(`owner.${k}`, s);
  }
}
