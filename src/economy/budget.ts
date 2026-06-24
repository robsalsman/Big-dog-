import { currentUserId } from '../db.js';
import { remainingThisMonth } from './ledger.js';

/** Raised when an action would exceed the user's monthly budget cap. */
export class BudgetError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(msg = "You've hit your monthly budget. Raise it in Billing to keep Big Dog working.") { super(msg); }
}

/**
 * Gate a spend for the current user. `estCredits` is a small estimate of what
 * the next action will cost. Unlimited / no-cap accounts always pass. We allow
 * the action when there's ANY budget left (so a single call can't be blocked by
 * a tiny remainder), and only hard-stop once the cap is fully spent.
 */
export function checkBudget(estCredits = 1): { ok: boolean; remaining: number | null } {
  const remaining = remainingThisMonth(currentUserId());
  if (remaining == null) return { ok: true, remaining: null };
  return { ok: remaining > 0, remaining };
}

export function assertBudget(estCredits = 1): void {
  if (!checkBudget(estCredits).ok) throw new BudgetError();
}
