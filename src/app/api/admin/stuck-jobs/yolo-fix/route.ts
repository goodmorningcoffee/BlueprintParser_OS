/**
 * POST /api/admin/stuck-jobs/yolo-fix — root only: close every running YOLO row SageMaker attests
 * Failed/Stopped or confirms absent (≥ 3 min). Thin shell — services/stuck-jobs-yolo.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { fixStuckYolo, zStuckYoloFixBody } from "@/server/services/stuck-jobs-yolo";

export const POST = defineRoute({
  auth: "root",
  body: zStuckYoloFixBody,
  handler: ({ body, session }) => fixStuckYolo(session!, body),
});
