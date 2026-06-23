import { settingsStore } from './db.js';

/**
 * Zoom integration — when Big Dog schedules a meeting it creates a real Zoom
 * meeting and attaches the join link to the calendar event + invite email.
 *
 * Uses Zoom **Server-to-Server OAuth** (the simplest for a personal app):
 *   Zoom Marketplace → Build App → "Server-to-Server OAuth" → copy the
 *   Account ID, Client ID, Client Secret, and add the `meeting:write` scope.
 * Credentials are stored locally (DB), with env fallback (ZOOM_*).
 */

export interface ZoomCreds {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

const FIELDS: (keyof ZoomCreds)[] = ['accountId', 'clientId', 'clientSecret'];

export function loadZoomCreds(): ZoomCreds {
  return {
    accountId: settingsStore.get('zoom.accountId') || process.env.ZOOM_ACCOUNT_ID || '',
    clientId: settingsStore.get('zoom.clientId') || process.env.ZOOM_CLIENT_ID || '',
    clientSecret: settingsStore.get('zoom.clientSecret') || process.env.ZOOM_CLIENT_SECRET || '',
  };
}

export function saveZoomCreds(p: Partial<Record<keyof ZoomCreds, unknown>>): void {
  for (const k of FIELDS) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s === '') continue;
    settingsStore.set(`zoom.${k}`, s);
  }
}

export function zoomConfigured(c: ZoomCreds = loadZoomCreds()): boolean {
  return !!(c.accountId && c.clientId && c.clientSecret);
}

export function publicZoom(c: ZoomCreds = loadZoomCreds()) {
  const mask = (s: string) => (s ? `••••${s.slice(-4)}` : '');
  return { configured: zoomConfigured(c), accountId: c.accountId, clientIdHint: mask(c.clientId), secretSet: !!c.clientSecret };
}

async function getToken(c: ZoomCreds): Promise<string> {
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(c.accountId)}`,
    { method: 'POST', headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Zoom auth ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const d = (await res.json()) as { access_token?: string };
  if (!d.access_token) throw new Error('Zoom returned no access token.');
  return d.access_token;
}

export interface ZoomMeeting {
  joinUrl: string;
  startUrl: string;
  meetingId: string;
  password?: string;
}

/** Create a scheduled Zoom meeting; returns the join link. */
export async function createZoomMeeting(
  opts: { topic: string; startISO: string; minutes: number; timezone?: string },
  c: ZoomCreds = loadZoomCreds(),
): Promise<ZoomMeeting> {
  const token = await getToken(c);
  const res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: opts.topic,
      type: 2, // scheduled
      start_time: opts.startISO,
      duration: opts.minutes,
      timezone: opts.timezone || 'UTC',
      settings: { join_before_host: true, waiting_room: false },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Zoom create ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const d = (await res.json()) as { join_url?: string; start_url?: string; id?: number; password?: string };
  if (!d.join_url) throw new Error('Zoom did not return a join URL.');
  return { joinUrl: d.join_url, startUrl: d.start_url ?? '', meetingId: String(d.id ?? ''), password: d.password };
}

export async function testZoom(c: ZoomCreds = loadZoomCreds()): Promise<{ ok: boolean; detail: string }> {
  if (!zoomConfigured(c)) return { ok: false, detail: 'Add your Account ID, Client ID and Client Secret first.' };
  try {
    await getToken(c);
    return { ok: true, detail: 'Zoom connected ✓' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
