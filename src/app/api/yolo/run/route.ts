/**
 * POST /api/yolo/run
 *
 * [refactor jul6 S031] Thin shell — behavior lives in services/yolo.ts (yoloRun).
 * auth:"session": legacy is AUTH-FIRST (then toggles → quota → fields — YQ-3 order
 * preserved in the service). body:zLooseBody — the shell owns body-parse (diff E; the
 * legacy parsed the body AFTER three gates, so malformed bodies now 400 before auth —
 * sanctioned ordering note, char-pinned). Demo "yoloRun" gate + root bypass + the
 * SageMaker cap semantics live in the service (YQ-1). Path pinned by middleware's
 * per-user rate rule on POST /api/yolo/run.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { yoloRun } from "@/server/services/yolo";

export const POST = defineRoute({
  auth: "session",
  body: zLooseBody,
  handler: ({ body, session, req }) => yoloRun(body, session!, req),
});
