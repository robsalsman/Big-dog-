import { randomUUID } from 'node:crypto';
import { messages, deals, events, memories } from './db.js';
import type { BigDogBrain } from './brain.js';
import type { Deal, CalendarEvent } from './types.js';

/**
 * Run Big Dog's triage over any new, un-analyzed mail: classify priority,
 * pull sales opportunities into the pipeline, and drop meeting requests onto
 * the calendar. This is the "works deals for you" loop.
 */
export async function triageNewMail(brain: BigDogBrain, limit = 15): Promise<number> {
  const pending = messages.unanalyzed(limit);
  let processed = 0;

  for (const m of pending) {
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

    messages.setAnalysis(m.id, analysis.priority, analysis.summary, dealId);
    processed++;
  }

  return processed;
}
