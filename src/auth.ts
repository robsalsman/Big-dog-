import { randomBytes, scryptSync, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { users, systemStore, type UserRow } from './db.js';

/**
 * Multi-user auth. Each account has a username + password (scrypt-hashed in the
 * shared system DB); on login the client gets an HMAC-signed session cookie that
 * encodes the user id. Each user's data lives in their own database. The FIRST
 * account created becomes the 'default' user — inheriting any existing
 * single-user data — and is the admin.
 */

const SECRET_KEY = 'auth.secret';
const MAX_AGE_MS = 30 * 86_400_000; // 30 days

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const c = scryptSync(pw, salt, 64);
  const e = Buffer.from(hash, 'hex');
  return c.length === e.length && timingSafeEqual(c, e);
}

export function anyUsers(): boolean {
  return users.count() > 0;
}

export function createAccount(username: string, password: string, email = ''): UserRow {
  const u = (username || '').trim();
  if (u.length < 3) throw new Error('Username must be at least 3 characters.');
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) throw new Error('Username can use letters, numbers, dots, dashes, underscores.');
  if ((password || '').length < 6) throw new Error('Password must be at least 6 characters.');
  if (users.byUsername(u)) throw new Error('That username is taken.');
  const first = users.count() === 0;
  const id = first ? 'default' : randomUUID().slice(0, 12); // first account inherits existing data
  const row: UserRow = { id, username: u, email: (email || '').trim(), passHash: hashPassword(password), role: first ? 'admin' : 'user', createdAt: new Date().toISOString() };
  users.create(row);
  return row;
}

export function verifyCredentials(username: string, password: string): UserRow | null {
  const row = users.byUsername(username);
  if (!row) return null;
  return checkPassword(password, row.passHash) ? row : null;
}

export function setUserPassword(userId: string, password: string): void {
  if ((password || '').length < 6) throw new Error('Password must be at least 6 characters.');
  users.setPass(userId, hashPassword(password));
}

/** Bootstrap the first admin account from env on a fresh install. */
export function seedAdminFromEnv(username?: string, password?: string): void {
  if (!password || users.count() > 0) return;
  try { createAccount(username || 'admin', password); } catch { /* ignore */ }
}

function secret(): string {
  let s = systemStore.get(SECRET_KEY);
  if (!s) { s = randomBytes(32).toString('hex'); systemStore.set(SECRET_KEY, s); }
  return s;
}

export function issueToken(userId: string): string {
  const iat = Date.now().toString();
  const payload = `${userId}.${iat}`;
  const mac = createHmac('sha256', secret()).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

/** Verify a session token; returns the userId if valid, else null. */
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, iat, mac] = parts;
  const expected = createHmac('sha256', secret()).update(`${userId}.${iat}`).digest('hex');
  const a = Buffer.from(mac!);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() - Number(iat) >= MAX_AGE_MS) return null;
  return users.byId(userId!) ? userId! : null;
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
