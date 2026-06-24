import { loadConfig, loadAccounts } from './config.js';
import { BigDogBrain } from './brain.js';
import { loadSettings, buildProvider } from './settings.js';
import { loadOwner } from './profile.js';
import { seedPasswordFromEnv, isAuthConfigured } from './auth.js';
import { allAccounts } from './accounts.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { startBots } from './bots/index.js';
import { setNotifiers } from './notify.js';
import { twilioConfigured, loadTwilioCreds, sendSms } from './twilio.js';
import { ensureBrowser } from './browser.js';
import { seedDemoData } from './seed.js';

async function main() {
  const cfg = loadConfig();
  const accountsCfg = loadAccounts();

  // Pick the LLM backend (Claude / ChatGPT / local Ollama) from saved settings,
  // which fall back to env vars. Switchable later from the in-app Settings screen.
  const provider = buildProvider(loadSettings(cfg));
  if (provider.ping) await provider.ping();
  const brain = new BigDogBrain(provider, loadOwner(cfg), cfg.calcom?.bookingUrl);

  // Seed a dashboard password from env if one isn't set yet.
  seedPasswordFromEnv(process.env.BIGDOG_PASSWORD);

  // Detect the optional real-browser capability (Vercel Labs agent-browser).
  const browserOk = await ensureBrowser();

  // Make sure there's something to look at on first run.
  seedDemoData();

  const app = createServer(cfg, accountsCfg, brain);
  const notifiers = await startBots({ cfg, accounts: accountsCfg, brain });
  // Text the owner on hot-lead alerts + the morning brief, if Twilio is set up.
  if (twilioConfigured() && loadTwilioCreds().ownerMobile) {
    notifiers.push({ notify: async (text: string) => { await sendSms(text.slice(0, 600)).catch(() => {}); } });
  }
  setNotifiers(notifiers); // let any flow (hot-lead alerts, cadences) ping the bots/SMS
  startScheduler(cfg, accountsCfg, brain, notifiers);

  app.listen(cfg.port, () => {
    console.log('');
    console.log("  🐕  What's up, Big Dog!?");
    console.log(`      Dashboard:  http://localhost:${cfg.port}`);
    console.log(
      `      Brain:      ${brain.live ? `live (${brain.backend})` : `offline (${brain.backend}) — set BIGDOG_PROVIDER`}`,
    );
    console.log(`      Mailboxes:  ${allAccounts().length || 'none yet — add one in ⚙ Settings'}`);
    console.log(`      Calendar:   ${cfg.calcom ? `Cal.com (${cfg.calcom.baseUrl})` : 'built-in only (add CALCOM_API_KEY for Cal.com)'}`);
    console.log(`      Bots:       ${notifiers.length ? `${notifiers.length} connected` : 'none (add Telegram/Slack tokens to .env)'}`);
    console.log(`      Browser:    ${browserOk ? 'agent-browser ready 🌐' : 'off (install agent-browser CLI for live page reading)'}`);
    console.log(`      Send mode:  ${cfg.sendMode}`);
    console.log(`      Auth:       ${isAuthConfigured() ? 'password set 🔒' : 'OPEN — set a password in ⚙ Settings'}`);
    console.log('');
  });
}

main().catch((err) => {
  console.error('[big-dog] fatal:', err);
  process.exit(1);
});
