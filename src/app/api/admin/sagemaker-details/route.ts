/**
 * GET /api/admin/sagemaker-details?jobName=xxx
 * Returns rich details about a SageMaker processing job.
 *
 * [refactor jul7 S052] Thin shell — behavior lives in services/sagemaker-details.ts
 * (getSagemakerDetails). auth:"admin" (A). No body (query param) → no E. Diff B: the legacy
 * catch that leaked err.message at 500 is retired → shell generic INTERNAL 500. Solo fold
 * (char: admin-sagemaker-details.route.test.ts SM-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getSagemakerDetails } from "@/server/services/sagemaker-details";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ req }) => getSagemakerDetails(req),
});
