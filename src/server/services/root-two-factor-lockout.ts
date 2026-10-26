/**
 * [2026-10-25 root hardening] Persistent code-guess lockout for the root two-factor routes — pure
 * schedule math over the three ladder fields stored in the `root-2fa:<userId>` row (the storage
 * side is root-two-factor.ts). The middleware's per-route buckets are in memory and reset on every
 * deploy; this ladder lives in the row, so a password holder cannot restart his 10-tries budget by
 * waiting for a restart.
 *
 * Same cadence as the sign-in lockout (lib/login-lockout.ts): THRESHOLD=5, then 60 s doubling every
 * 2 further failures, capped at 1 h. The count survives an expired lock (repeat offenders keep
 * escalating); only a successful code or password resets it (root-two-factor.ts withMarker).
 */

export const ROOT_TWO_FACTOR_LOCKOUT_THRESHOLD = 5;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;

export interface RootTwoFactorLockout {
  failedCount?: number;
  lockedUntil?: number;
  lastFailedAt?: number;
}

/** Lock length for the n-th consecutive failure (0 below the threshold). */
export function lockDurationMs(failedCount: number): number {
  if (failedCount < ROOT_TWO_FACTOR_LOCKOUT_THRESHOLD) return 0;
  const doublings = Math.floor((failedCount - ROOT_TWO_FACTOR_LOCKOUT_THRESHOLD) / 2);
  return Math.min(BASE_LOCK_MS * 2 ** doublings, MAX_LOCK_MS);
}

/** Milliseconds until the row's lock expires; 0 when there is none. */
export function lockoutRemainingMs(row: RootTwoFactorLockout, now: number): number {
  return typeof row.lockedUntil === "number" && row.lockedUntil > now ? row.lockedUntil - now : 0;
}

/** The ladder fields after one more failure at `now`. */
export function nextLockout(row: RootTwoFactorLockout, now: number): Required<Pick<RootTwoFactorLockout, "failedCount" | "lastFailedAt">> & { lockedUntil?: number } {
  const failedCount = (typeof row.failedCount === "number" && row.failedCount >= 0 ? row.failedCount : 0) + 1;
  const duration = lockDurationMs(failedCount);
  return { failedCount, lastFailedAt: now, lockedUntil: duration > 0 ? now + duration : undefined };
}
