/**
 * login-lockout.ts — Per-email brute-force lockout for credential sign-in.
 *
 * [refactor jul23 P5.4-A] Extracted verbatim from `auth.ts` (the `loginAttempts`
 * map, idle-sweep interval, and the three helper functions) into a pure module
 * with ZERO NextAuth/db/Google imports. Rationale: the exponential lockout
 * schedule had no test coverage because `auth.ts` cannot be imported in a unit
 * test (it pulls NextAuth/db/Google at module load). This seam lets the freeze
 * (login-lockout.test.ts) import the helpers directly and lock the exact
 * millisecond schedule before P5.4 swaps the backing store to Postgres
 * (`login_lockouts`). Behavior is identical to the pre-extraction auth.ts:
 * same THRESHOLD/STEP/BASE_MS/CAP_MS, same "count survives expired lockout"
 * semantics, same idle sweep. The only change is the sweep interval is now
 * `.unref()`'d so it never holds a test/process open (it never needed to).
 */

// ─── Brute force protection ──────────────────────────────────
const loginAttempts = new Map<
  string,
  { count: number; lockedUntil: number; lastAttempt: number }
>();

const idleSweep = setInterval(
  () => {
    const now = Date.now();
    for (const [key, val] of loginAttempts) {
      // Drop entries idle for 2h+ (lockout long expired, attacker gave up). We keep
      // the failure count across an expired lockout so repeat offenders keep
      // escalating — only true inactivity clears it.
      if (now - val.lastAttempt > 2 * 60 * 60 * 1000) loginAttempts.delete(key);
    }
  },
  10 * 60 * 1000,
);
// Never keep the event loop (or a test worker) alive on account of the sweep.
idleSweep.unref?.();

export function checkBruteForce(email: string): string | null {
  const key = email.toLowerCase();
  const entry = loginAttempts.get(key);
  if (!entry) return null;

  if (entry.lockedUntil > Date.now()) {
    const mins = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return `Account locked. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`;
  }
  return null;
}

export function recordFailedLogin(email: string) {
  const key = email.toLowerCase();
  const entry = loginAttempts.get(key) || {
    count: 0,
    lockedUntil: 0,
    lastAttempt: 0,
  };
  entry.count++;
  entry.lastAttempt = Date.now();

  // After THRESHOLD wrong attempts, lock the account with an EXPONENTIALLY
  // growing window: the base doubles for every STEP additional failures, capped.
  // A successful login clears the counter. Only failed passwords reach here —
  // normal sign-in/out never does.
  const THRESHOLD = 5;
  const STEP = 2; // double every 2 extra failures
  const BASE_MS = 60 * 1000; // 1 min at the threshold
  const CAP_MS = 60 * 60 * 1000; // cap at 1 hour
  if (entry.count >= THRESHOLD) {
    const over = entry.count - THRESHOLD;
    const lockMs = Math.min(
      CAP_MS,
      BASE_MS * Math.pow(2, Math.floor(over / STEP)),
    );
    entry.lockedUntil = Date.now() + lockMs;
  }

  loginAttempts.set(key, entry);
}

export function clearFailedLogins(email: string) {
  loginAttempts.delete(email.toLowerCase());
}
