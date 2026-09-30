// @vitest-environment node
// [refactor jul23 P5.4-C] SQL-REPRODUCTION spec — proves the login_lockouts
// upsert (the single INSERT ... ON CONFLICT in login-lockout.ts) reproduces the
// exact exponential schedule the in-memory JS Map used to compute. Per RD-P5e
// this ADDS the SQL layer under the semantic pins in login-lockout.test.ts; it
// does not replace them. It reads the raw login_lockouts columns (count,
// locked_until) directly so the SQL CASE — not JS — is what's under test.
//
// The schedule-mutant probe (flip `/ 2` → `/ 1` inside `power(2, floor((count
// + 1 - 5)::numeric / 2))` in login-lockout.ts) must turn THIS spec red: it
// breaks the doubling cadence the count==7 / count==9 assertions below pin.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { checkBruteForce, recordFailedLogin, clearFailedLogins } from "@/lib/login-lockout";

const dbUp = inject("dbUp") as boolean;
const BASE = new Date("2026-07-23T00:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});
afterEach(() => {
  vi.useRealTimers();
});

// Read the persisted row straight from PG — bypasses checkBruteForce so the
// stored SQL result (count + locked_until offset in seconds from BASE) is the
// thing asserted.
async function row(
  email: string,
): Promise<{ count: number; lockSecondsFromBase: number | null }> {
  const res = await db.execute(
    sql`SELECT count, locked_until FROM login_lockouts WHERE email = ${email.toLowerCase()}`,
  );
  const r = res.rows[0] as
    | { count: number; locked_until: Date | string | null }
    | undefined;
  if (!r) throw new Error(`no login_lockouts row for ${email}`);
  const lockSecondsFromBase =
    r.locked_until == null
      ? null
      : Math.round((new Date(r.locked_until).getTime() - BASE) / 1000);
  return { count: r.count, lockSecondsFromBase };
}

describe.skipIf(!dbUp)("login_lockouts upsert reproduces the schedule (SQL)", () => {
  it("increments count and holds locked_until NULL below the threshold", async () => {
    const email = "pg-below@sql.example.com";
    for (let i = 1; i <= 4; i += 1) {
      await recordFailedLogin(email);
      expect(await row(email)).toEqual({ count: i, lockSecondsFromBase: null });
    }
  });

  it("sets locked_until on the doubling-every-2 cadence, capped at 3600s", async () => {
    const email = "pg-cadence@sql.example.com";
    // (count → seconds): 5→60, 6→60, 7→120, 8→120, 9→240, 17→3600 (3840 capped).
    const expected = new Map<number, number>([
      [5, 60],
      [6, 60],
      [7, 120],
      [8, 120],
      [9, 240],
      [11, 480],
      [13, 960],
      [15, 1920],
      [17, 3600],
      [19, 3600],
    ]);
    for (let count = 1; count <= 19; count += 1) {
      await recordFailedLogin(email);
      const want = expected.get(count);
      if (want !== undefined) {
        expect(await row(email)).toEqual({ count, lockSecondsFromBase: want });
      }
    }
  });

  it("keeps the count across an expired lock, then re-locks on the higher rung", async () => {
    const email = "pg-survivor@sql.example.com";
    for (let i = 0; i < 5; i += 1) await recordFailedLogin(email); // count 5 → 60s
    expect(await row(email)).toEqual({ count: 5, lockSecondsFromBase: 60 });

    // Advance past the 60s lock; the row (and its count) persists in PG.
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 3; i += 1) await recordFailedLogin(email); // count 8
    // locked_until is now anchored on the LATER instant (BASE + 61s) + 120s.
    const r = await row(email);
    expect(r.count).toBe(8);
    expect(r.lockSecondsFromBase).toBe(61 + 120);
  });

  it("clearFailedLogins deletes the row (fresh escalation afterward)", async () => {
    const email = "pg-clear@sql.example.com";
    for (let i = 0; i < 6; i += 1) await recordFailedLogin(email); // count 6
    expect((await row(email)).count).toBe(6);

    await clearFailedLogins(email);
    const res = await db.execute(
      sql`SELECT count FROM login_lockouts WHERE email = ${email}`,
    );
    expect(res.rows).toHaveLength(0);

    // Next failure starts a brand-new row at count 1, locked_until NULL.
    await recordFailedLogin(email);
    expect(await row(email)).toEqual({ count: 1, lockSecondsFromBase: null });
  });
});

// [hardening sep30] With the caller's address known, an address locks only ITSELF out of an
// account, and an account-wide ceiling bounds guessing spread across many addresses.
describe.skipIf(!dbUp)("login lockout keyed on email + address", () => {
  const email = () => `owner-${Math.random().toString(36).slice(2)}@lockout.test`;
  const A = "203.0.113.50";
  const B = "203.0.113.51";

  it("failures from one address never lock the account for another", async () => {
    const e = email();
    for (let i = 0; i < 20; i += 1) await recordFailedLogin(e, A);
    expect(await checkBruteForce(e, A)).toMatch(/^Account locked\./);
    expect(await checkBruteForce(e, B)).toBeNull(); // the owner, elsewhere, still signs in
  });

  it("a correct password clears that address's ladder and the account-wide count", async () => {
    const e = email();
    for (let i = 0; i < 6; i += 1) await recordFailedLogin(e, A);
    expect(await checkBruteForce(e, A)).not.toBeNull();
    await clearFailedLogins(e, A);
    expect(await checkBruteForce(e, A)).toBeNull();
    const left = await db.execute(
      sql`SELECT count FROM runtime_counters WHERE scope = 'login_fail_email' AND key = ${e}`,
    );
    expect(left.rows).toHaveLength(0);
  });

  it("the account-wide ceiling: 50 failures across addresses refuse a fresh address for the rest of the hour", async () => {
    const e = email();
    for (let i = 0; i < 49; i += 1) await recordFailedLogin(e, `198.51.100.${i + 1}`);
    expect(await checkBruteForce(e, B)).toBeNull(); // 49: still open
    await recordFailedLogin(e, "198.51.100.200");
    expect(await checkBruteForce(e, B)).toBe("Account locked. Try again in 60 minutes.");
    vi.setSystemTime(BASE + 60 * 60 * 1000 + 1_000);
    expect(await checkBruteForce(e, B)).toBeNull(); // the window ended
  });

  it("with no address the key is the bare email and the frozen ladder is untouched", async () => {
    const e = email();
    for (let i = 0; i < 5; i += 1) await recordFailedLogin(e);
    expect((await row(e)).count).toBe(5);
    expect(await checkBruteForce(e)).toBe("Account locked. Try again in 1 minute.");
    const wide = await db.execute(
      sql`SELECT count FROM runtime_counters WHERE scope = 'login_fail_email' AND key = ${e}`,
    );
    expect(wide.rows).toHaveLength(0);
  });
});
