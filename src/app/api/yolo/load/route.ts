/**
 * POST /api/yolo/load  (ROOT ONLY since 2026-10-23)
 *
 * [refactor jul6 S031] Thin shell — behavior lives in services/yolo.ts (yoloLoad).
 * auth:"none" is MANDATORY (YQ-2, the S020-credentials class): legacy returns 403
 * "Admin only" even for SIGNED-OUT callers — auth:"admin" would 401 first. The service
 * calls auth() itself and applies the manual role check. body:zLooseBody (diff E).
 * The response is a plain object incl. the in-band error states at HTTP 200
 * ({success:false,...} and the pg firstError leak — both frozen, never enveloped).
 * [2026-10-23] Root only: services/yolo-root-gate.ts answers every non-root caller — signed-out
 * included, still 403 and never 401 — "Root admin only" before yoloLoad (an auth:"root" shell
 * would 401 a signed-out caller). The server-side catch-up loader calls yoloLoad directly.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { yoloLoadRootOnly } from "@/server/services/yolo-root-gate";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => yoloLoadRootOnly(body),
});
