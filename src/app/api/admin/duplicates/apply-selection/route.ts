/**
 * POST /api/admin/duplicates/apply-selection  (hide the admin's selected duplicate units)
 *
 * Thin shell — behavior lives in services/page-duplicates-select.ts (applyDuplicateSelection).
 * auth:"admin" (own company; root any or ?companyId). {selections:[{projectPublicId,
 * reportDigest, blocks?:[{id,keep}], pairs?:[{page,keep}]}]} — each project re-scans under its
 * lock and refuses on a digest mismatch. Reversible via /restore.
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zPageNumber, zPublicId } from "@/server/api/schemas";
import { applyDuplicateSelection, MAX_SELECTION_PROJECTS } from "@/server/services/page-duplicates-select";

const zKeep = z.enum(["latest", "earliest"]);

const zSelectionBody = z.object({
  selections: z
    .array(
      z.object({
        projectPublicId: zPublicId,
        reportDigest: z.string().regex(/^[0-9a-f]{64}$/),
        blocks: z.array(z.object({ id: z.string().regex(/^b\d+d\d+l\d+$/), keep: zKeep })).max(500).optional(),
        pairs: z.array(z.object({ page: zPageNumber, keep: zKeep })).max(5000).optional(),
      }),
    )
    .min(1)
    .max(MAX_SELECTION_PROJECTS),
});

export const POST = defineRoute({
  auth: "admin",
  body: zSelectionBody,
  query: z.object({ companyId: z.string().optional() }),
  handler: ({ body, query, session }) => applyDuplicateSelection(body, session!, query),
});
