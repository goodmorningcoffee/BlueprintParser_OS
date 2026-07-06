/**
 * GET/PUT /api/admin/usage  (root-only compute-usage dashboard + limit/reset mutations)
 *
 * [refactor jul6 S040] Thin shells — behavior lives in services/admin-usage.ts (getUsage /
 * updateUsage). auth:"root" (A). PUT body:zLooseBody (E: the legacy graceful
 * req.json().catch(()=>({})) → shell raw-parse → malformed 400 "Invalid JSON body"). All the
 * PUT validation literals (target/id, int4 clamp, null-clear, unknown-action) + the 4 write
 * branches + the 2 raw-SQL aggregates stay in-service. Part of the ADMIN B5 write-cluster
 * (char: admin-usage.route.test.ts UGET-* / UPUT-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getUsage, updateUsage } from "@/server/services/admin-usage";

export const GET = defineRoute({
  auth: "root",
  handler: () => getUsage(),
});

export const PUT = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body }) => updateUsage(body),
});
