import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { messages, deals, events, drafts, memories, activity, suppressed, contacts, sequences, enrollments, attachments, runWithUser, setContextBrain, currentBrainRaw, currentUserId, users, getDb, mailAccountsStore } from './db.js';
import { saveAttachment, resolveAttachments } from './repo.js';
import { createSequence, enrollContacts, runDueEnrollments, DEFAULT_SEQUENCE_STEPS } from './sequences.js';
import { runAutopilot } from './autopilot.js';
import { logActivity } from './activity.js';
import { runAgent } from './agent/agent.js';
import { runCadenceSweep } from './cadence.js';
import { findProspects, saveProspectAsDeal, activeProvider, findContactEmail, normalizeCsv, enrichRows } from './prospect.js';
import { runCampaign } from './campaign.js';
import { recordSentMessage } from './sentmail.js';
import { allAccounts, getAccount, fileAccountIds, saveAccount, deleteAccount, testAccount } from './accounts.js';
import { discoverMailConfig } from './maildiscovery.js';
import type { Account } from './types.js';
import { loadSettings, saveSettings, buildProvider, publicSettings, testProvider } from './settings.js';
import { loadOwner, saveOwner } from './profile.js';
import {
  anyUsers, createAccount, verifyCredentials, setUserPassword, issueToken, verifyToken, parseCookies, COOKIE,
} from './auth.js';
import { brainForUser } from './userbrain.js';
import type { Prospect } from './types.js';
import { syncAll } from './mail/ingest.js';
import { sendMail } from './mail/send.js';
import { triageNewMail } from './pipeline.js';
import { generateDigest } from './digest.js';
import { exportIcs } from './calendar.js';
import { calcomConfigured, syncCalcomBookings } from './calcom.js';
import { zoomConfigured, createZoomMeeting, saveZoomCreds, publicZoom, testZoom, getMeetingTranscript } from './zoom.js';
import { twilioConfigured, saveTwilioCreds, publicTwilio, testTwilio, sendSms, makeCall, loadTwilioCreds } from './twilio.js';
import { bookFromMessage } from './booking.js';
import { handleOwnerSms } from './smscommands.js';
import { voiceConfigured, loadVoiceSettings, saveVoiceSettings, publicVoice, testVoice, synthesize, saveVoiceSample, voiceFilePath } from './voice.js';
import { verifierConfigured, saveVerifySettings, publicVerify, testVerifier } from './emailverify.js';
import { browserConfigured, browserReady } from './browser.js';
import { managedActive } from './managed.js';
import { vault, publicVault } from './secrets.js';
import { invalidateAllBrains } from './userbrain.js';
import { stripeConfigured, packs, savePacks, createCheckout, verifySignature, handleEvent, type Pack } from './economy/stripe.js';
import { grant } from './economy/ledger.js';
import { summary as economySummary, setBudget, remainingThisMonth, ensureAccount } from './economy/ledger.js';
import { rateCard, saveRateCard, defaultBudgetCents } from './economy/rates.js';
import { economy as economyStore, users as allUsers } from './db.js';
import type { BigDogBrain } from './brain.js';
import type { AppConfig } from './config.js';
import type { AccountsConfig, DealStage, Draft, CalendarEvent } from './types.js';
import { DEAL_STAGES } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '..', 'public');

export function createServer(cfg: AppConfig, accountsCfg: AccountsConfig, defaultBrain: BigDogBrain) {
  const app = express();
  app.set('trust proxy', 1); // behind a TLS reverse proxy (Caddy/nginx) in production

  // Stripe webhook needs the RAW body for signature verification, so it must be
  // registered before the JSON body parser. Unauthenticated (Stripe calls it).
  app.post('/stripe/webhook', express.raw({ type: '*/*' }), (req, res) => {
    if (!verifySignature(req.body as Buffer, req.headers['stripe-signature'] as string | undefined)) {
      return res.status(400).send('bad signature');
    }
    try {
      handleEvent(JSON.parse((req.body as Buffer).toString('utf8')));
    } catch { /* malformed payload — ignore */ }
    res.json({ received: true });
  });

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded
  app.use(express.static(PUBLIC_DIR));

  // Health check for proxies / uptime monitors (unauthenticated).
  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Serve generated call audio (unauthenticated so Twilio can fetch it).
  app.get('/voice/:id.mp3', (req, res) => {
    const path = voiceFilePath(req.params.id);
    if (!existsSync(path)) return res.status(404).end();
    res.set('Content-Type', 'audio/mpeg');
    res.sendFile(path);
  });

  // ── Twilio inbound SMS: reply YES (or a time) to book from your phone ──
  // Unauthenticated by design (Twilio can't log in); gated to the owner's number.
  app.post('/twilio/inbound', async (req, res) => {
    res.set('Content-Type', 'text/xml');
    const xml = (msg: string) => res.send(msg ? `<Response><Message>${msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))}</Message></Response>` : '<Response></Response>');
    const digits = (s: string) => (s || '').replace(/\D/g, '').slice(-10);
    const from = String(req.body?.From ?? '');
    const body = String(req.body?.Body ?? '').trim();
    const owner = loadTwilioCreds().ownerMobile;
    if (!owner || digits(from) !== digits(owner)) return xml(''); // ignore anyone but the owner
    try {
      const quick = await handleOwnerSms(body, reqBrain(), cfg);
      if (quick !== null) return xml(quick);
    } catch (err) {
      return xml(`Error: ${(err as Error).message}`);
    }
    // Free-form: acknowledge now, run the operator agent, then text the result.
    void (async () => {
      try {
        const run = await runAgent(body, agentCtx());
        await sendSms(`🐕 ${run.final}`.slice(0, 600)).catch(() => {});
      } catch (err) {
        await sendSms(`Hit a snag on that: ${(err as Error).message}`.slice(0, 300)).catch(() => {});
      }
    })();
    return xml("🐕 On it — I'll text you when it's done.");
  });

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

  // ── Linked login (SSO from a Builda account) ────────────────────────
  // A founder logged into Builda lands here (bigdog.builda.company/sso?t=<builda
  // session>) with no separate Big Dog login. We validate the token against Clon,
  // resolve their founder workspace, mark them unlimited (a paying founder — the
  // operator covers compute), issue a Big Dog session, and drop them into the app.
  const founderUidFor = (raw: unknown): string => 'founder_' + String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  app.get('/sso', async (req, res) => {
    const t = String((req.query as { t?: string })?.t || '');
    if (!t) return res.redirect('/');
    try {
      const r = await fetch('https://clonecho.builda.company/account/me', { headers: { authorization: 'Bearer ' + t } });
      if (!r.ok) return res.redirect('/?sso=fail');
      const j = (await r.json()) as { account?: { id?: string } };
      const acctId = j.account?.id;
      if (!acctId) return res.redirect('/?sso=fail');
      const uid = founderUidFor(acctId);
      try { ensureAccount(uid); setBudget(uid, { unlimited: true }); } catch { /* budget best-effort */ }
      setSession(req, res, issueToken(uid), 30 * 86_400);
      return res.redirect('/');
    } catch { return res.redirect('/?sso=fail'); }
  });

  // ── Auth (unguarded) ────────────────────────────────────────────────
  // The dashboard always requires login now (multi-user). If no accounts exist
  // yet, the client shows a "create account" form and the first signup becomes
  // the admin, inheriting any pre-existing single-user data.
  app.get('/api/auth/status', (req, res) => {
    const uid = verifyToken(cookieOf(req));
    res.json({ required: true, hasAccounts: anyUsers(), authed: !!uid });
  });
  app.post('/api/auth/signup', (req, res) => {
    try {
      const row = createAccount(String(req.body?.username ?? ''), String(req.body?.password ?? ''), String(req.body?.email ?? ''));
      setSession(req, res, issueToken(row.id), 30 * 86_400);
      res.json({ ok: true, username: row.username, role: row.role });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  app.post('/api/auth/login', (req, res) => {
    const row = verifyCredentials(String(req.body?.username ?? '').trim(), String(req.body?.password ?? ''));
    if (!row) return res.status(401).json({ error: 'Wrong username or password.' });
    setSession(req, res, issueToken(row.id), 30 * 86_400);
    res.json({ ok: true, username: row.username, role: row.role });
  });
  app.post('/api/auth/logout', (req, res) => {
    setSession(req, res, '', 0);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', (req, res) => {
    const uid = verifyToken(cookieOf(req));
    if (!uid) return res.status(401).json({ error: 'login required' });
    const next = String(req.body?.password ?? '');
    if (next.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    setUserPassword(uid, next);
    setSession(req, res, issueToken(uid), 30 * 86_400);
    res.json({ ok: true });
  });

  // ── Guard + per-user context for everything else under /api ─────────
  // Verify the session, then run the rest of the request inside the logged-in
  // user's AsyncLocalStorage context so every store call hits their own DB and
  // reqBrain() resolves to their brain.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/api/auth/')) return next();
    if (req.path === '/api/company' || req.path === '/api/founder-activity' || req.path === '/api/founder-mailbox' || req.path === '/api/founder-mailbox/list' || req.path === '/api/founder-inbound' || req.path === '/api/founder-record') return next(); // token-gated (Builda platform), not session
    const uid = verifyToken(cookieOf(req));
    if (!uid) return res.status(401).json({ error: 'authentication required' });
    runWithUser(uid, () => {
      setContextBrain(brainForUser(uid, cfg));
      next();
    });
  });

  const accountById = (id: string) => getAccount(id);
  // The active brain for this request: the logged-in user's (set by the auth
  // middleware), falling back to the default-user brain outside a session.
  const reqBrain = (): BigDogBrain => (currentBrainRaw() as BigDogBrain) ?? defaultBrain;
  const agentCtx = () => ({ cfg, accounts: accountsCfg, brain: reqBrain() });

  // ── Whole-world snapshot for the dashboard ──────────────────────────
  app.get('/api/state', (_req, res) => {
    const me = users.byId(currentUserId());
    res.json({
      owner: cfg.owner,
      user: me ? { username: me.username, role: me.role, email: me.email } : null,
      brainLive: reqBrain().live,
      backend: reqBrain().backend,
      sendMode: cfg.sendMode,
      autoDraft: cfg.autoDraft,
      accounts: allAccounts().map((a) => ({ id: a.id, label: a.label, email: a.email })),
      stages: DEAL_STAGES,
      calcom: { configured: calcomConfigured(cfg), bookingUrl: cfg.calcom?.bookingUrl ?? '' },
      zoom: { configured: zoomConfigured() },
      twilio: { configured: twilioConfigured() },
      voice: { configured: voiceConfigured() },
      verify: { configured: verifierConfigured() },
      // What Big Dog provides for the user with zero setup (managed service +
      // bundled voice + native SMTP verification). Drives the one-step wizard.
      managed: { brain: managedActive(), voice: voiceConfigured(), verify: true },
      economy: economySummary(currentUserId()),
      billing: { stripe: stripeConfigured() },
      setup: {
        claude: reqBrain().live,
        mailbox: allAccounts().length > 0,
        password: true,
        verify: verifierConfigured(),
        zoom: zoomConfigured(),
        twilio: twilioConfigured(),
        voice: voiceConfigured(),
        apollo: !!cfg.apolloKey,
        calcom: calcomConfigured(cfg),
        telegram: !!cfg.telegram,
        slack: !!cfg.slack,
      },
      browser: { configured: browserConfigured(), ready: browserReady() },
      prospect: activeProvider(cfg),
      messages: messages.recent(100),
      readyToBook: messages.meetingRequests(),
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
      const triaged = await triageNewMail(reqBrain(), cfg, accountsCfg);
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
      const triaged = await triageNewMail(reqBrain(), cfg, accountsCfg);
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
    // Reply-all: CC everyone else on the original (minus us and the sender).
    let cc: string | null = null;
    if (req.body?.replyAll) {
      const mine = new Set(allAccounts().map((a) => a.email.toLowerCase()));
      mine.add(m.fromEmail.toLowerCase());
      const others = (m.toEmails || '')
        .split(/[,;]/).map((s) => (s.match(/[^<>\s]+@[^<>\s]+/)?.[0] || '').toLowerCase().trim())
        .filter((e) => e && e.includes('@') && !mine.has(e));
      cc = [...new Set(others)].join(', ') || null;
    }
    try {
      const { subject, body, rationale } = await reqBrain().draftReply(m, deal, memory, thread);
      const draft: Draft = {
        id: randomUUID().slice(0, 16),
        accountId: m.accountId,
        inReplyTo: m.messageId,
        dealId: m.dealId,
        toEmails: m.fromEmail,
        ccEmails: cc,
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
          await sendMail(account, { to: draft.toEmails, cc, subject, body, inReplyTo: m.messageId });
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
    const cc = (req.body?.cc as string) ?? draft.ccEmails ?? null;
    if (!account) {
      drafts.setStatus(draft.id, 'sent', new Date().toISOString());
      const from = allAccounts()[0];
      recordSentMessage({ accountId: draft.accountId, fromName: from?.label ?? 'Me', fromEmail: from?.email ?? cfg.owner.signature.split('\n')[0] ?? 'me', toEmails: draft.toEmails, subject, body });
      logActivity('send', `Marked sent to ${draft.toEmails} (demo — no live account): "${subject}"`);
      return res.json({ ok: true, note: 'No live account for this draft (demo) — marked as sent.' });
    }
    const draftAtt = draft.attachmentIds ? (JSON.parse(draft.attachmentIds) as string[]) : [];
    try {
      await sendMail(account, { to: draft.toEmails, cc, subject, body, inReplyTo: draft.inReplyTo, attachments: resolveAttachments(draftAtt) });
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

  // Dismiss the auto-draft attached to a given inbox message (declutter).
  app.post('/api/messages/:id/dismiss-draft', (req, res) => {
    const m = messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'message not found' });
    const d = drafts.forMessage(m.messageId);
    if (d) drafts.setStatus(d.id, 'discarded');
    res.json({ ok: true, dismissed: !!d });
  });

  // Dismiss a message from the inbox entirely (archive it + clear its draft).
  app.post('/api/messages/:id/archive', (req, res) => {
    const m = messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'message not found' });
    const d = drafts.forMessage(m.messageId);
    if (d) drafts.setStatus(d.id, 'discarded');
    messages.archive(m.id);
    res.json({ ok: true });
  });

  // ── Do-not-draft sender list ────────────────────────────────────────
  app.get('/api/suppressed', (_req, res) => res.json({ emails: suppressed.all() }));
  app.post('/api/suppressed', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'need a valid email' });
    suppressed.add(email);
    // Also clear any pending drafts already queued for this sender.
    for (const d of drafts.pending()) if (d.toEmails.toLowerCase().includes(email)) drafts.setStatus(d.id, 'discarded');
    logActivity('suppress', `Won't auto-draft replies to ${email}`);
    res.json({ ok: true, emails: suppressed.all() });
  });
  app.delete('/api/suppressed/:email', (req, res) => {
    suppressed.remove(req.params.email);
    res.json({ ok: true, emails: suppressed.all() });
  });

  // ── Compose a brand-new email (with AI help) ────────────────────────
  app.post('/api/compose', async (req, res) => {
    const instruction = String(req.body?.instruction ?? '').trim();
    if (!instruction) return res.status(400).json({ error: 'tell Big Dog what you want to say' });
    const to = String(req.body?.to ?? '').trim();
    try {
      const r = await reqBrain().composeEmail({ to, subject: req.body?.subject, draft: req.body?.body, instruction, memory: to ? memories.recall(to) : '' });
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Send (or queue) a composed email that isn't a reply.
  app.post('/api/compose/send', async (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    const cc = String(req.body?.cc ?? '').trim() || null;
    const subject = String(req.body?.subject ?? '(no subject)');
    const body = String(req.body?.body ?? '');
    if (!to.includes('@') || !body.trim()) return res.status(400).json({ error: 'need a recipient and a body' });
    const accountId = String(req.body?.accountId || allAccounts()[0]?.id || '');
    const account = accountById(accountId);
    const attachmentIds: string[] = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds.map(String) : [];
    const queue = !!req.body?.queue || !account;
    if (queue) {
      const draft: Draft = {
        id: randomUUID().slice(0, 16), accountId: accountId || 'demo', inReplyTo: null, dealId: null,
        toEmails: to, ccEmails: cc, attachmentIds: attachmentIds.length ? JSON.stringify(attachmentIds) : null,
        subject, body, rationale: 'Composed by you.', status: 'pending', createdAt: new Date().toISOString(), sentAt: null,
      };
      drafts.insert(draft);
      return res.json({ ok: true, queued: true, draftId: draft.id });
    }
    try {
      await sendMail(account!, { to, cc, subject, body, attachments: resolveAttachments(attachmentIds) });
      recordSentMessage({ accountId: account!.id, fromName: account!.label, fromEmail: account!.email, toEmails: to, subject, body });
      logActivity('send', `Sent email to ${to}: "${subject}"`);
      res.json({ ok: true, sent: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Autopilot: one command runs the whole top-of-funnel ─────────────
  app.post('/api/autopilot', async (req, res) => {
    const goal = String(req.body?.goal ?? '').trim();
    if (!goal) return res.status(400).json({ error: 'tell Big Dog the goal, e.g. "10 meetings with security guard company owners"' });
    try {
      const result = await runAutopilot(goal, { fullyAutomate: !!req.body?.fullyAutomate, accountId: req.body?.accountId }, reqBrain(), cfg);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Drip sequences (multi-touch campaigns) ──────────────────────────
  app.get('/api/sequences', (_req, res) => {
    res.json({ sequences: sequences.all(), enrollments: enrollments.all(), defaultSteps: DEFAULT_SEQUENCE_STEPS });
  });
  app.post('/api/sequences', (req, res) => {
    const name = String(req.body?.name ?? '').trim() || 'New sequence';
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : DEFAULT_SEQUENCE_STEPS;
    if (req.body?.id) {
      const existing = sequences.get(String(req.body.id));
      if (!existing) return res.status(404).json({ error: 'no such sequence' });
      const seq = { ...existing, name, steps, active: req.body?.active !== false };
      sequences.upsert(seq);
      return res.json({ sequence: seq });
    }
    res.json({ sequence: createSequence(name, steps) });
  });
  app.delete('/api/sequences/:id', (req, res) => { sequences.delete(req.params.id); res.json({ ok: true }); });
  app.post('/api/sequences/:id/enroll', (req, res) => {
    const people = Array.isArray(req.body?.contacts) ? req.body.contacts
      : String(req.body?.emails ?? '').split(/[,\n;]/).map((e: string) => ({ email: e.trim() })).filter((p: any) => p.email);
    if (!people.length) return res.status(400).json({ error: 'no contacts to enroll' });
    try {
      res.json(enrollContacts(req.params.id, people, req.body?.accountId));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  app.post('/api/enrollments/:id/stop', (req, res) => {
    const e = enrollments.all().find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    enrollments.update({ ...e, status: 'stopped', lastError: null });
    res.json({ ok: true });
  });
  // Manually advance due touches now (otherwise the scheduler does it).
  app.post('/api/sequences/run', async (_req, res) => {
    try { res.json({ produced: await runDueEnrollments(reqBrain(), cfg) }); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Sales repository (attachments) ──────────────────────────────────
  app.get('/api/repo', (_req, res) => res.json({ files: attachments.all().map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, notes: a.notes, createdAt: a.createdAt })) }));
  app.post('/api/repo', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const base64 = String(req.body?.data ?? '');
    if (!name || !base64) return res.status(400).json({ error: 'need {name, data(base64)}' });
    try {
      const a = saveAttachment(name, String(req.body?.mime ?? ''), base64, String(req.body?.notes ?? ''));
      logActivity('repo', `Added "${a.name}" to the sales repository`);
      res.json({ ok: true, id: a.id, name: a.name, size: a.size });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  app.delete('/api/repo/:id', (req, res) => { attachments.delete(req.params.id); res.json({ ok: true }); });
  app.get('/api/repo/:id/file', (req, res) => {
    const a = attachments.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    res.download(a.path, a.name);
  });

  // ── Contacts (CRM) ──────────────────────────────────────────────────
  app.get('/api/contacts', (_req, res) => res.json({ contacts: contacts.all() }));
  app.get('/api/contacts/suggest', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    res.json({ contacts: q ? contacts.suggest(q) : contacts.all(20) });
  });
  app.post('/api/contacts', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'need a valid email' });
    res.json({ contact: contacts.save({ email, name: req.body?.name, company: req.body?.company, title: req.body?.title, phone: req.body?.phone, notes: req.body?.notes, tags: req.body?.tags }) });
  });
  // Full contact card: profile + every interaction Big Dog has on file.
  app.get('/api/contacts/:email', (req, res) => {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const contact = contacts.get(email) ?? { email, name: '', company: '', title: '', phone: '', notes: '', tags: '', firstSeen: '', lastSeen: '', updatedAt: '' };
    const msgs = messages.forContact(email, 100);
    const deal = deals.findByContact(email) ?? null;
    const allDeals = deals.all().filter((d) => (d.contactEmail || '').toLowerCase() === email);
    const evts = events.all().filter((e) => (e.attendees || '').toLowerCase().includes(email));
    const pendingDrafts = drafts.pending().filter((d) => (d.toEmails + ',' + (d.ccEmails || '')).toLowerCase().includes(email));
    res.json({ contact, deal, deals: allDeals, messages: msgs, events: evts, drafts: pendingDrafts, memory: memories.recall(email) });
  });

  // One-tap "Confirm & book": turn an interested reply into a booked meeting +
  // sent confirmation (Zoom link + calendar event), all in one click.
  app.post('/api/messages/:id/book', async (req, res) => {
    const m = messages.get(req.params.id);
    if (!m || !m.fromEmail) return res.status(404).json({ error: 'message not found' });
    try {
      const r = await bookFromMessage(m, { whenISO: req.body?.whenISO, minutes: req.body?.minutes }, reqBrain(), cfg);
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Dismiss from the Ready-to-book queue ("not a meeting / not now").
  app.post('/api/messages/:id/not-meeting', (req, res) => {
    if (!messages.get(req.params.id)) return res.status(404).json({ error: 'message not found' });
    messages.setMeetingReq(req.params.id, 0);
    res.json({ ok: true });
  });

  // Create a meeting invite: calendar event + a (queued) invite email.
  app.post('/api/meeting/invite', async (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    if (!to.includes('@')) return res.status(400).json({ error: 'need an attendee email' });
    const title = String(req.body?.title ?? 'Meeting');
    const minutes = Number(req.body?.minutes ?? 30);
    const start = req.body?.whenISO ? new Date(String(req.body.whenISO)) : new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + minutes * 60_000);

    // Create a real Zoom meeting if Zoom is connected.
    let videoLink = cfg.calcom?.bookingUrl || '';
    let videoNote = '';
    let zoomMeetingId: string | null = null;
    if (zoomConfigured()) {
      try {
        const z = await createZoomMeeting({ topic: title, startISO: start.toISOString(), minutes });
        videoLink = z.joinUrl;
        zoomMeetingId = z.meetingId;
        videoNote = `Zoom: ${z.joinUrl}${z.password ? ` (passcode ${z.password})` : ''}`;
      } catch (err) {
        logActivity('error', `Zoom meeting create failed: ${(err as Error).message}`);
      }
    }

    const evt: CalendarEvent = {
      id: randomUUID().slice(0, 16), title, start: start.toISOString(), end: end.toISOString(),
      location: videoLink || 'Video call', attendees: to, notes: videoNote || 'Created from Big Dog compose.', dealId: null, source: 'big-dog', zoomMeetingId,
    };
    events.upsert(evt);
    const when = start.toISOString().slice(0, 16).replace('T', ' ');
    const link = videoLink ? ` Include this video meeting link: ${videoLink}.` : (cfg.calcom?.bookingUrl ? ` Include this booking link: ${cfg.calcom.bookingUrl}.` : '');
    let subject = `Invite: ${title}`;
    let body = `Hi,\n\nProposing ${title} on ${when} for ${minutes} minutes.${videoLink ? `\n\nJoin link: ${videoLink}` : (cfg.calcom?.bookingUrl ? `\n\nBook/confirm here: ${cfg.calcom.bookingUrl}` : '')}\n\n${cfg.owner.signature}`;
    if (reqBrain().live) {
      try {
        const c = await reqBrain().composeEmail({ to, subject, instruction: `Write a short, friendly meeting invite for "${title}" on ${when} (${minutes} minutes).${link}` });
        subject = c.subject; body = c.body;
      } catch { /* keep template */ }
    }
    const draft: Draft = {
      id: randomUUID().slice(0, 16), accountId: allAccounts()[0]?.id ?? 'demo', inReplyTo: null, dealId: null,
      toEmails: to, subject, body, rationale: 'Meeting invite — queued for your approval.', status: 'pending', createdAt: new Date().toISOString(), sentAt: null,
    };
    drafts.insert(draft);
    logActivity('calendar', `Drafted meeting invite to ${to}: "${title}" (${when})`);
    res.json({ ok: true, eventId: evt.id, draftId: draft.id });
  });

  // ── Twilio (SMS + voice) ────────────────────────────────────────────
  app.get('/api/twilio', (_req, res) => res.json(publicTwilio()));
  app.post('/api/twilio', (req, res) => { saveTwilioCreds(req.body ?? {}); res.json(publicTwilio()); });
  app.post('/api/twilio/test', async (_req, res) => res.json(await testTwilio()));
  app.post('/api/sms', async (req, res) => {
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'empty message' });
    try { const r = await sendSms(body, req.body?.to ? String(req.body.to) : undefined); logActivity('sms', `Texted ${req.body?.to || 'you'}: ${body.slice(0, 60)}`); res.json({ ok: true, sid: r.sid }); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  // Draft a short phone/voicemail script for a contact (in the owner's voice).
  app.post('/api/call/draft', async (req, res) => {
    try {
      const script = await reqBrain().callScript({
        name: req.body?.name ? String(req.body.name) : undefined,
        company: req.body?.company ? String(req.body.company) : undefined,
        goal: req.body?.goal ? String(req.body.goal) : undefined,
        voicemail: !!req.body?.voicemail,
      });
      res.json({ script });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/call', async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'empty message' });
    try {
      let playUrl: string | undefined;
      if (voiceConfigured()) {
        try {
          const { id } = await synthesize(message);
          playUrl = `${req.protocol}://${req.get('host')}/voice/${id}.mp3`;
        } catch (e) { logActivity('error', `Voice synth failed, using built-in TTS: ${(e as Error).message}`); }
      }
      const r = await makeCall(message, req.body?.to ? String(req.body.to) : undefined, { playUrl, voicemail: !!req.body?.voicemail });
      logActivity('call', `Called ${req.body?.to || 'you'}${playUrl ? ' (Big Dog voice)' : ''}`);
      res.json({ ok: true, sid: r.sid, voice: !!playUrl });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── Email verification API (hard verify even with port 25 blocked) ──
  app.get('/api/verify', (_req, res) => res.json(publicVerify()));
  app.post('/api/verify', (req, res) => { saveVerifySettings(req.body ?? {}); res.json(publicVerify()); });
  app.post('/api/verify/test', async (_req, res) => res.json(await testVerifier()));

  // ── Voice (TTS for calls/voicemails) ────────────────────────────────
  app.get('/api/voice', (_req, res) => res.json(publicVoice()));
  app.post('/api/voice', (req, res) => { saveVoiceSettings(req.body ?? {}); res.json(publicVoice()); });
  app.post('/api/voice/test', async (_req, res) => res.json(await testVoice()));
  app.post('/api/voice/sample', (req, res) => {
    const data = String(req.body?.data ?? '');
    if (!data) return res.status(400).json({ error: 'no audio data' });
    try { res.json(saveVoiceSample(data, String(req.body?.mime ?? ''))); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  // Synthesize a short preview the browser can play.
  app.post('/api/voice/preview', async (req, res) => {
    const text = String(req.body?.text ?? "What's up, Big Dog!? This is how I'll sound on your calls.").slice(0, 400);
    try {
      const { id } = await synthesize(text, req.body?.voice ? String(req.body.voice) : undefined);
      res.json({ ok: true, url: `/voice/${id}.mp3` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Zoom (video meetings) ───────────────────────────────────────────
  app.get('/api/zoom', (_req, res) => res.json(publicZoom()));
  app.post('/api/zoom', (req, res) => {
    saveZoomCreds(req.body ?? {});
    res.json(publicZoom());
  });
  app.post('/api/zoom/test', async (_req, res) => res.json(await testZoom()));

  // Pull a Zoom meeting transcript and draft the follow-up (→ close).
  app.post('/api/meeting/:eventId/followup', async (req, res) => {
    const evt = events.get(req.params.eventId);
    if (!evt) return res.status(404).json({ error: 'event not found' });
    const meetingId = evt.zoomMeetingId || String(req.body?.meetingId ?? '');
    if (!meetingId) return res.status(400).json({ error: 'no Zoom meeting linked to this event' });
    if (!zoomConfigured()) return res.status(400).json({ error: 'connect Zoom first (Settings → Video meetings)' });
    try {
      const transcript = await getMeetingTranscript(meetingId);
      if (!transcript.trim()) return res.status(400).json({ error: 'transcript is empty or still processing' });
      const to = (evt.attendees || '').split(/[,;]/)[0]?.trim() || '';
      const contact = { name: contacts.get(to)?.name || '', company: contacts.get(to)?.company || '', email: to };
      const f = await reqBrain().meetingFollowup(transcript, contact);
      if (to) memories.add(to, `Meeting recap (${evt.title}): ${f.summary}`.slice(0, 600));
      const draft: Draft = {
        id: randomUUID().slice(0, 16), accountId: allAccounts()[0]?.id ?? 'demo', inReplyTo: null, dealId: evt.dealId,
        toEmails: to, ccEmails: null, attachmentIds: null, subject: f.subject, body: f.body,
        rationale: `Post-meeting follow-up from the Zoom transcript. Action items: ${f.actionItems.join('; ') || '—'}`,
        status: 'pending', createdAt: new Date().toISOString(), sentAt: null,
      };
      drafts.insert(draft);
      logActivity('followup', `Drafted post-meeting follow-up to ${to || 'attendee'} from "${evt.title}" transcript`);
      res.json({ ok: true, summary: f.summary, actionItems: f.actionItems, draftId: draft.id });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // List sent mail (for the Sent view + searchable history).
  app.get('/api/sent', (_req, res) => res.json({ messages: messages.recentSent(300) }));

  // Learn the owner's voice from their own sent mail and persist it.
  app.post('/api/voice/learn-from-sent', async (_req, res) => {
    const sent = messages.recentSent(80).filter((m) => m.body && m.fromEmail);
    if (sent.length < 3) return res.status(400).json({ error: 'Not enough sent mail yet — sync your mailbox first (need a few sent emails to learn from).' });
    const samples = sent.map((m) => `Subject: ${m.subject}\n${m.body}`).join('\n\n---\n\n').slice(0, 16000);
    try {
      const r = await reqBrain().learnVoice(samples);
      saveOwner({ voiceNotes: r.voiceNotes });
      reqBrain().setOwner(loadOwner(cfg));
      res.json({ ok: true, observations: r.observations, samples: sent.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
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
      const content = await generateDigest(reqBrain());
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const question = (req.body?.question as string) ?? '';
    if (!question.trim()) return res.status(400).json({ error: 'empty question' });
    try {
      const answer = await reqBrain().chat(question, deals.all(), messages.recent(40), events.upcoming());
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
      const run = await runAgent(goal, agentCtx());
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
      res.json({ brief: await reqBrain().research(query) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Read any web page in a real headless browser (agent-browser) ────
  app.post('/api/browse', async (req, res) => {
    const url = (req.body?.url as string) ?? '';
    const instruction = (req.body?.instruction as string) ?? '';
    if (!url.trim()) return res.status(400).json({ error: 'empty url' });
    try {
      res.json(await reqBrain().browse(url.trim(), instruction));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Follow-up cadence sweep ─────────────────────────────────────────
  app.post('/api/cadence/run', async (_req, res) => {
    try {
      const created = await runCadenceSweep(agentCtx());
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
      const prospects = await findProspects(criteria, cfg, reqBrain());
      res.json({ provider: activeProvider(cfg), prospects, brainLive: reqBrain().live, webCapable: reqBrain().webCapable, backend: reqBrain().backend });
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
    try {
      const norm = req.body?.csv ? await normalizeCsv(String(req.body.csv), reqBrain()) : { rows: (req.body?.rows as Record<string, string>[]) ?? [], mapping: {}, headers: [] };
      if (!norm.rows.length) return res.status(400).json({ error: 'no rows — paste a CSV with a header row (name/company/domain/…)' });
      const verify = !!req.body?.verify;
      const enriched = await enrichRows(norm.rows, reqBrain(), { verify });
      if (req.body?.save) {
        for (const r of enriched) {
          if (r.email && r.confidence !== 'skipped') {
            saveProspectAsDeal({ name: r.name, title: r.title, company: r.company, domain: r.domain, email: r.email, linkedin: '', location: '', source: 'csv', notes: `${r.confidence} (${r.method})` });
          }
        }
      }
      res.json({ count: enriched.length, rows: enriched, mapping: norm.mapping });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // The campaign play: enrich a list → (research top N) → draft intros to all.
  app.post('/api/campaign/run', async (req, res) => {
    try {
      const norm = req.body?.csv ? await normalizeCsv(String(req.body.csv), reqBrain()) : { rows: (req.body?.rows as Record<string, string>[]) ?? [] };
      const rows = norm.rows;
      if (!rows.length) return res.status(400).json({ error: 'no rows — paste a CSV with a header row' });
      const accountId = allAccounts()[0]?.id ?? 'demo';
      const result = await runCampaign(rows, reqBrain(), accountId, {
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

  // Builda hands a built company to Big Dog: educate it (product + ICP + offer) and
  // start finding customers. Token-gated — called by the Builda platform.
  // Per-founder workspace id — each Builda founder gets an isolated Big Dog DB.
  const founderUid = (raw: unknown): string => {
    const s = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return s ? `founder_${s}` : 'default';
  };

  app.post('/api/company', async (req, res) => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!process.env.CORTEX_TOKEN || tok !== process.env.CORTEX_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const name = String(req.body?.name || '').slice(0, 160);
    const product = String(req.body?.product || '').slice(0, 500);
    const icpCriteria = String(req.body?.icpCriteria || '').slice(0, 500);
    const offer = String(req.body?.offer || '').slice(0, 300);
    if (!name || !icpCriteria) return res.status(400).json({ error: 'name + icpCriteria required' });
    const uid = founderUid(req.body?.founderUid);
    // A founder handed a company is a paying Big Dog customer — run their
    // workspace unlimited so prospecting (LLM/web-search) is never budget-blocked.
    try { ensureAccount(uid); setBudget(uid, { unlimited: true }); } catch { /* best-effort */ }
    res.json({ ok: true, queued: true });
    // Background: prospect for the ICP and add customers to THIS founder's pipeline.
    runWithUser(uid, async () => {
      try {
        logActivity('company', `New company to grow: ${name} — ${product}. Finding customers…`);
        const prospects = await findProspects(icpCriteria, cfg, defaultBrain);
        let saved = 0;
        for (const p of prospects.slice(0, 8)) { saveProspectAsDeal({ ...p, notes: `${name} — ${offer}` }); saved++; }
        logActivity('company', `${name}: found ${saved} prospect(s) and added them to the pipeline.`);
      } catch (e) { console.error('[company] prospecting failed:', (e as Error).message); }
    });
  });

  // Founder's own Big Dog activity + pipeline for a company — powers the Builda
  // dashboard's itemized feed. Token-gated; reads only that founder's workspace.
  app.post('/api/founder-activity', (req, res) => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!process.env.CORTEX_TOKEN || tok !== process.env.CORTEX_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const uid = founderUid(req.body?.founderUid);
    const company = String(req.body?.company || '').slice(0, 160);
    runWithUser(uid, () => {
      try {
        let acts = activity.recent(80);
        if (company) acts = acts.filter((a) => (a.message || '').includes(company));
        const db = getDb();
        const total = (db.prepare('SELECT COUNT(*) n FROM deals').get() as { n: number }).n;
        const forCompany = company ? (db.prepare('SELECT COUNT(*) n FROM deals WHERE notes LIKE ?').get(`%${company}%`) as { n: number }).n : total;
        res.json({ activity: acts.slice(0, 25), deals: forCompany, totalDeals: total });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });
  });

  // Cortex writes a record into a founder's Big Dog workspace — a lead, contact,
  // or note surfaced from the user's conversation with Cortex. Token-gated and
  // strictly scoped to that founder's own workspace (founder_<accountId>).
  app.post('/api/founder-record', (req, res) => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!process.env.CORTEX_TOKEN || tok !== process.env.CORTEX_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const uid = founderUid(req.body?.founderUid);
    const kind = String(req.body?.kind || 'lead');
    const name = String(req.body?.name || '').slice(0, 160);
    const company = String(req.body?.company || '').slice(0, 160);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
    const role = String(req.body?.role || req.body?.title || '').slice(0, 160);
    const note = String(req.body?.note || '').slice(0, 500);
    if (!name && !email && !note) return res.status(400).json({ error: 'name, email, or note required' });
    runWithUser(uid, () => {
      try {
        if (kind === 'note') {
          activity.add('cortex', note || `Note about ${name || email}`);
          if (email) memories.add(email, note || `Cortex note about ${name}`);
          return res.json({ ok: true, kind: 'note' });
        }
        if (kind === 'contact') {
          if (email) { contacts.seen(email, name); memories.add(email, note || `Contact added by Cortex from conversation.`); }
          activity.add('cortex', `Cortex added contact: ${name || email}${company ? ' (' + company + ')' : ''}.`);
          return res.json({ ok: true, kind: 'contact' });
        }
        // default: lead → into the pipeline (creates a deal + contact + memory)
        const deal = saveProspectAsDeal({ name: name || email, title: role, company, email, domain: (email.split('@')[1] || ''), linkedin: '', location: '', source: 'cortex', notes: note || 'Added by Cortex from conversation' });
        activity.add('cortex', `Cortex added lead: ${name || email}${company ? ' at ' + company : ''} — from your conversation.`);
        res.json({ ok: true, kind: 'lead', dealId: deal.id });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });
  });

  // Connect a founder's email so Big Dog can SEND outreach from their workspace.
  // SMTP/IMAP auto-detected for common providers; app password required.
  const mailboxDefaults = (email: string) => {
    const d = (email.split('@')[1] || '').toLowerCase();
    if (/gmail\.com|googlemail\.com/.test(d)) return { smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, imap: { host: 'imap.gmail.com', port: 993 } };
    if (/outlook\.|hotmail\.|live\.|office365/.test(d)) return { smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false }, imap: { host: 'outlook.office365.com', port: 993 } };
    if (/yahoo\./.test(d)) return { smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true }, imap: { host: 'imap.mail.yahoo.com', port: 993 } };
    if (/icloud\.|me\.com/.test(d)) return { smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, imap: { host: 'imap.mail.me.com', port: 993 } };
    return null;
  };
  app.post('/api/founder-mailbox', async (req, res) => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!process.env.CORTEX_TOKEN || tok !== process.env.CORTEX_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const uid = founderUid(req.body?.founderUid);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const pass = String(req.body?.password || req.body?.appPassword || '');
    if (!email || !pass) return res.status(400).json({ error: 'Email and app password are required.' });
    const def = mailboxDefaults(email);
    const smtpHost = String(req.body?.smtpHost || def?.smtp.host || '');
    if (!smtpHost) return res.status(400).json({ error: 'Unknown email provider — enter your SMTP host and port.' });
    const smtpPort = Number(req.body?.smtpPort || def?.smtp.port || 465);
    const smtpSecure = req.body?.smtpSecure != null ? !!req.body.smtpSecure : (def?.smtp.secure ?? smtpPort === 465);
    const user = String(req.body?.smtpUser || email);
    const imapHost = String(req.body?.imapHost || def?.imap.host || smtpHost.replace(/^smtp[.-]?/, 'imap.'));
    const imapPort = Number(req.body?.imapPort || def?.imap.port || 993);
    let verified = false, warning = '';
    try {
      const nm = (await import('nodemailer')).default;
      await nm.createTransport({ host: smtpHost, port: smtpPort, secure: smtpSecure, auth: { user, pass } }).verify();
      verified = true;
    } catch (e) { warning = 'Saved, but the login could not be verified: ' + (e as Error).message + ' (Gmail/Outlook need an app password, not your normal password.)'; }
    const account = { id: 'm_' + randomUUID().slice(0, 8), label: email, email, smtp: { host: smtpHost, port: smtpPort, secure: smtpSecure, user, pass }, imap: { host: imapHost, port: imapPort, secure: true, user, pass } };
    runWithUser(uid, () => { mailAccountsStore.set(account as never); });
    res.json({ ok: true, verified, warning: warning || undefined, email });
  });
  app.post('/api/founder-mailbox/list', (req, res) => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!process.env.CORTEX_TOKEN || tok !== process.env.CORTEX_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const uid = founderUid(req.body?.founderUid);
    runWithUser(uid, () => { res.json({ mailboxes: mailAccountsStore.all().map((a) => ({ email: a.email, label: a.label })) }); });
  });

  // Inbound reply to a company address (routed here by Builda) — drop it into
  // this founder's inbox and thread it onto the matching deal (by sender email).
  app.post('/api/founder-inbound', (req, res) => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!process.env.CORTEX_TOKEN || tok !== process.env.CORTEX_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const uid = founderUid(req.body?.founderUid);
    runWithUser(uid, () => {
      try {
        const fromRaw = String(req.body?.from || '');
        const fromEmail = (fromRaw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/) || [''])[0].toLowerCase();
        const fromName = (fromRaw.replace(/<[^>]*>/, '').replace(/["']/g, '').trim()) || fromEmail || 'Unknown';
        const text = String(req.body?.text || req.body?.html || '');
        let dealId: string | null = null;
        try { const d = getDb().prepare('SELECT id FROM deals WHERE lower(contactEmail)=? LIMIT 1').get(fromEmail) as { id: string } | undefined; dealId = d?.id ?? null; } catch { /* no deal */ }
        const acct = mailAccountsStore.all()[0]?.id || 'inbound';
        messages.upsert({
          id: randomUUID(), accountId: acct, messageId: String(req.body?.messageId || randomUUID()),
          threadId: String(req.body?.inReplyTo || req.body?.threadId || randomUUID()),
          fromName, fromEmail, toEmails: String(req.body?.to || ''), subject: String(req.body?.subject || '(no subject)'),
          snippet: text.replace(/\s+/g, ' ').slice(0, 180), body: text, date: String(req.body?.date || new Date().toISOString()),
          folder: 'inbox', unread: 1, dealId, priority: null, summary: null, analyzed: 0,
        } as never);
        logActivity('reply', `📥 Reply from ${fromName} — "${String(req.body?.subject || '').slice(0, 60)}"`);
        res.json({ ok: true, dealId });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });
  });

  // Find + verify a contact's email from name + domain (Hunter-style engine).
  app.post('/api/prospect/email', async (req, res) => {
    const domain = (req.body?.domain as string) ?? '';
    const name = (req.body?.name as string) ?? '';
    if (!domain.trim() || !name.trim()) return res.status(400).json({ error: 'need name and domain' });
    try {
      res.json(await findContactEmail({ name, domain }, reqBrain()));
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
    reqBrain().setOwner(owner);
    res.json(owner);
  });

  // Analyze pasted emails and propose a voice profile (review before saving).
  app.post('/api/voice/learn', async (req, res) => {
    const samples = String(req.body?.samples ?? '').trim();
    if (samples.length < 80) return res.status(400).json({ error: 'paste at least a few of your real emails' });
    try {
      res.json(await reqBrain().learnVoice(samples));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── LLM backend settings (Claude / ChatGPT / Ollama) ────────────────
  app.get('/api/settings', (_req, res) => {
    res.json({ ...publicSettings(loadSettings(cfg)), backend: reqBrain().backend, live: reqBrain().live });
  });

  app.post('/api/settings', async (req, res) => {
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    // Pasting a key means "use this backend" — switch to it so the key actually
    // takes effect (avoids saving a Claude key while the backend stays on Ollama).
    const ak = String(body.anthropicKey ?? '').trim();
    const ok = String(body.openaiKey ?? '').trim();
    if (ak) body.provider = 'anthropic';
    else if (ok) body.provider = 'openai';
    saveSettings(body);
    const provider = buildProvider(loadSettings(cfg));
    try {
      if (provider.ping) await provider.ping();
    } catch {
      /* ping is best-effort */
    }
    reqBrain().setProvider(provider);
    // Verify with a real call so the user gets unambiguous confirmation.
    let verified = reqBrain().live;
    let verifyDetail = reqBrain().live ? `Connected to ${reqBrain().backend}` : 'No backend configured.';
    if (reqBrain().live) {
      try {
        const t = await testProvider(provider);
        verified = t.ok;
        verifyDetail = t.detail;
      } catch (err) {
        verified = false;
        verifyDetail = (err as Error).message;
      }
    }
    res.json({ ...publicSettings(loadSettings(cfg)), backend: reqBrain().backend, live: reqBrain().live, verified, verifyDetail });
  });

  app.post('/api/settings/test', async (req, res) => {
    // Test the saved settings, optionally with proposed overrides from the form.
    const merged = { ...loadSettings(cfg), ...(req.body ?? {}) };
    // Ignore empty key fields in the proposed override so a blank doesn't wipe.
    if (!req.body?.anthropicKey) merged.anthropicKey = loadSettings(cfg).anthropicKey;
    if (!req.body?.openaiKey) merged.openaiKey = loadSettings(cfg).openaiKey;
    res.json(await testProvider(buildProvider(merged)));
  });

  // ── Economy: credits, budget, usage ────────────────────────────────
  app.get('/api/economy', (_req, res) => {
    res.json({ ...economySummary(currentUserId()), recent: economyStore.recentUsage(currentUserId(), 30) });
  });

  // User sets their monthly cap (USD) or chooses unlimited.
  app.post('/api/economy/budget', (req, res) => {
    const b = req.body ?? {};
    const unlimited = b.unlimited === true || b.unlimited === 'true';
    let monthlyBudgetCents: number | null | undefined;
    if (b.monthlyUsd !== undefined && b.monthlyUsd !== null && b.monthlyUsd !== '') {
      const usd = Number(b.monthlyUsd);
      if (!Number.isFinite(usd) || usd < 0) return res.status(400).json({ error: 'Enter a valid dollar amount.' });
      monthlyBudgetCents = Math.round(usd * 100);
    }
    setBudget(currentUserId(), { unlimited, ...(monthlyBudgetCents !== undefined ? { monthlyBudgetCents } : {}) });
    res.json(economySummary(currentUserId()));
  });

  // Prepaid credit packs + Stripe checkout.
  app.get('/api/economy/packs', (_req, res) => {
    res.json({ configured: stripeConfigured(), packs: packs() });
  });
  app.post('/api/economy/checkout', async (req, res) => {
    const pack = packs().find((p) => p.id === String(req.body?.packId ?? ''));
    if (!pack) return res.status(400).json({ error: 'Unknown pack.' });
    try {
      const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
      const origin = `${proto}://${req.headers.host}`;
      const url = await createCheckout(currentUserId(), pack, origin);
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Admin economy: rate card + per-user usage rollup (admin only) ────
  const requireAdmin = (req: express.Request, res: express.Response): boolean => {
    if (allUsers.byId(currentUserId())?.role === 'admin') return true;
    res.status(403).json({ error: 'admin only' }); return false;
  };
  app.get('/api/admin/economy', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rollup = economyStore.allAccounts().map((a) => {
      const u = allUsers.byId(a.userId);
      return { userId: a.userId, username: u?.username ?? a.userId, role: u?.role ?? 'user', ...economySummary(a.userId) };
    });
    res.json({ rates: rateCard(), defaultBudgetCents: defaultBudgetCents(), packs: packs(), stripeConfigured: stripeConfigured(), users: rollup });
  });
  app.post('/api/admin/economy/rates', (req, res) => {
    if (!requireAdmin(req, res)) return;
    saveRateCard(req.body ?? {});
    res.json({ ok: true, rates: rateCard() });
  });
  app.post('/api/admin/economy/packs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const p = (req.body?.packs ?? []) as Pack[];
    if (!Array.isArray(p) || !p.length) return res.status(400).json({ error: 'need a non-empty packs array' });
    savePacks(p);
    res.json({ ok: true, packs: packs() });
  });
  app.post('/api/admin/economy/grant', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const userId = String(req.body?.userId ?? '');
    const credits = Number(req.body?.credits ?? 0);
    if (!userId || !Number.isFinite(credits) || credits === 0) return res.status(400).json({ error: 'need userId + non-zero credits' });
    grant(userId, credits, 'admin grant');
    res.json({ ok: true });
  });

  // ── Admin Service-Keys vault (managed master credentials) ───────────
  app.get('/api/admin/keys', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ keys: publicVault(), masterSecretSet: !!process.env.BIGDOG_MASTER_SECRET });
  });
  app.post('/api/admin/keys', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let touchedBrain = false;
    for (const [name, value] of Object.entries(body)) {
      const v = String(value ?? '').trim();
      if (!v) continue;
      if (v === '__clear__') { vault.clear(name); } else { vault.set(name, v); }
      if (name === 'anthropicKey') touchedBrain = true;
    }
    if (touchedBrain) invalidateAllBrains(); // every user picks up the new brain key
    res.json({ ok: true, keys: publicVault() });
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

  // Autodiscover IMAP/SMTP from just an email (+ password to verify the login).
  app.post('/api/accounts/discover', async (req, res) => {
    const email = String(req.body?.email ?? '').trim();
    const password = req.body?.password ? String(req.body.password) : undefined;
    if (!email.includes('@')) return res.status(400).json({ error: 'need a full email address' });
    try {
      res.json(await discoverMailConfig(email, password));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // One-tap onboarding: discover servers, verify the login, and save the
  // mailbox in a single call. Powers the one-step setup wizard.
  app.post('/api/accounts/connect', async (req, res) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!email.includes('@') || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    try {
      const d = await discoverMailConfig(email, password);
      const c = d.config;
      if (!c) return res.json({ ok: false, detail: d.detail || "Couldn't find your email's servers automatically. Try Advanced setup." });
      if (!c.verified) {
        return res.json({ ok: false, needsManual: true, detail: d.detail || 'Found your mail servers, but the login was rejected. Double-check the password — Gmail and Outlook need an “App Password,” not your normal one.' });
      }
      const id = ((email.split('@')[1] || 'mail').split('.')[0] || 'mail').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const a: Account = {
        id, label: email, email,
        imap: { host: c.imap.host, port: Number(c.imap.port || 993), secure: c.imap.secure !== false, user: email, pass: password },
        smtp: { host: c.smtp.host, port: Number(c.smtp.port || 465), secure: !!c.smtp.secure, user: email, pass: password },
      };
      saveAccount(a);
      res.json({ ok: true, email });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

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
