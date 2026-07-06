/**
 * GET /api/admin/logs/engagement?range=1h|24h|7d|30d[&all=1]
 *
 * [refactor jul6 S038] Thin shell — behavior lives in services/admin-logs.ts
 * (getEngagementLog; range + ?all zero-fill + top10 aggregation ported verbatim).
 * auth:"root" (A); the ?range 400 literal stays byte-verbatim in-service (A). Diff B: fixed
 * "Engagement query failed" 500 literal retired → shell generic INTERNAL 500. Part of the
 * ADMIN B3 batch (char: admin-logs.route.test.ts ENG-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getEngagementLog } from "@/server/services/admin-logs";

export const GET = defineRoute({
  auth: "root",
  handler: ({ req }) => getEngagementLog(req),
});
