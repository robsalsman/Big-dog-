import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
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

/**
 * Pull recent mail from one account's INBOX into the local store.
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
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) return 0;
      const start = Math.max(1, total - MAX_PER_ACCOUNT + 1);

      for await (const msg of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        source: true,
      })) {
        const parsed = await simpleParser(msg.source as Buffer);
        const messageId = parsed.messageId ?? `${msg.uid}`;
        const id = stableId(account.id, messageId, msg.uid);
        if (messages.exists(id)) continue;

        const from = parsed.from?.value?.[0];
        const htmlText = typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '';
        const body = parsed.text || htmlText || '';
        const record: Message = {
          id,
          accountId: account.id,
          messageId,
          threadId: parsed.inReplyTo || messageId,
          fromName: from?.name || from?.address || 'Unknown',
          fromEmail: from?.address || '',
          toEmails: Array.isArray(parsed.to)
            ? parsed.to.map((t) => t.text).join(', ')
            : parsed.to?.text || account.email,
          subject: parsed.subject || '(no subject)',
          snippet: snippet(body),
          body,
          date: (parsed.date ?? new Date()).toISOString(),
          folder: 'INBOX',
          unread: msg.flags?.has('\\Seen') ? 0 : 1,
          dealId: null,
          priority: null,
          summary: null,
          analyzed: 0,
        };
        record.threadId = threadKey(record.subject, record.fromEmail);
        messages.upsert(record);
        added++;
      }
    } finally {
      lock.release();
    }
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
