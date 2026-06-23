import type { Notifier } from './bots/index.js';

/**
 * Global notifier registry so any flow (triage, cadence) can push a message to
 * the connected chat bots without threading notifiers through every signature.
 */
let notifiers: Notifier[] = [];

export function setNotifiers(n: Notifier[]): void {
  notifiers = n;
}

export async function notifyAll(text: string): Promise<void> {
  for (const n of notifiers) await n.notify(text).catch(() => {});
}
