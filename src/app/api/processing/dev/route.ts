/**
 * POST /api/processing/dev
 *
 * [refactor jul6 S035] Thin shell — behavior lives in services/processing-routes.ts
 * (processingDev). auth:"none" MANDATORY: the legacy ENV GUARD runs BEFORE auth
 * (prod + !DEV_PROCESSING_ENABLED → 403 "Dev processing not enabled" even signed-out —
 * frozen); the service calls auth() itself. body:zLooseBody (diff E). NOTE (S035
 * DETECTOR): shell body-parse AND zLooseBody validation precede the guard — malformed
 * → 400 BAD_REQUEST, non-record JSON → 400 VALIDATION, only THEN the 403 (the S033
 * body-first trait extended to the guard; pinned in the char file).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { processingDev } from "@/server/services/processing-routes";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => processingDev(body),
});
