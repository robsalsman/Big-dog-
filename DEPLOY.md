# Deploying Big Dog to bigdog.builda.company

Big Dog is a long-running, **stateful** Node service: it keeps IMAP connections
open, runs background workers (sync, digest, cadence, scheduled send), and stores
everything in a local SQLite file. That means it needs a **real server you
control** — a VPS / cloud server with root and Docker — **not** shared/managed
web hosting (those can't run persistent Node processes or open SQLite).

On IONOS the right product is a **Cloud Server** or **VPS** (Ubuntu 22.04+),
**not** the "Web Hosting" / "Deploy Now" plans.

---

## What you get

```
Internet ──HTTPS:443──▶ Caddy ──▶ bigdog:4137 (app)
                         │
                         └─ automatic Let's Encrypt certificate for
                            bigdog.builda.company, auto-renewed
```

One command builds and runs both containers. Caddy fetches and renews the TLS
cert automatically — you never touch certificates.

---

## Step 1 — Point DNS at the server

In your DNS provider for `builda.company`, add an **A record**:

| Type | Host     | Value                |
|------|----------|----------------------|
| A    | `bigdog` | `<your server's public IPv4>` |

(If the server has IPv6, add an `AAAA` record for `bigdog` too.)

Wait until it resolves: `dig +short bigdog.builda.company` should return your
server IP. TLS won't issue until this is live.

---

## Step 2 — Prepare the server

SSH into the server and install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

Open the firewall for web traffic (Caddy needs 80 + 443; 80 is required for the
ACME HTTP challenge):

```bash
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow OpenSSH && ufw --force enable
```

---

## Step 3 — Get the code + configure

```bash
git clone -b claude/big-dog-sales-assistant-h82vpz <your repo url> bigdog
cd bigdog
cp .env.example .env
```

Edit `.env` and set **at minimum**:

```ini
# REQUIRED — protects the whole app (inbox, deals, the ability to send mail as you)
BIGDOG_PASSWORD=<a long random password>

# Your LLM backend (or leave blank and pick it in-app under ⚙ Settings)
ANTHROPIC_API_KEY=sk-ant-...
```

You can configure everything else (mailboxes, Cal.com, Telegram/Slack, prospecting)
later from the **⚙ Settings** tab in the dashboard — no redeploy needed.

> **Live browser (optional):** the Docker image installs Vercel Labs'
> `agent-browser` + headless Chrome so Big Dog can read JS-rendered pages for
> lead research. It's on by default. To build a slimmer image without it:
> `docker compose build --build-arg WITH_BROWSER=false` (or set `BIGDOG_BROWSER=off`).

> **Voice (Kokoro, included):** the compose file runs a `kokoro` TTS service so
> Big Dog's phone calls have a real voice out of the box (built-in voices, CPU,
> ~1.5GB image + a one-time model download). Wants ~2GB+ RAM free. To skip it,
> comment out the `kokoro` service and the `VOICE_*` env on `bigdog` in
> `docker-compose.yml` — calls fall back to Twilio's built-in TTS. To use your
> **cloned** voice instead, run a Chatterbox server and point ⚙ Settings →
> Voice at it.

> Mailboxes: drop your real `config/accounts.json` on the server (it's gitignored
> and never committed), or just add mailboxes in ⚙ Settings after first launch.

---

## Step 4 — Launch

```bash
docker compose up -d --build
```

That's it. Watch it come up:

```bash
docker compose logs -f bigdog   # app boot + brain status
docker compose logs -f caddy    # TLS cert issuance
```

Visit **https://bigdog.builda.company**, log in with `BIGDOG_PASSWORD`, and
finish setup in ⚙ Settings.

---

## Updating

```bash
git pull
docker compose up -d --build
```

Your data (`./data`) and config (`./config`) and TLS certs survive rebuilds.

## Backups

Everything stateful is in two places — back these up:

- `./data/` — SQLite (mail cache, deals, calendar, drafts, memory)
- `./config/accounts.json` — your mailbox credentials

```bash
docker compose stop bigdog
tar czf bigdog-backup-$(date +%F).tgz data config/accounts.json
docker compose start bigdog
```

---

## Security notes (read before going public)

Big Dog can **read your mail and send email as you**. Exposing it on the
internet means anyone who reaches it could too. Non-negotiables:

1. **Set `BIGDOG_PASSWORD`** to something long and random. The app logs a loud
   `OPEN` warning if you don't.
2. **Always HTTPS.** Caddy enforces this and sets the session cookie `Secure`.
   Don't expose port 4137 directly — only 80/443 via Caddy.
3. **Start in `hold` send mode** (`BIGDOG_SEND_MODE=hold`, the default) so every
   outbound email waits for your one-click approval until you trust it.
4. Keep the server patched; restrict SSH to keys.

---

## Why not IONOS shared hosting / Deploy Now?

Those run stateless PHP/static sites or short-lived build outputs. Big Dog needs
a persistent process, a writable SQLite file, outbound IMAP/SMTP sockets, and
ports 80/443 — only a VPS / Cloud Server gives you that.
