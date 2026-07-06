/**
 * GET/POST/DELETE /api/admin/model-access  (root-only YOLO model-access grants)
 *
 * [refactor jul6 S041] Thin shells — behavior lives in services/model-access.ts
 * (getModelAccess / grantModelAccess / revokeModelAccess). auth:"root" (A). POST+DELETE
 * body:zLooseBody (E: the legacy graceful req.json().catch(()=>({})) → shell raw-parse →
 * malformed 400 "Invalid JSON body"). The parseTarget null-aware userId, the ownership gate
 * (root may only grant/revoke models IT uploaded), the cross-company-user check, and the
 * null-aware upsert stay in-service. Part of the ADMIN B6 write-cluster (char:
 * admin-models-access.route.test.ts MA-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getModelAccess, grantModelAccess, revokeModelAccess } from "@/server/services/model-access";

export const GET = defineRoute({
  auth: "root",
  handler: ({ session }) => getModelAccess(session!),
});

export const POST = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body, session }) => grantModelAccess(body, session!),
});

export const DELETE = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body, session }) => revokeModelAccess(body, session!),
});
