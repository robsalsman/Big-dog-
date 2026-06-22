import Anthropic from '@anthropic-ai/sdk';
import { bigDogSystemPrompt } from './persona.js';
import type { AppConfig } from './config.js';
import type { Message, Deal, CalendarEvent, MessageAnalysis, Owner } from './types.js';

/**
 * The Big Dog brain. Wraps Claude (claude-opus-4-8) for the four jobs that
 * actually need intelligence: triaging mail, drafting replies in the owner's
 * voice, writing the morning digest, and answering questions about the
 * pipeline. If no API key is configured, every method falls back to a simple
 * deterministic version so the app still runs end-to-end.
 */
export class BigDogBrain {
  private client: Anthropic | null;
  private model: string;
  private owner: Owner;
  private system: string;

  constructor(cfg: AppConfig) {
    this.client = cfg.anthropicKey ? new Anthropic({ apiKey: cfg.anthropicKey }) : null;
    this.model = cfg.model;
    this.owner = cfg.owner;
    this.system = bigDogSystemPrompt(cfg.owner);
  }

  get live(): boolean {
    return this.client !== null;
  }

  /** Pull the first text block out of a response. */
  private text(message: Anthropic.Message): string {
    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  // ── Triage one inbound message ────────────────────────────────────────
  async analyze(m: Message, openDeal: Deal | null): Promise<MessageAnalysis> {
    if (!this.client) return fallbackAnalysis(m);

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        priority: { type: 'string', enum: ['hot', 'warm', 'cold'] },
        summary: { type: 'string' },
        isSalesOpportunity: { type: 'boolean' },
        deal: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            company: { type: 'string' },
            contactName: { type: 'string' },
            suggestedStage: {
              type: 'string',
              enum: ['new', 'qualified', 'proposal', 'won', 'lost'],
            },
            estimatedValue: { type: ['number', 'null'] },
            nextStep: { type: 'string' },
          },
          required: ['title', 'company', 'contactName', 'suggestedStage', 'estimatedValue', 'nextStep'],
        },
        isMeetingRequest: { type: 'boolean' },
        meeting: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            proposedStart: { type: ['string', 'null'] },
            durationMinutes: { type: 'number' },
            location: { type: 'string' },
          },
          required: ['title', 'proposedStart', 'durationMinutes', 'location'],
        },
      },
      required: ['priority', 'summary', 'isSalesOpportunity', 'isMeetingRequest'],
    };

    const context = openDeal
      ? `There is already an OPEN deal with this contact: "${openDeal.title}" (stage: ${openDeal.stage}, next step: ${openDeal.nextStep}).`
      : 'No existing open deal with this contact.';

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1200,
      thinking: { type: 'adaptive' },
      system: this.system,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [
        {
          role: 'user',
          content:
            `Triage this inbound email like the sharp SDR you are. ${context}\n\n` +
            `From: ${m.fromName} <${m.fromEmail}>\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body.slice(0, 4000)}\n\n` +
            `Decide its priority (hot = real buying signal or time-sensitive, warm = worth a reply, cold = FYI/noise), ` +
            `a one-line summary, whether it's a sales opportunity (and the deal fields if so), and whether it's a meeting request.`,
        },
      ],
    });

    try {
      return JSON.parse(this.text(res)) as MessageAnalysis;
    } catch {
      return fallbackAnalysis(m);
    }
  }

  // ── Draft a reply in the owner's voice ────────────────────────────────
  async draftReply(
    m: Message,
    deal: Deal | null,
  ): Promise<{ subject: string; body: string; rationale: string }> {
    if (!this.client) return fallbackDraft(m, this.owner);

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['subject', 'body', 'rationale'],
    };

    const dealLine = deal
      ? `This ties to the deal "${deal.title}" (stage: ${deal.stage}). The agreed next step is: ${deal.nextStep}.`
      : 'No deal is open with this contact yet — qualify and drive toward a next step.';

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      thinking: { type: 'adaptive' },
      system: this.system,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [
        {
          role: 'user',
          content:
            `Write my reply to this email — as me, in my voice. ${dealLine}\n\n` +
            `From: ${m.fromName} <${m.fromEmail}>\nSubject: ${m.subject}\n\n${m.body.slice(0, 4000)}\n\n` +
            `Return the reply subject (keep "Re:" if appropriate), the full reply body (ready to send, signed off as me), ` +
            `and a one-sentence rationale for the angle you took.`,
        },
      ],
    });

    try {
      return JSON.parse(this.text(res)) as { subject: string; body: string; rationale: string };
    } catch {
      return fallbackDraft(m, this.owner);
    }
  }

  // ── Morning "What's up, Big Dog!?" digest ─────────────────────────────
  async digest(
    hotMessages: Message[],
    deals: Deal[],
    events: CalendarEvent[],
  ): Promise<string> {
    if (!this.client) return fallbackDigest(this.owner, hotMessages, deals, events);

    const dealLines = deals
      .map(
        (d) =>
          `- ${d.title} (${d.company}) — ${d.stage}, $${d.value ?? '?'}, next: ${d.nextStep}` +
          (d.nextStepDue ? ` by ${d.nextStepDue.slice(0, 10)}` : '') +
          `, last activity ${d.lastActivity.slice(0, 10)}`,
      )
      .join('\n');
    const msgLines = hotMessages
      .map((m) => `- [${m.priority}] ${m.fromName}: ${m.summary ?? m.subject}`)
      .join('\n');
    const evtLines = events
      .map((e) => `- ${e.start.slice(0, 16).replace('T', ' ')} ${e.title} (${e.attendees})`)
      .join('\n');

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1600,
      thinking: { type: 'adaptive' },
      system: this.system,
      messages: [
        {
          role: 'user',
          content:
            `Write my morning briefing. Open with "What's up, Big Dog!?" energy. Be punchy and decisive — ` +
            `tell me exactly what to focus on, which deals are going cold, and what you (Big Dog) are handling for me.\n\n` +
            `Use short Markdown sections. End with a "Big Dog is on it" line listing what you'll take off my plate today.\n\n` +
            `=== Today's calendar ===\n${evtLines || '(nothing scheduled)'}\n\n` +
            `=== Hot/warm threads ===\n${msgLines || '(inbox quiet)'}\n\n` +
            `=== Open deals ===\n${dealLines || '(no open deals)'}`,
        },
      ],
    });
    return this.text(res);
  }

  // ── Chat about the pipeline ───────────────────────────────────────────
  async chat(
    question: string,
    deals: Deal[],
    recentMessages: Message[],
    events: CalendarEvent[],
  ): Promise<string> {
    if (!this.client) {
      return `Big Dog's brain is offline — add ANTHROPIC_API_KEY to .env and I'll think for real. ` +
        `Right now you've got ${deals.length} open deals and ${events.length} things on the calendar.`;
    }

    const snapshot =
      `Open deals:\n${deals.map((d) => `- ${d.title} (${d.company}): ${d.stage}, next: ${d.nextStep}`).join('\n') || '(none)'}\n\n` +
      `Recent threads:\n${recentMessages.slice(0, 15).map((m) => `- ${m.fromName}: ${m.summary ?? m.subject}`).join('\n') || '(none)'}\n\n` +
      `Upcoming calendar:\n${events.slice(0, 10).map((e) => `- ${e.start.slice(0, 16).replace('T', ' ')} ${e.title}`).join('\n') || '(none)'}`;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1200,
      thinking: { type: 'adaptive' },
      system: this.system,
      messages: [
        {
          role: 'user',
          content: `Here's the current state of my world:\n\n${snapshot}\n\n---\n\nMy question: ${question}`,
        },
      ],
    });
    return this.text(res);
  }
}

// ── Deterministic fallbacks (used when no API key is set) ────────────────
function fallbackAnalysis(m: Message): MessageAnalysis {
  const text = `${m.subject} ${m.body}`.toLowerCase();
  const meeting = /\b(meet|call|demo|calendar|available|schedule|zoom|sync)\b/.test(text);
  const buying = /\b(pricing|quote|proposal|interested|budget|contract|buy|purchase|trial)\b/.test(text);
  return {
    priority: buying ? 'hot' : meeting ? 'warm' : 'cold',
    summary: m.subject || `Message from ${m.fromName}`,
    isSalesOpportunity: buying,
    deal: buying
      ? {
          title: m.subject || `Opportunity — ${m.fromName}`,
          company: m.fromEmail.split('@')[1] ?? '',
          contactName: m.fromName,
          suggestedStage: 'new',
          estimatedValue: null,
          nextStep: 'Reply and qualify',
        }
      : undefined,
    isMeetingRequest: meeting,
    meeting: meeting
      ? { title: `Call with ${m.fromName}`, proposedStart: null, durationMinutes: 30, location: 'Video call' }
      : undefined,
  };
}

function fallbackDraft(m: Message, owner: Owner): { subject: string; body: string; rationale: string } {
  const subject = m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`;
  const first = m.fromName.split(' ')[0] || 'there';
  return {
    subject,
    body:
      `Hi ${first},\n\nThanks for reaching out — good to connect. ` +
      `Happy to dig in on this. What does the next week look like for a quick call so I can get you exactly what you need?\n\n` +
      `${owner.signature}`,
    rationale: 'Template fallback (no API key): warm open, drives to a call.',
  };
}

function fallbackDigest(owner: Owner, msgs: Message[], deals: Deal[], events: CalendarEvent[]): string {
  return (
    `## What's up, Big Dog!? 🐕\n\n` +
    `Brain's offline (no API key) so here's the raw rundown for ${owner.name}:\n\n` +
    `**Calendar:** ${events.length} item(s) coming up.\n\n` +
    `**Threads needing you:** ${msgs.length}.\n\n` +
    `**Open deals:** ${deals.length}.\n\n` +
    `_Add ANTHROPIC_API_KEY to .env to get the real Big Dog briefing._`
  );
}
