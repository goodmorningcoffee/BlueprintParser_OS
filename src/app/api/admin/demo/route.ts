/**
 * POST /api/admin/demo  (refresh demo projects, or toggle a project's isDemo flag)
 *
 * [refactor jul6 S045] Thin shell — behavior lives in services/demo.ts (manageDemo).
 * auth:"admin" (A). body:zLooseBody (E: legacy `await req.json()` → shell "Invalid JSON
 * body"). Both writes' companyId tenancy scope + the "projectId and isDemo required"
 * validation stay in-service. Solo fold (char: admin-demo.route.test.ts DEMO-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { manageDemo } from "@/server/services/demo";

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => manageDemo(body, session!),
});
