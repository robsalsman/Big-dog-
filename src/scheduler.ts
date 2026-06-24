import { syncAll } from './mail/ingest.js';
import { triageNewMail } from './pipeline.js';
import { generateDigest } from './digest.js';
import { calcomConfigured, syncCalcomBookings } from './calcom.js';
import { runCadenceSweep } from './cadence.js';
import { allAccounts } from './accounts.js';
import { sendDueDrafts } from './scheduledsend.js';
import { runDueEnrollments } from './sequences.js';
import { users, runWithUser } from './db.js';
import { brainForUser } from './userbrain.js';
import type { AppConfig } from './config.js';
import type { AccountsConfig } from './types.js';
import type { Notifier } from './bots/index.js';

/**
 * Keep Big Dog working in the background for EVERY user: periodically pull +
 * triage each user's mail in their own DB context, and fire the morning digest
 * once a day. Chat-bot / SMS notifications go to the owner (the 'default' admin
 * account) since those channels are wired to their phone.
 */
function activeUserIds(): string[] {
  const ids = users.all().map((u) => u.id);
  return ids.length ? ids : ['default'];
}

export function startScheduler(
  cfg: AppConfig,
  accountsCfg: AccountsConfig,
  _brain: unknown,
  notifiers: Notifier[] = [],
): void {
  // Periodic mail sync + triage + Cal.com booking pull, per user. Accounts are
  // read live each tick, so mailboxes added in-app are picked up without a restart.
  if (cfg.syncMinutes > 0) {
    const everyMs = cfg.syncMinutes * 60_000;
    setInterval(async () => {
      for (const uid of activeUserIds()) {
        await runWithUser(uid, async () => {
          const brain = brainForUser(uid, cfg);
          try {
            const accts = allAccounts();
            if (accts.length) {
              await syncAll(accts);
              const n = await triageNewMail(brain, cfg, accountsCfg);
              if (n > 0) console.log(`[big-dog] [${uid}] triaged ${n} new message(s)`);
            }
            if (calcomConfigured(cfg)) {
              const b = await syncCalcomBookings(cfg);
              if (b > 0) console.log(`[big-dog] [${uid}] pulled ${b} Cal.com booking(s)`);
            }
            const touches = await runDueEnrollments(brain, cfg);
            if (touches > 0) console.log(`[big-dog] [${uid}] drip worker: ${touches} touch(es)`);
          } catch (err) {
            console.error(`[big-dog] [${uid}] sync error:`, (err as Error).message);
          }
        });
      }
    }, everyMs).unref();
    console.log(`[big-dog] auto-sync every ${cfg.syncMinutes} min`);
  }

  // Every minute: fire any scheduled sends; once a day fire the digest + cadence.
  let lastDigestDay = '';
  setInterval(async () => {
    for (const uid of activeUserIds()) {
      await runWithUser(uid, async () => { await sendDueDrafts().catch(() => {}); });
    }
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() === cfg.digestHour && lastDigestDay !== today) {
      lastDigestDay = today;
      for (const uid of activeUserIds()) {
        await runWithUser(uid, async () => {
          const brain = brainForUser(uid, cfg);
          try {
            const content = await generateDigest(brain);
            console.log(`[big-dog] [${uid}] morning digest ready for ${today}`);
            // Push to the owner's chat/SMS channels (only the admin account).
            if (uid === 'default') for (const n of notifiers) await n.notify(content).catch(() => {});

            const nudges = await runCadenceSweep({ cfg, accounts: accountsCfg, brain });
            if (nudges.length) {
              console.log(`[big-dog] [${uid}] queued ${nudges.length} follow-up nudge(s)`);
              if (uid === 'default') {
                const msg = `🐕 Queued ${nudges.length} follow-up(s) for your approval:\n` + nudges.map((n) => `• ${n}`).join('\n');
                for (const n of notifiers) await n.notify(msg).catch(() => {});
              }
            }
          } catch (err) {
            console.error(`[big-dog] [${uid}] digest error:`, (err as Error).message);
          }
        });
      }
    }
  }, 60_000).unref();
}
