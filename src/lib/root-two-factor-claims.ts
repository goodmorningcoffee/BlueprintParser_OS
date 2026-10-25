/**
 * Root two-factor (TOTP) claim model — pure, shared by the JWT callbacks, the route shell's session
 * projection and the middleware root confirmation. No I/O here; the storage side is
 * server/services/root-two-factor.ts.
 *
 * Three private JWT claims ride inside the AUTH_SECRET-encrypted session token (never the client):
 *   twoFactorRequired  — the user is root AND has an ACTIVE enrollment (re-read on every refresh);
 *   twoFactorVerified  — this login proved a code; re-derived from the server-side marker on EVERY
 *                        refresh (never sticky: disable, re-enroll, a password change or the
 *                        break-glass reset drop the marker and the next refresh drops this flag);
 *   twoFactorNonce     — a per-login random id the verified marker is keyed on (Auth.js rotates
 *                        `jti` on every re-encode, so it cannot serve as the login identity).
 *
 * [2026-10-25 root hardening] Root 2FA is MANDATORY. A root login is in one of three states:
 *   "enroll"   root in the database, no active enrollment  → no authority at all (not even member)
 *   "verify"   enrollment active, this login unverified    → no authority at all
 *   null       verified                                    → full root
 * While gated ("enroll" | "verify") the session callback (lib/auth.ts) returns a session WITHOUT
 * `user` and with a top-level `twoFactorGate`, so every server-side check — the route shell, the
 * project-access engine, every service that calls auth() itself — fails closed as signed-out, with
 * no per-call-site branch. The only things a gated root can reach are the /api/auth/2fa status /
 * enroll / confirm / verify routes (which identify the caller from the encrypted cookie, not the
 * session), sign-out, and the /admin page shell that hosts the gate UI.
 *
 * ROOT_2FA_ENFORCE=0 is the emergency off-switch (server-side env only, default ON): with it set,
 * root authority is projected from the database flag alone, exactly as before 2026-10-25, and
 * every evaluation that it changes is logged loudly. It exists for one case — the TOTP secrets
 * becoming unreadable (e.g. a NEXTAUTH_SECRET rotation) with no device to verify on.
 */

export const ROOT_TWO_FACTOR_KEY_PREFIX = "root-2fa:";

/** app_settings key for one user's enrollment document. */
export function rootTwoFactorSettingKey(userId: number): string {
  return `${ROOT_TWO_FACTOR_KEY_PREFIX}${userId}`;
}

/** Keys under the prefix are managed only by /api/auth/2fa/* — the generic settings route must refuse them. */
export function isRootTwoFactorSettingKey(key: string): boolean {
  return key.startsWith(ROOT_TWO_FACTOR_KEY_PREFIX);
}

export interface RootTwoFactorClaims {
  isRootAdmin?: unknown;
  twoFactorRequired?: unknown;
  twoFactorVerified?: unknown;
  twoFactorNonce?: unknown;
  /** Any other token claim (dbId, role, …) — this model reads only the four above. */
  [claim: string]: unknown;
}

/** What a root login still owes: enrollment, a code, or nothing. */
export type RootTwoFactorGate = "enroll" | "verify";

export const ROOT_TWO_FACTOR_ENFORCE_ENV = "ROOT_2FA_ENFORCE";
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * Whether mandatory root 2FA is enforced. Read server-side on every evaluation (never cached, so
 * an emergency task-definition change takes effect on the next request). Anything but an explicit
 * off value — including unset — means ON.
 */
export function rootTwoFactorEnforced(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[ROOT_TWO_FACTOR_ENFORCE_ENV];
  return !(typeof raw === "string" && OFF_VALUES.has(raw.trim().toLowerCase()));
}

/** The gate the off-switch would otherwise impose; evaluated without consulting the switch. */
function gateIgnoringSwitch(claims: RootTwoFactorClaims | null | undefined): RootTwoFactorGate | null {
  if (!claims || typeof claims !== "object") return null;
  if (claims.isRootAdmin !== true) return null;
  if (claims.twoFactorRequired !== true) return "enroll";
  if (claims.twoFactorVerified !== true) return "verify";
  return null;
}

/**
 * The state a root login is in: "enroll" (no active enrollment), "verify" (enrolled, this login
 * has not proved a code) or null (verified, or not root at all). With ROOT_2FA_ENFORCE=0 every
 * gate collapses to null and the bypass is logged loudly — once per evaluation that it changed.
 */
export function rootTwoFactorGate(claims: RootTwoFactorClaims | null | undefined): RootTwoFactorGate | null {
  const gate = gateIgnoringSwitch(claims);
  if (gate === null || rootTwoFactorEnforced()) return gate;
  // Loud by design: this line is the only trace that root was admitted without its second factor.
  console.error(
    `[SECURITY] ${ROOT_TWO_FACTOR_ENFORCE_ENV}=0: root user ${String(claims?.dbId ?? "?")} admitted as root ` +
      `without two-factor (state would be "${gate}"). Unset the switch as soon as the incident is over.`,
  );
  return null;
}

/** Root in the database and this login still owes its second factor (enrollment or a code). */
export function rootTwoFactorPending(claims: RootTwoFactorClaims | null | undefined): boolean {
  return rootTwoFactorGate(claims) !== null;
}

/**
 * What the session exposes: `isRootAdmin` is the EFFECTIVE root authority (false while gated),
 * `rootTwoFactorGate` tells lib/auth.ts to project a user-less session and the /admin page which
 * panel to show. `rootTwoFactorPending` is kept as the boolean form of the gate.
 */
export function projectRootAuthority(claims: RootTwoFactorClaims | null | undefined): {
  isRootAdmin: boolean;
  rootTwoFactorPending: boolean;
  rootTwoFactorGate: RootTwoFactorGate | null;
} {
  const gate = rootTwoFactorGate(claims);
  const pending = gate !== null;
  return {
    isRootAdmin: claims?.isRootAdmin === true && !pending,
    rootTwoFactorPending: pending,
    rootTwoFactorGate: gate,
  };
}
