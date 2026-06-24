import { randomUUID } from 'node:crypto';
import { messages, drafts, deals, events, memories } from './db.js';
import { bookFromMessage } from './booking.js';
import { generateDigest } from './digest.js';
import { getAccount, allAccounts } from './accounts.js';
import { sendMail } from './mail/send.js';
import { recordSentMessage } from './sentmail.js';
import { logActivity } from './activity.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';
import type { Draft } from './types.js';

const HELP = 'Text me: YES (book top of queue) · a time · NO (skip) · DRAFT (reply to newest lead) · SEND (send newest draft) · STATUS · BRIEF · HELP. 🐕';

/**
 * Run the whole business from your phone. Parses an owner SMS into an action and
 * returns the reply text. Gated to the owner's number by the caller.
 */
export async function handleOwnerSms(body: string, brain: BigDogBrain, cfg: AppConfig): Promise<string> {
  const lc = body.toLowerCase().trim();
  if (!lc || /^(help|commands|\?|menu)$/.test(lc)) return HELP;

  // Status snapshot.
  if (/^(status|recap|summary|stats)\b/.test(lc)) {
    const ready = messages.meetingRequests().length;
    const pend = drafts.pending().length;
    const today = new Date().toISOString().slice(0, 10);
    const todays = events.all().filter((e) => e.start.slice(0, 10) === today).length;
    const open = deals.all().filter((d) => d.stage !== 'won' && d.stage !== 'lost').length;
    return `📊 ${ready} ready to book · ${pend} draft(s) pending · ${todays} meeting(s) today · ${open} open deal(s). 🐕`;
  }

  // Morning brief on demand.
  if (/^(brief|digest|morning|update)\b/.test(lc)) {
    try { return (await generateDigest(brain)).replace(/\n{2,}/g, '\n').slice(0, 1400); }
    catch { return "Couldn't build the brief right now."; }
  }

  // Draft a reply to the newest lead that wants one.
  if (/^draft\b/.test(lc)) {
    const target = messages.recent(50).find((m) => m.category === 'reply' && (m.priority === 'hot' || m.priority === 'warm') && !drafts.existsForMessage(m.messageId));
    if (!target) return 'No fresh leads needing a reply right now.';
    try {
      const deal = target.dealId ? deals.get(target.dealId) ?? null : null;
      const { subject, body: b, rationale } = await brain.draftReply(target, deal, memories.recall(target.fromEmail), messages.thread(target.threadId));
      const d: Draft = {
        id: randomUUID().slice(0, 16), accountId: target.accountId, inReplyTo: target.messageId, dealId: target.dealId,
        toEmails: target.fromEmail, ccEmails: null, attachmentIds: null, subject, body: b, rationale, status: 'pending', createdAt: new Date().toISOString(), sentAt: null,
      };
      drafts.insert(d);
      logActivity('draft', `Drafted reply to ${target.fromName} (via SMS)`);
      return `✍ Drafted a reply to ${target.fromName}: "${subject}". Reply SEND to send it, or review in the app.`;
    } catch (err) {
      return `Couldn't draft that: ${(err as Error).message}`;
    }
  }

  // Send the newest pending draft.
  if (/^send\b/.test(lc)) {
    const d = drafts.pending()[0];
    if (!d) return 'No drafts waiting to send.';
    const account = getAccount(d.accountId) || allAccounts()[0];
    if (!account) return 'No mailbox connected to send from. Add one in Settings.';
    try {
      await sendMail(account, { to: d.toEmails, cc: d.ccEmails ?? null, subject: d.subject, body: d.body, inReplyTo: d.inReplyTo });
      drafts.setStatus(d.id, 'sent', new Date().toISOString());
      recordSentMessage({ accountId: account.id, fromName: account.label, fromEmail: account.email, toEmails: d.toEmails, subject: d.subject, body: d.body });
      logActivity('send', `Sent draft to ${d.toEmails} (via SMS)`);
      const left = drafts.pending().length;
      return `✅ Sent to ${d.toEmails}: "${d.subject}".${left ? ` ${left} draft(s) left — reply SEND for the next.` : ' 🐕'}`;
    } catch (err) {
      return `Send failed: ${(err as Error).message}`;
    }
  }

  // Default: the booking flow on the Ready-to-book queue.
  const queue = messages.meetingRequests();
  if (/^(no|skip|n|not now|pass)\b/.test(lc)) {
    if (queue[0]) { messages.setMeetingReq(queue[0].id, 0); const left = messages.meetingRequests(); return `Skipped ${queue[0].fromName || 'that one'}.${left[0] ? ` Next: ${left[0].fromName || left[0].fromEmail}. Reply YES.` : ' Queue clear. 🐕'}`; }
    return 'Nothing pending to skip.';
  }
  const target = queue[0];
  if (!target) return `Nothing waiting in your Ready-to-book queue. ${HELP}`;

  let whenISO: string | undefined;
  const isYes = /^(y|yes|yep|yeah|ok|okay|book|confirm|sure|do it|go)\b/.test(lc);
  if (!isYes && brain.live) {
    try {
      const out = await brain.raw(
        `Parse a meeting time from "${body}" as a single ISO 8601 datetime (next occurrence; business hours if vague). Return ONLY JSON {"whenISO":"..."} or {"whenISO":null}. NOW: ${new Date().toISOString()}`,
        { type: 'object', additionalProperties: false, properties: { whenISO: { type: ['string', 'null'] } }, required: ['whenISO'] }, 150,
      );
      const w = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).whenISO;
      if (w) whenISO = w; else if (!isYes) return `Didn't catch a command. ${HELP}`;
    } catch { /* treat as yes */ }
  }
  try {
    const r = await bookFromMessage(target, { whenISO }, brain, cfg);
    const next = messages.meetingRequests()[0];
    return `✅ Booked ${r.contactName} for ${r.whenLabel}${r.join ? ' (Zoom + invite sent)' : r.sent ? ' (invite sent)' : ' (confirmation queued)'}.${next ? ` Next: ${next.fromName || next.fromEmail}. Reply YES.` : ' Queue clear. 🐕'}`;
  } catch (err) {
    return `Couldn't book that: ${(err as Error).message}`;
  }
}
