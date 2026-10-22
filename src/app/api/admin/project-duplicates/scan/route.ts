/**
 * POST /api/admin/project-duplicates/scan  (Admin › Data tools › Duplicate projects — read-only)
 *
 * Thin shell — behavior lives in services/project-duplicates.ts (scanProjectDuplicates).
 * auth:"root" (a company admin gets 403): every company, or one via ?companyId. Groups likely
 * duplicate projects by name / normalized name / upload sizes / page-text hash (Postgres only),
 * then HeadObject on the group members' original.pdf (ETag + size). Changes nothing.
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { scanProjectDuplicates } from "@/server/services/project-duplicates";

export const POST = defineRoute({
  auth: "root",
  body: z.object({ checkFiles: z.boolean().optional() }),
  query: z.object({ companyId: z.string().optional() }),
  handler: ({ body, query, session }) => scanProjectDuplicates(session!, body, query),
});
