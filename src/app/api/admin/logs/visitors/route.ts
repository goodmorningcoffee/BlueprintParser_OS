/**
 * GET /api/admin/logs/visitors?range=1h|24h|7d|30d
 *
 * [refactor jul6 S038] Thin shell — behavior lives in services/admin-logs.ts
 * (getVisitorsLog; range + per-IP summary + manual-ban join + retentionWarning ported
 * verbatim). auth:"root" (A); the ?range 400 literal stays byte-verbatim in-service (A).
 * Diff B: fixed "Visitor query failed" 500 literal retired → shell generic INTERNAL 500.
 * Part of the ADMIN B3 batch (char: admin-logs.route.test.ts VIS-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getVisitorsLog } from "@/server/services/admin-logs";

export const GET = defineRoute({
  auth: "root",
  handler: ({ req }) => getVisitorsLog(req),
});
