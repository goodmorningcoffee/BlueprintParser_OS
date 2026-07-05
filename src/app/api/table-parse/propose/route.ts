/**
 * POST /api/table-parse/propose
 *
 * [refactor jul5 S026] Thin shell — behavior lives in services/table-parse-propose.ts
 * (tableParsePropose). auth:"none": validate-before-auth. Distinct from its 4 region-parse
 * siblings: SHORT bbox message + NO allowDemo (demo+anon → 401) — both frozen (char PQ-2/3).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { tableParsePropose } from "@/server/services/table-parse-propose";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => tableParsePropose(body),
});
