/**
 * POST /api/symbol-search
 *
 * [refactor jul4 S024] Thin shell — ALL behavior lives in services/symbol-search.ts
 * (symbolSearch). The FIRST stream-kind route through the shell.
 *
 * auth:"none" is MANDATORY: legacy ran the field+bbox cascade (400s) BEFORE
 * resolveProjectAccess (401/404) and the demo-only feature gate (403) — declarative
 * {project:{as:"dbId",bodyKey:"projectId"}} auth would run at shell step 2, before body
 * validation, inverting validate-before-auth AND it cannot express the isDemo-only
 * assertDemoFeatureEnabled gate. The service resolves access itself (S023 map-tags play).
 *
 * kind:"stream": the service's NDJSON Response rides the `result instanceof Response`
 * passthrough in defineRoute (it fires before the kind check); the kind arms the
 * INTERNAL safety net if the handler ever returns a non-Response.
 *
 * body:zLooseBody — the shell owns body-parse (sanctioned diff E); the service runs the
 * legacy field cascade itself. The route file must stay at this path: middleware.ts
 * rate-limits /api/symbol-search via its ABUSIVE_ROUTE_PREFIXES list.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { symbolSearch } from "@/server/services/symbol-search";

export const POST = defineRoute({
  auth: "none",
  kind: "stream",
  body: zLooseBody,
  handler: ({ body }) => symbolSearch(body),
});
