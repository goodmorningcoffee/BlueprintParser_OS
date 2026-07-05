/**
 * POST /api/table-parse
 *
 * [refactor jul5 S027] Thin shell — behavior lives in @/server/services/table-parse.ts
 * (tableParse = the ROUTE CONTRACT; the merge-pipeline ENGINE is the differently-pathed
 * @/lib/services/table-parse, byte-untouched).
 *
 * auth:"none" MANDATORY: legacy runs the field+bbox 400 cascade BEFORE
 * resolveProjectAccess AND has the project.isDemo-only assertDemoFeatureEnabled
 * (companyId,"tableParse") flat-403 gate — neither expressible declaratively
 * (symbol-search S024 shape). body:zLooseBody — shell owns body-parse (sanctioned
 * diff E; legacy req.json was pre-try → raw rejections). The service returns the
 * response body as a plain object (shell wraps json) or the demo-gate NextResponse
 * verbatim (instanceof-Response passthrough).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { tableParse } from "@/server/services/table-parse";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => tableParse(body),
});
