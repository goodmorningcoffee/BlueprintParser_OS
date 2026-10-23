/**
 * Root two-factor (TOTP) claim model — pure, shared by the JWT callbacks, the route shell's session
 * projection and the middleware root confirmation. No I/O here; the storage side is
 * server/services/root-two-factor.ts.
 *
 * Three private JWT claims ride inside the AUTH_SECRET-encrypted session token (never the client):
 *   twoFactorRequired  — the user is root AND has an ACTIVE enrollment (re-read on every refresh);
 *   twoFactorVerified  — this login proved a code; set ONLY by the server-side marker re-check;
 *   twoFactorNonce     — a per-login random id the verified marker is keyed on (Auth.js rotates
 *                        `jti` on every re-encode, so it cannot serve as the login identity).
 *
 * A root user whose enrollment is active but unverified is PENDING: every root-only surface
 * (defineRoute auth:"root", in-service isRootAdmin gates, the middleware root exemption) sees
 * isRootAdmin=false, while company-admin powers keep working through `rootTwoFactorPending`.
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

/** Root in the database, enrollment active, this login not yet verified. */
export function rootTwoFactorPending(claims: RootTwoFactorClaims | null | undefined): boolean {
  if (!claims || typeof claims !== "object") return false;
  return (
    claims.isRootAdmin === true &&
    claims.twoFactorRequired === true &&
    claims.twoFactorVerified !== true
  );
}

/**
 * What the session exposes: `isRootAdmin` is the EFFECTIVE root authority (false while pending),
 * `rootTwoFactorPending` tells the shell and the admin page to keep admin powers and prompt for a code.
 */
export function projectRootAuthority(claims: RootTwoFactorClaims | null | undefined): {
  isRootAdmin: boolean;
  rootTwoFactorPending: boolean;
} {
  const pending = rootTwoFactorPending(claims);
  return {
    isRootAdmin: claims?.isRootAdmin === true && !pending,
    rootTwoFactorPending: pending,
  };
}
