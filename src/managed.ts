/**
 * "Big Dog Managed" mode — the hosted-service path.
 *
 * When the operator runs Big Dog as a service for others, they supply a central
 * master Anthropic key via env (BIGDOG_MANAGED_ANTHROPIC_KEY). Every user's
 * brain then runs on that key with ZERO per-user setup — the customer brings
 * only their mailbox. A user who pastes their OWN key always overrides the
 * managed one (so power users / self-hosters are unaffected).
 *
 * Voice (bundled Kokoro) and email verification (native SMTP) are already
 * zero-config, so in managed mode the entire onboarding collapses to a single
 * step: "connect your email."
 */

export function managedBrainKey(): string {
  return (process.env.BIGDOG_MANAGED_ANTHROPIC_KEY || '').trim();
}

/** Is Big Dog running as a managed service (central brain provided)? */
export function managedActive(): boolean {
  return managedBrainKey().length > 0;
}
