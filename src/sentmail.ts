import { randomUUID } from 'node:crypto';
import { messages, contacts } from './db.js';
import { threadKey } from './threading.js';

/**
 * Record an email we sent as a message in the SENT folder, threaded with the
 * conversation it belongs to — so the dashboard shows both sides and the
 * drafter has the full back-and-forth as context.
 */
export function recordSentMessage(opts: {
  accountId: string;
  fromName: string;
  fromEmail: string;
  toEmails: string;
  subject: string;
  body: string;
}): void {
  const id = randomUUID().slice(0, 16);
  messages.upsert({
    id,
    accountId: opts.accountId,
    messageId: `<sent-${id}@bigdog>`,
    threadId: threadKey(opts.subject, opts.toEmails),
    fromName: opts.fromName,
    fromEmail: opts.fromEmail,
    toEmails: opts.toEmails,
    subject: opts.subject,
    snippet: opts.body.replace(/\s+/g, ' ').trim().slice(0, 200),
    body: opts.body,
    date: new Date().toISOString(),
    folder: 'SENT',
    unread: 0,
    dealId: null,
    priority: null,
    summary: 'Sent by you',
    analyzed: 1,
  });
  for (const e of opts.toEmails.split(/[,;]/)) contacts.seen(e.trim());
}
