import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { createHash } from 'node:crypto';
import { messages } from '../db.js';
import { threadKey } from '../threading.js';
import type { Account, Message } from '../types.js';

const MAX_PER_ACCOUNT = 40;

function stableId(accountId: string, messageId: string, uid: number): string {
  return createHash('sha1').update(`${accountId}:${messageId || uid}`).digest('hex').slice(0, 16);
}

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function firstRecipient(parsed: ParsedMail): string {
  const to = parsed.to;
  if (!to) return '';
  const obj = Array.isArray(to) ? to[0] : to;
  return obj?.value?.[0]?.address || '';
}

function toText(parsed: ParsedMail, fallback: string): string {
  return Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to?.text || fallback;
}

/** Locate the account's Sent folder (name varies by provider). */
async function findSentMailbox(client: ImapFlow): Promise<string | null> {
  try {
    const list = await client.list();
    const special = list.find((m: any) => String(m.specialUse || '').toLowerCase() === '\\sent');
    if (special) return special.path;
    const named = list.find(
      (m: any) => /^sent(\s?(items|messages|mail))?$/i.test(m.name || '') || /\[gmail\]\/sent|sent[ -]?mail/i.test(m.path || ''),
    );
    return named?.path ?? null;
  } catch {
    return null;
  }
}

/** Ingest recent messages from one mailbox (INBOX or the Sent folder). */
async function ingestMailbox(client: ImapFlow, account: Account, path: string, folder: 'INBOX' | 'SENT'): Promise<number> {
  let lock;
  try {
    lock = await client.getMailboxLock(path);
  } catch {
    return 0;
  }
  let added = 0;
  const isSent = folder === 'SENT';
  try {
    const status = await client.status(path, { messages: true });
    const total = status.messages ?? 0;
    if (total === 0) return 0;
    const start = Math.max(1, total - MAX_PER_ACCOUNT + 1);

    for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true, source: true })) {
      const parsed = await simpleParser(msg.source as Buffer);
      const messageId = parsed.messageId ?? `${msg.uid}`;
      const id = stableId(account.id, messageId, msg.uid);
      if (messages.exists(id)) continue;

      const from = parsed.from?.value?.[0];
      const htmlText = typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '';
      const body = parsed.text || htmlText || '';
      // Thread by the OTHER party: the recipient for sent mail, the sender for inbox.
      const otherEmail = isSent ? firstRecipient(parsed) : from?.address || '';

      const record: Message = {
        id,
        accountId: account.id,
        messageId,
        threadId: messageId,
        fromName: from?.name || from?.address || (isSent ? account.email : 'Unknown'),
        fromEmail: from?.address || (isSent ? account.email : ''),
        toEmails: toText(parsed, account.email),
        subject: parsed.subject || '(no subject)',
        snippet: snippet(body),
        body,
        date: (parsed.date ?? new Date()).toISOString(),
        folder,
        unread: isSent ? 0 : msg.flags?.has('\\Seen') ? 0 : 1,
        dealId: null,
        priority: null,
        summary: null,
        // Don't triage our own sent mail as if it were an inbound lead.
        analyzed: isSent ? 1 : 0,
      };
      record.threadId = threadKey(record.subject, otherEmail);
      messages.upsert(record);
      added++;
    }
  } finally {
    lock.release();
  }
  return added;
}

/**
 * Pull recent mail from one account's INBOX **and** Sent folder into the local
 * store, so Big Dog shows full conversations (your replies included).
 * Returns the number of new messages ingested.
 */
export async function syncAccount(account: Account): Promise<number> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.imap.user, pass: account.imap.pass },
    logger: false,
  });

  let added = 0;
  await client.connect();
  try {
    added += await ingestMailbox(client, account, 'INBOX', 'INBOX');
    const sentPath = await findSentMailbox(client);
    if (sentPath) added += await ingestMailbox(client, account, sentPath, 'SENT');
  } finally {
    await client.logout().catch(() => {});
  }
  return added;
}

export async function syncAll(accounts: Account[]): Promise<{ account: string; added: number; error?: string }[]> {
  const results: { account: string; added: number; error?: string }[] = [];
  for (const account of accounts) {
    try {
      const added = await syncAccount(account);
      results.push({ account: account.label, added });
    } catch (err) {
      results.push({ account: account.label, added: 0, error: (err as Error).message });
    }
  }
  return results;
}
