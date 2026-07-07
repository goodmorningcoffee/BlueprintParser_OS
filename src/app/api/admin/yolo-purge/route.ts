/**
 * DELETE /api/admin/yolo-purge
 * Purges ALL YOLO annotations across all projects for the current company.
 *
 * [refactor jul7 S049] Thin shell — behavior lives in services/yolo-admin.ts (purgeYolo).
 * auth:"admin" (A). No body → no E. A destructive but company-SCOPED write (tenancy-safe).
 * Solo fold (DR005 GAP-1 — this route was uninventoried; an unfolded destructive write now
 * brought under the envelope/service discipline). Char: admin-yolo-admin.route.test.ts YP-*.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { purgeYolo } from "@/server/services/yolo-admin";

export const DELETE = defineRoute({
  auth: "admin",
  handler: ({ session }) => purgeYolo(session!),
});
