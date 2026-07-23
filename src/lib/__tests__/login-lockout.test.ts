// @vitest-environment node
// [refactor jul23 P5.4-A] FREEZE — locks the exact millisecond lockout schedule
// of the per-email brute-force protection BEFORE P5.4 swaps the backing store to
// Postgres (login_lockouts). These behaviors had ZERO tests: the helpers were
// module-private in auth.ts, which is unimportable in a unit test. The schedule
// is observed through checkBruteForce's "N minute(s)" message under frozen time
// (mins = ceil((lockedUntil - now)/60000), so message N == lockMs in minutes).
//
// Schedule contract (THRESHOLD=5, STEP=2, BASE=60s, doubling every 2 failures,
// capped at 60m): count 5→1, 6→1, 7→2, 8→2, 9→4, 10→4, 11→8, ... capped 60m.
// Plus: the failure count SURVIVES an expired lockout (repeat offenders keep
// escalating), and a success (clearFailedLogins) resets the counter to zero.
//
// [refactor jul23 P5.4-C] The backing store is now Postgres (login_lockouts).
// Per RD-P5e the freeze ADAPTS to async by adding `await` ONLY — every assertion
// is unchanged. Fake timers still govern the schedule because recordFailedLogin
// threads Date.now() into the upsert (see login-lockout.ts). Isolation is still
// "unique email per case": global-setup fresh-migrates the DB once per run, so
// login_lockouts starts empty and non-reused keys never collide.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import {
  checkBruteForce,
  recordFailedLogin,
  clearFailedLogins,
} from "@/lib/login-lockout";

const dbUp = inject("dbUp") as boolean;
const BASE = new Date("2026-07-23T00:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});
afterEach(() => {
  vi.useRealTimers();
});

// Unique emails per case: the login_lockouts row per email is the shared state,
// so isolation comes from never reusing a key (the DB is migrated fresh per run).
async function lockMinutes(email: string): Promise<number | null> {
  const msg = await checkBruteForce(email);
  if (msg === null) return null;
  const m = /Try again in (\d+) minute/.exec(msg);
  return m ? Number(m[1]) : null;
}

describe.skipIf(!dbUp)("login-lockout exponential schedule (freeze)", () => {
  it("does not lock before the 5th failure", async () => {
    const email = "below@example.com";
    for (let i = 0; i < 4; i += 1) await recordFailedLogin(email);
    expect(await checkBruteForce(email)).toBeNull();
  });

  it("locks on the exact doubling-every-2 cadence, capped at 60m", async () => {
    const email = "cadence@example.com";
    // counts 1..4 → no lock
    for (let i = 0; i < 4; i += 1) await recordFailedLogin(email);
    expect(await lockMinutes(email)).toBeNull();

    const expected: Array<[number, number]> = [
      [5, 1],
      [6, 1],
      [7, 2],
      [8, 2],
      [9, 4],
      [10, 4],
      [11, 8],
      [12, 8],
      [13, 16],
      [14, 16],
      [15, 32],
      [16, 32],
      [17, 60], // 64m would exceed the 1h cap → clamped to 60
      [18, 60],
      [19, 60],
    ];
    let count = 4;
    for (const [target, mins] of expected) {
      while (count < target) {
        await recordFailedLogin(email);
        count += 1;
      }
      expect([count, await lockMinutes(email)]).toEqual([target, mins]);
    }
  });

  it("checkBruteForce returns null while a fresh entry has never crossed the threshold", async () => {
    const email = "never@example.com";
    await recordFailedLogin(email);
    await recordFailedLogin(email);
    expect(await checkBruteForce(email)).toBeNull();
  });

  it("emits singular 'minute' at 1m and plural 'minutes' above 1m", async () => {
    const one = "singular@example.com";
    for (let i = 0; i < 5; i += 1) await recordFailedLogin(one);
    expect(await checkBruteForce(one)).toBe(
      "Account locked. Try again in 1 minute.",
    );

    const many = "plural@example.com";
    for (let i = 0; i < 7; i += 1) await recordFailedLogin(many);
    expect(await checkBruteForce(many)).toBe(
      "Account locked. Try again in 2 minutes.",
    );
  });
});

describe.skipIf(!dbUp)("login-lockout count-survives-expiry (freeze)", () => {
  it("keeps escalating after a lockout window expires (count is not reset)", async () => {
    const email = "survivor@example.com";
    for (let i = 0; i < 5; i += 1) await recordFailedLogin(email); // count 5 → 1m lock
    expect(await lockMinutes(email)).toBe(1);

    // Let the 1-minute lock expire.
    vi.advanceTimersByTime(61_000);
    expect(await checkBruteForce(email)).toBeNull();

    // Three more failures → count 8 → 2m lock. Had the count reset on expiry,
    // these three would be count 1..3 (below threshold) → no lock.
    for (let i = 0; i < 3; i += 1) await recordFailedLogin(email);
    expect(await lockMinutes(email)).toBe(2);
  });
});

describe.skipIf(!dbUp)("login-lockout cleared-on-success (freeze)", () => {
  it("clearFailedLogins resets the counter to zero", async () => {
    const email = "success@example.com";
    for (let i = 0; i < 5; i += 1) await recordFailedLogin(email); // count 5 → 1m lock
    expect(await lockMinutes(email)).toBe(1);

    await clearFailedLogins(email);
    expect(await checkBruteForce(email)).toBeNull();

    // Fresh start: four failures stay below threshold, fifth re-locks at 1m.
    for (let i = 0; i < 4; i += 1) await recordFailedLogin(email);
    expect(await checkBruteForce(email)).toBeNull();
    await recordFailedLogin(email);
    expect(await lockMinutes(email)).toBe(1);
  });
});
