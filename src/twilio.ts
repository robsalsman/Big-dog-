import { settingsStore } from './db.js';

/**
 * Twilio integration — lets Big Dog send SMS and place voice calls: text/call
 * you (hot-lead alerts, the morning brief) or reach a customer from their
 * contact card. Credentials stored locally (DB) with env fallback (TWILIO_*).
 *
 *   Twilio Console → Account Info: Account SID + Auth Token.
 *   Phone Numbers → your Twilio number = the "from" number.
 */

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
  fromNumber: string; // your Twilio phone number
  ownerMobile: string; // where Big Dog texts/calls YOU
}

const FIELDS: (keyof TwilioCreds)[] = ['accountSid', 'authToken', 'fromNumber', 'ownerMobile'];

export function loadTwilioCreds(): TwilioCreds {
  return {
    accountSid: settingsStore.get('twilio.accountSid') || process.env.TWILIO_ACCOUNT_SID || '',
    authToken: settingsStore.get('twilio.authToken') || process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: settingsStore.get('twilio.fromNumber') || process.env.TWILIO_FROM_NUMBER || '',
    ownerMobile: settingsStore.get('twilio.ownerMobile') || process.env.TWILIO_OWNER_MOBILE || '',
  };
}

export function saveTwilioCreds(p: Partial<Record<keyof TwilioCreds, unknown>>): void {
  for (const k of FIELDS) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    // allow clearing ownerMobile/fromNumber with an explicit empty? keep simple: skip empties
    if (s === '') continue;
    settingsStore.set(`twilio.${k}`, s);
  }
}

export function twilioConfigured(c: TwilioCreds = loadTwilioCreds()): boolean {
  return !!(c.accountSid && c.authToken && c.fromNumber);
}

export function publicTwilio(c: TwilioCreds = loadTwilioCreds()) {
  return { configured: twilioConfigured(c), accountSid: c.accountSid, fromNumber: c.fromNumber, ownerMobile: c.ownerMobile, tokenSet: !!c.authToken };
}

function authHeader(c: TwilioCreds): string {
  return 'Basic ' + Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch] as string));
}

/** Send an SMS. `to` defaults to the owner's mobile (text yourself). */
export async function sendSms(body: string, to?: string, c: TwilioCreds = loadTwilioCreds()): Promise<{ sid: string }> {
  if (!twilioConfigured(c)) throw new Error('Twilio not configured.');
  const dest = (to || c.ownerMobile || '').trim();
  if (!dest) throw new Error('No destination number (set your mobile in Settings).');
  const form = new URLSearchParams({ To: dest, From: c.fromNumber, Body: body.slice(0, 1500) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: authHeader(c), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Twilio SMS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const d = (await res.json()) as { sid?: string };
  return { sid: d.sid ?? '' };
}

/** Place a voice call that speaks `message`. `to` defaults to the owner's mobile. */
export async function makeCall(message: string, to?: string, c: TwilioCreds = loadTwilioCreds()): Promise<{ sid: string }> {
  if (!twilioConfigured(c)) throw new Error('Twilio not configured.');
  const dest = (to || c.ownerMobile || '').trim();
  if (!dest) throw new Error('No destination number (set your mobile in Settings).');
  const twiml = `<Response><Say voice="Polly.Joanna">${escapeXml(message.slice(0, 1200))}</Say></Response>`;
  const form = new URLSearchParams({ To: dest, From: c.fromNumber, Twiml: twiml });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: authHeader(c), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Twilio call ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const d = (await res.json()) as { sid?: string };
  return { sid: d.sid ?? '' };
}

export async function testTwilio(c: TwilioCreds = loadTwilioCreds()): Promise<{ ok: boolean; detail: string }> {
  if (!twilioConfigured(c)) return { ok: false, detail: 'Add Account SID, Auth Token, and your Twilio number.' };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}.json`, {
      headers: { Authorization: authHeader(c) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `Twilio ${res.status}: check Account SID + Auth Token.` };
    return { ok: true, detail: 'Twilio connected ✓' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
