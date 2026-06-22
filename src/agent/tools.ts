import { randomUUID } from 'node:crypto';
import { messages, deals, events, drafts, memories } from '../db.js';
import { findContactEmail } from '../prospect.js';
import type { BigDogBrain } from '../brain.js';
import type { AppConfig } from '../config.js';
import type { AccountsConfig, Deal, DealStage, Draft, CalendarEvent } from '../types.js';
import { DEAL_STAGES } from '../types.js';

export interface AgentContext {
  cfg: AppConfig;
  accounts: AccountsConfig;
  brain: BigDogBrain;
}

export interface AgentTool {
  name: string;
  description: string;
  run(args: Record<string, any>): Promise<string>;
}

function defaultAccountId(ctx: AgentContext): string {
  return ctx.accounts.accounts[0]?.id ?? 'demo';
}

function queueDraft(ctx: AgentContext, d: Partial<Draft> & { toEmails: string; subject: string; body: string }): string {
  const draft: Draft = {
    id: randomUUID().slice(0, 16),
    accountId: d.accountId ?? defaultAccountId(ctx),
    inReplyTo: d.inReplyTo ?? null,
    dealId: d.dealId ?? null,
    toEmails: d.toEmails,
    subject: d.subject,
    body: d.body,
    rationale: d.rationale ?? 'Queued by Big Dog (operator mode).',
    status: 'pending',
    createdAt: new Date().toISOString(),
    sentAt: null,
  };
  drafts.insert(draft);
  return draft.id;
}

/** The toolbox Big Dog can use when running autonomously. */
export function buildToolset(ctx: AgentContext): AgentTool[] {
  return [
    {
      name: 'list_deals',
      description: 'List all open deals (id, title, stage, value, nextStep, contactEmail).',
      async run() {
        const open = deals.all().filter((d) => d.stage !== 'won' && d.stage !== 'lost');
        return JSON.stringify(
          open.map((d) => ({ id: d.id, title: d.title, stage: d.stage, value: d.value, nextStep: d.nextStep, contactEmail: d.contactEmail })),
        );
      },
    },
    {
      name: 'get_deal',
      description: 'Get one deal by {id} or {email}.',
      async run(args) {
        const d = args.id ? deals.get(String(args.id)) : args.email ? deals.findByContact(String(args.email)) : undefined;
        return d ? JSON.stringify(d) : 'No matching deal.';
      },
    },
    {
      name: 'update_deal',
      description: 'Update a deal. args: {id, stage?, nextStep?, value?, nextStepDue?}. stage ∈ new|qualified|proposal|won|lost.',
      async run(args) {
        const d = deals.get(String(args.id));
        if (!d) return 'No such deal.';
        const stage = args.stage as DealStage | undefined;
        const updated: Deal = {
          ...d,
          stage: stage && DEAL_STAGES.includes(stage) ? stage : d.stage,
          nextStep: args.nextStep ?? d.nextStep,
          value: args.value ?? d.value,
          nextStepDue: args.nextStepDue ?? d.nextStepDue,
          updatedAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        };
        deals.upsert(updated);
        return `Updated deal "${updated.title}" → ${updated.stage}, next: ${updated.nextStep}.`;
      },
    },
    {
      name: 'create_deal',
      description: 'Create a deal. args: {title, contactName?, contactEmail?, company?, stage?, value?, nextStep?}.',
      async run(args) {
        const now = new Date().toISOString();
        const deal: Deal = {
          id: randomUUID().slice(0, 16),
          title: String(args.title ?? 'New deal'),
          contactName: String(args.contactName ?? ''),
          contactEmail: String(args.contactEmail ?? ''),
          company: String(args.company ?? ''),
          stage: (args.stage as DealStage) ?? 'new',
          value: args.value ?? null,
          notes: '',
          nextStep: String(args.nextStep ?? 'Reach out'),
          nextStepDue: args.nextStepDue ?? null,
          createdAt: now,
          updatedAt: now,
          lastActivity: now,
        };
        deals.upsert(deal);
        return `Created deal "${deal.title}" (${deal.id}).`;
      },
    },
    {
      name: 'list_messages',
      description: 'List recent inbox messages. args: {limit?}. Returns id, from, subject, priority, summary.',
      async run(args) {
        const limit = Number(args.limit ?? 15);
        return JSON.stringify(
          messages.recent(limit).map((m) => ({ id: m.id, from: m.fromName, email: m.fromEmail, subject: m.subject, priority: m.priority, summary: m.summary })),
        );
      },
    },
    {
      name: 'draft_reply',
      description: 'Draft a reply to an inbox message in the owner\'s voice, queued for approval. args: {messageId}.',
      async run(args) {
        const m = messages.get(String(args.messageId));
        if (!m) return 'No such message.';
        const deal = m.dealId ? deals.get(m.dealId) ?? null : null;
        const memory = m.fromEmail ? memories.recall(m.fromEmail) : '';
        const { subject, body, rationale } = await ctx.brain.draftReply(m, deal, memory);
        const id = queueDraft(ctx, { inReplyTo: m.messageId, dealId: m.dealId, toEmails: m.fromEmail, subject, body, rationale });
        return `Drafted reply to ${m.fromName} (draft ${id}, pending approval): "${subject}".`;
      },
    },
    {
      name: 'queue_email',
      description: 'Compose a new email, queued for the owner\'s approval (never sent silently). args: {to, subject, body, dealId?}.',
      async run(args) {
        if (!args.to || !args.body) return 'Need at least {to, body}.';
        const id = queueDraft(ctx, {
          toEmails: String(args.to),
          subject: String(args.subject ?? '(no subject)'),
          body: String(args.body),
          dealId: args.dealId ?? null,
        });
        return `Queued email to ${args.to} (draft ${id}, pending approval).`;
      },
    },
    {
      name: 'schedule_call',
      description: 'Put a call on the calendar. args: {title, attendeeEmail, whenISO?, minutes?}. If no time, defaults to tomorrow.',
      async run(args) {
        const start = args.whenISO ? new Date(String(args.whenISO)) : new Date(Date.now() + 86_400_000);
        const mins = Number(args.minutes ?? 30);
        const evt: CalendarEvent = {
          id: randomUUID().slice(0, 16),
          title: String(args.title ?? 'Call'),
          start: start.toISOString(),
          end: new Date(start.getTime() + mins * 60_000).toISOString(),
          location: ctx.cfg.calcom?.bookingUrl || 'Video call',
          attendees: String(args.attendeeEmail ?? ''),
          notes: 'Scheduled by Big Dog (operator mode).',
          dealId: null,
          source: 'big-dog',
        };
        events.upsert(evt);
        const link = ctx.cfg.calcom?.bookingUrl ? ` Share booking link: ${ctx.cfg.calcom.bookingUrl}.` : '';
        return `Scheduled "${evt.title}" for ${evt.start.slice(0, 16).replace('T', ' ')}.${link}`;
      },
    },
    {
      name: 'list_calendar',
      description: 'List upcoming calendar events.',
      async run() {
        return JSON.stringify(events.upcoming().map((e) => ({ title: e.title, start: e.start, attendees: e.attendees })));
      },
    },
    {
      name: 'recall',
      description: 'Recall what Big Dog remembers about a contact. args: {email}.',
      async run(args) {
        const r = args.email ? memories.recall(String(args.email)) : '';
        return r || 'No memories stored for that contact.';
      },
    },
    {
      name: 'remember',
      description: 'Save a durable note about a contact for future conversations. args: {email, note}.',
      async run(args) {
        if (!args.email || !args.note) return 'Need {email, note}.';
        memories.add(String(args.email), String(args.note));
        return `Noted for ${args.email}.`;
      },
    },
    {
      name: 'research_lead',
      description: 'Research a person or company on the web and return a short brief. args: {query}.',
      async run(args) {
        if (!args.query) return 'Need {query}.';
        return ctx.brain.research(String(args.query));
      },
    },
    {
      name: 'find_email',
      description: 'Find + SMTP-verify a contact\'s work email from a name and company domain. args: {name, domain}.',
      async run(args) {
        if (!args.name || !args.domain) return 'Need {name, domain}.';
        const r = await findContactEmail({ name: String(args.name), domain: String(args.domain) });
        return `${r.email} — ${r.confidence} (${r.method})`;
      },
    },
  ];
}
