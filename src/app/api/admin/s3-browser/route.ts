/**
 * GET /api/admin/s3-browser?prefix=companyKey/projectHash/
 * List S3 objects under a prefix. Admin only.
 * Security: validates prefix starts with the admin's company data key, and fail-closed blocks
 * any tenant from reaching the root-managed models/ weights (WEIGHTS-2 backstop).
 *
 * [refactor jul7 S054] Thin shell — behavior lives in services/s3-browser.ts (getS3Browser).
 * auth:"admin" (A). No body (query params) → no E. Diff B: both catch-500s (the list
 * err.message leak + the download fixed literal) retired → shell generic INTERNAL 500. The
 * WEIGHTS-2 + dataKey scope gates stay in-service, byte-exact. Solo fold (char:
 * admin-s3-browser.route.test.ts SB-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getS3Browser } from "@/server/services/s3-browser";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ req, session }) => getS3Browser(req, session!),
});
