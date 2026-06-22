import { createEvents, type EventAttributes } from 'ics';
import { events } from './db.js';
import type { CalendarEvent } from './types.js';

function toIcsDate(iso: string): [number, number, number, number, number] {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

/**
 * Export the single unified calendar as an .ics feed that any calendar app
 * (Google, Apple, Outlook) can subscribe to. This is how "one calendar"
 * across all your mailboxes shows up wherever you already look.
 */
export function exportIcs(): string {
  const all: CalendarEvent[] = events.all();
  const attrs: EventAttributes[] = all.map((e) => ({
    uid: e.id,
    title: e.title,
    start: toIcsDate(e.start),
    end: toIcsDate(e.end),
    location: e.location || undefined,
    description: e.notes || undefined,
    attendees: e.attendees
      ? e.attendees
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
          .map((email) => ({ email }))
      : undefined,
    productId: 'big-dog/ics',
    calName: 'Big Dog',
  }));

  const { error, value } = createEvents(attrs);
  if (error) throw error;
  return value || 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:big-dog\nEND:VCALENDAR';
}
