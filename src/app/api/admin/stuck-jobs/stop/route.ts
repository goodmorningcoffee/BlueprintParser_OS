/**
 * POST /api/admin/stuck-jobs/stop — root only: StopExecution on a hung ingest execution. Changes
 * no rows; the next reconcile closes the job after the grace. Thin shell — services/stuck-jobs.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { stopStuckExecution, zStuckStopBody } from "@/server/services/stuck-jobs";

export const POST = defineRoute({
  auth: "root",
  body: zStuckStopBody,
  handler: ({ body, session }) => stopStuckExecution(session!, body),
});
