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
  // LLM backend
  provider: 'anthropic' | 'ollama' | 'auto';
  ollamaHost: string;
  ollamaModel: string;
  // Chat bots
  telegram: { token: string; chatId: string } | undefined;
  slack: { botToken: string; appToken: string; channel: string; webhookUrl: string } | undefined;
  // Cal.com scheduling (cloud or self-hosted open-source instance)
  calcom: { apiKey: string; baseUrl: string; bookingUrl: string } | undefined;
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

  const providerRaw = (process.env.BIGDOG_PROVIDER || 'auto').toLowerCase();
  const provider: AppConfig['provider'] =
    providerRaw === 'anthropic' || providerRaw === 'ollama' ? providerRaw : 'auto';

  const calcomKey = process.env.CALCOM_API_KEY?.trim();
  const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const slackBot = process.env.SLACK_BOT_TOKEN?.trim();
  const slackApp = process.env.SLACK_APP_TOKEN?.trim();
  const slackWebhook = process.env.SLACK_WEBHOOK_URL?.trim();

  return {
    model: process.env.BIGDOG_MODEL || 'claude-opus-4-8',
    port: Number(process.env.PORT || 4137),
    syncMinutes: Number(process.env.BIGDOG_SYNC_MINUTES ?? 5),
    digestHour: Number(process.env.BIGDOG_DIGEST_HOUR ?? 7),
    sendMode: process.env.BIGDOG_SEND_MODE === 'auto' ? 'auto' : 'hold',
    anthropicKey: process.env.ANTHROPIC_API_KEY || undefined,
    owner,
    accountsConfigPath,
    provider,
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',
    calcom: calcomKey
      ? {
          apiKey: calcomKey,
          baseUrl: process.env.CALCOM_BASE_URL?.trim() || 'https://api.cal.com/v1',
          bookingUrl: process.env.CALCOM_BOOKING_URL?.trim() || '',
        }
      : undefined,
    telegram: tgToken ? { token: tgToken, chatId: process.env.TELEGRAM_CHAT_ID?.trim() || '' } : undefined,
    slack:
      (slackBot && slackApp) || slackWebhook
        ? {
            botToken: slackBot || '',
            appToken: slackApp || '',
            channel: process.env.SLACK_CHANNEL?.trim() || '',
            webhookUrl: slackWebhook || '',
          }
        : undefined,
  };
}

export function loadAccounts(): AccountsConfig {
  const path = resolve(ROOT, 'config', 'accounts.json');
  return loadAccountsConfig(path);
}
