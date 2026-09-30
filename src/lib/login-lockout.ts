/**
 * login-lockout.ts — Brute-force lockout for credential sign-in.
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
import { loginLockouts, runtimeCounters } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";

/**
 * [hardening sep30] WHO gets locked. Keyed on the email alone, the ladder let anyone who knew an
 * address lock its owner out from one machine: 17 parallel bad logins → a 1 h lock, and one bad
 * login an hour kept it locked, with no in-app way back. So when the caller's address is known:
 *
 *   - the LADDER row is keyed `email|ip` — an address locks only itself out of that account;
 *   - an account-wide CEILING counts failures from every address in a rolling hour, and past it
 *     the account is refused for everyone until the window ends. That keeps a bound on
 *     distributed guessing, at a price an attacker needs many addresses to make the owner pay.
 *
 * Without an address (tests, non-ALB callers) the key is the bare email and there is no ceiling:
 * exactly the behaviour the frozen schedule specs pin.
 */
const EMAIL_FAILURE_CEILING = 50;
const EMAIL_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_FAILURE_SCOPE = "login_fail_email";

function ladderKey(email: string, ip?: string): string {
  return ip ? `${email.toLowerCase()}|${ip}` : email.toLowerCase();
}

export async function checkBruteForce(email: string, ip?: string): Promise<string | null> {
  const key = ladderKey(email, ip);
  const now = Date.now();
  if (ip) {
    const nowTs = sql`to_timestamp(${now}::double precision / 1000)`;
    const [wide] = await db
      .select({ count: runtimeCounters.count, resetAt: runtimeCounters.resetAt })
      .from(runtimeCounters)
      .where(
        and(
          eq(runtimeCounters.scope, EMAIL_FAILURE_SCOPE),
          eq(runtimeCounters.key, email.toLowerCase()),
          sql`${runtimeCounters.resetAt} > ${nowTs}`,
        ),
      );
    if (wide && wide.count >= EMAIL_FAILURE_CEILING) {
      const mins = Math.max(1, Math.ceil((new Date(wide.resetAt).getTime() - now) / 60000));
      return `Account locked. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`;
    }
  }
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

export async function recordFailedLogin(email: string, ip?: string): Promise<void> {
  const key = ladderKey(email, ip);
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
  if (ip) {
    const windowTs = sql`${nowTs} + (${EMAIL_FAILURE_WINDOW_MS} * interval '1 millisecond')`;
    await db
      .insert(runtimeCounters)
      .values({ scope: EMAIL_FAILURE_SCOPE, key: email.toLowerCase(), count: 1, resetAt: windowTs })
      .onConflictDoUpdate({
        target: [runtimeCounters.scope, runtimeCounters.key],
        set: {
          count: sql`CASE WHEN ${runtimeCounters.resetAt} < ${nowTs} THEN 1 ELSE ${runtimeCounters.count} + 1 END`,
          resetAt: sql`CASE WHEN ${runtimeCounters.resetAt} < ${nowTs} THEN ${windowTs} ELSE ${runtimeCounters.resetAt} END`,
        },
      });
  }
}

export async function clearFailedLogins(email: string, ip?: string): Promise<void> {
  const key = ladderKey(email, ip);
  await db.delete(loginLockouts).where(eq(loginLockouts.email, key));
  // A correct password also lifts the account-wide count: only the owner can produce one.
  if (ip) {
    await db
      .delete(runtimeCounters)
      .where(
        and(
          eq(runtimeCounters.scope, EMAIL_FAILURE_SCOPE),
          eq(runtimeCounters.key, email.toLowerCase()),
        ),
      );
  }
}
