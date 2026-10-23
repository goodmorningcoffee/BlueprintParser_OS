/**
 * POST /api/yolo/run  (ROOT ONLY since 2026-10-23)
 *
 * [refactor jul6 S031] Thin shell — behavior lives in services/yolo.ts (yoloRun).
 * auth:"session": legacy is AUTH-FIRST (then toggles → quota → fields — YQ-3 order
 * preserved in the service). body:zLooseBody — the shell owns body-parse (diff E; the
 * legacy parsed the body AFTER three gates, so malformed bodies now 400 before auth —
 * sanctioned ordering note, char-pinned). Demo "yoloRun" gate + root bypass + the
 * SageMaker cap semantics live in the service (YQ-1). Path pinned by middleware's
 * per-user rate rule on POST /api/yolo/run.
 * [2026-10-23] Root only: services/yolo-root-gate.ts runs the demo preflight, then 401 signed-out /
 * 403 "Root admin only" for every non-root caller, before yoloRun.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { yoloRunRootOnly } from "@/server/services/yolo-root-gate";

export const POST = defineRoute({
  // The gate performs a demo-target preflight before authentication so public demo
  // immutability has one status for signed-out and authenticated callers alike; it then
  // requires a root session (an auth:"root" shell would 401 a signed-out demo caller first).
  auth: "none",
  body: zLooseBody,
  handler: ({ body, req }) => yoloRunRootOnly(body, req),
});
