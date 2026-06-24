import { BigDogBrain } from './brain.js';
import { loadSettings, buildProvider } from './settings.js';
import { loadOwner } from './profile.js';
import type { AppConfig } from './config.js';

/**
 * Per-user brains. Each logged-in user gets their own BigDogBrain built from
 * THEIR settings (LLM provider/key) and THEIR owner profile. We cache one brain
 * per user id and rebuild lazily when their settings or profile change
 * (server calls invalidateBrain(uid) after a save).
 *
 * Must be called inside that user's AsyncLocalStorage context (loadSettings /
 * loadOwner read the per-user DB).
 */
const brains = new Map<string, BigDogBrain>();

export function brainForUser(userId: string, cfg: AppConfig): BigDogBrain {
  const cached = brains.get(userId);
  if (cached) return cached;
  const provider = buildProvider(loadSettings(cfg));
  const brain = new BigDogBrain(provider, loadOwner(cfg), cfg.calcom?.bookingUrl);
  brains.set(userId, brain);
  return brain;
}

/** Drop a user's cached brain so the next request rebuilds it (e.g. after they
 * change their API key, provider, or voice profile). */
export function invalidateBrain(userId: string): void {
  brains.delete(userId);
}

/** Drop every cached brain — used when the managed master key changes so all
 * users pick it up on their next request without a restart. */
export function invalidateAllBrains(): void {
  brains.clear();
}
