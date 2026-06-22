import { events } from './db.js';
import type { AppConfig } from './config.js';
import type { CalendarEvent } from './types.js';

/**
 * Cal.com integration. Works against both Cal.com cloud (api.cal.com) and a
 * self-hosted open-source instance (https://github.com/calcom/cal.com) — point
 * CALCOM_BASE_URL at your own deployment's API. Big Dog pulls your Cal.com
 * bookings into the one unified calendar and shares your booking link when it
 * sets up a call on your behalf.
 */

interface CalcomAttendee {
  email?: string;
  name?: string;
}
interface CalcomBooking {
  id: number;
  uid?: string;
  title?: string;
  description?: string;
  startTime: string;
  endTime: string;
  status?: string;
  location?: string;
  attendees?: CalcomAttendee[];
}

export function calcomConfigured(cfg: AppConfig): boolean {
  return !!cfg.calcom?.apiKey;
}

/**
 * Pull upcoming Cal.com bookings into the events table. Returns how many were
 * synced. Uses the Cal.com v1 API (apiKey query param) so it works the same on
 * cloud and self-hosted.
 */
export async function syncCalcomBookings(cfg: AppConfig): Promise<number> {
  if (!cfg.calcom?.apiKey) return 0;
  const base = cfg.calcom.baseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/bookings?apiKey=${encodeURIComponent(cfg.calcom.apiKey)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`cal.com ${res.status}: ${await res.text().catch(() => '')}`);

  const data = (await res.json()) as { bookings?: CalcomBooking[] };
  const bookings = data.bookings ?? [];
  let synced = 0;

  for (const b of bookings) {
    if (b.status && ['cancelled', 'rejected'].includes(b.status.toLowerCase())) continue;
    const evt: CalendarEvent = {
      id: `calcom-${b.id}`,
      title: b.title || 'Cal.com booking',
      start: new Date(b.startTime).toISOString(),
      end: new Date(b.endTime).toISOString(),
      location: typeof b.location === 'string' ? b.location : '',
      attendees: (b.attendees ?? []).map((a) => a.email).filter(Boolean).join(', '),
      notes: b.description || 'Booked via Cal.com',
      dealId: null,
      source: 'cal.com',
    };
    events.upsert(evt);
    synced++;
  }
  return synced;
}
