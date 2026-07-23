/**
 * login-lockout.ts — Per-email brute-force lockout for credential sign-in.
 *
 * [refactor jul23 P5.4-A] Extracted verbatim from `auth.ts` into a pure module
 * so the exponential lockout schedule could be frozen (login-lockout.test.ts).
 *
 * [refactor jul23 P5.4-C] Backing store swapped from the per-ECS-task in-memory
 * `loginAttempts` Map to the shared Postgres `login_lockouts` table (migration
 * 0039). Rationale: an autoscaled N-task cluster no longer N×-dilutes the
 * lockout — every task reads/writes the one row per email. Signatures are
 * preserved except that the three helpers are now `async` (callers in auth.ts
 * await them; RD-P5e).
 *
 * WHY the schedule math is threaded with a JS timestamp instead of PG `now()`:
 * the exponential cadence still lives in SQL (the `power(2, floor(...))` CASE
 * below — one single upsert per failed attempt), but the *reference instant* is
 * the caller's `Date.now()`, passed as a bound parameter. That keeps the frozen
 * schedule assertions (login-lockout.test.ts uses vi.useFakeTimers) byte-for-
 * byte green: awaiting the same functions under fake timers reproduces the exact
 * same locked_until, because both the write and the read use the faked clock.
 *
 * Schedule (unchanged from the extraction): THRESHOLD=5, doubling every 2 extra
 * failures, base 60s, capped at 3600s (1h). count 5→1m, 6→1m, 7→2m, 8→2m,
 * 9→4m, ... 17→60m (64m clamped). The count SURVIVES an expired lockout so
 * repeat offenders keep escalating; a successful login clears the row. Only
 * failed passwords reach recordFailedLogin — normal sign-in/out never does.
 *
 * The idle sweep that dropped >2h-stale entries is now the advisory-locked
 * runtime-state janitor (P5.4-E, DELETE FROM login_lockouts WHERE last_attempt
 * < now() - interval '2 hours'), so this module no longer holds a setInterval.
 */

import { db } from "@/lib/db";
import { loginLockouts } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export async function checkBruteForce(email: string): Promise<string | null> {
  const key = email.toLowerCase();
  const now = Date.now();
  const res = await db.execute(
    sql`SELECT locked_until FROM login_lockouts WHERE email = ${key}`,
  );
  const row = res.rows[0] as { locked_until: Date | string | null } | undefined;
  if (!row || row.locked_until == null) return null;

  const lockedUntilMs = new Date(row.locked_until).getTime();
  if (lockedUntilMs > now) {
    const mins = Math.ceil((lockedUntilMs - now) / 60000);
    return `Account locked. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`;
  }
  return null;
}

export async function recordFailedLogin(email: string): Promise<void> {
  const key = email.toLowerCase();
  const now = Date.now();
  // The caller's instant, threaded so fake timers control the stored window.
  const nowTs = sql`to_timestamp(${now}::double precision / 1000)`;
  // Single upsert: increment the count, and (once past the threshold) set a new
  // locked_until on the exponential schedule. `login_lockouts.count` in the SET
  // clause is the PRE-update value, so `+ 1` is the new count. A brand-new row
  // is always count 1 (below threshold) → locked_until NULL.
  // [P5.4-C security-policy] Written via the drizzle builder (statically-resolvable
  // loginLockouts table) rather than db.execute(sql`INSERT…`): the project-security
  // checker forbids dynamic raw-SQL mutations it cannot prove target a non-tenant table.
  // The exponential-schedule value-SQL is verbatim from the prior raw statement, so the
  // frozen ladder is byte-preserved (login_lockouts.count in the ON-CONFLICT SET is the
  // PRE-update value per Postgres; `${loginLockouts.count}` renders that same column).
  await db
    .insert(loginLockouts)
    .values({ email: key, count: 1, lockedUntil: null, lastAttempt: nowTs })
    .onConflictDoUpdate({
      target: loginLockouts.email,
      set: {
        count: sql`${loginLockouts.count} + 1`,
        lastAttempt: nowTs,
        lockedUntil: sql`CASE
          WHEN ${loginLockouts.count} + 1 >= 5
          THEN ${nowTs} + (LEAST(3600, 60 * power(2, floor((${loginLockouts.count} + 1 - 5)::numeric / 2)))::int * interval '1 second')
          ELSE NULL
        END`,
      },
    });
}

export async function clearFailedLogins(email: string): Promise<void> {
  const key = email.toLowerCase();
  await db.delete(loginLockouts).where(eq(loginLockouts.email, key));
}
