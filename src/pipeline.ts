import { randomUUID } from 'node:crypto';
import { messages, deals, events, memories, drafts, suppressed } from './db.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';
import type { AccountsConfig, Deal, CalendarEvent, Draft } from './types.js';
import { allAccounts } from './accounts.js';
import { notifyAll } from './notify.js';
import { logActivity } from './activity.js';
import { stopEnrollmentsOnReply } from './sequences.js';

const NO_REPLY = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|postmaster|@.*\.(amazonaws|sendgrid|mailchimp)/i;

/**
 * Run Big Dog's triage over any new, un-analyzed mail: classify priority,
 * pull sales opportunities into the pipeline, drop meeting requests onto the
 * calendar, and — when auto-draft is on — have a reply already waiting for any
 * hot/warm thread. This is the "works deals for you" loop.
 */
export async function triageNewMail(
  brain: BigDogBrain,
  cfg: AppConfig,
  accounts: AccountsConfig,
  limit = 15,
): Promise<number> {
  const pending = messages.unanalyzed(limit);
  let processed = 0;

  for (const m of pending) {
    // A reply ends any active drip sequence for that contact (engagement rule).
    if (m.fromEmail) stopEnrollmentsOnReply(m.fromEmail);
    const existingDeal = m.fromEmail ? deals.findByContact(m.fromEmail) ?? null : null;
    const memory = m.fromEmail ? memories.recall(m.fromEmail) : '';
    const analysis = await brain.analyze(m, existingDeal, memory);

    let dealId: string | null = existingDeal?.id ?? null;
    const nowIso = new Date().toISOString();

    // Create or advance a deal when there's a real opportunity.
    if (analysis.isSalesOpportunity && analysis.deal) {
      if (existingDeal) {
        deals.upsert({
          ...existingDeal,
          stage: analysis.deal.suggestedStage,
          value: analysis.deal.estimatedValue ?? existingDeal.value,
          nextStep: analysis.deal.nextStep,
          updatedAt: nowIso,
          lastActivity: m.date,
        });
        dealId = existingDeal.id;
      } else {
        const deal: Deal = {
          id: randomUUID().slice(0, 16),
          title: analysis.deal.title,
          contactName: analysis.deal.contactName || m.fromName,
          contactEmail: m.fromEmail,
          company: analysis.deal.company,
          stage: analysis.deal.suggestedStage,
          value: analysis.deal.estimatedValue,
          notes: '',
          nextStep: analysis.deal.nextStep,
          nextStepDue: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          lastActivity: m.date,
        };
        deals.upsert(deal);
        dealId = deal.id;
      }
    }

    // Drop meeting requests onto the unified calendar.
    if (analysis.isMeetingRequest && analysis.meeting) {
      const start = analysis.meeting.proposedStart
        ? new Date(analysis.meeting.proposedStart)
        : new Date(Date.now() + 86_400_000); // default: tomorrow if no time proposed
      const end = new Date(start.getTime() + analysis.meeting.durationMinutes * 60_000);
      const evt: CalendarEvent = {
        id: randomUUID().slice(0, 16),
        title: analysis.meeting.title,
        start: start.toISOString(),
        end: end.toISOString(),
        location: analysis.meeting.location,
        attendees: m.fromEmail,
        notes: `From email: "${m.subject}". ${analysis.meeting.proposedStart ? '' : '(Time needs confirming.)'}`,
        dealId,
        source: 'big-dog',
      };
      events.upsert(evt);
    }

    messages.setAnalysis(m.id, analysis.priority, analysis.summary, dealId, analysis.category ?? null, analysis.isMeetingRequest ? 1 : 0);

    // Real-time alert when a hot lead lands.
    if (analysis.priority === 'hot' && m.fromEmail && !NO_REPLY.test(m.fromEmail)) {
      const line = `🔥 Hot lead — ${m.fromName}: ${analysis.summary || m.subject}`;
      logActivity('hot', line);
      void notifyAll(line);
    }

    // Auto-draft: have a reply waiting for any hot/warm thread worth answering.
    if (
      cfg.autoDraft &&
      analysis.needsReply && // only draft for genuine emails (not invoices/receipts/promos)
      (analysis.priority === 'hot' || analysis.priority === 'warm') &&
      m.fromEmail &&
      !NO_REPLY.test(m.fromEmail) &&
      !suppressed.has(m.fromEmail) &&
      !drafts.existsForMessage(m.messageId)
    ) {
      try {
        const dealForDraft = dealId ? deals.get(dealId) ?? null : null;
        const { subject, body, rationale } = await brain.draftReply(m, dealForDraft, memory, messages.thread(m.threadId));
        const draft: Draft = {
          id: randomUUID().slice(0, 16),
          accountId: m.accountId || allAccounts()[0]?.id || 'demo',
          inReplyTo: m.messageId,
          dealId,
          toEmails: m.fromEmail,
          subject,
          body,
          rationale: `Auto-drafted on arrival. ${rationale}`,
          status: 'pending',
          createdAt: new Date().toISOString(),
          sentAt: null,
        };
        drafts.insert(draft);
      } catch {
        /* auto-draft is best-effort; never block triage */
      }
    }

    processed++;
  }

  if (processed > 0) logActivity('triage', `Triaged ${processed} new message(s)`);
  return processed;
}
