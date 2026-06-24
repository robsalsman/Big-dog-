import nodemailer from 'nodemailer';
import type { Account } from '../types.js';

/**
 * Send an email through an account's SMTP server. Big Dog uses this to fire
 * off the replies it drafts in your voice — once you approve them (or auto,
 * if you flip BIGDOG_SEND_MODE=auto).
 */
export async function sendMail(
  account: Account,
  opts: { to: string; cc?: string | null; subject: string; body: string; inReplyTo?: string | null; attachments?: { filename: string; path: string; contentType: string }[] },
): Promise<{ messageId: string }> {
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.smtp.user, pass: account.smtp.pass },
  });

  const info = await transport.sendMail({
    from: `"${account.label}" <${account.email}>`,
    to: opts.to,
    cc: opts.cc || undefined,
    subject: opts.subject,
    text: opts.body,
    attachments: opts.attachments && opts.attachments.length ? opts.attachments : undefined,
    inReplyTo: opts.inReplyTo ?? undefined,
    references: opts.inReplyTo ?? undefined,
  });

  return { messageId: info.messageId };
}
