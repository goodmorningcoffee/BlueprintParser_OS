/**
 * POST /api/table-structure
 *
 * [refactor jul6 S029] Thin shell — behavior lives in services/table-structure.ts
 * (tableStructure). TATR cell-structure detection ("Detect Cell Structure" button).
 *
 * auth:"none" MANDATORY: legacy validates the field cascade BEFORE resolveProjectAccess
 * and has the project.isDemo-only "tableParse" flat-403 gate (not expressible
 * declaratively). body:zLooseBody — shell owns body-parse (sanctioned diff E; legacy
 * req.json was pre-try → raw rejections). The service returns plain objects — including
 * the UQ-3 in-band-error-at-200 body — or the demo-gate NextResponse (passthrough).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { withAnonymousHeavySlot } from "@/server/api/heavy-work";
import { zLooseBody } from "@/server/api/schemas";
import { tableStructure } from "@/server/services/table-structure";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => withAnonymousHeavySlot(() => tableStructure(body)),
});
