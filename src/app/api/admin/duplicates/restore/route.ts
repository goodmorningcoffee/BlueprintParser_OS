/**
 * POST /api/admin/duplicates/restore  (unhide hidden duplicate pages of one project)
 *
 * Thin shell — behavior lives in services/page-duplicates-apply.ts (restoreDuplicates).
 * auth:"admin" (own company; root any or ?companyId). {projectPublicId, pages?}.
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zPageNumber, zPublicId } from "@/server/api/schemas";
import { restoreDuplicates } from "@/server/services/page-duplicates-apply";

const zRestoreBody = z.object({
  projectPublicId: zPublicId,
  pages: z.array(zPageNumber).max(5000).optional(),
});

export const POST = defineRoute({
  auth: "admin",
  body: zRestoreBody,
  query: z.object({ companyId: z.string().optional() }),
  handler: ({ body, query, session }) => restoreDuplicates(body, session!, query),
});
