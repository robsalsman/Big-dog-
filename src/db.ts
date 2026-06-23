import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
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
} from './types.js';

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(resolve(DATA_DIR, 'bigdog.sqlite'));
db.pragma('journal_mode = WAL');

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

  CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_deal ON messages(dealId);
  CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);
`);

// Migration: add drafts.sendAt to pre-existing databases.
{
  const cols = db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'sendAt')) db.exec('ALTER TABLE drafts ADD COLUMN sendAt TEXT');
}

// ── Messages ────────────────────────────────────────────────────────────
export const messages = {
  upsert(m: Message) {
    db.prepare(
      `INSERT INTO messages (id, accountId, messageId, threadId, fromName, fromEmail,
        toEmails, subject, snippet, body, date, folder, unread, dealId, priority, summary, analyzed)
       VALUES (@id, @accountId, @messageId, @threadId, @fromName, @fromEmail,
        @toEmails, @subject, @snippet, @body, @date, @folder, @unread, @dealId, @priority, @summary, @analyzed)
       ON CONFLICT(id) DO UPDATE SET unread=excluded.unread`,
    ).run(m);
  },
  exists(id: string): boolean {
    return !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
  },
  get(id: string): Message | undefined {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
  },
  recent(limit = 100): Message[] {
    // The main feed is received mail; sent mail still appears inside threads.
    return db.prepare("SELECT * FROM messages WHERE folder IS NULL OR folder != 'SENT' ORDER BY date DESC LIMIT ?").all(limit) as Message[];
  },
  recentSent(limit = 100): Message[] {
    return db.prepare("SELECT * FROM messages WHERE folder = 'SENT' ORDER BY date DESC LIMIT ?").all(limit) as Message[];
  },
  thread(threadId: string): Message[] {
    return db.prepare('SELECT * FROM messages WHERE threadId = ? ORDER BY date ASC').all(threadId) as Message[];
  },
  unanalyzed(limit = 20): Message[] {
    return db
      .prepare('SELECT * FROM messages WHERE analyzed = 0 ORDER BY date DESC LIMIT ?')
      .all(limit) as Message[];
  },
  setAnalysis(id: string, priority: string, summary: string, dealId: string | null) {
    db.prepare(
      'UPDATE messages SET analyzed = 1, priority = ?, summary = ?, dealId = ? WHERE id = ?',
    ).run(priority, summary, dealId, id);
  },
  markRead(id: string) {
    db.prepare('UPDATE messages SET unread = 0 WHERE id = ?').run(id);
  },
  count(): number {
    return (db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
  },
  search(q: string, limit = 50): Message[] {
    const like = `%${q}%`;
    return db
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
    db.prepare(
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
    return db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as Deal | undefined;
  },
  findByContact(email: string): Deal | undefined {
    return db
      .prepare('SELECT * FROM deals WHERE lower(contactEmail) = lower(?) AND stage NOT IN (?, ?)')
      .get(email, 'won', 'lost') as Deal | undefined;
  },
  all(): Deal[] {
    return db.prepare('SELECT * FROM deals ORDER BY updatedAt DESC').all() as Deal[];
  },
  search(q: string, limit = 30): Deal[] {
    const like = `%${q}%`;
    return db
      .prepare(
        `SELECT * FROM deals
         WHERE title LIKE ? OR company LIKE ? OR contactName LIKE ? OR contactEmail LIKE ? OR nextStep LIKE ?
         ORDER BY updatedAt DESC LIMIT ?`,
      )
      .all(like, like, like, like, like, limit) as Deal[];
  },
  setStage(id: string, stage: DealStage) {
    db.prepare('UPDATE deals SET stage = ?, updatedAt = ? WHERE id = ?').run(
      stage,
      new Date().toISOString(),
      id,
    );
  },
};

// ── Calendar ────────────────────────────────────────────────────────────
export const events = {
  upsert(e: CalendarEvent) {
    db.prepare(
      `INSERT INTO events (id, title, start, end, location, attendees, notes, dealId, source)
       VALUES (@id, @title, @start, @end, @location, @attendees, @notes, @dealId, @source)
       ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, start=excluded.start, end=excluded.end,
        location=excluded.location, attendees=excluded.attendees, notes=excluded.notes`,
    ).run(e);
  },
  all(): CalendarEvent[] {
    return db.prepare('SELECT * FROM events ORDER BY start ASC').all() as CalendarEvent[];
  },
  upcoming(): CalendarEvent[] {
    return db
      .prepare('SELECT * FROM events WHERE start >= ? ORDER BY start ASC')
      .all(new Date().toISOString()) as CalendarEvent[];
  },
};

// ── Drafts ──────────────────────────────────────────────────────────────
export const drafts = {
  insert(d: Draft) {
    db.prepare(
      `INSERT INTO drafts (id, accountId, inReplyTo, dealId, toEmails, subject, body, rationale, status, createdAt, sentAt, sendAt)
       VALUES (@id, @accountId, @inReplyTo, @dealId, @toEmails, @subject, @body, @rationale, @status, @createdAt, @sentAt, @sendAt)`,
    ).run({ ...d, sendAt: d.sendAt ?? null });
  },
  setSendAt(id: string, sendAt: string | null) {
    db.prepare('UPDATE drafts SET sendAt = ? WHERE id = ?').run(sendAt, id);
  },
  due(nowIso: string): Draft[] {
    return db
      .prepare("SELECT * FROM drafts WHERE status = 'pending' AND sendAt IS NOT NULL AND sendAt <= ?")
      .all(nowIso) as Draft[];
  },
  get(id: string): Draft | undefined {
    return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
  },
  pending(): Draft[] {
    return db
      .prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY createdAt DESC")
      .all() as Draft[];
  },
  recentForDeal(dealId: string, sinceIso: string): Draft[] {
    return db
      .prepare("SELECT * FROM drafts WHERE dealId = ? AND createdAt >= ?")
      .all(dealId, sinceIso) as Draft[];
  },
  existsForMessage(inReplyTo: string): boolean {
    return !!db
      .prepare("SELECT 1 FROM drafts WHERE inReplyTo = ? AND status IN ('pending','sent')")
      .get(inReplyTo);
  },
  forMessage(inReplyTo: string): Draft | undefined {
    return db
      .prepare("SELECT * FROM drafts WHERE inReplyTo = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 1")
      .get(inReplyTo) as Draft | undefined;
  },
  setStatus(id: string, status: Draft['status'], sentAt: string | null = null) {
    db.prepare('UPDATE drafts SET status = ?, sentAt = ? WHERE id = ?').run(status, sentAt, id);
  },
};

// ── Suppressed senders (do-not-draft list) ───────────────────────────────
export const suppressed = {
  add(email: string) {
    db.prepare('INSERT INTO suppressed (email, ts) VALUES (?, ?) ON CONFLICT(email) DO NOTHING').run(
      email.toLowerCase().trim(),
      new Date().toISOString(),
    );
  },
  remove(email: string) {
    db.prepare('DELETE FROM suppressed WHERE email = ?').run(email.toLowerCase().trim());
  },
  has(email: string): boolean {
    return !!db.prepare('SELECT 1 FROM suppressed WHERE email = ?').get((email || '').toLowerCase().trim());
  },
  all(): string[] {
    return (db.prepare('SELECT email FROM suppressed ORDER BY ts DESC').all() as { email: string }[]).map((r) => r.email);
  },
};

// ── Digests ─────────────────────────────────────────────────────────────
export const digests = {
  upsert(d: Digest) {
    db.prepare(
      `INSERT INTO digests (id, date, content, createdAt) VALUES (@id, @date, @content, @createdAt)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, createdAt=excluded.createdAt`,
    ).run(d);
  },
  latest(): Digest | undefined {
    return db.prepare('SELECT * FROM digests ORDER BY date DESC LIMIT 1').get() as Digest | undefined;
  },
};

// ── Memories (long-term relationship context per contact) ────────────────
export const memories = {
  add(contactEmail: string, content: string) {
    db.prepare('INSERT INTO memories (id, contactEmail, content, createdAt) VALUES (?, ?, ?, ?)').run(
      randomUUID().slice(0, 16),
      contactEmail.toLowerCase(),
      content,
      new Date().toISOString(),
    );
  },
  forContact(contactEmail: string, limit = 12): { content: string; createdAt: string }[] {
    return db
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
    return (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
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
    return db.prepare('SELECT * FROM patterns WHERE domain = ?').get(domain.toLowerCase()) as DomainPattern | undefined;
  },
  set(domain: string, patternKey: string, sample: string, source: string) {
    db.prepare(
      `INSERT INTO patterns (domain, patternKey, sample, source, updatedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET patternKey=excluded.patternKey, sample=excluded.sample, source=excluded.source, updatedAt=excluded.updatedAt`,
    ).run(domain.toLowerCase(), patternKey, sample, source, new Date().toISOString());
  },
};

// ── Settings (runtime config: provider + keys, set from the dashboard) ───
export const settingsStore = {
  get(key: string): string | undefined {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  },
  set(key: string, value: string) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, value);
  },
  all(): Record<string, string> {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
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
    db.prepare('INSERT INTO activity (ts, type, message) VALUES (?, ?, ?)').run(new Date().toISOString(), type, message);
    db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 500)').run();
  },
  recent(limit = 100): ActivityEntry[] {
    return db.prepare('SELECT ts, type, message FROM activity ORDER BY id DESC LIMIT ?').all(limit) as ActivityEntry[];
  },
};

// ── Mail accounts added in-app (file accounts live in config/accounts.json) ─
export const mailAccountsStore = {
  all(): Account[] {
    const rows = db.prepare('SELECT json FROM mailaccounts').all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Account);
  },
  set(account: Account) {
    db.prepare('INSERT INTO mailaccounts (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(
      account.id,
      JSON.stringify(account),
    );
  },
  delete(id: string) {
    db.prepare('DELETE FROM mailaccounts WHERE id = ?').run(id);
  },
};

export function isEmpty(): boolean {
  return messages.count() === 0 && deals.all().length === 0;
}

export default db;
