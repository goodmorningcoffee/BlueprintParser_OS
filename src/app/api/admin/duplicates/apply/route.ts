/**
 * POST /api/admin/duplicates/apply  (hide duplicate pages; reversible via /restore)
 *
 * Thin shell — behavior lives in services/page-duplicates-apply.ts (applyDuplicates).
 * auth:"admin" (own company; root any or ?companyId). Single project: {projectPublicId,
 * reportDigest, tiers?, blocks?, keep?} — re-scans and 409s on a digest mismatch. All
 * projects: {all:true, tiers, digests:{publicId: reportDigest}} — only listed projects.
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zPublicId } from "@/server/api/schemas";
import { applyDuplicates } from "@/server/services/page-duplicates-apply";

const zTier = z.enum(["exact", "run", "near", "possible"]);
const zDigest = z.string().regex(/^[0-9a-f]{64}$/);

const zApplyBody = z.object({
  projectPublicId: zPublicId.optional(),
  reportDigest: zDigest.optional(),
  tiers: z.array(zTier).max(4).optional(),
  blocks: z.array(z.string().regex(/^b\d+d\d+l\d+$/)).max(500).optional(),
  keep: z.enum(["latest", "earliest"]).optional(),
  all: z.boolean().optional(),
  digests: z.record(zPublicId, zDigest).optional(),
});

export const POST = defineRoute({
  auth: "admin",
  body: zApplyBody,
  query: z.object({ companyId: z.string().optional() }),
  handler: ({ body, query, session }) => applyDuplicates(body, session!, query),
});
