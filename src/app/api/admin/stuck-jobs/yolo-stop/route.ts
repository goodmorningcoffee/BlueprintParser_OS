/**
 * POST /api/admin/stuck-jobs/yolo-stop — root only: StopProcessingJob on a running YOLO job
 * ({executionId}) or on every one ({all:true, confirm:"STOP ALL"}); rows of jobs already ended or
 * confirmed absent are closed. Thin shell — services/stuck-jobs-yolo.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { stopStuckYolo, zStuckYoloStopBody } from "@/server/services/stuck-jobs-yolo";

export const POST = defineRoute({
  auth: "root",
  body: zStuckYoloStopBody,
  handler: ({ body, session }) => stopStuckYolo(session!, body),
});
