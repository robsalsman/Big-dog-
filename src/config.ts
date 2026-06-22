import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AccountsConfig, Owner } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const DATA_DIR = resolve(ROOT, 'data');

export interface AppConfig {
  model: string;
  port: number;
  syncMinutes: number;
  digestHour: number;
  sendMode: 'hold' | 'auto';
  anthropicKey: string | undefined;
  owner: Owner;
  accountsConfigPath: string;
}

const DEFAULT_OWNER: Owner = {
  name: 'Big Dog',
  title: 'Founder',
  company: 'Big Dog Co',
  signature: 'Big Dog',
  voiceNotes:
    'Warm but direct. CEO-level intellect and hustle. Drives toward a clear next step on every thread. ' +
    'Short paragraphs, no corporate fluff, never desperate. Opens warm, closes with a specific ask.',
};

function loadAccountsConfig(path: string): AccountsConfig {
  if (!existsSync(path)) {
    return { owner: DEFAULT_OWNER, accounts: [] };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AccountsConfig>;
  return {
    owner: { ...DEFAULT_OWNER, ...(raw.owner ?? {}) },
    accounts: raw.accounts ?? [],
  };
}

export function loadConfig(): AppConfig {
  const accountsConfigPath = resolve(ROOT, 'config', 'accounts.json');
  const { owner } = loadAccountsConfig(accountsConfigPath);

  return {
    model: process.env.BIGDOG_MODEL || 'claude-opus-4-8',
    port: Number(process.env.PORT || 4137),
    syncMinutes: Number(process.env.BIGDOG_SYNC_MINUTES ?? 5),
    digestHour: Number(process.env.BIGDOG_DIGEST_HOUR ?? 7),
    sendMode: process.env.BIGDOG_SEND_MODE === 'auto' ? 'auto' : 'hold',
    anthropicKey: process.env.ANTHROPIC_API_KEY || undefined,
    owner,
    accountsConfigPath,
  };
}

export function loadAccounts(): AccountsConfig {
  const path = resolve(ROOT, 'config', 'accounts.json');
  return loadAccountsConfig(path);
}
