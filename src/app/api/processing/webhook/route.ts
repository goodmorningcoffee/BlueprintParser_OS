/**
 * POST /api/processing/webhook
 *
 * [refactor jul6 S035] Thin shell — behavior lives in services/processing-routes.ts
 * (processingWebhook). auth:"webhookSecret" — THE FIRST consumer of the shell's spec;
 * checkWebhookSecret (in server/api/defineRoute.ts) was authored as a replica of this route's
 * legacy inline check and the S035 freeze verified branch parity behaviorally
 * (Unauthorized / Missing timestamp / Webhook expired — statuses+messages identical;
 * envelope flip = diff A). body:zLooseBody (diff E; note the S033 systemic trait:
 * malformed bodies 400 before the secret check).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { processingWebhook } from "@/server/services/processing-routes";

export const POST = defineRoute({
  auth: "webhookSecret",
  body: zLooseBody,
  handler: ({ body }) => processingWebhook(body),
});
