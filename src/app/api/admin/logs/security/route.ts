/**
 * GET /api/admin/logs/security
 *
 * [refactor jul6 S038] Thin shell — behavior lives in services/admin-logs.ts
 * (getSecurityLog). auth:"root" (A). The fire-and-forget mark-seen UPDATE side-effect is
 * preserved in the service. Diff B: the legacy fixed "Security query failed" 500 literal is
 * retired → shell generic INTERNAL 500 (no err leak either way). Part of the ADMIN B3 batch
 * (char: admin-logs.route.test.ts SEC-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getSecurityLog } from "@/server/services/admin-logs";

export const GET = defineRoute({
  auth: "root",
  handler: () => getSecurityLog(),
});
