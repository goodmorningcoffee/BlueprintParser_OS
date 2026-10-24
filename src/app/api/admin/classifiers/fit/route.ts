/**
 * POST /api/admin/classifiers/fit — fit the company's classifier weights on its stored proposal
 * verdicts and return the report + a PROPOSED overlay (body {companyId?, dryRun: true}). ROOT only.
 * Read-only: nothing is written; the overlay is applied through the classifier builder.
 * Thin shell — services/classifier-fit.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { fitCompanyClassifiers, zClassifierFitBody } from "@/server/services/classifier-fit";

export const POST = defineRoute({
  auth: "root",
  body: zClassifierFitBody,
  handler: ({ body, session }) => fitCompanyClassifiers(session!, body),
});
