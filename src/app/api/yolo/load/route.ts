/**
 * POST /api/yolo/load
 *
 * [refactor jul6 S031] Thin shell — behavior lives in services/yolo.ts (yoloLoad).
 * auth:"none" is MANDATORY (YQ-2, the S020-credentials class): legacy returns 403
 * "Admin only" even for SIGNED-OUT callers — auth:"admin" would 401 first. The service
 * calls auth() itself and applies the manual role check. body:zLooseBody (diff E).
 * The response is a plain object incl. the in-band error states at HTTP 200
 * ({success:false,...} and the pg firstError leak — both frozen, never enveloped).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { yoloLoad } from "@/server/services/yolo";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => yoloLoad(body),
});
