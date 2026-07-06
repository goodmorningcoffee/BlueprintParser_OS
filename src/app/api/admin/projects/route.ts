/**
 * GET /api/admin/projects  (root-only cross-company god-view)
 *
 * [refactor jul6 S040] Thin shell — behavior lives in services/admin-usage.ts
 * (getAdminProjects). auth:"root" (A) — this cross-company listing is deliberately gated to
 * root (normal company queries always filter by companyId); the auth:"root" gate is the
 * security-load-bearing invariant. The innerJoin companies + leftJoin users god-view (exposes
 * publicId, ORDER BY createdAt DESC LIMIT 1000) is ported verbatim. Part of the ADMIN B5
 * write-cluster (char: admin-usage.route.test.ts PROJ-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getAdminProjects } from "@/server/services/admin-usage";

export const GET = defineRoute({
  auth: "root",
  handler: () => getAdminProjects(),
});
