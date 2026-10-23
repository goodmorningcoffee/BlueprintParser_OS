/**
 * GET /api/admin/reprocess/scope  (read-only dry count for the Reprocess "All" button)
 *
 * [2026-10-23] Thin shell — services/reprocess-scope.ts. auth:"admin", the same as POST
 * /api/admin/reprocess, whose no-selection scope (own company, non-demo, any status) it counts.
 * No body, no writes.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getReprocessScope } from "@/server/services/reprocess-scope";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getReprocessScope(session!),
});
