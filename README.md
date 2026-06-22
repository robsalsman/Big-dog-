# 🐕 Big Dog

> *"What's up, Big Dog!?"*

Your inside-sales development rep, executive assistant, and **clone** — all in one
self-hosted app. Big Dog pulls all your work mailboxes into one inbox, puts
everything on one calendar, works your deals, and keeps you briefed — writing and
sending email in *your* voice with CEO-level intellect and hustle.

It runs on [Claude](https://www.anthropic.com/) (`claude-opus-4-8`).

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

Without an API key it still runs end-to-end using simple fallbacks. Add the key to
get the real "clone of you" intelligence.

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
| `ANTHROPIC_API_KEY` | — | Your Claude key. Powers the brain. |
| `BIGDOG_MODEL` | `claude-opus-4-8` | The model behind your clone. |
| `PORT` | `4137` | Dashboard port. |
| `BIGDOG_SYNC_MINUTES` | `5` | Mailbox check interval (`0` disables). |
| `BIGDOG_DIGEST_HOUR` | `7` | Hour (0–23) the morning brief fires. |
| `BIGDOG_SEND_MODE` | `hold` | `hold` = approve every reply · `auto` = send confident ones automatically. |

---

## How it's built

```
src/
  index.ts        Entry point — boots server + scheduler, seeds demo data
  config.ts       Loads .env + config/accounts.json
  persona.ts      The Big Dog system prompt (your clone)
  claude.ts       The brain — triage, drafting, digest, chat (graceful no-key fallbacks)
  db.ts           SQLite store (messages, deals, events, drafts, digests)
  mail/ingest.ts  IMAP → normalized messages
  mail/send.ts    SMTP send
  pipeline.ts     Triage loop: mail → deals + calendar
  digest.ts       Morning brief
  calendar.ts     Unified calendar + .ics export
  server.ts       REST API + static dashboard
  scheduler.ts    Background sync + daily digest
  seed.ts         Demo data for first run
public/           The dashboard (vanilla JS — inbox, pipeline, calendar, drafts, brief, chat)
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
