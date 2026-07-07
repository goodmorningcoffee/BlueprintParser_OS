/**
 * /api/admin/remerge
 *
 * Admin-only: accept a stored MethodResult[] (from the parse-history ring buffer or a recent
 * response) and re-run mergeGrids against it with the current merger code. Lets us iterate on
 * merger heuristics and inspect the result against historical data without a 90-second re-parse.
 *
 * POST body: { results: MethodResult[], options?: { editDistanceThreshold?: number } }
 *
 * [refactor jul7 S050] Thin shell — behavior lives in services/remerge.ts (remergeGrids).
 * auth:"admin" (A). body:zLooseBody (E: legacy graceful req.json + "body must be JSON"
 * non-object guard → shell "Invalid JSON body" / generic VALIDATION). The "results must be an
 * array" check + the mergeGrids call stay in-service. Solo fold (char: admin-remerge.route.test.ts RM-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { remergeGrids } from "@/server/services/remerge";

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body }) => remergeGrids(body),
});
