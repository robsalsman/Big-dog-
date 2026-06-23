import { drafts } from './db.js';
import { getAccount, allAccounts } from './accounts.js';
import { sendMail } from './mail/send.js';
import { recordSentMessage } from './sentmail.js';
import { logActivity } from './activity.js';

/** Send any pending drafts whose scheduled time has arrived. Returns how many. */
export async function sendDueDrafts(): Promise<number> {
  const due = drafts.due(new Date().toISOString());
  for (const d of due) {
    const account = getAccount(d.accountId);
    try {
      if (account) {
        await sendMail(account, { to: d.toEmails, subject: d.subject, body: d.body, inReplyTo: d.inReplyTo });
        recordSentMessage({ accountId: account.id, fromName: account.label, fromEmail: account.email, toEmails: d.toEmails, subject: d.subject, body: d.body });
      } else {
        const from = allAccounts()[0];
        recordSentMessage({ accountId: d.accountId, fromName: from?.label ?? 'Me', fromEmail: from?.email ?? 'me', toEmails: d.toEmails, subject: d.subject, body: d.body });
      }
      drafts.setStatus(d.id, 'sent', new Date().toISOString());
      logActivity('send', `Sent scheduled email to ${d.toEmails}: "${d.subject}"`);
    } catch (err) {
      logActivity('error', `Scheduled send to ${d.toEmails} failed: ${(err as Error).message}`);
    }
  }
  return due.length;
}
