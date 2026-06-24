import { randomUUID } from 'node:crypto';
import { messages, deals, events, drafts, memories } from './db.js';
import { getAccount, allAccounts } from './accounts.js';
import { sendMail } from './mail/send.js';
import { recordSentMessage } from './sentmail.js';
import { zoomConfigured, createZoomMeeting } from './zoom.js';
import { logActivity } from './activity.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';
import type { Message, CalendarEvent, Draft } from './types.js';

export interface BookResult {
  ok: boolean;
  sent: boolean;
  queued?: boolean;
  when: string; // ISO
  whenLabel: string;
  join: string;
  eventId: string;
  draftId?: string;
  contactName: string;
}

/**
 * Turn an interested reply into a booked meeting: pick the time, create the
 * Zoom + calendar event, advance the deal, and send (or queue) the confirmation.
 * Shared by the dashboard "Confirm & book" button and the SMS reply flow.
 */
export async function bookFromMessage(
  m: Message,
  opts: { whenISO?: string; minutes?: number },
  brain: BigDogBrain,
  cfg: AppConfig,
): Promise<BookResult> {
  const to = m.fromEmail;
  const minutes = Number(opts.minutes ?? 30);

  // Time: explicit > read from the email > sensible default.
  let start: Date | null = opts.whenISO ? new Date(opts.whenISO) : null;
  if ((!start || isNaN(start.getTime())) && brain.live) {
    try {
      const out = await brain.raw(
        `From this email, extract the meeting time the sender proposed as a single ISO 8601 datetime (assume the next occurrence, business hours if vague). ` +
          `Return ONLY JSON {"whenISO": "..."} or {"whenISO": null} if none.\n\nDATE NOW: ${new Date().toISOString()}\n\n${m.subject}\n${m.body.slice(0, 2000)}`,
        { type: 'object', additionalProperties: false, properties: { whenISO: { type: ['string', 'null'] } }, required: ['whenISO'] },
        200,
      );
      const w = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).whenISO;
      if (w) start = new Date(w);
    } catch { /* fall through */ }
  }
  if (!start || isNaN(start.getTime())) {
    start = new Date(Date.now() + 86_400_000);
    start.setHours(15, 0, 0, 0);
  }
  const end = new Date(start.getTime() + minutes * 60_000);
  const title = `Call with ${m.fromName || to}`;

  let join = cfg.calcom?.bookingUrl || '';
  let zoomMeetingId: string | null = null;
  if (zoomConfigured()) {
    try { const z = await createZoomMeeting({ topic: title, startISO: start.toISOString(), minutes }); join = z.joinUrl; zoomMeetingId = z.meetingId; }
    catch (err) { logActivity('error', `Zoom create failed during book: ${(err as Error).message}`); }
  }

  const deal = m.dealId ? deals.get(m.dealId) ?? null : (deals.findByContact(to) ?? null);
  const evt: CalendarEvent = {
    id: randomUUID().slice(0, 16), title, start: start.toISOString(), end: end.toISOString(),
    location: join || 'Video call', attendees: to, notes: `Booked from "${m.subject}".`, dealId: deal?.id ?? null, source: 'big-dog', zoomMeetingId,
  };
  events.upsert(evt);
  messages.setMeetingReq(m.id, 0);
  messages.markRead(m.id);

  const whenLabel = start.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let subject = `Confirmed: ${title} — ${whenLabel}`;
  let body = `Hi ${m.fromName || ''},\n\nGreat — I've set us up for ${whenLabel} (${minutes} min).${join ? `\n\nJoin: ${join}` : ''}\n\nIf another time is better, just say the word.\n\n${cfg.owner.signature}`;
  if (brain.live) {
    try {
      const c = await brain.composeEmail({ to, subject, instruction: `Confirm the meeting for ${whenLabel} (${minutes} min). Friendly, brief.${join ? ` Include the join link: ${join}.` : ''} Offer to adjust the time if needed.`, memory: memories.recall(to) });
      subject = c.subject; body = c.body;
    } catch { /* keep template */ }
  }

  if (deal) deals.upsert({ ...deal, nextStep: `Meeting booked for ${whenLabel}`, lastActivity: new Date().toISOString(), updatedAt: new Date().toISOString() });

  const account = getAccount(m.accountId || allAccounts()[0]?.id || '');
  if (account) {
    try {
      await sendMail(account, { to, subject, body, inReplyTo: m.messageId });
      recordSentMessage({ accountId: account.id, fromName: account.label, fromEmail: account.email, toEmails: to, subject, body });
      logActivity('book', `Booked + confirmed ${title} for ${whenLabel}`);
      return { ok: true, sent: true, when: start.toISOString(), whenLabel, join, eventId: evt.id, contactName: m.fromName || to };
    } catch (err) {
      logActivity('error', `Confirmation send failed: ${(err as Error).message}`);
    }
  }
  const draft: Draft = {
    id: randomUUID().slice(0, 16), accountId: m.accountId || allAccounts()[0]?.id || 'demo', inReplyTo: m.messageId, dealId: deal?.id ?? null,
    toEmails: to, ccEmails: null, attachmentIds: null, subject, body, rationale: `Meeting confirmation for ${whenLabel} (queued).`, status: 'pending', createdAt: new Date().toISOString(), sentAt: null,
  };
  drafts.insert(draft);
  return { ok: true, sent: false, queued: true, when: start.toISOString(), whenLabel, join, eventId: evt.id, draftId: draft.id, contactName: m.fromName || to };
}
