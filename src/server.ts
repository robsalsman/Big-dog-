import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { messages, deals, events, drafts } from './db.js';
import { syncAll } from './mail/ingest.js';
import { sendMail } from './mail/send.js';
import { triageNewMail } from './pipeline.js';
import { generateDigest } from './digest.js';
import { exportIcs } from './calendar.js';
import type { BigDogBrain } from './claude.js';
import type { AppConfig } from './config.js';
import type { AccountsConfig, DealStage, Draft } from './types.js';
import { DEAL_STAGES } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '..', 'public');

export function createServer(cfg: AppConfig, accountsCfg: AccountsConfig, brain: BigDogBrain) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(PUBLIC_DIR));

  const accountById = (id: string) => accountsCfg.accounts.find((a) => a.id === id);

  // ── Whole-world snapshot for the dashboard ──────────────────────────
  app.get('/api/state', (_req, res) => {
    res.json({
      owner: cfg.owner,
      brainLive: brain.live,
      sendMode: cfg.sendMode,
      accounts: accountsCfg.accounts.map((a) => ({ id: a.id, label: a.label, email: a.email })),
      stages: DEAL_STAGES,
      messages: messages.recent(100),
      deals: deals.all(),
      events: events.all(),
      drafts: drafts.pending(),
      digest: undefined as undefined | string,
    });
  });

  // ── Sync mailboxes, then triage ─────────────────────────────────────
  app.post('/api/sync', async (_req, res) => {
    try {
      const synced = await syncAll(accountsCfg.accounts);
      const triaged = await triageNewMail(brain);
      res.json({ synced, triaged });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/triage', async (_req, res) => {
    try {
      const triaged = await triageNewMail(brain);
      res.json({ triaged });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Draft a reply in the owner's voice ──────────────────────────────
  app.post('/api/messages/:id/draft', async (req, res) => {
    const m = messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'message not found' });
    const deal = m.dealId ? deals.get(m.dealId) ?? null : null;
    try {
      const { subject, body, rationale } = await brain.draftReply(m, deal);
      const draft: Draft = {
        id: randomUUID().slice(0, 16),
        accountId: m.accountId,
        inReplyTo: m.messageId,
        dealId: m.dealId,
        toEmails: m.fromEmail,
        subject,
        body,
        rationale,
        status: 'pending',
        createdAt: new Date().toISOString(),
        sentAt: null,
      };
      drafts.insert(draft);

      // In auto mode, fire it immediately if we can.
      if (cfg.sendMode === 'auto') {
        const account = accountById(m.accountId);
        if (account) {
          await sendMail(account, { to: draft.toEmails, subject, body, inReplyTo: m.messageId });
          drafts.setStatus(draft.id, 'sent', new Date().toISOString());
        }
      }
      res.json({ draft, autoSent: cfg.sendMode === 'auto' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/messages/:id/read', (req, res) => {
    messages.markRead(req.params.id);
    res.json({ ok: true });
  });

  // ── Approve / send / discard a draft ────────────────────────────────
  app.post('/api/drafts/:id/send', async (req, res) => {
    const draft = drafts.get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'draft not found' });
    const account = accountById(draft.accountId);
    if (!account) {
      drafts.setStatus(draft.id, 'sent', new Date().toISOString());
      return res.json({ ok: true, note: 'No live account for this draft (demo) — marked as sent.' });
    }
    try {
      const body = (req.body?.body as string) ?? draft.body;
      const subject = (req.body?.subject as string) ?? draft.subject;
      await sendMail(account, { to: draft.toEmails, subject, body, inReplyTo: draft.inReplyTo });
      drafts.setStatus(draft.id, 'sent', new Date().toISOString());
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/drafts/:id/discard', (req, res) => {
    drafts.setStatus(req.params.id, 'discarded');
    res.json({ ok: true });
  });

  // ── Pipeline edits ──────────────────────────────────────────────────
  app.patch('/api/deals/:id', (req, res) => {
    const deal = deals.get(req.params.id);
    if (!deal) return res.status(404).json({ error: 'deal not found' });
    const stage = req.body?.stage as DealStage | undefined;
    const updated = {
      ...deal,
      stage: stage && DEAL_STAGES.includes(stage) ? stage : deal.stage,
      title: req.body?.title ?? deal.title,
      value: req.body?.value ?? deal.value,
      nextStep: req.body?.nextStep ?? deal.nextStep,
      nextStepDue: req.body?.nextStepDue ?? deal.nextStepDue,
      notes: req.body?.notes ?? deal.notes,
      updatedAt: new Date().toISOString(),
    };
    deals.upsert(updated);
    res.json(updated);
  });

  app.post('/api/deals', (req, res) => {
    const now = new Date().toISOString();
    const deal = {
      id: randomUUID().slice(0, 16),
      title: req.body?.title ?? 'New deal',
      contactName: req.body?.contactName ?? '',
      contactEmail: req.body?.contactEmail ?? '',
      company: req.body?.company ?? '',
      stage: (req.body?.stage as DealStage) ?? 'new',
      value: req.body?.value ?? null,
      notes: req.body?.notes ?? '',
      nextStep: req.body?.nextStep ?? 'Reach out',
      nextStepDue: req.body?.nextStepDue ?? null,
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
    };
    deals.upsert(deal);
    res.json(deal);
  });

  // ── Calendar ────────────────────────────────────────────────────────
  app.post('/api/events', (req, res) => {
    const start = req.body?.start ?? new Date().toISOString();
    const event = {
      id: randomUUID().slice(0, 16),
      title: req.body?.title ?? 'New event',
      start,
      end: req.body?.end ?? new Date(new Date(start).getTime() + 1_800_000).toISOString(),
      location: req.body?.location ?? '',
      attendees: req.body?.attendees ?? '',
      notes: req.body?.notes ?? '',
      dealId: req.body?.dealId ?? null,
      source: 'manual',
    };
    events.upsert(event);
    res.json(event);
  });

  app.get('/calendar.ics', (_req, res) => {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="big-dog.ics"');
    res.send(exportIcs());
  });

  // ── Digest + chat ───────────────────────────────────────────────────
  app.post('/api/digest', async (_req, res) => {
    try {
      const content = await generateDigest(brain);
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const question = (req.body?.question as string) ?? '';
    if (!question.trim()) return res.status(400).json({ error: 'empty question' });
    try {
      const answer = await brain.chat(question, deals.all(), messages.recent(40), events.upcoming());
      res.json({ answer });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return app;
}
