import { activity } from './db.js';

/** Record something Big Dog did (or failed to do) — surfaced in the Activity tab. */
export function logActivity(type: string, message: string): void {
  try {
    activity.add(type, message);
  } catch {
    /* never let logging break a flow */
  }
  if (type === 'error') console.error('[big-dog]', message);
}
