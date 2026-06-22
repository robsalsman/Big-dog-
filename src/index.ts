import { loadConfig, loadAccounts } from './config.js';
import { BigDogBrain } from './brain.js';
import { selectProvider } from './llm/provider.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { startBots } from './bots/index.js';
import { seedDemoData } from './seed.js';

async function main() {
  const cfg = loadConfig();
  const accountsCfg = loadAccounts();

  // Pick the LLM backend (Claude or local Ollama) and build the brain.
  const provider = selectProvider({
    provider: cfg.provider,
    anthropicKey: cfg.anthropicKey,
    model: cfg.model,
    ollamaHost: cfg.ollamaHost,
    ollamaModel: cfg.ollamaModel,
  });
  if (provider.ping) await provider.ping();
  const brain = new BigDogBrain(provider, cfg.owner, cfg.calcom?.bookingUrl);

  // Make sure there's something to look at on first run.
  seedDemoData();

  const app = createServer(cfg, accountsCfg, brain);
  const notifiers = await startBots({ cfg, accounts: accountsCfg, brain });
  startScheduler(cfg, accountsCfg, brain, notifiers);

  app.listen(cfg.port, () => {
    console.log('');
    console.log("  🐕  What's up, Big Dog!?");
    console.log(`      Dashboard:  http://localhost:${cfg.port}`);
    console.log(
      `      Brain:      ${brain.live ? `live (${brain.backend})` : `offline (${brain.backend}) — set BIGDOG_PROVIDER`}`,
    );
    console.log(`      Mailboxes:  ${accountsCfg.accounts.length || 'none yet — see config/accounts.example.json'}`);
    console.log(`      Calendar:   ${cfg.calcom ? `Cal.com (${cfg.calcom.baseUrl})` : 'built-in only (add CALCOM_API_KEY for Cal.com)'}`);
    console.log(`      Bots:       ${notifiers.length ? `${notifiers.length} connected` : 'none (add Telegram/Slack tokens to .env)'}`);
    console.log(`      Send mode:  ${cfg.sendMode}`);
    console.log('');
  });
}

main().catch((err) => {
  console.error('[big-dog] fatal:', err);
  process.exit(1);
});
