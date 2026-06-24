import { findProspects } from './prospect.js';
import { enrichRows } from './prospect.js';
import { saveProspectAsDeal } from './prospect.js';
import { memories, contacts } from './db.js';
import { createSequence, enrollContacts, runDueEnrollments } from './sequences.js';
import { allAccounts } from './accounts.js';
import { logActivity } from './activity.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';

/**
 * Autopilot — one natural-language command runs the whole top-of-funnel:
 *   "book me 10 meetings next week with security guard company owners"
 * Big Dog parses the goal, sources leads, fills emails, researches each, builds
 * a personalized meeting-ask drip, enrolls everyone, and (in fully-automate
 * mode) sends the outreach + follow-ups itself. Booking a meeting still waits
 * for the owner's one-tap confirmation.
 */

export interface AutopilotResult {
  goal: string;
  criteria: string;
  targetMeetings: number;
  found: number;
  withEmail: number;
  researched: number;
  enrolled: number;
  sequenceId: string;
  sequenceName: string;
  mode: 'fully-automate' | 'draft-and-approve';
  firstTouches: number;
  notes: string[];
}

interface ParsedGoal {
  criteria: string;
  targetMeetings: number;
  valueProp: string;
}

async function parseGoal(goal: string, brain: BigDogBrain): Promise<ParsedGoal> {
  const fallback: ParsedGoal = {
    criteria: goal,
    targetMeetings: Number((goal.match(/(\d+)\s*(meeting|call|demo|appointment)/i) || [])[1] || 5),
    valueProp: '',
  };
  if (!brain.live) return fallback;
  try {
    const out = await brain.raw(
      `Extract a prospecting plan from this sales goal. Return JSON {"criteria","targetMeetings","valueProp"} where ` +
        `"criteria" is a crisp ideal-customer search brief (title/industry/region), "targetMeetings" is the number of meetings wanted (integer), ` +
        `and "valueProp" is one sentence on why they'd take the meeting.\n\nGOAL: ${goal}`,
      { type: 'object', additionalProperties: true, properties: { criteria: { type: 'string' }, targetMeetings: { type: 'number' }, valueProp: { type: 'string' } } },
      500,
    );
    const o = JSON.parse(extractJson(out));
    return {
      criteria: String(o.criteria || goal),
      targetMeetings: Math.max(1, Math.min(50, Number(o.targetMeetings) || fallback.targetMeetings)),
      valueProp: String(o.valueProp || ''),
    };
  } catch {
    return fallback;
  }
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  return s !== -1 && e > s ? text.slice(s, e + 1) : text.trim();
}

function meetingSequenceSteps(valueProp: string, bookingUrl: string) {
  const book = bookingUrl ? ` Offer this booking link to grab a time: ${bookingUrl}.` : ' Offer two specific time windows and ask which works.';
  const vp = valueProp ? ` Anchor on this value: ${valueProp}.` : '';
  return [
    { dayOffset: 0, subject: 'Quick question', instruction: `Warm, personalized first touch. Reference something specific about them/their company from research. Ask for a brief intro call.${vp}${book} Keep it under 5 sentences.` },
    { dayOffset: 2, subject: 're: Quick question', instruction: `Short, friendly bump. Add one concrete proof point or result relevant to their business.${book}` },
    { dayOffset: 5, subject: 'Worth 15 minutes?', instruction: `New angle — lead with an insight specific to their industry/role, then a soft ask for a short call.${book}` },
    { dayOffset: 10, subject: 'Closing the loop', instruction: `Polite break-up. Leave the door open and make it easy to say "not now". Friendly, no pressure.${book}` },
  ];
}

export async function runAutopilot(
  goal: string,
  opts: { fullyAutomate?: boolean; accountId?: string },
  brain: BigDogBrain,
  cfg: AppConfig,
): Promise<AutopilotResult> {
  const notes: string[] = [];
  const plan = await parseGoal(goal, brain);
  logActivity('autopilot', `Autopilot launched: "${goal}" (target ${plan.targetMeetings} meetings)`);

  // Source more leads than meetings wanted — not everyone replies.
  const want = Math.min(plan.targetMeetings * 3, 20);
  let prospects = await findProspects(plan.criteria, cfg, brain).catch(() => []);
  if (!prospects.length) notes.push('No leads sourced — connect Claude (web research) or widen the brief.');
  prospects = prospects.slice(0, want);

  // Fill in missing emails.
  const rows = prospects.map((p) => ({ name: p.name, company: p.company, domain: p.domain, title: p.title, email: p.email }));
  const enriched = await enrichRows(rows, brain, { verify: false, limit: want }).catch(() => []);
  const leads = enriched.filter((r) => r.email && r.confidence !== 'skipped');

  // Research each lead and stash as memory for personalization.
  let researched = 0;
  for (const r of leads.slice(0, Math.min(leads.length, 12))) {
    if (!brain.live) break;
    const brief = await brain.research(`${r.name}${r.title ? ', ' + r.title : ''}${r.company ? ' at ' + r.company : ''} (${r.domain})`).catch(() => '');
    if (brief && r.email) { memories.add(r.email, `Autopilot research: ${brief.slice(0, 500)}`); researched++; }
    if (r.email) contacts.save({ email: r.email, name: r.name, company: r.company, title: r.title });
  }

  // Build a meeting-ask drip and enroll everyone.
  const seq = createSequence(`Autopilot — ${plan.criteria.slice(0, 40)}`, meetingSequenceSteps(plan.valueProp, cfg.calcom?.bookingUrl || ''), !!opts.fullyAutomate);
  const accountId = opts.accountId || allAccounts()[0]?.id;
  const { enrolled } = enrollContacts(seq.id, leads.map((r) => ({ email: r.email, name: r.name, company: r.company })), accountId);

  // Kick off the first touches immediately.
  const firstTouches = await runDueEnrollments(brain, cfg).catch(() => 0);

  if (opts.fullyAutomate) notes.push('Fully-automate ON: outreach + follow-ups send automatically. Meeting bookings still wait for your one-tap confirm.');
  else notes.push('Draft mode: every touch is queued in Drafts for your approval.');
  if (!allAccounts().length) notes.push('No mailbox connected yet — touches are queued but can\'t send until you add one in Settings.');

  return {
    goal,
    criteria: plan.criteria,
    targetMeetings: plan.targetMeetings,
    found: prospects.length,
    withEmail: leads.length,
    researched,
    enrolled,
    sequenceId: seq.id,
    sequenceName: seq.name,
    mode: opts.fullyAutomate ? 'fully-automate' : 'draft-and-approve',
    firstTouches,
    notes,
  };
}
