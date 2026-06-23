import { messages, deals, events } from '../db.js';
import { syncAll } from '../mail/ingest.js';
import { triageNewMail } from '../pipeline.js';
import { generateDigest } from '../digest.js';
import { runAgent } from '../agent/agent.js';
import { runCadenceSweep } from '../cadence.js';
import { findProspects, findContactEmail } from '../prospect.js';
import { allAccounts } from '../accounts.js';
import type { BigDogBrain } from '../brain.js';
import type { AppConfig } from '../config.js';
import type { AccountsConfig } from '../types.js';

export interface BotDeps {
  cfg: AppConfig;
  accounts: AccountsConfig;
  brain: BigDogBrain;
}

const HELP = [
  "What's up, Big Dog! 🐕 Here's what I answer to:",
  '',
  '• /do <goal> — go DO it (draft, schedule, update deals…)',
  '• /find <criteria> — prospect for new leads (lead gen)',
  '• /email <name> at <domain> — find + verify a work email',
  '• /research <who> — web brief on a person or company',
  '• /followups — queue nudges for stalled deals',
  '• /brief — your morning rundown',
  '• /sync — pull + triage the inbox now',
  '• /deals — open pipeline',
  '• /today — what\'s on the calendar',
  '• /help — this',
  '',
  'Or just talk to me — ask anything about your deals, your day, or who\'s going cold.',
].join('\n');

function fmtDeals(): string {
  const open = deals.all().filter((d) => d.stage !== 'won' && d.stage !== 'lost');
  if (!open.length) return 'No open deals right now.';
  return (
    '🐕 Open pipeline:\n' +
    open
      .map(
        (d) =>
          `• ${d.title} — ${d.stage.toUpperCase()} (${d.value != null ? '$' + d.value.toLocaleString() : '$?'})\n   → ${d.nextStep}`,
      )
      .join('\n')
  );
}

function fmtToday(): string {
  const up = events.upcoming();
  if (!up.length) return 'Calendar is clear.';
  return (
    '📅 Coming up:\n' +
    up
      .slice(0, 10)
      .map((e) => `• ${e.start.slice(0, 16).replace('T', ' ')} — ${e.title}${e.attendees ? ` (${e.attendees})` : ''}`)
      .join('\n')
  );
}

/**
 * Route an inbound bot message (Telegram or Slack) to the right action.
 * Slash commands run app actions; anything else is a chat with Big Dog.
 */
export async function routeMessage(rawText: string, deps: BotDeps): Promise<string> {
  const text = rawText.trim();
  const cmd = text.toLowerCase();

  if (cmd === '/help' || cmd === 'help' || cmd === '/start') return HELP;

  if (cmd === '/deals' || cmd === 'deals') return fmtDeals();

  if (cmd === '/today' || cmd === '/cal' || cmd === 'today') return fmtToday();

  if (cmd === '/brief' || cmd === 'brief') {
    return generateDigest(deps.brain);
  }

  if (cmd.startsWith('/do ') || cmd === '/do') {
    const goal = text.slice(3).trim();
    if (!goal) return 'Tell me what to do, e.g. /do follow up with everyone in proposal stage';
    const run = await runAgent(goal, deps);
    const trace = run.steps.map((s) => `• ${s.tool}: ${s.observation.slice(0, 120)}`).join('\n');
    return `🐕 ${run.final}` + (trace ? `\n\n— how I got there —\n${trace}` : '');
  }

  if (cmd.startsWith('/research ') || cmd === '/research') {
    const q = text.slice(9).trim();
    if (!q) return 'Who should I research? e.g. /research Acme Corp';
    return deps.brain.research(q);
  }

  if (cmd.startsWith('/find ') || cmd === '/find') {
    const q = text.slice(5).trim();
    if (!q) return 'Describe who to find, e.g. /find VP Sales at Series B fintechs in Texas';
    const prospects = await findProspects(q, deps.cfg, deps.brain);
    if (!prospects.length) return 'No prospects found (or the web/Apollo backend isn\'t configured). 🐕';
    return (
      `🐕 Found ${prospects.length}:\n` +
      prospects
        .map((p) => `• ${p.name}${p.title ? ', ' + p.title : ''}${p.company ? ' @ ' + p.company : ''}${p.email ? ' — ' + p.email : ''}`)
        .join('\n')
    );
  }

  // /email Jane Doe at acme.com
  if (cmd.startsWith('/email ') || cmd === '/email') {
    const rest = text.slice(6).trim();
    const m = rest.match(/^(.*?)\s+(?:at|@)\s+(\S+)$/i);
    if (!m) return 'Format: /email <name> at <domain> — e.g. /email Jane Doe at acme.com';
    const r = await findContactEmail({ name: m[1]!.trim(), domain: m[2]!.trim() }, deps.brain);
    return `🐕 ${r.email}\n${r.confidence.toUpperCase()} — ${r.method}`;
  }

  if (cmd === '/followups' || cmd === 'followups') {
    const created = await runCadenceSweep(deps);
    return created.length
      ? `🐕 Queued ${created.length} follow-up(s) for approval:\n` + created.map((c) => `• ${c}`).join('\n')
      : 'No stalled deals need a nudge right now. 🐕';
  }

  if (cmd === '/sync' || cmd === 'sync') {
    const accts = allAccounts();
    const synced = await syncAll(accts);
    const triaged = await triageNewMail(deps.brain, deps.cfg, deps.accounts);
    const newMail = synced.reduce((n, s) => n + s.added, 0);
    return `🐕 Synced ${newMail} new message(s) and worked ${triaged}. ${accts.length ? '' : '(No mailboxes configured yet.)'}`;
  }

  // Default: chat with the clone.
  return deps.brain.chat(text, deals.all(), messages.recent(40), events.upcoming());
}
