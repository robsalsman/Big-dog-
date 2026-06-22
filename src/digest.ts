import { randomUUID } from 'node:crypto';
import { messages, deals, events, digests } from './db.js';
import type { BigDogBrain } from './claude.js';

/**
 * Generate (and store) the morning "What's up, Big Dog!?" briefing for today.
 */
export async function generateDigest(brain: BigDogBrain): Promise<string> {
  const hot = messages.recent(60).filter((m) => m.priority === 'hot' || m.priority === 'warm');
  const openDeals = deals.all().filter((d) => d.stage !== 'won' && d.stage !== 'lost');
  const upcoming = events.upcoming();

  const content = await brain.digest(hot, openDeals, upcoming);
  const date = new Date().toISOString().slice(0, 10);

  digests.upsert({
    id: `digest-${date}`,
    date,
    content,
    createdAt: new Date().toISOString(),
  });

  return content;
}
