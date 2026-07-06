/**
 * POST /api/processing/dev
 *
 * [refactor jul6 S035] Thin shell — behavior lives in services/processing-routes.ts
 * (processingDev). auth:"none" MANDATORY: the legacy ENV GUARD runs BEFORE auth
 * (prod + !DEV_PROCESSING_ENABLED → 403 "Dev processing not enabled" even signed-out —
 * frozen); the service calls auth() itself. body:zLooseBody (diff E).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { processingDev } from "@/server/services/processing-routes";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => processingDev(body),
});
