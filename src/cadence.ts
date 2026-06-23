import { randomUUID } from 'node:crypto';
import { deals, drafts, memories } from './db.js';
import type { AgentContext } from './agent/tools.js';
import type { Draft } from './types.js';
import { allAccounts } from './accounts.js';
import { logActivity } from './activity.js';

/**
 * The follow-up cadence engine. Sweeps open deals and, for any that have gone
 * quiet or slipped past their next-step date, drafts a follow-up nudge in the
 * owner's voice — queued for approval. Deals stop going cold silently.
 */
export async function runCadenceSweep(ctx: AgentContext): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const staleMs = ctx.cfg.cadenceStaleDays * 86_400_000;
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const accountId = allAccounts()[0]?.id ?? 'demo';
  const created: string[] = [];

  for (const d of deals.all()) {
    if (d.stage === 'won' || d.stage === 'lost' || !d.contactEmail) continue;

    const overdue = !!d.nextStepDue && d.nextStepDue < today;
    const stale = Date.now() - new Date(d.lastActivity).getTime() > staleMs;
    if (!overdue && !stale) continue;

    // Don't pile up nudges — skip if we already drafted one for this deal recently.
    if (drafts.recentForDeal(d.id, twoDaysAgo).length > 0) continue;

    const reason = overdue
      ? `the next step "${d.nextStep}" is past due`
      : `no activity in ${ctx.cfg.cadenceStaleDays}+ days`;
    const memory = memories.recall(d.contactEmail);
    const { subject, body, rationale } = await ctx.brain.draftFollowUp(d, reason, memory);

    const draft: Draft = {
      id: randomUUID().slice(0, 16),
      accountId,
      inReplyTo: null,
      dealId: d.id,
      toEmails: d.contactEmail,
      subject,
      body,
      rationale,
      status: 'pending',
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    drafts.insert(draft);
    created.push(`${d.title} — ${reason}`);
  }

  if (created.length) logActivity('cadence', `Queued ${created.length} follow-up(s) for stalled deals`);
  return created;
}
