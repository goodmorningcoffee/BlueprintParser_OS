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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkBruteForce,
  recordFailedLogin,
  clearFailedLogins,
} from "@/lib/login-lockout";

const BASE = new Date("2026-07-23T00:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});
afterEach(() => {
  vi.useRealTimers();
});

// Unique emails per case: the loginAttempts map is a module-level singleton that
// persists across cases, so isolation comes from never reusing a key.
function lockMinutes(email: string): number | null {
  const msg = checkBruteForce(email);
  if (msg === null) return null;
  const m = /Try again in (\d+) minute/.exec(msg);
  return m ? Number(m[1]) : null;
}

describe("login-lockout exponential schedule (freeze)", () => {
  it("does not lock before the 5th failure", () => {
    const email = "below@example.com";
    for (let i = 0; i < 4; i += 1) recordFailedLogin(email);
    expect(checkBruteForce(email)).toBeNull();
  });

  it("locks on the exact doubling-every-2 cadence, capped at 60m", () => {
    const email = "cadence@example.com";
    // counts 1..4 → no lock
    for (let i = 0; i < 4; i += 1) recordFailedLogin(email);
    expect(lockMinutes(email)).toBeNull();

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
        recordFailedLogin(email);
        count += 1;
      }
      expect([count, lockMinutes(email)]).toEqual([target, mins]);
    }
  });

  it("checkBruteForce returns null while a fresh entry has never crossed the threshold", () => {
    const email = "never@example.com";
    recordFailedLogin(email);
    recordFailedLogin(email);
    expect(checkBruteForce(email)).toBeNull();
  });

  it("emits singular 'minute' at 1m and plural 'minutes' above 1m", () => {
    const one = "singular@example.com";
    for (let i = 0; i < 5; i += 1) recordFailedLogin(one);
    expect(checkBruteForce(one)).toBe("Account locked. Try again in 1 minute.");

    const many = "plural@example.com";
    for (let i = 0; i < 7; i += 1) recordFailedLogin(many);
    expect(checkBruteForce(many)).toBe(
      "Account locked. Try again in 2 minutes.",
    );
  });
});

describe("login-lockout count-survives-expiry (freeze)", () => {
  it("keeps escalating after a lockout window expires (count is not reset)", () => {
    const email = "survivor@example.com";
    for (let i = 0; i < 5; i += 1) recordFailedLogin(email); // count 5 → 1m lock
    expect(lockMinutes(email)).toBe(1);

    // Let the 1-minute lock expire.
    vi.advanceTimersByTime(61_000);
    expect(checkBruteForce(email)).toBeNull();

    // Three more failures → count 8 → 2m lock. Had the count reset on expiry,
    // these three would be count 1..3 (below threshold) → no lock.
    for (let i = 0; i < 3; i += 1) recordFailedLogin(email);
    expect(lockMinutes(email)).toBe(2);
  });
});

describe("login-lockout cleared-on-success (freeze)", () => {
  it("clearFailedLogins resets the counter to zero", () => {
    const email = "success@example.com";
    for (let i = 0; i < 5; i += 1) recordFailedLogin(email); // count 5 → 1m lock
    expect(lockMinutes(email)).toBe(1);

    clearFailedLogins(email);
    expect(checkBruteForce(email)).toBeNull();

    // Fresh start: four failures stay below threshold, fifth re-locks at 1m.
    for (let i = 0; i < 4; i += 1) recordFailedLogin(email);
    expect(checkBruteForce(email)).toBeNull();
    recordFailedLogin(email);
    expect(lockMinutes(email)).toBe(1);
  });
});
