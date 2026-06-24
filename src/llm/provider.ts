import Anthropic from '@anthropic-ai/sdk';

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

  async complete(opts: { system: string; user: string; maxTokens?: number; schema?: object }): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1200,
      thinking: { type: 'adaptive' },
      system: opts.system,
      ...(opts.schema ? { output_config: { format: { type: 'json_schema', schema: opts.schema } } } : {}),
      messages: [{ role: 'user', content: opts.user }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webResearch(query: string): Promise<string> {
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

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webProspect(criteria: string): Promise<string> {
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

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webFindEmail(domain: string): Promise<string> {
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

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  async webCompanyDomain(company: string): Promise<string> {
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

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }
}

// ── Local Ollama ────────────────────────────────────────────────────────────
export class OllamaProvider implements LLMProvider {
  private host: string;
  private model: string;
  private reachable = true;

  constructor(host: string, model: string) {
    this.host = host.replace(/\/$/, '');
    this.model = model;
  }

  get live(): boolean {
    return this.reachable;
  }

  get label(): string {
    return `ollama:${this.model}`;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      this.reachable = res.ok;
    } catch {
      this.reachable = false;
    }
    return this.reachable;
  }

  async complete(opts: { system: string; user: string; maxTokens?: number; schema?: object }): Promise<string> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        // Ollama (v0.5+) accepts a JSON schema object here to constrain output.
        ...(opts.schema ? { format: opts.schema } : {}),
        options: { num_predict: opts.maxTokens ?? 1200, temperature: 0.7 },
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text().catch(() => '')}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? '').trim();
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

// ── OpenAI / ChatGPT ──────────────────────────────────────────────────────
export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  readonly live = true;

  // baseUrl lets you target any OpenAI-compatible endpoint (Azure, OpenRouter,
  // LM Studio, vLLM, …) — set OPENAI_BASE_URL. Defaults to OpenAI itself.
  constructor(apiKey: string, model: string, baseUrl = 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  get label(): string {
    return `openai:${this.model}`;
  }

  async complete(opts: { system: string; user: string; maxTokens?: number; schema?: object }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1200,
        // json_object guarantees valid JSON without strict-schema constraints.
        ...(opts.schema ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text().catch(() => '')}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'ollama' | 'auto';
  anthropicKey: string | undefined;
  anthropicModel: string;
  openaiKey: string | undefined;
  openaiModel: string;
  openaiBaseUrl?: string;
  ollamaHost: string;
  ollamaModel: string;
}

/** Pick the backend per config. `auto` prefers Claude, then ChatGPT, then local Ollama. */
export function selectProvider(cfg: ProviderConfig): LLMProvider {
  const openai = () => new OpenAIProvider(cfg.openaiKey!, cfg.openaiModel, cfg.openaiBaseUrl);
  switch (cfg.provider) {
    case 'anthropic':
      return cfg.anthropicKey ? new AnthropicProvider(cfg.anthropicKey, cfg.anthropicModel) : new NullProvider();
    case 'openai':
      return cfg.openaiKey ? openai() : new NullProvider();
    case 'ollama':
      return new OllamaProvider(cfg.ollamaHost, cfg.ollamaModel);
    default: // auto
      if (cfg.anthropicKey) return new AnthropicProvider(cfg.anthropicKey, cfg.anthropicModel);
      if (cfg.openaiKey) return openai();
      return new OllamaProvider(cfg.ollamaHost, cfg.ollamaModel);
  }
}
