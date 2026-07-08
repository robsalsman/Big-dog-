import Anthropic from '@anthropic-ai/sdk';
import { meterLlm } from '../economy/meter.js';
import { assertBudget } from '../economy/budget.js';

/**
 * A pluggable LLM backend. Big Dog's brain talks to one of these, so the same
 * agent runs on Claude (best quality) or a fully local Ollama model (zero API
 * cost) — or neither, in which case the brain uses deterministic fallbacks.
 */
export interface LLMProvider {
  /** Is a real model available? If false, the brain uses simple fallbacks. */
  readonly live: boolean;
  /** Human-readable backend label, e.g. "claude-opus-4-8" or "ollama:llama3.1". */
  readonly label: string;
  /** Run one completion. If `schema` is given, the model must return JSON matching it. */
  complete(opts: { system: string; user: string; maxTokens?: number; schema?: object }): Promise<string>;
  /** Optional startup reachability check (used for nicer logs). */
  ping?(): Promise<boolean>;
  /** Optional live web research (lead enrichment). Only backends with web access implement it. */
  webResearch?(query: string): Promise<string>;
  /** Optional web prospecting — find leads matching criteria, returns a JSON array string. */
  webProspect?(criteria: string): Promise<string>;
  /** Optional — find one known (name, email) at a domain to learn its email format. */
  webFindEmail?(domain: string): Promise<string>;
  /** Optional — resolve a company name to its primary web/email domain. */
  webCompanyDomain?(company: string): Promise<string>;
}

// ── Claude ────────────────────────────────────────────────────────────────
export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;
  readonly live = true;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  get label(): string {
    return this.model;
  }

  /** Record token + web-search usage against the current user for billing. */
  private meter(res: Anthropic.Message): void {
    const u = (res as unknown as { usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } } }).usage;
    meterLlm({
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      webSearches: u?.server_tool_use?.web_search_requests ?? 0,
      model: this.model,
    });
  }

  async complete(opts: { system: string; user: string; maxTokens?: number; schema?: object }): Promise<string> {
    assertBudget();
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1200,
      thinking: { type: 'adaptive' },
      system: opts.system,
      ...(opts.schema ? { output_config: { format: { type: 'json_schema', schema: opts.schema } } } : {}),
      messages: [{ role: 'user', content: opts.user }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    this.meter(res);

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webResearch(query: string): Promise<string> {
    assertBudget();
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content:
            `Research this sales lead on the web and give me a tight brief: who they are, what the company does, ` +
            `recent news or funding, the person's role, and one specific angle to open a conversation with. ` +
            `Keep it under 200 words. Lead: ${query}`,
        },
      ],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    this.meter(res);

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webProspect(criteria: string): Promise<string> {
    assertBudget();
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 3000,
      messages: [
        {
          role: 'user',
          content:
            `You are an elite B2B prospect researcher. Find REAL prospects that STRICTLY satisfy EVERY constraint in this brief — ` +
            `honor the location, company size/scale, industry, the exact role/seniority, and the stated product fit. Discard anyone who doesn't clearly match.\n\n` +
            `BRIEF: ${criteria}\n\n` +
            `Prioritize the decision-maker (owner/founder/CEO, or the named role). For each, find a CONTACT EMAIL — the person's work email if it's public, ` +
            `otherwise the company's general email (info@/contact@). ALWAYS include the company's email DOMAIN (e.g. "acme.com") so an address can be derived.\n\n` +
            `Return ONLY a JSON array (no prose) of up to 12 objects with keys: ` +
            `"name", "title", "company", "domain" (company email domain or ""), "email" (best real contact email or ""), ` +
            `"linkedin" (URL or ""), "location" (or ""), "notes" (one line: why they fit the brief + how you found the email). ` +
            `CRITICAL: only include a prospect if it can actually be contacted — it must have a real email OR (a company domain AND a full person name so an address can be inferred). ` +
            `Skip anyone with no domain and no email. Never fabricate a specific email — leave "email":"" if unsure, but still give the "domain".`,
        },
      ],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    this.meter(res);

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webFindEmail(domain: string): Promise<string> {
    assertBudget();
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content:
            `Find ONE named employee at the company on domain "${domain}" whose work email address (ending @${domain}) ` +
            `is publicly listed (team page, press release, paper, signature, etc.). ` +
            `Return ONLY JSON: {"name": "Full Name", "email": "their@${domain}"} — or {} if you can't find a real one. ` +
            `Do not guess or invent the email; it must be one you actually found.`,
        },
      ],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    this.meter(res);

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webCompanyDomain(company: string): Promise<string> {
    assertBudget();
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content:
            `What is the primary website/email domain for the company "${company}"? ` +
            `Return ONLY JSON: {"domain": "example.com"} — or {} if you're not sure. Just the bare domain, no https/www.`,
        },
      ],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    this.meter(res);

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }
}

// ── No model available ──────────────────────────────────────────────────────
export class NullProvider implements LLMProvider {
  readonly live = false;
  readonly label = 'fallback (no model)';
  async complete(): Promise<string> {
    return '';
  }
}

// ProviderConfig keeps its legacy fields so existing callers (settings.ts) still
// type-check; only anthropic* is used now. Multi-provider (ChatGPT/Ollama) removed.
export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'ollama' | 'auto';
  anthropicKey: string | undefined;
  anthropicModel: string;
  openaiKey?: string | undefined;
  openaiModel?: string;
  openaiBaseUrl?: string;
  ollamaHost?: string;
  ollamaModel?: string;
}

/** Platform-Claude ONLY. Multi-provider was removed — any legacy provider value
 *  resolves to Claude, or the null fallback if no key is configured. */
export function selectProvider(cfg: ProviderConfig): LLMProvider {
  return cfg.anthropicKey ? new AnthropicProvider(cfg.anthropicKey, cfg.anthropicModel) : new NullProvider();
}
