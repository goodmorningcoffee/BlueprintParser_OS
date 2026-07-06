/**
 * POST /api/admin/models/reprocess-csi
 * Re-stamp CSI codes + keywords on existing YOLO annotations for a model.
 *
 * [refactor jul6 S041] Thin shell — behavior lives in services/reprocess-csi.ts
 * (reprocessCsi). ⚠️ auth:"admin" — this is requireAdmin (company-admin), NOT root; do NOT
 * elevate (the DR002 §5 auth trap). body:zLooseBody (E: legacy `await req.json()` threw on
 * malformed → shell raw-parse "Invalid JSON body"). The H6-class cross-company SECURITY SCOPE
 * check, the raw pg Pool, and the `data = data || $1::jsonb` jsonb MERGE stay in-service,
 * byte-exact. Part of the ADMIN B6 write-cluster (char: admin-models-access.route.test.ts RC-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { reprocessCsi } from "@/server/services/reprocess-csi";

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => reprocessCsi(body, session!),
});
