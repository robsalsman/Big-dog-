import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { settingsStore } from './db.js';

/**
 * Dashboard auth. A single password protects the app; on success the client
 * gets an HMAC-signed session cookie. If no password is set, the app runs open
 * (local dev) and the UI nudges you to set one. Stored hashed (scrypt) locally.
 */

const PW_KEY = 'auth.passwordHash';
const SECRET_KEY = 'auth.secret';
const MAX_AGE_MS = 30 * 86_400_000; // 30 days

export function isAuthConfigured(): boolean {
  return !!settingsStore.get(PW_KEY);
}

export function setPassword(password: string): void {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  settingsStore.set(PW_KEY, `${salt}:${hash}`);
}

/** Seed the password from env on first run (only if none is stored yet). */
export function seedPasswordFromEnv(envPassword?: string): void {
  if (envPassword && !isAuthConfigured()) setPassword(envPassword);
}

export function verifyPassword(password: string): boolean {
  const stored = settingsStore.get(PW_KEY);
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function secret(): string {
  let s = settingsStore.get(SECRET_KEY);
  if (!s) {
    s = randomBytes(32).toString('hex');
    settingsStore.set(SECRET_KEY, s);
  }
  return s;
}

export function issueToken(): string {
  const iat = Date.now().toString();
  const mac = createHmac('sha256', secret()).update(iat).digest('hex');
  return `${iat}.${mac}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [iat, mac] = token.split('.');
  if (!iat || !mac) return false;
  const expected = createHmac('sha256', secret()).update(iat).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Date.now() - Number(iat) < MAX_AGE_MS;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export const COOKIE = 'bigdog_session';
