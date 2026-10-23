// [2026-10-23 owner ask] YOLO run/load are ROOT-ONLY. POST /api/yolo/run and POST /api/yolo/load call
// these wrappers instead of services/yolo.ts directly; the services keep their characterized
// behaviour (YQ-1..YQ-5) for the callers that remain (the catch-up loader passes its own session).
//
// The shells stay auth:"none" on purpose, and the gate runs in this order:
//   1. the public-demo preflight (assertDemoYoloTargetReadOnly) — a demo target answers the same
//      canonical 403 to signed-out, member, admin and root callers (the L5 freeze); auth:"root" in the
//      shell would answer a signed-out caller 401 before it;
//   2. no session → run: 401 UNAUTHORIZED (as before); load: 403 FORBIDDEN (YQ-2 — load has always
//      answered a signed-out caller 403, never 401);
//   3. not root → 403 FORBIDDEN "Root admin only" (defineRoute's auth:"root" message).
// Then the service runs and re-resolves its own session exactly as before.

import { auth } from "@/lib/auth";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { yoloLoad, yoloRun } from "@/server/services/yolo";
import { assertDemoYoloTargetReadOnly } from "@/server/services/yolo-demo-target";

export const YOLO_ROOT_ONLY_MESSAGE = "Root admin only";

async function requireYoloRoot(projectId: unknown, signedOut: "UNAUTHORIZED" | "FORBIDDEN"): Promise<void> {
  await assertDemoYoloTargetReadOnly(projectId);
  const session = (await auth()) as unknown as AuthSession | null;
  if (!session?.user) {
    throw signedOut === "UNAUTHORIZED"
      ? new ApiError("UNAUTHORIZED", "Unauthorized")
      : new ApiError("FORBIDDEN", YOLO_ROOT_ONLY_MESSAGE);
  }
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", YOLO_ROOT_ONLY_MESSAGE);
}

/** POST /api/yolo/run — root only, then services/yolo.ts yoloRun. */
export async function yoloRunRootOnly(rawBody: Record<string, unknown>, req: Request): Promise<unknown> {
  await requireYoloRoot(rawBody.projectId, "UNAUTHORIZED");
  return yoloRun(rawBody, req);
}

/** POST /api/yolo/load — root only (signed-out → 403, never 401), then services/yolo.ts yoloLoad. */
export async function yoloLoadRootOnly(rawBody: Record<string, unknown>): Promise<unknown> {
  await requireYoloRoot(rawBody.projectId, "FORBIDDEN");
  return yoloLoad(rawBody);
}
