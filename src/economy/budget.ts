import { currentUserId } from '../db.js';
import { ensureAccount, remainingThisMonth } from './ledger.js';
import { managedActive } from '../managed.js';

/** Raised when an action can't be afforded (budget cap hit or out of credits). */
export class BudgetError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(msg: string) { super(msg); }
}

/**
 * Gate a spend for the current user. Unlimited accounts (admins / operator) and
 * self-host (bring-your-own-key, non-managed) always pass. In managed mode a
 * regular user is blocked when they've spent their prepaid credits or hit the
 * monthly cap they set.
 */
export function checkBudget(): { ok: boolean; reason?: string } {
  const uid = currentUserId();
  const acct = ensureAccount(uid);
  if (acct.unlimited) return { ok: true };

  const capLeft = remainingThisMonth(uid);
  if (capLeft != null && capLeft <= 0) {
    return { ok: false, reason: "You've hit your monthly budget. Raise it in Billing to keep Big Dog working." };
  }
  // Prepaid balance only gates managed users (who run on the operator's key).
  if (managedActive() && acct.balanceCredits <= 0) {
    return { ok: false, reason: "You're out of Big Dog credits. Top up in Billing to keep going." };
  }
  return { ok: true };
}

export function assertBudget(): void {
  const r = checkBudget();
  if (!r.ok) throw new BudgetError(r.reason || 'Budget limit reached.');
}
