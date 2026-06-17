// [refactor jun16 P1.2] Bridge: the project-access ENGINE → the unified envelope.
//
// `resolveProjectAccess` (api-utils) does the real work — authenticate, look up the
// project, enforce tenancy (cross-tenant = 404, no existence leak), resolve scope. It
// predates the route shell and returns a NextResponse carrying the OLD `{error:string}`
// envelope. Both the shell's declarative project-auth AND service functions that resolve
// access imperatively (routes whose auth can't be expressed declaratively — see
// services/takeoff.ts) need its result as data-or-throw in the NEW envelope. This is the
// single translation point so that mapping lives in exactly one place.

import {
  resolveProjectAccess,
  type AuthSession,
  type ProjectAccessRow,
  type ProjectAccessScope,
} from "@/lib/api-utils";
import { ApiError } from "./envelope";

export type ResolvedProject = {
  project: ProjectAccessRow;
  session: AuthSession | null;
  scope: ProjectAccessScope;
};

type ProjectLookup = { publicId: string } | { dbId: number };

/**
 * Resolve project access, or throw an `ApiError` in the unified envelope.
 *
 * Status translation mirrors what the shell did inline: 401 → UNAUTHORIZED, anything
 * else (404, including cross-tenant) → NOT_FOUND. Missing vs. cross-tenant stay
 * deliberately indistinguishable (no existence leak). On success returns the resolved
 * row + session + scope; the caller applies any further policy (min-scope, demo gate).
 */
export async function resolveProjectOrThrow(
  lookup: ProjectLookup,
  options?: { allowDemo?: boolean },
): Promise<ResolvedProject> {
  const res = await resolveProjectAccess(lookup, options);
  if (res.error) {
    const status = res.error.status;
    throw new ApiError(
      status === 401 ? "UNAUTHORIZED" : "NOT_FOUND",
      status === 401 ? "Unauthorized" : "Not found",
    );
  }
  return { project: res.project, session: res.session, scope: res.scope };
}
