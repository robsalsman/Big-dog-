import { createHash } from 'node:crypto';

/** Strip Re:/Fwd: prefixes to get the conversation's base subject. */
export function baseSubject(subject = ''): string {
  return subject.replace(/^((re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

/**
 * Stable thread id: base subject + the other party's email. An inbound message
 * and the reply you send back land in the same thread (the reply's "Re:" is
 * stripped and the recipient equals the original sender).
 */
export function threadKey(subject: string, otherEmail: string): string {
  const base = baseSubject(subject) || '(no subject)';
  const who = (otherEmail || '').toLowerCase().trim();
  return createHash('sha1').update(`${base}::${who}`).digest('hex').slice(0, 16);
}
