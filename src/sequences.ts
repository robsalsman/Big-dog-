import { randomUUID } from 'node:crypto';
import { sequences, enrollments, drafts, messages, memories, suppressed, contacts } from './db.js';
import { allAccounts, getAccount } from './accounts.js';
import { sendMail } from './mail/send.js';
import { recordSentMessage } from './sentmail.js';
import { logActivity } from './activity.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';
import type { Sequence, Enrollment, Draft } from './types.js';

/**
 * Drip-sequence engine — the multi-touch follow-up campaigns that complement
 * Big Dog's one-shot outreach. Modeled on open-source engagement platforms
 * (Dittofeed journeys, Parcelvoy campaigns): a Sequence is an ordered set of
 * timed steps; contacts are *enrolled*; a background worker advances each
 * enrollment, personalizing every touch in the owner's voice. Engagement rules
 * stop the sequence automatically when a contact replies or opts out.
 */

const DAY = 86_400_000;

/** A sensible default cold-outreach drip the user can edit. */
export const DEFAULT_SEQUENCE_STEPS = [
  { dayOffset: 0, subject: 'Quick intro', instruction: 'Warm, concise first-touch intro. One specific reason to talk and a low-friction ask for a short call. No hard sell.' },
  { dayOffset: 3, subject: 're: Quick intro', instruction: 'Short, friendly bump on the first email. Add one concrete value point or proof. Keep it under 4 sentences.' },
  { dayOffset: 7, subject: 'Worth a quick look?', instruction: 'Different angle than before — lead with a relevant insight or result for their role/company, then a soft ask.' },
  { dayOffset: 14, subject: 'Closing the loop', instruction: 'Polite break-up email. Acknowledge timing may be off, leave the door open, make it easy to say "not now". Friendly, no guilt.' },
];

export function createSequence(name: string, steps = DEFAULT_SEQUENCE_STEPS, autoSend = false): Sequence {
  const seq: Sequence = { id: randomUUID().slice(0, 12), name: name || 'New sequence', steps, active: true, autoSend, createdAt: new Date().toISOString() };
  sequences.upsert(seq);
  return seq;
}

export interface EnrollInput {
  email: string;
  name?: string;
  company?: string;
  dealId?: string | null;
}

/** Enroll contacts into a sequence. Skips opt-outs and already-active enrollments. */
export function enrollContacts(sequenceId: string, people: EnrollInput[], accountId?: string): { enrolled: number; skipped: number } {
  const seq = sequences.get(sequenceId);
  if (!seq) throw new Error('No such sequence.');
  const acct = accountId || allAccounts()[0]?.id || 'demo';
  const now = Date.now();
  let enrolled = 0;
  let skipped = 0;
  for (const p of people) {
    const email = (p.email || '').toLowerCase().trim();
    if (!email.includes('@') || suppressed.has(email) || enrollments.existsActive(sequenceId, email)) { skipped++; continue; }
    const startedAt = new Date(now).toISOString();
    const firstOffset = seq.steps[0]?.dayOffset ?? 0;
    const e: Enrollment = {
      id: randomUUID().slice(0, 16),
      sequenceId,
      email,
      name: p.name || contacts.get(email)?.name || '',
      company: p.company || contacts.get(email)?.company || '',
      accountId: acct,
      dealId: p.dealId ?? null,
      step: 0,
      status: 'active',
      startedAt,
      nextRunAt: new Date(now + firstOffset * DAY).toISOString(),
      lastError: null,
    };
    enrollments.add(e);
    enrolled++;
  }
  if (enrolled) logActivity('sequence', `Enrolled ${enrolled} contact(s) into "${seq.name}"`);
  return { enrolled, skipped };
}

/** Stop a contact's active enrollments because they replied. */
export function stopEnrollmentsOnReply(email: string): void {
  for (const e of enrollments.activeForEmail(email)) {
    enrollments.update({ ...e, status: 'replied', nextRunAt: e.nextRunAt, lastError: null });
    logActivity('sequence', `Stopped sequence for ${email} — they replied`);
  }
}

function hasRepliedSince(email: string, sinceIso: string): boolean {
  return messages
    .forContact(email, 50)
    .some((m) => m.folder !== 'SENT' && (m.fromEmail || '').toLowerCase() === email.toLowerCase() && m.date > sinceIso);
}

/**
 * Advance every enrollment whose next step is due: personalize the email, queue
 * it (or send it in auto mode), then schedule the following step. Returns how
 * many touches it produced.
 */
export async function runDueEnrollments(brain: BigDogBrain, cfg: AppConfig): Promise<number> {
  const nowIso = new Date().toISOString();
  const due = enrollments.due(nowIso);
  let produced = 0;

  for (const e of due) {
    const seq = sequences.get(e.sequenceId);
    if (!seq || !seq.active) { enrollments.update({ ...e, status: 'stopped', lastError: 'sequence inactive' }); continue; }

    // Engagement stop-rules: opted out, or they replied since enrollment.
    if (suppressed.has(e.email)) { enrollments.update({ ...e, status: 'stopped', lastError: 'opted out' }); continue; }
    if (hasRepliedSince(e.email, e.startedAt)) { enrollments.update({ ...e, status: 'replied', lastError: null }); continue; }

    const step = seq.steps[e.step];
    if (!step) { enrollments.update({ ...e, status: 'completed', lastError: null }); continue; }

    try {
      const memory = memories.recall(e.email);
      const context = `Sequence "${seq.name}", touch ${e.step + 1} of ${seq.steps.length}. Recipient: ${e.name || e.email}${e.company ? ` at ${e.company}` : ''}.`;
      const composed = await brain.composeEmail({ to: e.email, subject: step.subject, instruction: `${step.instruction}\n\n${context}`, memory });
      const account = getAccount(e.accountId);

      if ((seq.autoSend || cfg.sendMode === 'auto') && account) {
        await sendMail(account, { to: e.email, subject: composed.subject, body: composed.body });
        recordSentMessage({ accountId: account.id, fromName: account.label, fromEmail: account.email, toEmails: e.email, subject: composed.subject, body: composed.body });
        logActivity('sequence', `Sent "${seq.name}" touch ${e.step + 1} to ${e.email}`);
      } else {
        const draft: Draft = {
          id: randomUUID().slice(0, 16), accountId: e.accountId, inReplyTo: null, dealId: e.dealId,
          toEmails: e.email, ccEmails: null, subject: composed.subject, body: composed.body,
          rationale: `Drip "${seq.name}" — touch ${e.step + 1}/${seq.steps.length} (queued for approval).`,
          status: 'pending', createdAt: new Date().toISOString(), sentAt: null,
        };
        drafts.insert(draft);
        logActivity('sequence', `Queued "${seq.name}" touch ${e.step + 1} for ${e.email}`);
      }
      produced++;

      // Schedule the next step (absolute cadence from enrollment), or complete.
      const nextIdx = e.step + 1;
      const next = seq.steps[nextIdx];
      if (next) {
        const at = new Date(new Date(e.startedAt).getTime() + next.dayOffset * DAY).toISOString();
        enrollments.update({ ...e, step: nextIdx, nextRunAt: at, lastError: null });
      } else {
        enrollments.update({ ...e, step: nextIdx, status: 'completed', lastError: null });
      }
    } catch (err) {
      // Back off a day on error so a transient failure doesn't spin.
      enrollments.update({ ...e, nextRunAt: new Date(Date.now() + DAY).toISOString(), lastError: (err as Error).message });
    }
  }
  if (produced) logActivity('sequence', `Drip worker produced ${produced} touch(es)`);
  return produced;
}
