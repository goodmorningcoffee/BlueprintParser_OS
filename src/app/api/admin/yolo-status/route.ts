/**
 * GET /api/admin/yolo-status
 * Returns which projects have YOLO annotations loaded, with detection counts.
 *
 * [refactor jul7 S049] Thin shell — behavior lives in services/yolo-admin.ts (getYoloStatus).
 * auth:"admin" (A). No body → no E. Solo fold (DR005 GAP-1 — this route was uninventoried).
 * Char: admin-yolo-admin.route.test.ts YS-*.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getYoloStatus } from "@/server/services/yolo-admin";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getYoloStatus(session!),
});
