import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { messages, deals, events, drafts, memories, activity } from './db.js';
import { logActivity } from './activity.js';
import { runAgent } from './agent/agent.js';
import { runCadenceSweep } from './cadence.js';
import { findProspects, saveProspectAsDeal, activeProvider, findContactEmail, parseCsv, enrichRows } from './prospect.js';
import { runCampaign } from './campaign.js';
import { recordSentMessage } from './sentmail.js';
import { allAccounts, getAccount, fileAccountIds, saveAccount, deleteAccount, testAccount } from './accounts.js';
import type { Account } from './types.js';
import { loadSettings, saveSettings, buildProvider, publicSettings, testProvider } from './settings.js';
import { loadOwner, saveOwner } from './profile.js';
import {
  isAuthConfigured, setPassword, verifyPassword, issueToken, verifyToken, parseCookies, COOKIE,
} from './auth.js';
import type { Prospect } from './types.js';
import { syncAll } from './mail/ingest.js';
import { sendMail } from './mail/send.js';
import { triageNewMail } from './pipeline.js';
import { generateDigest } from './digest.js';
import { exportIcs } from './calendar.js';
import { calcomConfigured, syncCalcomBookings } from './calcom.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';
import type { AccountsConfig, DealStage, Draft } from './types.js';
import { DEAL_STAGES } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '..', 'public');

export function createServer(cfg: AppConfig, accountsCfg: AccountsConfig, brain: BigDogBrain) {
  const app = express();
  app.set('trust proxy', 1); // behind a TLS reverse proxy (Caddy/nginx) in production
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(PUBLIC_DIR));

  // Health check for proxies / uptime monitors (unauthenticated).
  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Parse cookies for auth.
  app.use((req, _res, next) => {
    (req as unknown as { cookies: Record<string, string> }).cookies = parseCookies(req.headers.cookie);
    next();
  });
  const cookieOf = (req: express.Request) => (req as unknown as { cookies: Record<string, string> }).cookies?.[COOKIE];
  const setSession = (req: express.Request, res: express.Response, token: string, maxAgeSec: number) => {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  };

  // ── Auth (unguarded) ────────────────────────────────────────────────
  app.get('/api/auth/status', (req, res) => {
    res.json({ required: isAuthConfigured(), authed: !isAuthConfigured() || verifyToken(cookieOf(req)) });
  });
  app.post('/api/auth/login', (req, res) => {
    if (!isAuthConfigured() || verifyPassword(String(req.body?.password ?? ''))) {
      setSession(req, res, issueToken(), 30 * 86_400);
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'wrong password' });
  });
  app.post('/api/auth/logout', (req, res) => {
    setSession(req, res, '', 0);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', (req, res) => {
    const next = String(req.body?.password ?? '');
    if (next.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    // To change an existing password you must already be authed (or give the current one).
    if (isAuthConfigured()) {
      const ok = verifyToken(cookieOf(req)) || verifyPassword(String(req.body?.current ?? ''));
      if (!ok) return res.status(401).json({ error: 'current password or login required' });
    }
    setPassword(next);
    setSession(req, res, issueToken(), 30 * 86_400);
    res.json({ ok: true });
  });

  // ── Guard everything else under /api ────────────────────────────────
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/api/auth/')) return next();
    if (!isAuthConfigured() || verifyToken(cookieOf(req))) return next();
    res.status(401).json({ error: 'authentication required' });
  });

  const accountById = (id: string) => getAccount(id);
  const agentCtx = { cfg, accounts: accountsCfg, brain };

  // ── Whole-world snapshot for the dashboard ──────────────────────────
  app.get('/api/state', (_req, res) => {
    res.json({
      owner: cfg.owner,
      brainLive: brain.live,
      backend: brain.backend,
      sendMode: cfg.sendMode,
      autoDraft: cfg.autoDraft,
      accounts: allAccounts().map((a) => ({ id: a.id, label: a.label, email: a.email })),
      stages: DEAL_STAGES,
      calcom: { configured: calcomConfigured(cfg), bookingUrl: cfg.calcom?.bookingUrl ?? '' },
      prospect: activeProvider(cfg),
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
      const synced = await syncAll(allAccounts());
      const triaged = await triageNewMail(brain, cfg, accountsCfg);
      const bookings = calcomConfigured(cfg) ? await syncCalcomBookings(cfg).catch(() => 0) : 0;
      const newMail = synced.reduce((n, s) => n + s.added, 0);
      logActivity('sync', `Synced ${newMail} new message(s)${bookings ? `, ${bookings} booking(s)` : ''}`);
      for (const s of synced) if (s.error) logActivity('error', `Mailbox ${s.account}: ${s.error}`);
      res.json({ synced, triaged, bookings });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/calcom/sync', async (_req, res) => {
    if (!calcomConfigured(cfg)) return res.status(400).json({ error: 'Cal.com not configured' });
    try {
      const bookings = await syncCalcomBookings(cfg);
      res.json({ bookings });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/triage', async (_req, res) => {
    try {
      const triaged = await triageNewMail(brain, cfg, accountsCfg);
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
    const memory = m.fromEmail ? memories.recall(m.fromEmail) : '';
    const thread = messages.thread(m.threadId);
    try {
      const { subject, body, rationale } = await brain.draftReply(m, deal, memory, thread);
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
          recordSentMessage({ accountId: account.id, fromName: account.label, fromEmail: account.email, toEmails: draft.toEmails, subject, body });
        }
      }
      logActivity('draft', `Drafted reply to ${m.fromName} <${m.fromEmail}>`);
      res.json({ draft, autoSent: cfg.sendMode === 'auto' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/messages/:id/read', (req, res) => {
    messages.markRead(req.params.id);
    res.json({ ok: true });
  });

  // Full conversation thread for a message.
  app.get('/api/threads/:id', (req, res) => {
    res.json({ messages: messages.thread(req.params.id) });
  });

  // Activity log — what Big Dog has been doing.
  app.get('/api/activity', (_req, res) => {
    res.json({ activity: activity.recent(120) });
  });

  // Schedule a draft to send later (or clear the schedule with sendAt:null).
  app.post('/api/drafts/:id/schedule', (req, res) => {
    const draft = drafts.get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'draft not found' });
    const sendAt = req.body?.sendAt ? new Date(String(req.body.sendAt)).toISOString() : null;
    drafts.setSendAt(draft.id, sendAt);
    logActivity('schedule', sendAt ? `Scheduled email to ${draft.toEmails} for ${sendAt.slice(0, 16).replace('T', ' ')}` : `Cleared schedule for ${draft.toEmails}`);
    res.json({ ok: true, sendAt });
  });

  // ── Approve / send / discard a draft ────────────────────────────────
  app.post('/api/drafts/:id/send', async (req, res) => {
    const draft = drafts.get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'draft not found' });
    const account = accountById(draft.accountId);
    const body = (req.body?.body as string) ?? draft.body;
    const subject = (req.body?.subject as string) ?? draft.subject;
    if (!account) {
      drafts.setStatus(draft.id, 'sent', new Date().toISOString());
      const from = allAccounts()[0];
      recordSentMessage({ accountId: draft.accountId, fromName: from?.label ?? 'Me', fromEmail: from?.email ?? cfg.owner.signature.split('\n')[0] ?? 'me', toEmails: draft.toEmails, subject, body });
      logActivity('send', `Marked sent to ${draft.toEmails} (demo — no live account): "${subject}"`);
      return res.json({ ok: true, note: 'No live account for this draft (demo) — marked as sent.' });
    }
    try {
      await sendMail(account, { to: draft.toEmails, subject, body, inReplyTo: draft.inReplyTo });
      drafts.setStatus(draft.id, 'sent', new Date().toISOString());
      recordSentMessage({ accountId: account.id, fromName: account.label, fromEmail: account.email, toEmails: draft.toEmails, subject, body });
      logActivity('send', `Sent email to ${draft.toEmails}: "${subject}"`);
      res.json({ ok: true });
    } catch (err) {
      logActivity('error', `Send to ${draft.toEmails} failed: ${(err as Error).message}`);
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

  // ── Operator mode: tell Big Dog to DO something ─────────────────────
  app.post('/api/agent', async (req, res) => {
    const goal = (req.body?.goal as string) ?? '';
    if (!goal.trim()) return res.status(400).json({ error: 'empty goal' });
    try {
      const run = await runAgent(goal, agentCtx);
      res.json(run);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Lead research (web) ─────────────────────────────────────────────
  app.post('/api/research', async (req, res) => {
    const query = (req.body?.query as string) ?? '';
    if (!query.trim()) return res.status(400).json({ error: 'empty query' });
    try {
      res.json({ brief: await brain.research(query) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Follow-up cadence sweep ─────────────────────────────────────────
  app.post('/api/cadence/run', async (_req, res) => {
    try {
      const created = await runCadenceSweep(agentCtx);
      res.json({ created });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Relationship memory ─────────────────────────────────────────────
  app.post('/api/memory', (req, res) => {
    const email = (req.body?.email as string) ?? '';
    const note = (req.body?.note as string) ?? '';
    if (!email.trim() || !note.trim()) return res.status(400).json({ error: 'need email and note' });
    memories.add(email, note);
    res.json({ ok: true, recall: memories.recall(email) });
  });

  app.get('/api/memory/:email', (req, res) => {
    res.json({ recall: memories.recall(req.params.email) });
  });

  // ── Prospecting / lead gen ──────────────────────────────────────────
  app.post('/api/prospect/find', async (req, res) => {
    const criteria = (req.body?.criteria as string) ?? '';
    if (!criteria.trim()) return res.status(400).json({ error: 'describe who to find' });
    try {
      const prospects = await findProspects(criteria, cfg, brain);
      res.json({ provider: activeProvider(cfg), prospects });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/prospect/save', (req, res) => {
    const p = req.body?.prospect as Prospect | undefined;
    if (!p || !p.name) return res.status(400).json({ error: 'no prospect' });
    res.json({ deal: saveProspectAsDeal(p) });
  });

  // Bulk: import a CSV lead list and fill in each contact's email.
  app.post('/api/prospect/enrich', async (req, res) => {
    const rows = req.body?.csv ? parseCsv(String(req.body.csv)) : (req.body?.rows as Record<string, string>[]) ?? [];
    if (!rows.length) return res.status(400).json({ error: 'no rows — paste a CSV with a header row (name/company/domain/…)' });
    try {
      const verify = !!req.body?.verify;
      const enriched = await enrichRows(rows, brain, { verify });
      if (req.body?.save) {
        for (const r of enriched) {
          if (r.email && r.confidence !== 'skipped') {
            saveProspectAsDeal({ name: r.name, title: r.title, company: r.company, domain: r.domain, email: r.email, linkedin: '', location: '', source: 'csv', notes: `${r.confidence} (${r.method})` });
          }
        }
      }
      res.json({ count: enriched.length, rows: enriched });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // The campaign play: enrich a list → (research top N) → draft intros to all.
  app.post('/api/campaign/run', async (req, res) => {
    const rows = req.body?.csv ? parseCsv(String(req.body.csv)) : (req.body?.rows as Record<string, string>[]) ?? [];
    if (!rows.length) return res.status(400).json({ error: 'no rows — paste a CSV with a header row' });
    try {
      const accountId = allAccounts()[0]?.id ?? 'demo';
      const result = await runCampaign(rows, brain, accountId, {
        verify: !!req.body?.verify,
        addToPipeline: req.body?.addToPipeline !== false,
        research: Number(req.body?.research ?? 0),
        draft: req.body?.draft !== false,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Find + verify a contact's email from name + domain (Hunter-style engine).
  app.post('/api/prospect/email', async (req, res) => {
    const domain = (req.body?.domain as string) ?? '';
    const name = (req.body?.name as string) ?? '';
    if (!domain.trim() || !name.trim()) return res.status(400).json({ error: 'need name and domain' });
    try {
      res.json(await findContactEmail({ name, domain }, brain));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Owner profile + voice ───────────────────────────────────────────
  app.get('/api/profile', (_req, res) => {
    res.json(loadOwner(cfg));
  });

  app.post('/api/profile', (req, res) => {
    saveOwner(req.body ?? {});
    const owner = loadOwner(cfg);
    brain.setOwner(owner);
    res.json(owner);
  });

  // Analyze pasted emails and propose a voice profile (review before saving).
  app.post('/api/voice/learn', async (req, res) => {
    const samples = String(req.body?.samples ?? '').trim();
    if (samples.length < 80) return res.status(400).json({ error: 'paste at least a few of your real emails' });
    try {
      res.json(await brain.learnVoice(samples));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── LLM backend settings (Claude / ChatGPT / Ollama) ────────────────
  app.get('/api/settings', (_req, res) => {
    res.json({ ...publicSettings(loadSettings(cfg)), backend: brain.backend, live: brain.live });
  });

  app.post('/api/settings', async (req, res) => {
    saveSettings(req.body ?? {});
    const provider = buildProvider(loadSettings(cfg));
    if (provider.ping) await provider.ping();
    brain.setProvider(provider);
    res.json({ ...publicSettings(loadSettings(cfg)), backend: brain.backend, live: brain.live });
  });

  app.post('/api/settings/test', async (req, res) => {
    // Test the saved settings, optionally with proposed overrides from the form.
    const merged = { ...loadSettings(cfg), ...(req.body ?? {}) };
    // Ignore empty key fields in the proposed override so a blank doesn't wipe.
    if (!req.body?.anthropicKey) merged.anthropicKey = loadSettings(cfg).anthropicKey;
    if (!req.body?.openaiKey) merged.openaiKey = loadSettings(cfg).openaiKey;
    res.json(await testProvider(buildProvider(merged)));
  });

  // ── Mailbox management (in-app, no JSON editing) ────────────────────
  const acctPublic = (a: Account, fileIds: Set<string>) => ({
    id: a.id, label: a.label, email: a.email, source: fileIds.has(a.id) ? 'file' : 'app',
    imap: { host: a.imap.host, port: a.imap.port, secure: a.imap.secure, user: a.imap.user },
    smtp: { host: a.smtp.host, port: a.smtp.port, secure: a.smtp.secure, user: a.smtp.user },
  });

  app.get('/api/accounts', (_req, res) => {
    const fileIds = fileAccountIds();
    res.json({ accounts: allAccounts().map((a) => acctPublic(a, fileIds)) });
  });

  function readAccount(body: Record<string, unknown>): Account | null {
    const b = body as Record<string, any>;
    if (!b.id || !b.email || !b.imap?.host || !b.smtp?.host) return null;
    const slug = String(b.id).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return {
      id: slug,
      label: String(b.label || b.email),
      email: String(b.email),
      imap: { host: String(b.imap.host), port: Number(b.imap.port || 993), secure: b.imap.secure !== false, user: String(b.imap.user || b.email), pass: String(b.imap.pass || '') },
      smtp: { host: String(b.smtp.host), port: Number(b.smtp.port || 465), secure: !!b.smtp.secure, user: String(b.smtp.user || b.email), pass: String(b.smtp.pass || b.imap.pass || '') },
    };
  }

  app.post('/api/accounts/test', async (req, res) => {
    const a = readAccount(req.body ?? {});
    if (!a) return res.status(400).json({ error: 'need id, email, imap.host, smtp.host' });
    // Fill password from the saved account if the form left it blank.
    if (!a.imap.pass) { const existing = getAccount(a.id); if (existing) { a.imap.pass = existing.imap.pass; a.smtp.pass = a.smtp.pass || existing.smtp.pass; } }
    res.json(await testAccount(a));
  });

  app.post('/api/accounts', (req, res) => {
    const a = readAccount(req.body ?? {});
    if (!a) return res.status(400).json({ error: 'need id, email, imap.host, smtp.host' });
    if (fileAccountIds().has(a.id)) return res.status(400).json({ error: 'that id is defined in config/accounts.json (read-only here)' });
    if (!a.imap.pass) { const existing = getAccount(a.id); if (existing) { a.imap.pass = existing.imap.pass; if (!a.smtp.pass) a.smtp.pass = existing.smtp.pass; } }
    saveAccount(a);
    res.json({ ok: true });
  });

  app.delete('/api/accounts/:id', (req, res) => {
    if (fileAccountIds().has(req.params.id)) return res.status(400).json({ error: 'file account — remove it from config/accounts.json' });
    deleteAccount(req.params.id);
    res.json({ ok: true });
  });

  // ── Search across the inbox + pipeline ──────────────────────────────
  app.get('/api/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ messages: [], deals: [] });
    res.json({ messages: messages.search(q), deals: deals.search(q) });
  });

  return app;
}
