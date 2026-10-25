/**
 * [2026-10-25 root hardening] Admission for POST /api/admin/reprocess — lives beside reprocess.ts
 * (which sits at its MAX_LINES ceiling) and runs in the route shell before reprocessProjects.
 *
 *   • scope=shape-parse with Lambda CV enabled fans one Lambda invocation per page across EVERY
 *     non-demo project of the company: owner-billed bulk spend, so it is ROOT ONLY (verified 2FA).
 *     Non-root admins keep the scope only when Lambda is off (local engine). The tiles and channels
 *     scopes already refuse non-root inside their own modules.
 *   • Every scope writes one audit row (who, which scope) — none did before.
 */

import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { isLambdaCvEnabled } from "@/lib/lambda-cv";
import { ApiError } from "@/server/api/envelope";
import { isVerifiedRoot } from "@/server/api/root-authority";

export const OWNER_BILLED_REPROCESS_SCOPES: ReadonlySet<string> = new Set(["shape-parse"]);

export function admitReprocess(session: AuthSession, req: Request): AuthSession {
  const scope = new URL(req.url).searchParams.get("scope") ?? "full";
  const root = isVerifiedRoot(session);
  // Read the flag at most ONCE here, and only for an owner-billed scope: reprocessProjects reads it
  // again for its own config line.
  const lambda = OWNER_BILLED_REPROCESS_SCOPES.has(scope) ? isLambdaCvEnabled() : null;
  if (lambda && !root) {
    throw new ApiError("FORBIDDEN", "Root admin only: this scope fans out owner-billed Lambda invocations");
  }
  audit("admin.reprocess", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { scope, isRootAdmin: root, lambda },
  });
  return session;
}
