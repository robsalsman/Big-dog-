import { loadConfig, loadAccounts } from './config.js';
import { BigDogBrain } from './claude.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { seedDemoData } from './seed.js';

function main() {
  const cfg = loadConfig();
  const accountsCfg = loadAccounts();
  const brain = new BigDogBrain(cfg);

  // Make sure there's something to look at on first run.
  seedDemoData();

  const app = createServer(cfg, accountsCfg, brain);
  startScheduler(cfg, accountsCfg, brain);

  app.listen(cfg.port, () => {
    console.log('');
    console.log("  🐕  What's up, Big Dog!?");
    console.log(`      Dashboard:  http://localhost:${cfg.port}`);
    console.log(`      Brain:      ${brain.live ? `live (${cfg.model})` : 'offline — add ANTHROPIC_API_KEY to .env'}`);
    console.log(`      Mailboxes:  ${accountsCfg.accounts.length || 'none yet — see config/accounts.example.json'}`);
    console.log(`      Send mode:  ${cfg.sendMode}`);
    console.log('');
  });
}

main();
