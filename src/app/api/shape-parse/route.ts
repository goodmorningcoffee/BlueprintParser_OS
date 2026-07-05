/**
 * POST /api/shape-parse
 *
 * [refactor jul5 S028] Thin shell — behavior lives in services/shape-parse.ts (shapeParse).
 * Direct symbol-search (S024) sibling, kind:json (no stream).
 *
 * auth:"none" MANDATORY: legacy runs the two-step field cascade (400s) BEFORE
 * resolveProjectAccess AND has the project.isDemo-only "keynoteParse" flat-403 gate —
 * neither expressible declaratively. body:zLooseBody — shell owns body-parse (sanctioned
 * diff E; legacy req.json was pre-try → raw rejections). The service returns plain
 * objects (shell wraps json) or the demo-gate NextResponse verbatim (passthrough).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { shapeParse } from "@/server/services/shape-parse";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => shapeParse(body),
});
