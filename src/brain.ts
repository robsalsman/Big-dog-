import { bigDogSystemPrompt } from './persona.js';
import type { LLMProvider } from './llm/provider.js';
import type { Message, Deal, CalendarEvent, MessageAnalysis, Owner, Prospect } from './types.js';

/**
 * The Big Dog brain. Wraps whatever LLM backend is configured (Claude or a
 * local Ollama model) for the four jobs that actually need intelligence:
 * triaging mail, drafting replies in the owner's voice, writing the morning
 * digest, and answering questions about the pipeline. If no model is live, or
 * a call fails, every method falls back to a simple deterministic version so
 * the app still runs end-to-end.
 */
export class BigDogBrain {
  private provider: LLMProvider;
  private owner: Owner;
  private system: string;

  constructor(provider: LLMProvider, owner: Owner, bookingUrl = '') {
    this.provider = provider;
    this.owner = owner;
    this.system = bigDogSystemPrompt(owner, bookingUrl);
  }

  get live(): boolean {
    return this.provider.live;
  }

  get backend(): string {
    return this.provider.label;
  }

  /** Swap the LLM backend at runtime (from the in-app Settings screen). */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  /** Raw persona-grounded completion — used by the agent loop. */
  async raw(user: string, schema?: object, maxTokens = 1200): Promise<string> {
    return this.provider.complete({ system: this.system, user, schema, maxTokens });
  }

  /** Find prospects from public web data (only when the backend has web access). */
  async prospect(criteria: string): Promise<Prospect[]> {
    if (!this.provider.webProspect) return [];
    try {
      const out = await this.provider.webProspect(criteria);
      const arr = JSON.parse(extractJsonArray(out)) as Partial<Prospect>[];
      return arr.map((p) => ({
        name: String(p.name ?? ''),
        title: String(p.title ?? ''),
        company: String(p.company ?? ''),
        domain: String(p.domain ?? ''),
        email: String(p.email ?? ''),
        linkedin: String(p.linkedin ?? ''),
        location: String(p.location ?? ''),
        source: 'web',
        notes: String(p.notes ?? ''),
      }));
    } catch {
      return [];
    }
  }

  /** Find one known (name, email) at a domain — used to learn its email format. */
  async knownEmail(domain: string): Promise<{ name: string; email: string } | null> {
    if (!this.provider.webFindEmail) return null;
    try {
      const out = await this.provider.webFindEmail(domain);
      const o = JSON.parse(extractJson(out)) as { name?: string; email?: string };
      return o.email && o.email.includes('@') ? { name: String(o.name ?? ''), email: String(o.email) } : null;
    } catch {
      return null;
    }
  }

  /** Resolve a company name to its email domain (web-backed; '' if unavailable). */
  async companyDomain(company: string): Promise<string> {
    if (!this.provider.webCompanyDomain) return '';
    try {
      const out = await this.provider.webCompanyDomain(company);
      const o = JSON.parse(extractJson(out)) as { domain?: string };
      return (o.domain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    } catch {
      return '';
    }
  }

  /** Live web research on a lead (only when the backend supports it). */
  async research(query: string): Promise<string> {
    if (this.provider.webResearch) {
      try {
        return await this.provider.webResearch(query);
      } catch (err) {
        return `Couldn't complete web research (${(err as Error).message}).`;
      }
    }
    return 'Web research needs the Claude backend (BIGDOG_PROVIDER=anthropic with a key). Local Ollama has no web access.';
  }

  // ── Triage one inbound message ────────────────────────────────────────
  async analyze(m: Message, openDeal: Deal | null, memory = ''): Promise<MessageAnalysis> {
    if (!this.provider.live) return fallbackAnalysis(m);

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
            suggestedStage: { type: 'string', enum: ['new', 'qualified', 'proposal', 'won', 'lost'] },
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
    const memoryBlock = memory ? `\n\nWhat you remember about this contact:\n${memory}\n` : '';

    try {
      const out = await this.provider.complete({
        system: this.system,
        maxTokens: 1200,
        schema,
        user:
          `Triage this inbound email like the sharp SDR you are. ${context}${memoryBlock}\n\n` +
          `From: ${m.fromName} <${m.fromEmail}>\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body.slice(0, 4000)}\n\n` +
          `Decide its priority (hot = real buying signal or time-sensitive, warm = worth a reply, cold = FYI/noise), ` +
          `a one-line summary, whether it's a sales opportunity (and the deal fields if so), and whether it's a meeting request. ` +
          `Respond with ONLY the JSON object.`,
      });
      return JSON.parse(extractJson(out)) as MessageAnalysis;
    } catch {
      return fallbackAnalysis(m);
    }
  }

  // ── Draft a reply in the owner's voice ────────────────────────────────
  async draftReply(
    m: Message,
    deal: Deal | null,
    memory = '',
  ): Promise<{ subject: string; body: string; rationale: string }> {
    if (!this.provider.live) return fallbackDraft(m, this.owner);

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
    const memoryBlock = memory ? `\n\nWhat you remember about this contact (use it to personalize):\n${memory}\n` : '';

    try {
      const out = await this.provider.complete({
        system: this.system,
        maxTokens: 1500,
        schema,
        user:
          `Write my reply to this email — as me, in my voice. ${dealLine}${memoryBlock}\n\n` +
          `From: ${m.fromName} <${m.fromEmail}>\nSubject: ${m.subject}\n\n${m.body.slice(0, 4000)}\n\n` +
          `Return the reply subject (keep "Re:" if appropriate), the full reply body (ready to send, signed off as me), ` +
          `and a one-sentence rationale for the angle you took. Respond with ONLY the JSON object.`,
      });
      return JSON.parse(extractJson(out)) as { subject: string; body: string; rationale: string };
    } catch {
      return fallbackDraft(m, this.owner);
    }
  }

  // ── Draft a follow-up nudge for a stalled deal (cadence engine) ───────
  async draftFollowUp(
    deal: Deal,
    reason: string,
    memory = '',
  ): Promise<{ subject: string; body: string; rationale: string }> {
    if (!this.provider.live) {
      return {
        subject: `Following up — ${deal.title}`,
        body: `Hi ${deal.contactName.split(' ')[0] || 'there'},\n\nCircling back on this — still keen to help you move it forward. Worth a quick call this week?\n\n${this.owner.signature}`,
        rationale: `Fallback nudge (${reason}).`,
      };
    }
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { subject: { type: 'string' }, body: { type: 'string' }, rationale: { type: 'string' } },
      required: ['subject', 'body', 'rationale'],
    };
    const memoryBlock = memory ? `\n\nWhat you remember about ${deal.contactName}:\n${memory}\n` : '';
    try {
      const out = await this.provider.complete({
        system: this.system,
        maxTokens: 1000,
        schema,
        user:
          `Write a short, warm follow-up to ${deal.contactName} at ${deal.company} — as me, in my voice. ` +
          `Why now: ${reason}. The deal is "${deal.title}" (stage: ${deal.stage}); the next step is "${deal.nextStep}".${memoryBlock}\n\n` +
          `Keep it brief and non-needy. Re-open with a reason to talk, drive to the next step. ` +
          `Respond with ONLY the JSON object {subject, body, rationale}.`,
      });
      return JSON.parse(extractJson(out)) as { subject: string; body: string; rationale: string };
    } catch {
      return {
        subject: `Following up — ${deal.title}`,
        body: `Hi ${deal.contactName.split(' ')[0] || 'there'},\n\nCircling back — still happy to help you get this over the line. Worth a quick call this week?\n\n${this.owner.signature}`,
        rationale: `Fallback nudge (${reason}).`,
      };
    }
  }

  // ── Draft a personalized cold intro (campaign play) ───────────────────
  async draftColdIntro(
    p: { name: string; title: string; company: string },
    research = '',
    memory = '',
  ): Promise<{ subject: string; body: string; rationale: string }> {
    const first = p.name.split(/\s+/)[0] || 'there';
    if (!this.provider.live) {
      return {
        subject: `Quick idea for ${p.company || 'your team'}`,
        body:
          `Hi ${first},\n\nI work with teams like ${p.company || 'yours'} and had a specific idea I think is worth 15 minutes. ` +
          `Open to a quick call next week?\n\n${this.owner.signature}\n\nP.S. Not the right time? Just reply "no" and I'll close the loop.`,
        rationale: 'Fallback cold intro (no model live).',
      };
    }
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { subject: { type: 'string' }, body: { type: 'string' }, rationale: { type: 'string' } },
      required: ['subject', 'body', 'rationale'],
    };
    const ctx =
      (research ? `\n\nWhat I found about them:\n${research}\n` : '') +
      (memory ? `\n\nWhat I remember about this contact:\n${memory}\n` : '');
    try {
      const out = await this.provider.complete({
        system: this.system,
        maxTokens: 1100,
        schema,
        user:
          `Write a SHORT personalized cold intro email to ${p.name}${p.title ? `, ${p.title}` : ''}` +
          `${p.company ? ` at ${p.company}` : ''} — as me, in my voice.${ctx}\n\n` +
          `Rules: 3–5 sentences. Open with a specific, genuine hook (use the research — no generic flattery). ` +
          `Make ONE clear, low-friction ask (a quick call). Never sound like a mass blast. Sign off as me. ` +
          `End with a one-line P.S. opt-out: 'Not the right time? Just reply "no" and I'll close the loop.' ` +
          `Respond with ONLY the JSON object {subject, body, rationale}.`,
      });
      return JSON.parse(extractJson(out)) as { subject: string; body: string; rationale: string };
    } catch {
      return {
        subject: `Quick idea for ${p.company || 'your team'}`,
        body: `Hi ${first},\n\nHad a specific idea for ${p.company || 'your team'} — worth a quick call next week?\n\n${this.owner.signature}\n\nP.S. Not the right time? Just reply "no" and I'll close the loop.`,
        rationale: 'Fallback cold intro (draft error).',
      };
    }
  }

  // ── Morning "What's up, Big Dog!?" digest ─────────────────────────────
  async digest(hotMessages: Message[], deals: Deal[], events: CalendarEvent[]): Promise<string> {
    if (!this.provider.live) return fallbackDigest(this.owner, hotMessages, deals, events);

    const dealLines = deals
      .map(
        (d) =>
          `- ${d.title} (${d.company}) — ${d.stage}, $${d.value ?? '?'}, next: ${d.nextStep}` +
          (d.nextStepDue ? ` by ${d.nextStepDue.slice(0, 10)}` : '') +
          `, last activity ${d.lastActivity.slice(0, 10)}`,
      )
      .join('\n');
    const msgLines = hotMessages.map((m) => `- [${m.priority}] ${m.fromName}: ${m.summary ?? m.subject}`).join('\n');
    const evtLines = events
      .map((e) => `- ${e.start.slice(0, 16).replace('T', ' ')} ${e.title} (${e.attendees})`)
      .join('\n');

    try {
      const out = await this.provider.complete({
        system: this.system,
        maxTokens: 1600,
        user:
          `Write my morning briefing. Open with "What's up, Big Dog!?" energy. Be punchy and decisive — ` +
          `tell me exactly what to focus on, which deals are going cold, and what you (Big Dog) are handling for me.\n\n` +
          `Use short Markdown sections. End with a "Big Dog is on it" line listing what you'll take off my plate today.\n\n` +
          `=== Today's calendar ===\n${evtLines || '(nothing scheduled)'}\n\n` +
          `=== Hot/warm threads ===\n${msgLines || '(inbox quiet)'}\n\n` +
          `=== Open deals ===\n${dealLines || '(no open deals)'}`,
      });
      return out || fallbackDigest(this.owner, hotMessages, deals, events);
    } catch {
      return fallbackDigest(this.owner, hotMessages, deals, events);
    }
  }

  // ── Chat about the pipeline ───────────────────────────────────────────
  async chat(question: string, deals: Deal[], recentMessages: Message[], events: CalendarEvent[]): Promise<string> {
    if (!this.provider.live) {
      return (
        `Big Dog's brain is offline — set BIGDOG_PROVIDER (ANTHROPIC_API_KEY for Claude, or a local Ollama model) and I'll think for real. ` +
        `Right now you've got ${deals.length} open deals and ${events.length} things on the calendar.`
      );
    }

    const snapshot =
      `Open deals:\n${deals.map((d) => `- ${d.title} (${d.company}): ${d.stage}, next: ${d.nextStep}`).join('\n') || '(none)'}\n\n` +
      `Recent threads:\n${recentMessages.slice(0, 15).map((m) => `- ${m.fromName}: ${m.summary ?? m.subject}`).join('\n') || '(none)'}\n\n` +
      `Upcoming calendar:\n${events.slice(0, 10).map((e) => `- ${e.start.slice(0, 16).replace('T', ' ')} ${e.title}`).join('\n') || '(none)'}`;

    try {
      return await this.provider.complete({
        system: this.system,
        maxTokens: 1200,
        user: `Here's the current state of my world:\n\n${snapshot}\n\n---\n\nMy question: ${question}`,
      });
    } catch (err) {
      return `Big Dog hit a snag reaching the model (${(err as Error).message}). Check your provider is up.`;
    }
  }
}

/** Pull a JSON array out of a model response that may wrap it in prose/fences. */
function extractJsonArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start !== -1 && end > start) return body.slice(start, end + 1);
  return '[]';
}

/** Pull a JSON object out of a model response that may wrap it in prose/fences. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

// ── Deterministic fallbacks (used when no model is live) ─────────────────
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
    rationale: 'Template fallback (no model live): warm open, drives to a call.',
  };
}

function fallbackDigest(owner: Owner, msgs: Message[], deals: Deal[], events: CalendarEvent[]): string {
  return (
    `## What's up, Big Dog!? 🐕\n\n` +
    `Brain's offline (no model live) so here's the raw rundown for ${owner.name}:\n\n` +
    `**Calendar:** ${events.length} item(s) coming up.\n\n` +
    `**Threads needing you:** ${msgs.length}.\n\n` +
    `**Open deals:** ${deals.length}.\n\n` +
    `_Set BIGDOG_PROVIDER (Claude key or local Ollama) to get the real Big Dog briefing._`
  );
}
