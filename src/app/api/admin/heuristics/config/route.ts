/**
 * GET/PUT /api/admin/heuristics/config
 *
 * [refactor jul6 S037] Thin shells — behavior lives in services/company-settings.ts
 * (getHeuristicsConfig/putHeuristicsConfig). GET is auth:"none" ON PURPOSE — legacy
 * swallows the requireAdmin error and answers unauth/non-admin callers with the
 * built-in-rules fallback (the B1 batch's one auth-shape deviation, frozen HEU-1);
 * the service checks admin-ness inline via auth(). PUT auth:"admin" (A) +
 * body:zLooseBody (E); the "heuristics array or pageNaming config required" check and
 * the conditional dual-key write (+updatedAt touch) stay in-service. Part of the
 * ADMIN B1 six-clone batch (char: __tests__/admin-config.route.test.ts HEU-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getHeuristicsConfig, putHeuristicsConfig } from "@/server/services/company-settings";

export const GET = defineRoute({
  auth: "none",
  handler: () => getHeuristicsConfig(),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ session, body }) => putHeuristicsConfig(session!, body),
});
