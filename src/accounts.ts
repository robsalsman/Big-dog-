import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { loadAccounts } from './config.js';
import { mailAccountsStore } from './db.js';
import type { Account } from './types.js';

/**
 * Live view of mailboxes: those in config/accounts.json (read-only) plus any
 * added in-app (stored locally in the DB). In-app accounts win on id clash.
 */
export function fileAccounts(): Account[] {
  return loadAccounts().accounts;
}

export function fileAccountIds(): Set<string> {
  return new Set(fileAccounts().map((a) => a.id));
}

export function allAccounts(): Account[] {
  const byId = new Map<string, Account>();
  for (const a of fileAccounts()) byId.set(a.id, a);
  for (const a of mailAccountsStore.all()) byId.set(a.id, a);
  return [...byId.values()];
}

export function getAccount(id: string): Account | undefined {
  return allAccounts().find((a) => a.id === id);
}

export function saveAccount(a: Account): void {
  mailAccountsStore.set(a);
}

export function deleteAccount(id: string): void {
  mailAccountsStore.delete(id);
}

/** Test IMAP + SMTP credentials for an account. */
export async function testAccount(a: Account): Promise<{ imap: { ok: boolean; detail: string }; smtp: { ok: boolean; detail: string } }> {
  const imap = await testImap(a);
  const smtp = await testSmtp(a);
  return { imap, smtp };
}

async function testImap(a: Account): Promise<{ ok: boolean; detail: string }> {
  const client = new ImapFlow({
    host: a.imap.host,
    port: a.imap.port,
    secure: a.imap.secure,
    auth: { user: a.imap.user, pass: a.imap.pass },
    logger: false,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
  });
  try {
    await client.connect();
    await client.logout().catch(() => {});
    return { ok: true, detail: 'IMAP login OK' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function testSmtp(a: Account): Promise<{ ok: boolean; detail: string }> {
  const transport = nodemailer.createTransport({
    host: a.smtp.host,
    port: a.smtp.port,
    secure: a.smtp.secure,
    auth: { user: a.smtp.user, pass: a.smtp.pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
  });
  try {
    await transport.verify();
    return { ok: true, detail: 'SMTP login OK' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
