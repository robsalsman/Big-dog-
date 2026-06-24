import { createHmac, timingSafeEqual } from 'node:crypto';
import { vault } from '../secrets.js';
import { systemStore } from '../db.js';
import { grant } from './ledger.js';

/**
 * Stripe prepaid credits — REST-only (no SDK dependency). Customers buy a credit
 * pack via Stripe Checkout; the webhook tops up their balance. Their card stays
 * at Stripe; we only ever see a payment confirmation.
 *
 * Operator config lives in the vault (stripe.secretKey, stripe.webhookSecret),
 * with env fallback. Credit packs are operator-editable (systemStore).
 */

export function stripeKey(): string { return vault.get('stripe.secretKey') || process.env.STRIPE_SECRET_KEY || ''; }
export function stripeWebhookSecret(): string { return vault.get('stripe.webhookSecret') || process.env.STRIPE_WEBHOOK_SECRET || ''; }
export function stripeConfigured(): boolean { return !!stripeKey(); }

export interface Pack { id: string; label: string; usd: number; credits: number; }
const DEFAULT_PACKS: Pack[] = [
  { id: 'starter', label: 'Starter', usd: 25, credits: 25_000 },
  { id: 'pro', label: 'Pro', usd: 100, credits: 110_000 },   // +10% bonus
  { id: 'scale', label: 'Scale', usd: 500, credits: 600_000 }, // +20% bonus
];

export function packs(): Pack[] {
  const raw = systemStore.get('economy.packs');
  if (raw) { try { const p = JSON.parse(raw) as Pack[]; if (Array.isArray(p) && p.length) return p; } catch { /* fall through */ } }
  return DEFAULT_PACKS;
}
export function savePacks(p: Pack[]): void { systemStore.set('economy.packs', JSON.stringify(p)); }

/** Create a Stripe Checkout session for a credit pack; returns the hosted URL. */
export async function createCheckout(userId: string, pack: Pack, origin: string): Promise<string> {
  const key = stripeKey();
  if (!key) throw new Error('Billing is not set up yet.');
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', `${origin}/?billing=success`);
  body.set('cancel_url', `${origin}/?billing=cancel`);
  body.set('client_reference_id', userId);
  body.set('metadata[userId]', userId);
  body.set('metadata[credits]', String(pack.credits));
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', 'usd');
  body.set('line_items[0][price_data][unit_amount]', String(Math.round(pack.usd * 100)));
  body.set('line_items[0][price_data][product_data][name]', `Big Dog credits — ${pack.label}`);
  body.set('line_items[0][price_data][product_data][description]', `${pack.credits.toLocaleString()} credits`);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = (await res.json()) as { url?: string; error?: { message?: string } };
  if (!res.ok || !j.url) throw new Error(j.error?.message || 'Stripe could not start checkout.');
  return j.url;
}

/** Verify a Stripe webhook signature (t=…,v1=… HMAC-SHA256 over `${t}.${body}`). */
export function verifySignature(rawBody: Buffer, sigHeader: string | undefined): boolean {
  const secret = stripeWebhookSecret();
  if (!secret || !sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')) as [string, string][]);
  const t = parts['t']; const v1 = parts['v1'];
  if (!t || !v1) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  try { return timingSafeEqual(Buffer.from(v1), Buffer.from(expected)); } catch { return false; }
}

/** Handle a verified webhook event. Credits the buyer once (idempotent). */
export function handleEvent(event: { type?: string; data?: { object?: Record<string, unknown> } }): void {
  if (event.type !== 'checkout.session.completed') return;
  const s = (event.data?.object ?? {}) as Record<string, unknown>;
  const id = String(s.id ?? '');
  const meta = (s.metadata ?? {}) as Record<string, string>;
  const userId = meta.userId || String(s.client_reference_id ?? '');
  const credits = Number(meta.credits ?? 0);
  if (!id || !userId || !(credits > 0)) return;
  if (systemStore.get(`stripe.done.${id}`)) return; // already processed
  grant(userId, credits, `Stripe purchase ${id}`);
  systemStore.set(`stripe.done.${id}`, '1');
}
