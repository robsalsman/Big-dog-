import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { DATA_DIR } from './config.js';
import { attachments } from './db.js';
import type { Attachment } from './types.js';

/**
 * The sales repository — datasheets, one-pagers, and other files Big Dog can
 * attach to outgoing emails. Files live under data/repo; metadata in SQLite.
 */
export const REPO_DIR = resolve(DATA_DIR, 'repo');

function ensureDir() {
  if (!existsSync(REPO_DIR)) mkdirSync(REPO_DIR, { recursive: true });
}

/** Save a base64-encoded upload to the repository. */
export function saveAttachment(name: string, mime: string, base64: string, notes = ''): Attachment {
  ensureDir();
  const buf = Buffer.from(base64, 'base64');
  const id = randomUUID().slice(0, 16);
  const safeExt = extname(name).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '');
  const path = resolve(REPO_DIR, `${id}${safeExt}`);
  writeFileSync(path, buf);
  const a: Attachment = {
    id,
    name: name.slice(0, 200) || 'file',
    mime: mime || 'application/octet-stream',
    size: buf.length,
    path,
    notes: notes.slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  attachments.add(a);
  return a;
}

/** Resolve attachment ids to nodemailer attachment descriptors. */
export function resolveAttachments(ids: string[]): { filename: string; path: string; contentType: string }[] {
  const out: { filename: string; path: string; contentType: string }[] = [];
  for (const id of ids) {
    const a = attachments.get(id);
    if (a && existsSync(a.path)) out.push({ filename: a.name, path: a.path, contentType: a.mime });
  }
  return out;
}
