import { systemStore } from '../db.js';

/**
 * The rate card. Every metered resource has a real provider cost (USD); the
 * operator's markup turns that into Big Dog **credits**, the single internal
 * currency. 1 credit = $0.001 (a tenth of a cent) so balances stay integers.
 *
 * Defaults are conservative; the operator can override any of these from the
 * Admin economy panel (persisted in systemStore as economy.rate.<key>).
 */
export const CREDIT_USD = 0.001; // 1000 credits = $1
export function usdToCredits(usd: number): number {
  return Math.ceil((usd / CREDIT_USD));
}

export interface RateCard {
  llmInputPerMTok: number;   // USD per 1M input tokens
  llmOutputPerMTok: number;  // USD per 1M output tokens
  webSearchEach: number;     // USD per web search request
  smsEach: number;           // USD per SMS segment
  callPerMin: number;        // USD per voice minute
  verifyEach: number;        // USD per email verification (native SMTP = free)
  ttsPerKChar: number;       // USD per 1k TTS characters (bundled Kokoro = free)
  markup: number;            // operator margin multiplier applied to real cost
}

const DEFAULTS: RateCard = {
  llmInputPerMTok: 15,
  llmOutputPerMTok: 75,
  webSearchEach: 0.01,
  smsEach: 0.0079,
  callPerMin: 0.014,
  verifyEach: 0,
  ttsPerKChar: 0,
  markup: 1.5,
};

function num(key: keyof RateCard, dflt: number): number {
  const v = systemStore.get(`economy.rate.${key}`);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function rateCard(): RateCard {
  return {
    llmInputPerMTok: num('llmInputPerMTok', DEFAULTS.llmInputPerMTok),
    llmOutputPerMTok: num('llmOutputPerMTok', DEFAULTS.llmOutputPerMTok),
    webSearchEach: num('webSearchEach', DEFAULTS.webSearchEach),
    smsEach: num('smsEach', DEFAULTS.smsEach),
    callPerMin: num('callPerMin', DEFAULTS.callPerMin),
    verifyEach: num('verifyEach', DEFAULTS.verifyEach),
    ttsPerKChar: num('ttsPerKChar', DEFAULTS.ttsPerKChar),
    markup: num('markup', DEFAULTS.markup),
  };
}

export function saveRateCard(partial: Partial<RateCard>): void {
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || v === null || !Number.isFinite(Number(v))) continue;
    systemStore.set(`economy.rate.${k}`, String(Number(v)));
  }
}

/** Default monthly budget (USD cents) applied to a new non-admin account. */
export function defaultBudgetCents(): number {
  const v = Number(systemStore.get('economy.defaultBudgetCents'));
  return Number.isFinite(v) && v > 0 ? v : 2000; // $20/mo
}
