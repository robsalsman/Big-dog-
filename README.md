# 🐕 Big Dog

> *"What's up, Big Dog!?"*

Your inside-sales development rep, executive assistant, and **clone** — all in one
self-hosted app. Big Dog pulls all your work mailboxes into one inbox, puts
everything on one calendar, works your deals, and keeps you briefed — writing and
sending email in *your* voice with CEO-level intellect and hustle.

Runs on [Claude](https://www.anthropic.com/), **[ChatGPT](https://platform.openai.com/),
or a fully local [Ollama](https://ollama.com) model** (zero API cost) — pick your
backend and paste your own key right in the app (**⚙ Settings**), no config files.
Chat with it from the web dashboard, **Telegram, or Slack**.

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

### Big Dog does big things

Beyond triage and drafting, Big Dog is a real agent:

- **Operator mode** — tell it a goal ("follow up with everyone stuck in proposal
  stage") and it runs an autonomous tool loop: look up deals, draft replies, update
  stages, schedule calls, remember facts — taking real action and queuing anything
  that needs your sign-off. (Dashboard → *Ask Big Dog* → Operator, or `/do` from a bot.)
- **Relationship memory** — it remembers each contact across months (objections,
  preferences, history) and threads that into every reply. (📝 *Remember* on any
  message, or the `remember` tool.)
- **Lead research** — pulls a web brief on a prospect (company, funding, role, news)
  before you reply. (🔎 *Research* on any message, or `/research`. Uses the Claude
  backend's web access.)
- **Follow-up cadences** — sweeps for stalled or overdue deals daily and drafts
  nudges so nothing goes cold silently. (🐕 *Run follow-ups* on the Pipeline, or
  `/followups`.)
- **Auto-draft on arrival** — the moment a hot/warm email lands, a reply is already
  drafted and waiting for your approval (no-reply/notification senders skipped).
  Toggle with `BIGDOG_AUTODRAFT`. (Inspired by `cloudflare/agentic-inbox`.)
- **Search** — full-text search across your inbox and pipeline from the Inbox tab.
- **Prospecting (lead gen)** — ZoomInfo-style: describe your ideal customer and Big
  Dog sources leads, then one-click them into the pipeline. Free **web research** by
  default (public data, no signup); add an `APOLLO_API_KEY` for structured B2B search.
  (Prospect tab, or `/find <criteria>` from a bot.) *No true open-source ZoomInfo
  exists — the data is proprietary — so this is a pluggable free-backend approach.*
- **Email finder + verifier** — the same engine Hunter.io charges for, built in and
  free: from a name + company domain it permutes the likely addresses, finds the
  domain's mail server, and SMTP-`RCPT`-probes each (no email is ever sent) to return
  a **verified** address — with catch-all detection and honest confidence labels.
  ("Find email" on any sourced lead, `/email <name> at <domain>` from a bot, or the
  `find_email` operator tool.)
- **Email-pattern learner** — closes most of the gap with paid tools: Big Dog finds
  one known email at a company (web anchor, or by scraping the site), deduces that
  company's exact format (`first.last`, `flast`, …), caches it per domain, and applies
  it — so even domains it can't SMTP-verify get a confident, correctly-formatted
  address instead of a blind guess.

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

## Choose your AI (no config files)

Open the **⚙ Settings** tab and pick a backend — **Claude**, **ChatGPT**, or local
**Ollama** — and paste your own API key. It's stored locally, takes effect
immediately (no restart), and there's a **Test connection** button. This is what
makes Big Dog shareable: hand someone the app and they just drop in their key.

> Heads up: **web research, prospecting, and email-pattern learning use the Claude
> backend** (it has built-in web access). On ChatGPT/Ollama everything else works;
> those web features return a clear "needs Claude" message. Advanced: set
> `OPENAI_BASE_URL` to use any OpenAI-compatible endpoint (Azure, OpenRouter, LM
> Studio, vLLM, …).

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

## Calendar via Cal.com (open-source scheduling)

Big Dog plugs into [Cal.com](https://github.com/calcom/cal.com) — cloud or your own
self-hosted instance — for real scheduling. It pulls your bookings into the one
unified calendar and shares your booking link automatically when it sets up a call
on your behalf.

```bash
# .env:
CALCOM_API_KEY=cal_xxx                 # Cal.com → Settings → Developer → API Keys
CALCOM_BASE_URL=https://api.cal.com/v1 # or your self-hosted instance's v1 API
CALCOM_BOOKING_URL=https://cal.com/rob # your public booking link
```

Bookings sync on the same interval as mail (and on demand from the Calendar tab).
Without Cal.com configured, the built-in calendar + `.ics` feed still work.

---

## How the email finder works (and its limits)

This is what Hunter.io/Apollo's email-finding actually is — an algorithm, not a
database, so Big Dog does it for free:

1. **Permute** — generate the common corporate patterns from a name + domain
   (`first.last@`, `flast@`, `first@`, …).
2. **MX lookup** — find the domain's real mail server.
3. **SMTP probe** — open a session and `RCPT TO` each candidate. The server says
   whether the mailbox exists. **No email is ever sent.** A random-address probe
   detects **catch-all** domains (which accept everything and can't be verified).

Confidence is honest: `verified` (server confirmed), `guess` (catch-all domain *or*
a learned company pattern), or `unverified` (best-pattern fallback).

**Pattern learning** (`patternlearner.ts`) makes the guesses far better. Before
guessing, Big Dog tries to learn the company's actual format from one *known* email:
a real name+email pair found on the web (exact pattern), or a personal address
scraped from the site's contact/team pages (structural pattern). It caches the result
per domain and applies it first — so a domain you can't verify still yields the
right-shaped address (`jane.smith@…` not a blind `j.smith@…`).

> **The catch:** SMTP verification needs outbound **port 25**, which many ISPs and
> cloud hosts block, and Gmail/Microsoft 365 deliberately defeat probing. When it
> can't verify, Big Dog returns the best-pattern guess clearly labelled
> `unverified` — it never fakes a "verified". For reliable verification at scale you
> need a host with port 25 egress (or a paid verifier's IP pool) — that's exactly
> what you're paying Hunter for.

---

## Chat with Big Dog (Telegram / Slack)

Talk to your clone from your phone — ask about deals, get the morning brief, trigger
a sync — using the same commands everywhere: `/do <goal>`, `/research <who>`,
`/followups`, `/brief`, `/sync`, `/deals`, `/today`, `/help`, or just chat.

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
| `BIGDOG_PROVIDER` | `auto` | Default backend: `auto` · `anthropic` · `openai` · `ollama` (also settable in-app). |
| `ANTHROPIC_API_KEY` | — | Your Claude key (for `anthropic`/`auto`). |
| `BIGDOG_MODEL` | `claude-opus-4-8` | The Claude model behind your clone. |
| `OPENAI_API_KEY` | — | Your ChatGPT key (for `openai`/`auto`). |
| `OPENAI_MODEL` | `gpt-4o` | The OpenAI model to use. |
| `OPENAI_BASE_URL` | OpenAI | Any OpenAI-compatible endpoint (Azure/OpenRouter/LM Studio/…). |
| `OLLAMA_HOST` | `http://localhost:11434` | Local Ollama endpoint. |
| `OLLAMA_MODEL` | `llama3.1` | Local model to run. |
| `PORT` | `4137` | Dashboard port. |
| `BIGDOG_SYNC_MINUTES` | `5` | Mailbox check interval (`0` disables). |
| `BIGDOG_DIGEST_HOUR` | `7` | Hour (0–23) the morning brief fires. |
| `BIGDOG_SEND_MODE` | `hold` | `hold` = approve every reply · `auto` = send confident ones automatically. |
| `BIGDOG_AUTODRAFT` | `on` | Auto-draft a reply when a hot/warm email arrives (`on`/`off`). |
| `BIGDOG_CADENCE_STALE_DAYS` | `4` | Days of silence before a deal gets a follow-up nudge. |
| `BIGDOG_AGENT_MAX_STEPS` | `8` | Max tool steps per operator-mode task. |
| `BIGDOG_PROSPECT_PROVIDER` | `auto` | Lead-gen backend: `web` (free) · `apollo` · `auto`. |
| `APOLLO_API_KEY` | — | Apollo.io free-tier key for structured B2B prospecting. |
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
  llm/provider.ts   Pluggable LLM backends: Claude · ChatGPT · Ollama · fallback
  settings.ts       Runtime backend/key settings (the ⚙ Settings screen)
  db.ts             SQLite store (messages, deals, events, drafts, digests)
  mail/ingest.ts    IMAP → normalized messages
  mail/send.ts      SMTP send
  pipeline.ts       Triage loop: mail → deals + calendar
  agent/agent.ts    Operator mode — autonomous ReAct tool loop (any backend)
  agent/tools.ts    The tools Big Dog can act with (deals, drafts, calendar, memory…)
  cadence.ts        Follow-up engine — nudges for stalled/overdue deals
  prospect.ts       Lead gen — pluggable backends (web research · Apollo.io)
  emailfinder.ts    Free email finder + SMTP verifier (Hunter-style engine)
  patternlearner.ts Learns a company's email format (web anchor / site scrape)
  digest.ts         Morning brief
  calendar.ts       Unified calendar + .ics export
  calcom.ts         Cal.com booking sync (cloud or self-hosted)
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
