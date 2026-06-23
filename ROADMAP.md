# 🐕 Big Dog — Roadmap to "complete"

Big Dog already does a lot: unified inbox, AI triage, auto-draft, deal pipeline,
Cal.com calendar, morning brief, operator mode, memory, research, follow-up
cadences, prospecting, a free email finder/verifier + pattern learner, CSV bulk
enrichment, the campaign play, multi-backend AI (Claude/ChatGPT/Ollama) with in-app
settings, and Telegram/Slack.

Here's an honest, prioritized list of what would make it a *complete, trustworthy
product* — roughly in the order I'd build it.

## 1. Trust & safety (do these before sending real volume)
- **Dashboard auth** — right now anyone who can reach the port sees all mail/deals
  and can send. Add a login (single password / token) and bind to localhost by
  default. *Highest priority if you ever host it.*
- **Outreach compliance** — a **suppression list** (never email opted-out/bounced
  addresses), automatic unsubscribe handling (detect "no"/"unsubscribe" replies →
  suppress + close the deal), and physical-address/identity footer for CAN-SPAM.
- **Send throttling & warmup** — rate-limit outbound (per-hour caps, jitter, daily
  limits) so campaigns don't trip spam filters or get the mailbox flagged.
- **Bounce handling** — read bounces/auto-replies and mark emails invalid + suppress.

## 2. Core product completeness
- **Sent-mail + true threading** — record sent messages, thread replies into one
  conversation view, and feed the *whole thread* to the drafter (today it replies to
  a single message). This is the biggest quality lever for reply quality.
- **In-app mailbox setup** — add/test IMAP/SMTP accounts from the UI (like the AI
  Settings screen) instead of editing `config/accounts.json`. Makes it truly
  shareable. Add OAuth for Gmail/Outlook so no app passwords.
- **Contacts / people view** — a real contact record (not just deals): every person,
  their threads, memory, last touch. Deals link to contacts.
- **Deal detail + activity timeline** — open a deal and see its full history: emails,
  events, drafts, notes, stage changes.
- **Reporting** — pipeline value by stage, win rate, activity counts, emails
  sent/replied, campaign performance.

## 3. Reliability & maintainability
- **Automated tests** — a real test suite (vitest) for triage, the email
  finder/verifier, pattern learner, CSV parse, providers. (Today it's verified by
  hand each change.)
- **Activity log / observability** — a visible feed of what Big Dog did and any
  errors (sync failures, send errors, model errors) instead of silent `catch`.
- **Backup / export** — one-click export of deals/contacts/emails (CSV/JSON) and a
  DB backup; import to restore.
- **Graceful model retries** — backoff + clear surfacing when a provider rate-limits
  or errors mid-campaign.

## 4. Higher-leverage AI
- **Full-thread context** for replies (pairs with threading above).
- **RAG over your collateral** — ground replies in your real pricing sheets,
  battlecards, and past proposals (a `knowledge/` folder + local embeddings).
- **Reply auto-classification → auto-actions** — "interested" advances the deal +
  proposes a meeting; "not now" sets a snooze cadence; "unsubscribe" suppresses.
- **A/B subject/intro testing** in campaigns with reply-rate tracking.

## 5. Nice-to-have
- **Attachments** — view inbound attachments; attach files when sending.
- **Templates / snippets** — reusable, editable building blocks for common replies.
- **Mobile-polished UI** + a couple of keyboard shortcuts.
- **More integrations** — push deals to a real CRM (HubSpot/Salesforce/Pipedrive),
  enrichment via a paid data key when you want verified phone/email at scale,
  calendar two-way sync beyond Cal.com.
- **Voice** — a quick "what's up, Big Dog" voice check-in/briefing.

---

**If I had to pick the next three:** (1) dashboard auth, (2) sent-mail + true
threading with full-thread reply context, (3) in-app mailbox setup with Gmail/Outlook
OAuth. Those turn Big Dog from a powerful personal tool into something you'd trust to
hand to someone else and point at a real mailbox.
