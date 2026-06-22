# 🐕 Big Dog

> *"What's up, Big Dog!?"*

Your inside-sales development rep, executive assistant, and **clone** — all in one
self-hosted app. Big Dog pulls all your work mailboxes into one inbox, puts
everything on one calendar, works your deals, and keeps you briefed — writing and
sending email in *your* voice with CEO-level intellect and hustle.

Runs on [Claude](https://www.anthropic.com/) (`claude-opus-4-8`) **or a fully local
[Ollama](https://ollama.com) model** (zero API cost). Chat with it from the web
dashboard, **Telegram, or Slack**.

---

## What it does

- **One inbox** — aggregates any number of mailboxes (Gmail, Outlook/Microsoft 365,
  Fastmail, custom domains — anything with IMAP/SMTP) into a single triaged feed.
- **Works your deals** — reads incoming mail, scores it `hot / warm / cold`, pulls
  real opportunities into a **pipeline** (`new → qualified → proposal → won/lost`)
  with next steps, and keeps it current as threads move.
- **One calendar** — detects meeting requests and drops them onto a unified
  calendar you can subscribe to from Google/Apple/Outlook (`/calendar.ics`).
- **Drafts & sends as you** — writes replies in your voice. Approve with one click,
  or flip to auto-send for the ones it's sure about.
- **Morning brief** — the *"What's up, Big Dog!?"* digest: what's hot, what's going
  cold, and what Big Dog is taking off your plate today.
- **Ask Big Dog** — chat about your pipeline, your day, who's at risk.

It ships with **demo data**, so the dashboard is alive the moment you start it —
before you wire up a single real mailbox.

---

## Quick start

```bash
npm install
cp .env.example .env          # add your ANTHROPIC_API_KEY (optional but recommended)
npm start
```

Open **http://localhost:4137**.

Without a brain configured it still runs end-to-end using simple fallbacks. Add a
Claude key **or** point it at a local Ollama model to get the real "clone of you"
intelligence.

---

## Run it free & local (Ollama)

No API bills, nothing leaves your machine:

```bash
# 1. Install Ollama from https://ollama.com, then pull a model:
ollama pull llama3.1

# 2. In .env:
BIGDOG_PROVIDER=ollama
OLLAMA_MODEL=llama3.1        # or qwen2.5, mistral, etc.

npm start
```

`BIGDOG_PROVIDER=auto` (the default) uses Claude when `ANTHROPIC_API_KEY` is set and
falls back to local Ollama otherwise — so you can keep a key for quality and a local
model for free/offline, and switch with one env var. A bigger local model (e.g.
`llama3.1:70b`, `qwen2.5:32b`) drafts noticeably better email.

---

## Chat with Big Dog (Telegram / Slack)

Talk to your clone from your phone — ask about deals, get the morning brief, trigger
a sync — using the same commands everywhere: `/brief`, `/sync`, `/deals`, `/today`,
`/help`, or just chat.

**Telegram** (easiest — no public URL needed):

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Put it in `.env` as `TELEGRAM_BOT_TOKEN`. DM your bot and say hi.
3. (Optional) set `TELEGRAM_CHAT_ID` to get the morning brief pushed to you. Find it
   at `https://api.telegram.org/bot<token>/getUpdates` after you DM the bot.

**Slack** (two-way via Socket Mode — also no public URL):

1. Create an app → enable **Socket Mode**.
2. Bot token (`xoxb-`) with `chat:write`, `app_mentions:read`, `im:history`;
   app-level token (`xapp-`) with `connections:write`.
3. Subscribe to `app_mention` and `message.im` events.
4. Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and (optional) `SLACK_CHANNEL` for the
   pushed morning brief. For notifications only, set `SLACK_WEBHOOK_URL` instead.

Both bots are implemented with **zero extra dependencies** — Telegram over plain
HTTPS long-polling, Slack over Node's native WebSocket.

---

## Connect your mailboxes

```bash
cp config/accounts.example.json config/accounts.json
```

Edit `config/accounts.json` and add each mailbox's IMAP + SMTP settings, plus your
owner profile (name, title, company, signature, and **voice notes** — the more
specific, the more it sounds like you). This file is gitignored.

**Gmail / Google Workspace:** turn on 2-step verification and create an
[App Password](https://myaccount.google.com/apppasswords) — use that as `pass`.
IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:465`.

**Outlook / Microsoft 365:** IMAP `outlook.office365.com:993`, SMTP
`smtp.office365.com:587` (secure: false → STARTTLS).

Then **Sync & work the inbox** in the dashboard, or let the background scheduler do
it every few minutes.

---

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `BIGDOG_PROVIDER` | `auto` | Brain backend: `auto` · `anthropic` · `ollama`. |
| `ANTHROPIC_API_KEY` | — | Your Claude key (for `anthropic`/`auto`). |
| `BIGDOG_MODEL` | `claude-opus-4-8` | The Claude model behind your clone. |
| `OLLAMA_HOST` | `http://localhost:11434` | Local Ollama endpoint. |
| `OLLAMA_MODEL` | `llama3.1` | Local model to run. |
| `PORT` | `4137` | Dashboard port. |
| `BIGDOG_SYNC_MINUTES` | `5` | Mailbox check interval (`0` disables). |
| `BIGDOG_DIGEST_HOUR` | `7` | Hour (0–23) the morning brief fires. |
| `BIGDOG_SEND_MODE` | `hold` | `hold` = approve every reply · `auto` = send confident ones automatically. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Telegram two-way chat + push target. |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_CHANNEL` | — | Slack two-way chat (Socket Mode) + push channel. |
| `SLACK_WEBHOOK_URL` | — | Slack one-way notifications (alternative to tokens). |

---

## How it's built

```
src/
  index.ts          Entry point — boots provider, server, bots, scheduler
  config.ts         Loads .env + config/accounts.json
  persona.ts        The Big Dog system prompt (your clone)
  brain.ts          The brain — triage, drafting, digest, chat (provider-agnostic)
  llm/provider.ts   Pluggable LLM backends: Claude · local Ollama · fallback
  db.ts             SQLite store (messages, deals, events, drafts, digests)
  mail/ingest.ts    IMAP → normalized messages
  mail/send.ts      SMTP send
  pipeline.ts       Triage loop: mail → deals + calendar
  digest.ts         Morning brief
  calendar.ts       Unified calendar + .ics export
  server.ts         REST API + static dashboard
  scheduler.ts      Background sync + daily digest (pushed to bots)
  bots/commands.ts  Shared command router (/brief /sync /deals /today + chat)
  bots/telegram.ts  Telegram two-way chat (long polling)
  bots/slack.ts     Slack two-way chat (Socket Mode, native WebSocket)
  seed.ts           Demo data for first run
public/             The dashboard (vanilla JS — inbox, pipeline, calendar, drafts, brief, chat)
```

Storage is a local SQLite file under `data/` (gitignored). Everything runs on your
machine; mail and deal data never leave it except for the Claude API calls that do
the thinking.

---

## Notes & roadmap

- Big Dog reads the most recent ~40 messages per mailbox per sync. Tune in
  `src/mail/ingest.ts`.
- Auto-send is off by default — start in `hold` mode and graduate threads you trust.
- Natural next steps: OAuth (Gmail/Graph) instead of app passwords, full thread
  context for replies, two-way calendar sync, and per-deal email history views.

🐕 *Go get 'em, Big Dog.*
