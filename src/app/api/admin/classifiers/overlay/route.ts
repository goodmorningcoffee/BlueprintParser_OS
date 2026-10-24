/**
 * PUT /api/admin/classifiers/overlay — save the company's recipe overlay (strict-validated, versions
 * bumped per changed recipe, audited). Body `{ overlay, companyId? }` from the tab, or a bare overlay
 * from the weight fitter. auth:"admin". Thin shell — services/classifier-builder.ts.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { putClassifierOverlay } from "@/server/services/classifier-builder";

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ session, body }) => putClassifierOverlay(session!, body),
});
