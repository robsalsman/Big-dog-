import { buildToolset, type AgentContext, type AgentTool } from './tools.js';

export interface AgentStep {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
  observation: string;
}

export interface AgentRun {
  goal: string;
  steps: AgentStep[];
  final: string;
}

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    thought: { type: 'string' },
    tool: { type: ['string', 'null'] },
    args: { type: 'object', additionalProperties: true },
    final: { type: ['string', 'null'] },
  },
  required: ['thought'],
};

/**
 * Operator mode. Big Dog runs an autonomous tool loop to achieve a goal: it
 * reasons, calls one tool at a time (look up a deal, draft a reply, schedule a
 * call, remember a fact, research a lead…), reads the result, and continues
 * until done. Provider-agnostic — the same JSON action protocol works on Claude
 * and on a local Ollama model.
 */
export async function runAgent(goal: string, ctx: AgentContext): Promise<AgentRun> {
  const tools = buildToolset(ctx);
  const toolByName = new Map<string, AgentTool>(tools.map((t) => [t.name, t]));
  const maxSteps = ctx.cfg.agentMaxSteps;
  const steps: AgentStep[] = [];

  if (!ctx.brain.live) {
    return { goal, steps, final: 'Operator mode needs a live model — set a Claude key or a local Ollama model (BIGDOG_PROVIDER).' };
  }

  const toolDocs = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const instructions =
    `You are operating in AUTONOMOUS OPERATOR mode. Achieve the goal by calling tools, one at a time.\n\n` +
    `TOOLS:\n${toolDocs}\n\n` +
    `Each turn, respond with ONLY a JSON object — either take an action:\n` +
    `  {"thought": "...", "tool": "<tool name>", "args": { ... }}\n` +
    `or finish:\n` +
    `  {"thought": "...", "final": "<summary of what you did for the owner>"}\n\n` +
    `Rules: take real actions, don't just describe them. Email is always queued for the owner's approval. ` +
    `Stop and return "final" as soon as the goal is met. Don't repeat a tool call that already succeeded.`;

  const transcript: string[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const user =
      `${instructions}\n\nGOAL: ${goal}\n\n` +
      (transcript.length ? `HISTORY:\n${transcript.join('\n')}\n\n` : '') +
      `Respond with the next JSON action.`;

    let parsed: { thought?: string; tool?: string | null; args?: Record<string, unknown>; final?: string | null };
    try {
      const out = await ctx.brain.raw(user, ACTION_SCHEMA, 900);
      parsed = JSON.parse(extractJson(out));
    } catch (err) {
      transcript.push(`ERROR parsing action: ${(err as Error).message}. Respond with valid JSON only.`);
      continue;
    }

    if (parsed.final || !parsed.tool) {
      return { goal, steps, final: parsed.final || parsed.thought || 'Done.' };
    }

    const tool = toolByName.get(parsed.tool);
    const args = (parsed.args ?? {}) as Record<string, unknown>;
    let observation: string;
    if (!tool) {
      observation = `No tool named "${parsed.tool}". Available: ${tools.map((t) => t.name).join(', ')}.`;
    } else {
      try {
        observation = await tool.run(args);
      } catch (err) {
        observation = `Tool error: ${(err as Error).message}`;
      }
    }

    steps.push({ thought: parsed.thought ?? '', tool: parsed.tool, args, observation });
    transcript.push(
      `ACTION: ${JSON.stringify({ tool: parsed.tool, args })}\nOBSERVATION: ${observation.slice(0, 1500)}`,
    );
  }

  // Ran out of steps — ask for a closing summary.
  const summary = await ctx.brain
    .raw(`You ran out of steps working on: "${goal}". Briefly summarize for the owner what you got done and what's left.`)
    .catch(() => 'Reached the step limit before finishing.');
  return { goal, steps, final: summary };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}
