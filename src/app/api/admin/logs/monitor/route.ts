/**
 * GET /api/admin/logs/monitor
 *
 * Pulls infra health signals from CloudWatch + AWS Budgets (all free-tier friendly).
 * The Monitor subtab is refresh-only; recommendations surface "should I bump resources?" prompts.
 *
 * [refactor jul7 S053] Thin shell — behavior lives in services/admin-monitor.ts (getMonitor).
 * auth:"root" (A). No body → no E. Diff B: the fixed "Monitor fetch failed" catch-500 literal
 * is retired → shell generic INTERNAL 500. Solo fold (char: admin-monitor.route.test.ts MON-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getMonitor } from "@/server/services/admin-monitor";

export const GET = defineRoute({
  auth: "root",
  handler: () => getMonitor(),
});
