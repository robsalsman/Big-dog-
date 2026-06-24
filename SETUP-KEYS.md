# Big Dog — keys & accounts checklist

Everything is set in **⚙ Settings** in the app (no file editing). Big Dog runs
without any of these — but each one lights up more of the funnel.

## Required (the basics)

| What | Where to get it | Unlocks |
|------|-----------------|---------|
| **Anthropic (Claude) API key** | console.anthropic.com → API Keys (`sk-ant-…`) | The brain: triage, writing in your voice, research, prospecting, autopilot, natural-language commands. *Nothing intelligent works without this.* |
| **A mailbox** (email + password) | Your email provider (IONOS, Gmail, etc.). Gmail/Outlook need an **App Password**. | Reading + sending email. Just enter the address + password — Big Dog auto-detects the IMAP/SMTP servers. |

## Highly recommended

| What | Where | Unlocks |
|------|-------|---------|
| **Email-verification API key** | Reoon (free tier), ZeroBounce, Hunter.io, or AbstractAPI | Hard ✓-verified prospect emails over HTTPS (works even though VPS port 25 is blocked). |
| **Zoom** — Server-to-Server OAuth: **Account ID, Client ID, Client Secret** | marketplace.zoom.us → Build App → Server-to-Server OAuth. Scopes: `meeting:write`, `cloud_recording:read` | Real Zoom links on every meeting + pulling call transcripts for follow-ups. |
| **Twilio** — **Account SID, Auth Token, a phone number** | twilio.com/console | Text/call you (alerts, ready-to-book) and customers; reply-by-text control. Set the inbound webhook to `https://<your-domain>/twilio/inbound`. |

## Optional (nice to have)

| What | Where | Unlocks |
|------|-------|---------|
| **Apollo.io API key** | apollo.io (free tier) | Structured B2B prospect search instead of (or alongside) free Claude web research. |
| **Cal.com API key** | cal.com → Settings → Developer | Sync your Cal.com bookings into the unified calendar. |
| **Telegram bot token** | @BotFather on Telegram | Chat with / command Big Dog from Telegram. |
| **Slack tokens** (Bot + App token, or Webhook URL) | api.slack.com/apps | Chat with / command Big Dog from Slack. |
| **OpenAI API key** | platform.openai.com | Alternative LLM backend (note: web research/prospecting need Claude). |
| **TTS voice** | Bundled **Kokoro** runs free out of the box. For a **cloned** voice, run a **Chatterbox** server and point Settings → Voice at it. | A real voice on phone calls + voicemail. |

## Not an API — infrastructure (one-time)

- A **VPS / cloud server** (e.g. IONOS Cloud Server, Ubuntu) to run it.
- A **domain + DNS A-record** pointing at the server (HTTPS is automatic via Caddy).

---

**Fastest path to "it works":** Claude key + your mailbox → you have a working
AI inbox/CRM. Add the verification key + Zoom + Twilio to unlock the full
autonomous, book-meetings-by-text funnel.
