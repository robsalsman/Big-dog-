import { randomUUID } from 'node:crypto';
import { drafts, memories } from './db.js';
import { enrichRows, saveProspectAsDeal } from './prospect.js';
import { logActivity } from './activity.js';
import type { BigDogBrain } from './brain.js';
import type { Draft } from './types.js';

/**
 * The campaign play — the one-shot move that ties Big Dog together: take a lead
 * list, fill in everyone's email, (optionally) research the top names, and draft
 * a personalized cold intro to each — all queued for your approval, never sent
 * silently. Optionally drops everyone into the pipeline too.
 */
export interface CampaignOptions {
  verify?: boolean; // SMTP-verify emails (slower)
  addToPipeline?: boolean; // create a deal per contact
  research?: number; // research the top N contacts (web; Claude backend)
  draft?: boolean; // draft a personalized intro per contact
}

export interface CampaignResultRow {
  name: string;
  company: string;
  email: string;
  confidence: string;
  dealId?: string;
  researched?: boolean;
  draftId?: string;
}

export interface CampaignResult {
  summary: { total: number; withEmail: number; researched: number; drafted: number; added: number };
  rows: CampaignResultRow[];
}

export async function runCampaign(
  rows: Record<string, string>[],
  brain: BigDogBrain,
  accountId: string,
  opts: CampaignOptions,
): Promise<CampaignResult> {
  const enriched = await enrichRows(rows, brain, { verify: opts.verify, limit: 60 });
  const researchCap = Math.min(opts.research ?? 0, 15);
  const draftCap = 30;

  const result: CampaignResult = {
    summary: { total: enriched.length, withEmail: 0, researched: 0, drafted: 0, added: 0 },
    rows: [],
  };

  let researched = 0;
  let drafted = 0;

  for (const r of enriched) {
    const row: CampaignResultRow = { name: r.name, company: r.company, email: r.email, confidence: r.confidence };
    const hasEmail = !!r.email && r.confidence !== 'skipped';
    if (hasEmail) result.summary.withEmail++;

    if (hasEmail && opts.addToPipeline) {
      const deal = saveProspectAsDeal({
        name: r.name, title: r.title, company: r.company, domain: r.domain, email: r.email, linkedin: '', location: '', source: 'campaign', notes: `${r.confidence} (${r.method})`,
      });
      row.dealId = deal.id;
      result.summary.added++;
    }

    // Research the top N (web-backed) and keep it as memory for the draft.
    let brief = '';
    if (hasEmail && researched < researchCap && brain.live) {
      brief = await brain.research(`${r.name}${r.title ? ', ' + r.title : ''}${r.company ? ' at ' + r.company : ''} (${r.domain})`).catch(() => '');
      if (brief && r.email) memories.add(r.email, `Campaign research: ${brief.slice(0, 400)}`);
      row.researched = true;
      researched++;
    }

    if (hasEmail && opts.draft && drafted < draftCap) {
      const memory = r.email ? memories.recall(r.email) : '';
      const intro = await brain.draftColdIntro({ name: r.name, title: r.title, company: r.company }, brief, memory);
      const draft: Draft = {
        id: randomUUID().slice(0, 16),
        accountId,
        inReplyTo: null,
        dealId: row.dealId ?? null,
        toEmails: r.email,
        subject: intro.subject,
        body: intro.body,
        rationale: `Campaign intro. ${intro.rationale}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        sentAt: null,
      };
      drafts.insert(draft);
      row.draftId = draft.id;
      drafted++;
    }

    result.rows.push(row);
  }

  result.summary.researched = researched;
  result.summary.drafted = drafted;
  logActivity('campaign', `Campaign: ${result.summary.withEmail} email(s) found, ${result.summary.added} added, ${drafted} intro(s) drafted`);
  return result;
}
