import { startTelegram } from './telegram.js';
import { startSlack } from './slack.js';
import type { BotDeps } from './commands.js';

export interface Notifier {
  notify(text: string): Promise<void>;
}

/**
 * Start whatever chat bots are configured (Telegram and/or Slack) and return
 * their notifiers so the scheduler can push proactive messages — the morning
 * brief, cold-deal alerts — to wherever you actually chat with Big Dog.
 */
export async function startBots(deps: BotDeps): Promise<Notifier[]> {
  const notifiers: Notifier[] = [];
  const { cfg } = deps;

  if (cfg.telegram) {
    try {
      notifiers.push(await startTelegram(cfg.telegram.token, cfg.telegram.chatId, deps));
    } catch (err) {
      console.error('[big-dog] Telegram failed to start:', (err as Error).message);
    }
  }

  if (cfg.slack) {
    try {
      notifiers.push(await startSlack(cfg.slack, deps));
    } catch (err) {
      console.error('[big-dog] Slack failed to start:', (err as Error).message);
    }
  }

  return notifiers;
}
