/**
 * POST /api/admin/duplicates/scan  (Admin › Data tools › Duplicates — read-only NDJSON stream)
 *
 * Thin shell — behavior lives in services/page-duplicates.ts (scanDuplicates). auth:"admin":
 * a company admin scans their own company; root may pass ?companyId (or scan every company).
 * Changes nothing; each project line carries the `reportDigest` the apply must echo.
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zPublicId } from "@/server/api/schemas";
import { scanDuplicates } from "@/server/services/page-duplicates";

const zScanBody = z.object({
  projectPublicIds: z.array(zPublicId).max(500).optional(),
  all: z.boolean().optional(),
});

export const POST = defineRoute({
  auth: "admin",
  kind: "stream",
  body: zScanBody,
  query: z.object({ companyId: z.string().optional() }),
  handler: ({ req, body, query, session }) => scanDuplicates(req, session!, body, query),
});
