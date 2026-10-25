/**
 * [2026-10-25 root hardening] THE one place that answers "is this session a verified root?".
 *
 * `session.user.isRootAdmin` is already the EFFECTIVE authority: lib/auth.ts projects it from the
 * encrypted token through lib/root-two-factor-claims.ts (projectRootAuthority), so a root login
 * that has not enrolled, or has not proved a code in this session, never carries it — in fact
 * such a session carries no `user` at all. Every in-service root gate that bypasses the route
 * shell's auth:"root" (yolo-root-gate, app-settings, toggles, reprocess, textract-rerun, …) must
 * call one of these two helpers rather than re-deriving the answer, so the claim model has a
 * single consumer surface and a future change to it cannot leave a gate behind.
 */

import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "./envelope";

export const ROOT_ONLY_MESSAGE = "Root admin only";

/** True only for a root user whose login has enrolled AND verified a code (or the enforce switch is off). */
export function isVerifiedRoot(session: AuthSession | null | undefined): boolean {
  return session?.user?.isRootAdmin === true;
}

/** Throws FORBIDDEN "Root admin only" (401 UNAUTHORIZED with no session) unless isVerifiedRoot. */
export function requireVerifiedRoot(session: AuthSession | null | undefined): AuthSession {
  if (!session?.user) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  if (!isVerifiedRoot(session)) throw new ApiError("FORBIDDEN", ROOT_ONLY_MESSAGE);
  return session;
}
