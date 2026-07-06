/**
 * GET /api/admin/logs/accounts?range=1h|24h|7d|30d
 *
 * [refactor jul6 S038] Thin shell — behavior lives in services/admin-logs.ts
 * (getAccountsLog; range validation + CloudWatch Insights query + userId/companyId → name
 * PII resolution ported verbatim). auth:"root" (A); the ?range 400 literal stays byte-
 * verbatim in-service as VALIDATION (A). Diff B: fixed "Accounts query failed" 500 literal
 * retired → shell generic INTERNAL 500. Part of the ADMIN B3 batch (char:
 * admin-logs.route.test.ts ACC-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getAccountsLog } from "@/server/services/admin-logs";

export const GET = defineRoute({
  auth: "root",
  handler: ({ req }) => getAccountsLog(req),
});
