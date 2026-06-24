import { currentUserId } from '../db.js';
import { charge } from './ledger.js';
import { rateCard } from './rates.js';

/**
 * High-level meters called from the code that actually spends money. Each
 * resolves the current user from the request context and records the real cost.
 * Safe to call from anywhere — if there's no user context it charges the
 * 'default' (operator) account, who is unlimited.
 */

export function meterLlm(opts: { inputTokens?: number; outputTokens?: number; webSearches?: number; model?: string }): void {
  const r = rateCard();
  const inTok = opts.inputTokens ?? 0;
  const outTok = opts.outputTokens ?? 0;
  const web = opts.webSearches ?? 0;
  const usd = (inTok / 1e6) * r.llmInputPerMTok + (outTok / 1e6) * r.llmOutputPerMTok;
  try {
    if (usd > 0) charge(currentUserId(), { kind: 'llm', qty: inTok + outTok, usd, meta: { model: opts.model, inTok, outTok } });
    if (web > 0) charge(currentUserId(), { kind: 'web_search', qty: web, usd: web * r.webSearchEach });
  } catch { /* metering must never break a request */ }
}

export function meterSms(segments: number): void {
  try { charge(currentUserId(), { kind: 'sms', qty: segments, usd: segments * rateCard().smsEach }); } catch { /* ignore */ }
}

export function meterCall(minutes: number): void {
  try { charge(currentUserId(), { kind: 'call', qty: minutes, usd: minutes * rateCard().callPerMin }); } catch { /* ignore */ }
}

export function meterVerify(count: number): void {
  const usd = count * rateCard().verifyEach;
  if (usd <= 0) return;
  try { charge(currentUserId(), { kind: 'verify', qty: count, usd }); } catch { /* ignore */ }
}

export function meterTts(chars: number): void {
  const usd = (chars / 1000) * rateCard().ttsPerKChar;
  if (usd <= 0) return;
  try { charge(currentUserId(), { kind: 'tts', qty: chars, usd }); } catch { /* ignore */ }
}
