/**
 * POST /api/admin/classifiers/preview — dry run of a draft recipe on ≤ 20 pages of one project; no
 * writes. Body `{ projectId, pages[], recipe, companyId? }`. auth:"admin"; demo projects refused.
 * Thin shell — services/classifier-preview.ts.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { previewClassifierRecipe } from "@/server/services/classifier-preview";

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  maxBodyBytes: 4 * 1024 * 1024,
  handler: ({ session, body }) => previewClassifierRecipe(session!, body),
});
