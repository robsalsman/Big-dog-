import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { systemStore } from './db.js';

/**
 * Encrypted Service-Keys vault (operator/admin only).
 *
 * In managed mode the operator pastes their master third-party keys once (the
 * brain's Claude key, Twilio, Zoom) and they become the shared credentials for
 * every user — so customers bring nothing. Values are encrypted at rest with
 * AES-256-GCM and never returned raw to the client.
 *
 * The encryption key comes from BIGDOG_MASTER_SECRET (recommended — keep it out
 * of the DB). If unset, we generate and persist one so values are still
 * encrypted at rest; setting the env var is strictly stronger.
 */

function masterKey(): Buffer {
  let secret = process.env.BIGDOG_MASTER_SECRET || '';
  if (!secret) {
    secret = systemStore.get('secret.master') || '';
    if (!secret) { secret = randomBytes(32).toString('hex'); systemStore.set('secret.master', secret); }
  }
  return scryptSync(secret, 'bigdog.vault.v1', 32);
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(blob: string): string {
  const [v, ivHex, tagHex, ctHex] = blob.split(':');
  if (v !== 'v1' || !ivHex || !tagHex || !ctHex) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

/** The managed credentials the vault knows about (paste targets in the UI). */
export const VAULT_KEYS = [
  { name: 'anthropicKey', label: 'Claude API key (the brain)', secret: true },
  { name: 'twilio.accountSid', label: 'Twilio Account SID', secret: false },
  { name: 'twilio.authToken', label: 'Twilio Auth Token', secret: true },
  { name: 'twilio.fromNumber', label: 'Twilio From Number', secret: false },
  { name: 'twilio.ownerMobile', label: 'Owner mobile (alerts)', secret: false },
  { name: 'zoom.accountId', label: 'Zoom Account ID', secret: false },
  { name: 'zoom.clientId', label: 'Zoom Client ID', secret: false },
  { name: 'zoom.clientSecret', label: 'Zoom Client Secret', secret: true },
  { name: 'stripe.secretKey', label: 'Stripe Secret Key (billing)', secret: true },
  { name: 'stripe.webhookSecret', label: 'Stripe Webhook Signing Secret', secret: true },
] as const;

export const vault = {
  get(name: string): string {
    const blob = systemStore.get(`vault.${name}`);
    return blob ? decrypt(blob) : '';
  },
  set(name: string, plain: string): void {
    const v = (plain ?? '').trim();
    if (!v) return;
    systemStore.set(`vault.${name}`, encrypt(v));
  },
  has(name: string): boolean { return !!systemStore.get(`vault.${name}`); },
  clear(name: string): void { systemStore.set(`vault.${name}`, ''); },
};

function mask(v: string): string {
  if (!v) return '';
  return v.length <= 8 ? '••••' : `••••${v.slice(-4)}`;
}

/** Masked status for the admin UI — never the raw value. */
export function publicVault() {
  return VAULT_KEYS.map((k) => {
    const v = vault.get(k.name);
    return { name: k.name, label: k.label, secret: k.secret, set: !!v, hint: k.secret ? (v ? '••••set' : '') : v };
  });
}
