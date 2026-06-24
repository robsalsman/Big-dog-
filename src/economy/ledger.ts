import { randomUUID } from 'node:crypto';
import { economy, users, type EconomyAccount } from '../db.js';
import { rateCard, usdToCredits, CREDIT_USD, defaultBudgetCents } from './rates.js';

/**
 * The metering ledger + per-user credit accounts. Every costly action writes a
 * usage event and debits credits; the budget gate reads the running monthly
 * total from here. All amounts are in the shared system DB.
 */

function monthStart(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Make sure an economy account exists; new users get the default monthly cap
 * (admins are unlimited so the operator's own usage is never gated). */
export function ensureAccount(userId: string): EconomyAccount {
  let acct = economy.getAccount(userId);
  if (!acct) {
    const isAdmin = users.byId(userId)?.role === 'admin';
    acct = {
      userId,
      balanceCredits: 0,
      monthlyBudgetCents: isAdmin ? null : defaultBudgetCents(),
      unlimited: isAdmin ? 1 : 0,
      periodStart: monthStart(),
      createdAt: new Date().toISOString(),
    };
    economy.createAccount(acct);
  }
  // Roll the billing period over if we've crossed into a new month.
  if (acct.periodStart && acct.periodStart < monthStart()) {
    economy.updateAccount(userId, { periodStart: monthStart() });
    acct.periodStart = monthStart();
  }
  return acct;
}

export interface Charge { kind: string; qty?: number; usd: number; meta?: Record<string, unknown> }

/** Record a charge against a user: writes the event and debits the balance. */
export function charge(userId: string, c: Charge): number {
  ensureAccount(userId);
  const credits = usdToCredits(c.usd * rateCard().markup);
  economy.insertUsage({
    id: randomUUID().slice(0, 16),
    userId,
    ts: new Date().toISOString(),
    kind: c.kind,
    qty: c.qty ?? 0,
    usdCost: c.usd,
    credits,
    meta: c.meta ? JSON.stringify(c.meta) : null,
  });
  if (credits) economy.addBalance(userId, -credits);
  return credits;
}

/** Add credits (Stripe top-up or admin grant) — recorded as a negative-cost event. */
export function grant(userId: string, credits: number, reason: string): void {
  ensureAccount(userId);
  economy.insertUsage({ id: randomUUID().slice(0, 16), userId, ts: new Date().toISOString(), kind: 'grant', qty: 0, usdCost: 0, credits: -Math.abs(credits), meta: JSON.stringify({ reason }) });
  economy.addBalance(userId, Math.abs(credits));
}

export interface Summary {
  unlimited: boolean;
  balanceCredits: number;
  monthlyBudgetCents: number | null;
  spentThisMonthCredits: number;
  spentThisMonthUsd: number;
  budgetUsedPct: number | null;
  periodStart: string;
  breakdown: { kind: string; qty: number; credits: number }[];
}

export function summary(userId: string): Summary {
  const acct = ensureAccount(userId);
  const since = acct.periodStart || monthStart();
  const spent = economy.spentSince(userId, since);
  const budgetCredits = acct.monthlyBudgetCents != null ? Math.round((acct.monthlyBudgetCents / 100) / CREDIT_USD) : null;
  return {
    unlimited: !!acct.unlimited,
    balanceCredits: acct.balanceCredits,
    monthlyBudgetCents: acct.monthlyBudgetCents,
    spentThisMonthCredits: spent,
    spentThisMonthUsd: +(spent * CREDIT_USD).toFixed(2),
    budgetUsedPct: budgetCredits ? Math.min(100, Math.round((spent / budgetCredits) * 100)) : null,
    periodStart: since,
    breakdown: economy.usageBreakdownSince(userId, since),
  };
}

export function setBudget(userId: string, opts: { monthlyBudgetCents?: number | null; unlimited?: boolean }): void {
  ensureAccount(userId);
  const fields: { monthlyBudgetCents?: number | null; unlimited?: number } = {};
  if (opts.unlimited !== undefined) fields.unlimited = opts.unlimited ? 1 : 0;
  if (opts.monthlyBudgetCents !== undefined) fields.monthlyBudgetCents = opts.monthlyBudgetCents;
  economy.updateAccount(userId, fields);
}

/** Credits remaining this month under the cap (null = unlimited / no cap). */
export function remainingThisMonth(userId: string): number | null {
  const acct = ensureAccount(userId);
  if (acct.unlimited || acct.monthlyBudgetCents == null) return null;
  const budgetCredits = Math.round((acct.monthlyBudgetCents / 100) / CREDIT_USD);
  const spent = economy.spentSince(userId, acct.periodStart || monthStart());
  return Math.max(0, budgetCredits - spent);
}
