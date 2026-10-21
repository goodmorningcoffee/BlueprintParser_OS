/**
 * GET /api/admin/data-export  (admin data export, bp-dataset/1, streamed .ndjson.gz)
 *
 * Thin shell — behavior lives in services/admin-data-export.ts (exportAdminDataset).
 * auth:"admin": a company admin exports their own company; root exports any company or all.
 * kind:"stream": the service returns the gzip Response (back-pressured, one export per caller class —
 * root / company admin — per process; a second concurrent request of that class → 429). Read-only.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { exportAdminDataset, zDataExportQuery } from "@/server/services/admin-data-export";

export const GET = defineRoute({
  auth: "admin",
  kind: "stream",
  query: zDataExportQuery,
  handler: ({ req, session, query }) => exportAdminDataset(req, session!, query),
});
