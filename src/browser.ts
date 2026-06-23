import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Real-browser capability for Big Dog, powered by Vercel Labs' `agent-browser`
 * CLI (https://github.com/vercel-labs/agent-browser) — a headless Chrome driven
 * over CDP. It lets Big Dog actually *read* JS-rendered pages (company team /
 * contact pages, profiles, anything search snippets miss) for lead research and
 * email-pattern learning.
 *
 * It's entirely OPTIONAL: if the `agent-browser` binary isn't installed, every
 * call degrades gracefully and the rest of Big Dog runs unchanged. Install with
 * `npm i -g agent-browser && agent-browser install` (Chrome included in Docker).
 */

const BIN = process.env.BIGDOG_BROWSER_BIN || 'agent-browser';
const MODE = (process.env.BIGDOG_BROWSER || 'auto').toLowerCase(); // auto | on | off
const ALLOWED = (process.env.BIGDOG_BROWSER_ALLOWED_DOMAINS || '').trim();
const TIMEOUT_MS = Number(process.env.BIGDOG_BROWSER_TIMEOUT_MS || 30_000);
const MAX_OUTPUT = Number(process.env.BIGDOG_BROWSER_MAX_OUTPUT || 12_000);

let availability: Promise<boolean> | null = null;
let lastKnownReady = false;

/** True unless explicitly disabled — used to decide whether to advertise the tool. */
export function browserConfigured(): boolean {
  return MODE !== 'off';
}

/** Last resolved availability (sync; prewarm with ensureBrowser() at startup). */
export function browserReady(): boolean {
  return lastKnownReady;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, timeout = TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err ? String(err.message) : '') });
    });
  });
}

/** Detect (and cache) whether the agent-browser CLI is installed and runnable. */
export async function ensureBrowser(): Promise<boolean> {
  if (MODE === 'off') return false;
  if (!availability) {
    availability = runCli(['--version'], process.env, 8000)
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        lastKnownReady = ok;
        return ok;
      });
  }
  return availability;
}

// Block obvious internal/SSRF targets — page URLs can originate from the model.
function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;
  return true;
}

function safeEnv(session: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_HEADED: 'false',
    // Wrap page text in LLM-safety delimiters — a guard against prompt injection
    // from untrusted page content we feed back to the model.
    AGENT_BROWSER_CONTENT_BOUNDARIES: 'true',
    AGENT_BROWSER_MAX_OUTPUT: String(MAX_OUTPUT),
    AGENT_BROWSER_DEFAULT_TIMEOUT: String(TIMEOUT_MS),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '15000', // auto-close Chrome/daemon when idle
    ...(ALLOWED ? { AGENT_BROWSER_ALLOWED_DOMAINS: ALLOWED } : {}),
  };
}

function dataFrom(stdout: string): any {
  try {
    const o = JSON.parse(stdout);
    return o?.data ?? o;
  } catch {
    return null;
  }
}

export interface PageRead {
  ok: boolean;
  url: string;
  text: string; // accessibility-tree snapshot (compact), or error message
  error?: string;
}

/**
 * Open a URL in headless Chrome and return a compact accessibility snapshot —
 * the LLM-friendly view of the page. Falls back gracefully if unavailable.
 */
export async function readPage(url: string): Promise<PageRead> {
  if (!(await ensureBrowser())) {
    return { ok: false, url, text: '', error: 'Browser not available (install the agent-browser CLI to enable page reading).' };
  }
  if (!isPublicHttpUrl(url)) {
    return { ok: false, url, text: '', error: 'Refused: only public http(s) URLs can be browsed.' };
  }
  const session = `bigdog-${randomUUID().slice(0, 8)}`;
  const env = safeEnv(session);
  try {
    const open = await runCli(['open', url, '--json'], env);
    if (!open.ok) return { ok: false, url, text: '', error: `Couldn't open page: ${open.stderr.slice(0, 200)}` };
    const snap = await runCli(['snapshot', '-c', '--json'], env);
    const data = dataFrom(snap.stdout);
    const text = (data?.snapshot ?? snap.stdout ?? '').toString().trim();
    return text ? { ok: true, url, text } : { ok: false, url, text: '', error: 'Empty page snapshot.' };
  } finally {
    await runCli(['close'], env, 8000).catch(() => undefined);
  }
}

/**
 * Fetch a page's rendered HTML (captures emails injected by JS that a plain
 * fetch misses). Used to strengthen the email-pattern learner. '' on failure.
 */
export async function pageHtml(url: string): Promise<string> {
  if (!(await ensureBrowser()) || !isPublicHttpUrl(url)) return '';
  const session = `bigdog-${randomUUID().slice(0, 8)}`;
  const env = safeEnv(session);
  try {
    const open = await runCli(['open', url, '--json'], env);
    if (!open.ok) return '';
    const got = await runCli(['get', 'html', '--json'], env);
    const data = dataFrom(got.stdout);
    return (data?.html ?? data?.value ?? data?.text ?? '').toString();
  } catch {
    return '';
  } finally {
    await runCli(['close'], env, 8000).catch(() => undefined);
  }
}
