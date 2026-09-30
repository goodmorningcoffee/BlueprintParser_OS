/**
 * POST /api/bucket-fill
 *
 * [refactor jul6 S030] Thin shell — behavior lives in services/bucket-fill.ts
 * (bucketFillRoute; named to avoid colliding with the ENGINE export @/lib/bucket-fill
 * .bucketFill, which is byte-untouched). The flood-fill SERVER FALLBACK.
 *
 * auth:"none" MANDATORY: legacy validates field+seedPoint BEFORE resolveProjectAccess
 * and has the project.isDemo-only "bucketFill" flat-403 gate. body:zLooseBody — shell
 * owns body-parse (sanctioned diff E; legacy req.json was pre-try → raw rejections).
 * The service returns the engine result verbatim — including its in-band
 * {type:"error"}-at-200 protocol — or the demo-gate NextResponse (passthrough).
 * Path must stay /api/bucket-fill: middleware ABUSIVE_ROUTE_PREFIXES keys on it.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { withAnonymousHeavySlot } from "@/server/api/heavy-work";
import { zLooseBody } from "@/server/api/schemas";
import { bucketFillRoute } from "@/server/services/bucket-fill";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => withAnonymousHeavySlot(() => bucketFillRoute(body)),
});
