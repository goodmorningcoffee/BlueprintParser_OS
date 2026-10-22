/**
 * POST /api/admin/project-duplicates/delete  (dry run, or delete the non-keeper duplicates)
 *
 * Thin shell — behavior lives in services/project-duplicates.ts (deleteProjectDuplicates).
 * auth:"root". {groups:[{keeper, remove[]}], dryRun, planDigest?, confirm?}. The dry run writes
 * nothing; the real run needs confirm "DELETE" + the dry run's planDigest and goes through the
 * one project-deletion path per project, reporting deleted / blocked / refused / failed.
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zPublicId } from "@/server/api/schemas";
import { deleteProjectDuplicates } from "@/server/services/project-duplicates";

const zDeleteBody = z.object({
  groups: z
    .array(z.object({ keeper: zPublicId, remove: z.array(zPublicId).min(1).max(200) }))
    .min(1)
    .max(500),
  dryRun: z.boolean(),
  planDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  confirm: z.string().max(20).optional(),
});

export const POST = defineRoute({
  auth: "root",
  body: zDeleteBody,
  query: z.object({ companyId: z.string().optional() }),
  handler: ({ body, query, session }) => deleteProjectDuplicates(session!, body, query),
});
