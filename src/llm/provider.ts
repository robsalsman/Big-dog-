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

export interface ProviderConfig {
  provider: 'anthropic' | 'ollama' | 'auto';
  anthropicKey: string | undefined;
  model: string;
  ollamaHost: string;
  ollamaModel: string;
}

/** Pick the backend per config. `auto` prefers Claude, then local Ollama. */
export function selectProvider(cfg: ProviderConfig): LLMProvider {
  const wantAnthropic = cfg.provider === 'anthropic' || (cfg.provider === 'auto' && !!cfg.anthropicKey);
  if (wantAnthropic && cfg.anthropicKey) return new AnthropicProvider(cfg.anthropicKey, cfg.model);
  if (cfg.provider === 'anthropic') return new NullProvider(); // asked for Claude but no key
  if (cfg.provider === 'ollama' || cfg.provider === 'auto') return new OllamaProvider(cfg.ollamaHost, cfg.ollamaModel);
  return new NullProvider();
}
