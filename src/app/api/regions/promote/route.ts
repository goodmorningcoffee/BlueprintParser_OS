// [refactor jun17 P1.3] Thin shell — behavior in services/regions.ts (promoteRegion).
// P1.3 family 7/7 (the LAST core family). POST /api/regions/promote = the dual-accept "Stage 4
// generic commit" route: validate-before-auth (`auth:"none"` — the field-400s must fire before the
// 401/403/404, so the shell can't resolve project-auth declaratively), publicId wins over numeric
// projectId, allowDemo:true with an imperative demo-write 403 gate in the service. The doc comment
// + the full quirk freeze + sanctioned diffs A-F (incl. the functional-error 500→4xx status remap)
// live in services/regions.ts.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { promoteRegion } from "@/server/services/regions";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => promoteRegion(body),
});
