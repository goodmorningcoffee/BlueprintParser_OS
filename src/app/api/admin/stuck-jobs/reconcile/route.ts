/**
 * POST /api/admin/stuck-jobs/reconcile — `{projectPublicId}` or `{all:true}`: close ingest jobs
 * that Step Functions attests are finished (and reclaim their worker lease under the ownership
 * proof). Idempotent. Thin shell — services/stuck-jobs.ts → services/ingest-reconcile.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { reconcileStuckJobs, zStuckReconcileBody } from "@/server/services/stuck-jobs";

export const POST = defineRoute({
  auth: "admin",
  body: zStuckReconcileBody,
  handler: ({ body, session }) => reconcileStuckJobs(session!, body),
});
