import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import type {
  Message,
  Deal,
  CalendarEvent,
  Draft,
  Digest,
  DealStage,
  Account,
  Contact,
  Sequence,
  Enrollment,
  Attachment,
} from './types.js';

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Multi-user: a separate SQLite database per user (full data isolation) ──
// A request runs inside runWithUser(); store methods use getDb(). With no
// context (startup, single-user), everything falls back to the 'default' user
// — which maps to the original bigdog.sqlite, so existing data is preserved.
type DB = Database.Database;
const DEFAULT_USER = 'default';
const conns = new Map<string, DB>();

function dbFileFor(userId: string): string {
  if (userId === DEFAULT_USER) return resolve(DATA_DIR, 'bigdog.sqlite');
  const dir = resolve(DATA_DIR, 'users');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, `${userId}.sqlite`);
}

export function openUserDb(userId: string): DB {
  const cached = conns.get(userId);
  if (cached) return cached;
  const d = new Database(dbFileFor(userId));
  d.pragma('journal_mode = WAL');
  initSchema(d);
  conns.set(userId, d);
  return d;
}

const als = new AsyncLocalStorage<{ userId: string; db: DB; brain?: unknown }>();
export function runWithUser<T>(userId: string, fn: () => T): T {
  return als.run({ userId, db: openUserDb(userId) }, fn);
}
export function currentUserId(): string { return als.getStore()?.userId ?? DEFAULT_USER; }
export function getDb(): DB { return als.getStore()?.db ?? openUserDb(DEFAULT_USER); }
export function setContextBrain(b: unknown): void { const s = als.getStore(); if (s) s.brain = b; }
export function currentBrainRaw(): unknown { return als.getStore()?.brain; }

function initSchema(db: DB) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    messageId TEXT,
    threadId TEXT,
    fromName TEXT,
    fromEmail TEXT,
    toEmails TEXT,
    subject TEXT,
    snippet TEXT,
    body TEXT,
    date TEXT,
    folder TEXT,
    unread INTEGER DEFAULT 1,
    dealId TEXT,
    priority TEXT,
    summary TEXT,
    analyzed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS deals (
    id TEXT PRIMARY KEY,
    title TEXT,
    contactName TEXT,
    contactEmail TEXT,
    company TEXT,
    stage TEXT,
    value REAL,
    notes TEXT,
    nextStep TEXT,
    nextStepDue TEXT,
    createdAt TEXT,
    updatedAt TEXT,
    lastActivity TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT,
    start TEXT,
    end TEXT,
    location TEXT,
    attendees TEXT,
    notes TEXT,
    dealId TEXT,
    source TEXT
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    accountId TEXT,
    inReplyTo TEXT,
    dealId TEXT,
    toEmails TEXT,
    subject TEXT,
    body TEXT,
    rationale TEXT,
    status TEXT DEFAULT 'pending',
    createdAt TEXT,
    sentAt TEXT,
    sendAt TEXT
  );

  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT,
    type TEXT,
    message TEXT
  );

  CREATE TABLE IF NOT EXISTS digests (
    id TEXT PRIMARY KEY,
    date TEXT,
    content TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    contactEmail TEXT,
    content TEXT,
    createdAt TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_memories_contact ON memories(contactEmail);

  CREATE TABLE IF NOT EXISTS patterns (
    domain TEXT PRIMARY KEY,
    patternKey TEXT,
    sample TEXT,
    source TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS mailaccounts (
    id TEXT PRIMARY KEY,
    json TEXT
  );

  CREATE TABLE IF NOT EXISTS suppressed (
    email TEXT PRIMARY KEY,
    ts TEXT
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    name TEXT,
    mime TEXT,
    size INTEGER,
    path TEXT,
    notes TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS contacts (
    email TEXT PRIMARY KEY,
    name TEXT,
    company TEXT,
    title TEXT,
    phone TEXT,
    notes TEXT,
    tags TEXT,
    firstSeen TEXT,
    lastSeen TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY,
    name TEXT,
    steps TEXT,
    active INTEGER DEFAULT 1,
    autoSend INTEGER DEFAULT 0,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    id TEXT PRIMARY KEY,
    sequenceId TEXT,
    email TEXT,
    name TEXT,
    company TEXT,
    accountId TEXT,
    dealId TEXT,
    step INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    startedAt TEXT,
    nextRunAt TEXT,
    lastError TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_deal ON messages(dealId);
  CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);
`);

// Migration: add drafts.sendAt to pre-existing databases.
{
  const cols = db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'sendAt')) db.exec('ALTER TABLE drafts ADD COLUMN sendAt TEXT');
}

// Migration: add messages.archived (dismiss from inbox) to pre-existing DBs.
{
  const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'archived')) db.exec('ALTER TABLE messages ADD COLUMN archived INTEGER DEFAULT 0');
}

// Migration: add drafts.ccEmails for CC / reply-all.
{
  const cols = db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'ccEmails')) db.exec('ALTER TABLE drafts ADD COLUMN ccEmails TEXT');
}

// Migration: add messages.category (email kind from triage).
{
  const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'category')) db.exec('ALTER TABLE messages ADD COLUMN category TEXT');
}

// Migration: add drafts.attachmentIds.
{
  const cols = db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'attachmentIds')) db.exec('ALTER TABLE drafts ADD COLUMN attachmentIds TEXT');
}

// Migration: add events.zoomMeetingId (for transcript follow-up).
{
  const cols = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'zoomMeetingId')) db.exec('ALTER TABLE events ADD COLUMN zoomMeetingId TEXT');
}

// Migration: add messages.meetingReq (one-tap "Confirm & book").
{
  const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'meetingReq')) db.exec('ALTER TABLE messages ADD COLUMN meetingReq INTEGER DEFAULT 0');
}

// Migration: add sequences.autoSend.
{
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sequences'").get();
  if (t) {
    const cols = db.prepare('PRAGMA table_info(sequences)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'autoSend')) db.exec('ALTER TABLE sequences ADD COLUMN autoSend INTEGER DEFAULT 0');
  }
}
} // end initSchema

// Eagerly open the default user's DB (preserves single-user behavior).
openUserDb(DEFAULT_USER);

// ── System database: user accounts (shared, not per-user) ─────────────────
const sysDb = new Database(resolve(DATA_DIR, 'system.sqlite'));
sysDb.pragma('journal_mode = WAL');
sysDb.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT, passHash TEXT, role TEXT, createdAt TEXT
);`);

sysDb.exec(`CREATE TABLE IF NOT EXISTS system (key TEXT PRIMARY KEY, value TEXT);`);
export const systemStore = {
  get(key: string): string | undefined { return (sysDb.prepare('SELECT value FROM system WHERE key = ?').get(key) as { value: string } | undefined)?.value; },
  set(key: string, value: string) { sysDb.prepare('INSERT INTO system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); },
};

export interface UserRow { id: string; username: string; email: string; passHash: string; role: string; createdAt: string; }
export const users = {
  count(): number { return (sysDb.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c; },
  byUsername(u: string): UserRow | undefined { return sysDb.prepare('SELECT * FROM users WHERE lower(username) = ?').get((u || '').toLowerCase().trim()) as UserRow | undefined; },
  byId(id: string): UserRow | undefined { return sysDb.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined; },
  all(): UserRow[] { return sysDb.prepare('SELECT * FROM users ORDER BY createdAt ASC').all() as UserRow[]; },
  create(u: UserRow) { sysDb.prepare('INSERT INTO users (id, username, email, passHash, role, createdAt) VALUES (@id, @username, @email, @passHash, @role, @createdAt)').run(u); },
  setPass(id: string, passHash: string) { sysDb.prepare('UPDATE users SET passHash = ? WHERE id = ?').run(passHash, id); },
};

// ── Messages ────────────────────────────────────────────────────────────
export const messages = {
  upsert(m: Message) {
    getDb().prepare(
      `INSERT INTO messages (id, accountId, messageId, threadId, fromName, fromEmail,
        toEmails, subject, snippet, body, date, folder, unread, dealId, priority, summary, analyzed)
       VALUES (@id, @accountId, @messageId, @threadId, @fromName, @fromEmail,
        @toEmails, @subject, @snippet, @body, @date, @folder, @unread, @dealId, @priority, @summary, @analyzed)
       ON CONFLICT(id) DO UPDATE SET unread=excluded.unread`,
    ).run(m);
  },
  exists(id: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
  },
  get(id: string): Message | undefined {
    return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
  },
  recent(limit = 100): Message[] {
    // The main feed is received mail; sent mail still appears inside threads,
    // and dismissed (archived) messages are hidden.
    return getDb().prepare("SELECT * FROM messages WHERE (folder IS NULL OR folder != 'SENT') AND (archived IS NULL OR archived = 0) ORDER BY date DESC LIMIT ?").all(limit) as Message[];
  },
  meetingRequests(limit = 50): Message[] {
    return getDb().prepare("SELECT * FROM messages WHERE meetingReq = 1 AND (archived IS NULL OR archived = 0) AND (folder IS NULL OR folder != 'SENT') ORDER BY date DESC LIMIT ?").all(limit) as Message[];
  },
  setMeetingReq(id: string, val: 0 | 1) {
    getDb().prepare('UPDATE messages SET meetingReq = ? WHERE id = ?').run(val, id);
  },
  forContact(email: string, limit = 100): Message[] {
    const e = (email || '').toLowerCase().trim();
    return getDb().prepare('SELECT * FROM messages WHERE lower(fromEmail) = ? OR lower(toEmails) LIKE ? ORDER BY date DESC LIMIT ?').all(e, `%${e}%`, limit) as Message[];
  },
  archive(id: string) {
    getDb().prepare('UPDATE messages SET archived = 1 WHERE id = ?').run(id);
  },
  unarchive(id: string) {
    getDb().prepare('UPDATE messages SET archived = 0 WHERE id = ?').run(id);
  },
  recentSent(limit = 100): Message[] {
    return getDb().prepare("SELECT * FROM messages WHERE folder = 'SENT' ORDER BY date DESC LIMIT ?").all(limit) as Message[];
  },
  thread(threadId: string): Message[] {
    return getDb().prepare('SELECT * FROM messages WHERE threadId = ? ORDER BY date ASC').all(threadId) as Message[];
  },
  unanalyzed(limit = 20): Message[] {
    return getDb()
      .prepare('SELECT * FROM messages WHERE analyzed = 0 ORDER BY date DESC LIMIT ?')
      .all(limit) as Message[];
  },
  setAnalysis(id: string, priority: string, summary: string, dealId: string | null, category: string | null = null, meetingReq = 0) {
    getDb().prepare(
      'UPDATE messages SET analyzed = 1, priority = ?, summary = ?, dealId = ?, category = ?, meetingReq = ? WHERE id = ?',
    ).run(priority, summary, dealId, category, meetingReq, id);
  },
  markRead(id: string) {
    getDb().prepare('UPDATE messages SET unread = 0 WHERE id = ?').run(id);
  },
  count(): number {
    return (getDb().prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
  },
  search(q: string, limit = 50): Message[] {
    const like = `%${q}%`;
    return getDb()
      .prepare(
        `SELECT * FROM messages
         WHERE subject LIKE ? OR fromName LIKE ? OR fromEmail LIKE ? OR body LIKE ? OR summary LIKE ?
         ORDER BY date DESC LIMIT ?`,
      )
      .all(like, like, like, like, like, limit) as Message[];
  },
};

// ── Deals ───────────────────────────────────────────────────────────────
export const deals = {
  upsert(d: Deal) {
    getDb().prepare(
      `INSERT INTO deals (id, title, contactName, contactEmail, company, stage, value,
        notes, nextStep, nextStepDue, createdAt, updatedAt, lastActivity)
       VALUES (@id, @title, @contactName, @contactEmail, @company, @stage, @value,
        @notes, @nextStep, @nextStepDue, @createdAt, @updatedAt, @lastActivity)
       ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, contactName=excluded.contactName, contactEmail=excluded.contactEmail,
        company=excluded.company, stage=excluded.stage, value=excluded.value, notes=excluded.notes,
        nextStep=excluded.nextStep, nextStepDue=excluded.nextStepDue,
        updatedAt=excluded.updatedAt, lastActivity=excluded.lastActivity`,
    ).run(d);
  },
  get(id: string): Deal | undefined {
    return getDb().prepare('SELECT * FROM deals WHERE id = ?').get(id) as Deal | undefined;
  },
  findByContact(email: string): Deal | undefined {
    return getDb()
      .prepare('SELECT * FROM deals WHERE lower(contactEmail) = lower(?) AND stage NOT IN (?, ?)')
      .get(email, 'won', 'lost') as Deal | undefined;
  },
  all(): Deal[] {
    return getDb().prepare('SELECT * FROM deals ORDER BY updatedAt DESC').all() as Deal[];
  },
  search(q: string, limit = 30): Deal[] {
    const like = `%${q}%`;
    return getDb()
      .prepare(
        `SELECT * FROM deals
         WHERE title LIKE ? OR company LIKE ? OR contactName LIKE ? OR contactEmail LIKE ? OR nextStep LIKE ?
         ORDER BY updatedAt DESC LIMIT ?`,
      )
      .all(like, like, like, like, like, limit) as Deal[];
  },
  setStage(id: string, stage: DealStage) {
    getDb().prepare('UPDATE deals SET stage = ?, updatedAt = ? WHERE id = ?').run(
      stage,
      new Date().toISOString(),
      id,
    );
  },
};

// ── Calendar ────────────────────────────────────────────────────────────
export const events = {
  upsert(e: CalendarEvent) {
    getDb().prepare(
      `INSERT INTO events (id, title, start, end, location, attendees, notes, dealId, source, zoomMeetingId)
       VALUES (@id, @title, @start, @end, @location, @attendees, @notes, @dealId, @source, @zoomMeetingId)
       ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, start=excluded.start, end=excluded.end,
        location=excluded.location, attendees=excluded.attendees, notes=excluded.notes, zoomMeetingId=excluded.zoomMeetingId`,
    ).run({ ...e, zoomMeetingId: e.zoomMeetingId ?? null });
  },
  get(id: string): CalendarEvent | undefined {
    return getDb().prepare('SELECT * FROM events WHERE id = ?').get(id) as CalendarEvent | undefined;
  },
  all(): CalendarEvent[] {
    return getDb().prepare('SELECT * FROM events ORDER BY start ASC').all() as CalendarEvent[];
  },
  upcoming(): CalendarEvent[] {
    return getDb()
      .prepare('SELECT * FROM events WHERE start >= ? ORDER BY start ASC')
      .all(new Date().toISOString()) as CalendarEvent[];
  },
};

// ── Drafts ──────────────────────────────────────────────────────────────
export const drafts = {
  insert(d: Draft) {
    getDb().prepare(
      `INSERT INTO drafts (id, accountId, inReplyTo, dealId, toEmails, ccEmails, attachmentIds, subject, body, rationale, status, createdAt, sentAt, sendAt)
       VALUES (@id, @accountId, @inReplyTo, @dealId, @toEmails, @ccEmails, @attachmentIds, @subject, @body, @rationale, @status, @createdAt, @sentAt, @sendAt)`,
    ).run({ ...d, ccEmails: d.ccEmails ?? null, attachmentIds: d.attachmentIds ?? null, sendAt: d.sendAt ?? null });
  },
  setSendAt(id: string, sendAt: string | null) {
    getDb().prepare('UPDATE drafts SET sendAt = ? WHERE id = ?').run(sendAt, id);
  },
  due(nowIso: string): Draft[] {
    return getDb()
      .prepare("SELECT * FROM drafts WHERE status = 'pending' AND sendAt IS NOT NULL AND sendAt <= ?")
      .all(nowIso) as Draft[];
  },
  get(id: string): Draft | undefined {
    return getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
  },
  pending(): Draft[] {
    return getDb()
      .prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY createdAt DESC")
      .all() as Draft[];
  },
  recentForDeal(dealId: string, sinceIso: string): Draft[] {
    return getDb()
      .prepare("SELECT * FROM drafts WHERE dealId = ? AND createdAt >= ?")
      .all(dealId, sinceIso) as Draft[];
  },
  existsForMessage(inReplyTo: string): boolean {
    return !!getDb()
      .prepare("SELECT 1 FROM drafts WHERE inReplyTo = ? AND status IN ('pending','sent')")
      .get(inReplyTo);
  },
  forMessage(inReplyTo: string): Draft | undefined {
    return getDb()
      .prepare("SELECT * FROM drafts WHERE inReplyTo = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 1")
      .get(inReplyTo) as Draft | undefined;
  },
  setStatus(id: string, status: Draft['status'], sentAt: string | null = null) {
    getDb().prepare('UPDATE drafts SET status = ?, sentAt = ? WHERE id = ?').run(status, sentAt, id);
  },
};

// ── Suppressed senders (do-not-draft list) ───────────────────────────────
export const suppressed = {
  add(email: string) {
    getDb().prepare('INSERT INTO suppressed (email, ts) VALUES (?, ?) ON CONFLICT(email) DO NOTHING').run(
      email.toLowerCase().trim(),
      new Date().toISOString(),
    );
  },
  remove(email: string) {
    getDb().prepare('DELETE FROM suppressed WHERE email = ?').run(email.toLowerCase().trim());
  },
  has(email: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM suppressed WHERE email = ?').get((email || '').toLowerCase().trim());
  },
  all(): string[] {
    return (getDb().prepare('SELECT email FROM suppressed ORDER BY ts DESC').all() as { email: string }[]).map((r) => r.email);
  },
};

// ── Contacts (CRM) ───────────────────────────────────────────────────────
export const contacts = {
  /** Note that we've seen this address (mail in/out). Fills name if we don't have one. */
  seen(email: string, name = '', whenIso?: string) {
    const e = (email || '').toLowerCase().trim();
    if (!e || !e.includes('@')) return;
    const when = whenIso || new Date().toISOString();
    const existing = getDb().prepare('SELECT email, name FROM contacts WHERE email = ?').get(e) as { email: string; name: string } | undefined;
    if (existing) {
      getDb().prepare('UPDATE contacts SET name = CASE WHEN (name IS NULL OR name = \'\') AND ? <> \'\' THEN ? ELSE name END, lastSeen = ? WHERE email = ?')
        .run(name, name, when, e);
    } else {
      getDb().prepare('INSERT INTO contacts (email, name, company, title, phone, notes, tags, firstSeen, lastSeen, updatedAt) VALUES (?, ?, \'\', \'\', \'\', \'\', \'\', ?, ?, ?)')
        .run(e, name, when, when, when);
    }
  },
  get(email: string): Contact | undefined {
    return getDb().prepare('SELECT * FROM contacts WHERE email = ?').get((email || '').toLowerCase().trim()) as Contact | undefined;
  },
  save(c: Partial<Contact> & { email: string }) {
    const e = c.email.toLowerCase().trim();
    const cur = this.get(e) ?? { email: e, name: '', company: '', title: '', phone: '', notes: '', tags: '', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const merged = { ...cur, ...c, email: e, updatedAt: new Date().toISOString() };
    getDb().prepare(
      `INSERT INTO contacts (email, name, company, title, phone, notes, tags, firstSeen, lastSeen, updatedAt)
       VALUES (@email, @name, @company, @title, @phone, @notes, @tags, @firstSeen, @lastSeen, @updatedAt)
       ON CONFLICT(email) DO UPDATE SET name=@name, company=@company, title=@title, phone=@phone, notes=@notes, tags=@tags, lastSeen=@lastSeen, updatedAt=@updatedAt`,
    ).run(merged);
    return merged as Contact;
  },
  all(limit = 1000): Contact[] {
    return getDb().prepare('SELECT * FROM contacts ORDER BY lastSeen DESC LIMIT ?').all(limit) as Contact[];
  },
  suggest(q: string, limit = 8): Contact[] {
    const like = `%${q}%`;
    return getDb().prepare('SELECT * FROM contacts WHERE email LIKE ? OR name LIKE ? OR company LIKE ? ORDER BY lastSeen DESC LIMIT ?').all(like, like, like, limit) as Contact[];
  },
};

// ── Sales repository (attachments Big Dog can send) ──────────────────────
export const attachments = {
  add(a: Attachment) {
    getDb().prepare('INSERT INTO attachments (id, name, mime, size, path, notes, createdAt) VALUES (@id, @name, @mime, @size, @path, @notes, @createdAt)').run(a);
  },
  all(): Attachment[] {
    return getDb().prepare('SELECT * FROM attachments ORDER BY createdAt DESC').all() as Attachment[];
  },
  get(id: string): Attachment | undefined {
    return getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Attachment | undefined;
  },
  delete(id: string) {
    getDb().prepare('DELETE FROM attachments WHERE id = ?').run(id);
  },
};

// ── Drip sequences + enrollments ─────────────────────────────────────────
export const sequences = {
  all(): Sequence[] {
    return (getDb().prepare('SELECT * FROM sequences ORDER BY createdAt DESC').all() as any[]).map((r) => ({
      id: r.id, name: r.name, steps: JSON.parse(r.steps || '[]'), active: !!r.active, autoSend: !!r.autoSend, createdAt: r.createdAt,
    }));
  },
  get(id: string): Sequence | undefined {
    const r = getDb().prepare('SELECT * FROM sequences WHERE id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name, steps: JSON.parse(r.steps || '[]'), active: !!r.active, autoSend: !!r.autoSend, createdAt: r.createdAt } : undefined;
  },
  upsert(s: Sequence) {
    getDb().prepare('INSERT INTO sequences (id, name, steps, active, autoSend, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, steps=excluded.steps, active=excluded.active, autoSend=excluded.autoSend')
      .run(s.id, s.name, JSON.stringify(s.steps), s.active ? 1 : 0, s.autoSend ? 1 : 0, s.createdAt);
  },
  delete(id: string) {
    getDb().prepare('DELETE FROM sequences WHERE id = ?').run(id);
    getDb().prepare('DELETE FROM enrollments WHERE sequenceId = ?').run(id);
  },
};

export const enrollments = {
  add(e: Enrollment) {
    getDb().prepare(`INSERT INTO enrollments (id, sequenceId, email, name, company, accountId, dealId, step, status, startedAt, nextRunAt, lastError)
      VALUES (@id, @sequenceId, @email, @name, @company, @accountId, @dealId, @step, @status, @startedAt, @nextRunAt, @lastError)`).run(e);
  },
  update(e: Enrollment) {
    getDb().prepare('UPDATE enrollments SET step=@step, status=@status, nextRunAt=@nextRunAt, lastError=@lastError WHERE id=@id').run(e);
  },
  all(): Enrollment[] {
    return getDb().prepare('SELECT * FROM enrollments ORDER BY nextRunAt ASC').all() as Enrollment[];
  },
  due(nowIso: string): Enrollment[] {
    return getDb().prepare("SELECT * FROM enrollments WHERE status = 'active' AND nextRunAt <= ? ORDER BY nextRunAt ASC LIMIT 50").all(nowIso) as Enrollment[];
  },
  activeForEmail(email: string): Enrollment[] {
    return getDb().prepare("SELECT * FROM enrollments WHERE lower(email) = ? AND status = 'active'").all((email || '').toLowerCase().trim()) as Enrollment[];
  },
  existsActive(sequenceId: string, email: string): boolean {
    return !!getDb().prepare("SELECT 1 FROM enrollments WHERE sequenceId = ? AND lower(email) = ? AND status = 'active'").get(sequenceId, (email || '').toLowerCase().trim());
  },
};

// ── Digests ─────────────────────────────────────────────────────────────
export const digests = {
  upsert(d: Digest) {
    getDb().prepare(
      `INSERT INTO digests (id, date, content, createdAt) VALUES (@id, @date, @content, @createdAt)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, createdAt=excluded.createdAt`,
    ).run(d);
  },
  latest(): Digest | undefined {
    return getDb().prepare('SELECT * FROM digests ORDER BY date DESC LIMIT 1').get() as Digest | undefined;
  },
};

// ── Memories (long-term relationship context per contact) ────────────────
export const memories = {
  add(contactEmail: string, content: string) {
    getDb().prepare('INSERT INTO memories (id, contactEmail, content, createdAt) VALUES (?, ?, ?, ?)').run(
      randomUUID().slice(0, 16),
      contactEmail.toLowerCase(),
      content,
      new Date().toISOString(),
    );
  },
  forContact(contactEmail: string, limit = 12): { content: string; createdAt: string }[] {
    return getDb()
      .prepare('SELECT content, createdAt FROM memories WHERE contactEmail = ? ORDER BY createdAt DESC LIMIT ?')
      .all(contactEmail.toLowerCase(), limit) as { content: string; createdAt: string }[];
  },
  /** Compact recall string for prompt injection. */
  recall(contactEmail: string): string {
    const rows = this.forContact(contactEmail);
    if (!rows.length) return '';
    return rows.map((r) => `- ${r.content} (${r.createdAt.slice(0, 10)})`).join('\n');
  },
  count(): number {
    return (getDb().prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
  },
};

// ── Learned email patterns (per company domain) ─────────────────────────
export interface DomainPattern {
  domain: string;
  patternKey: string;
  sample: string;
  source: string;
  updatedAt: string;
}

export const patterns = {
  get(domain: string): DomainPattern | undefined {
    return getDb().prepare('SELECT * FROM patterns WHERE domain = ?').get(domain.toLowerCase()) as DomainPattern | undefined;
  },
  set(domain: string, patternKey: string, sample: string, source: string) {
    getDb().prepare(
      `INSERT INTO patterns (domain, patternKey, sample, source, updatedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET patternKey=excluded.patternKey, sample=excluded.sample, source=excluded.source, updatedAt=excluded.updatedAt`,
    ).run(domain.toLowerCase(), patternKey, sample, source, new Date().toISOString());
  },
};

// ── Settings (runtime config: provider + keys, set from the dashboard) ───
export const settingsStore = {
  get(key: string): string | undefined {
    const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  },
  set(key: string, value: string) {
    getDb().prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, value);
  },
  all(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
};

// ── Activity log (what Big Dog did) ──────────────────────────────────────
export interface ActivityEntry {
  ts: string;
  type: string;
  message: string;
}
export const activity = {
  add(type: string, message: string) {
    getDb().prepare('INSERT INTO activity (ts, type, message) VALUES (?, ?, ?)').run(new Date().toISOString(), type, message);
    getDb().prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 500)').run();
  },
  recent(limit = 100): ActivityEntry[] {
    return getDb().prepare('SELECT ts, type, message FROM activity ORDER BY id DESC LIMIT ?').all(limit) as ActivityEntry[];
  },
};

// ── Mail accounts added in-app (file accounts live in config/accounts.json) ─
export const mailAccountsStore = {
  all(): Account[] {
    const rows = getDb().prepare('SELECT json FROM mailaccounts').all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Account);
  },
  set(account: Account) {
    getDb().prepare('INSERT INTO mailaccounts (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(
      account.id,
      JSON.stringify(account),
    );
  },
  delete(id: string) {
    getDb().prepare('DELETE FROM mailaccounts WHERE id = ?').run(id);
  },
};

export function isEmpty(): boolean {
  return messages.count() === 0 && deals.all().length === 0;
}

