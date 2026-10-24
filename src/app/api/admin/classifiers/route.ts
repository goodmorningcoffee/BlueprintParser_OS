/**
 * GET /api/admin/classifiers — the classifier builder's read: built-in recipes, the company overlay,
 * the effective recipes and the signal catalog (YOLO models + class lists, tool signal types).
 * auth:"admin"; root may pass ?companyId=. Thin shell — services/classifier-builder.ts.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { getClassifierBuilder } from "@/server/services/classifier-builder";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ req, session }) => getClassifierBuilder(req, session!),
});
