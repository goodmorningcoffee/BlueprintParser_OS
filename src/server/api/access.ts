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
import { zPublicId } from "@/server/api/schemas";
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

// ── shared dual-ID resolvers ─────────────────────────────────────────────────────────────────
// [refactor jul8 P1-review PR-C1] hoisted from 10 byte-identical service-local copies
// (pages.ts ×3, regions.ts ×3, annotations.ts, annotation-groups.ts, takeoff.ts,
// qto-workflows.ts); allowDemo passed per-call — takeoff/qto require true.
// Bodies are verbatim the pages.ts/regions.ts trio (the opts-parameterized superset): the
// annotations/annotation-groups copies were the no-opts special case (undefined ≡ allowDemo:false —
// api-utils gates on `options?.allowDemo`), and the takeoff/qto copies were the hardcoded
// `{allowDemo:true}` special case, so every prior behavior is reproduced by the right opts at the
// call site. Discharges the regions.ts BACKLOG note. Behavior identical.

/** publicId path: validate the uuid at the access step (zPublicId → clean 400 "Invalid project
 *  id", closing the S003 pg-uuid-cast 500), then resolve. In the validate-before-auth services
 *  this is called AFTER field validation so the frozen error precedence holds. */
export async function resolveByPublicId(
  publicId: unknown,
  opts?: { allowDemo?: boolean },
): Promise<ResolvedProject> {
  const parsed = zPublicId.safeParse(publicId);
  if (!parsed.success) throw new ApiError("VALIDATION", "Invalid project id");
  return resolveProjectOrThrow({ publicId: parsed.data }, opts);
}

/** dbId path: coerce + Number.isInteger(>0) guard (closes the latent pg int-cast 500 the
 *  cast-only legacy POSTs had), then resolve. */
export async function resolveByDbId(
  dbId: unknown,
  opts?: { allowDemo?: boolean },
): Promise<ResolvedProject> {
  const n = typeof dbId === "number" ? dbId : Number(dbId);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("VALIDATION", "Invalid project id");
  return resolveProjectOrThrow({ dbId: n }, opts);
}

/** The unified dual selector (generalizes the legacy `publicId ? {publicId} : {dbId: projectId!}`):
 *  a truthy publicId WINS (the canonical, invariant-honoring path); otherwise fall back to the
 *  legacy numeric dbId. */
export async function resolveDual(
  args: { publicId?: unknown; dbId?: unknown },
  opts?: { allowDemo?: boolean },
): Promise<ResolvedProject> {
  if (args.publicId) return resolveByPublicId(args.publicId, opts);
  return resolveByDbId(args.dbId, opts);
}
