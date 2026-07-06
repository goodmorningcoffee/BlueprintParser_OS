/**
 * GET /api/admin/logs/alert-count
 *
 * [refactor jul6 S038] Thin shell — behavior lives in services/admin-logs.ts
 * (getAlertCount; the internal try/catch → 200 graceful "fail quietly" fallback is
 * PRESERVED there, NOT dropped to a generic 500). auth:"root" (A: flat errors → envelope,
 * byte-same). No body/query. Part of the ADMIN B3 batch (char: admin-logs.route.test.ts
 * ALERT-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getAlertCount } from "@/server/services/admin-logs";

export const GET = defineRoute({
  auth: "root",
  handler: () => getAlertCount(),
});
