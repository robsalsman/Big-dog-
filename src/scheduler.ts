import { syncAll } from './mail/ingest.js';
import { triageNewMail } from './pipeline.js';
import { generateDigest } from './digest.js';
import { calcomConfigured, syncCalcomBookings } from './calcom.js';
import { runCadenceSweep } from './cadence.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';
import type { AccountsConfig } from './types.js';
import type { Notifier } from './bots/index.js';

/**
 * Keep Big Dog working in the background: periodically pull + triage mail, and
 * fire the morning digest once a day at the configured hour — pushing it to
 * any connected chat bots (Telegram/Slack).
 */
export function startScheduler(
  cfg: AppConfig,
  accountsCfg: AccountsConfig,
  brain: BigDogBrain,
  notifiers: Notifier[] = [],
): void {
  // Periodic mail sync + triage + Cal.com booking pull.
  const hasMail = accountsCfg.accounts.length > 0;
  if (cfg.syncMinutes > 0 && (hasMail || calcomConfigured(cfg))) {
    const everyMs = cfg.syncMinutes * 60_000;
    setInterval(async () => {
      try {
        if (hasMail) {
          await syncAll(accountsCfg.accounts);
          const n = await triageNewMail(brain);
          if (n > 0) console.log(`[big-dog] triaged ${n} new message(s)`);
        }
        if (calcomConfigured(cfg)) {
          const b = await syncCalcomBookings(cfg);
          if (b > 0) console.log(`[big-dog] pulled ${b} Cal.com booking(s)`);
        }
      } catch (err) {
        console.error('[big-dog] sync error:', (err as Error).message);
      }
    }, everyMs).unref();
    console.log(`[big-dog] auto-sync every ${cfg.syncMinutes} min`);
  }

  // Daily digest at the configured hour, pushed to chat bots.
  let lastDigestDay = '';
  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() === cfg.digestHour && lastDigestDay !== today) {
      lastDigestDay = today;
      try {
        const content = await generateDigest(brain);
        console.log(`[big-dog] morning digest ready for ${today}`);
        for (const n of notifiers) await n.notify(content).catch(() => {});

        // Sweep for stalled deals and queue follow-up nudges.
        const nudges = await runCadenceSweep({ cfg, accounts: accountsCfg, brain });
        if (nudges.length) {
          console.log(`[big-dog] queued ${nudges.length} follow-up nudge(s)`);
          const msg = `🐕 Queued ${nudges.length} follow-up(s) for your approval:\n` + nudges.map((n) => `• ${n}`).join('\n');
          for (const n of notifiers) await n.notify(msg).catch(() => {});
        }
      } catch (err) {
        console.error('[big-dog] digest error:', (err as Error).message);
      }
    }
  }, 60_000).unref();
}
