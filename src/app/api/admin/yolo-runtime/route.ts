/**
 * PUT /api/admin/yolo-runtime  (ROOT ONLY — the YOLO processing-job timeout)
 *
 * [2026-10-22 owner: "ability to modify timeout time in the admin"] Thin shell — behavior lives in
 * services/yolo-instance.ts (putYoloMaxRuntime). Body { maxRuntimeSeconds } strictly validated
 * (whole seconds, 900..86400); stored in app_settings["yolo_max_runtime_seconds"] with an audit row.
 * Read back through GET /api/admin/yolo-instance/options. Effective for jobs started after the save.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { putYoloMaxRuntime, zYoloRuntimePut } from "@/server/services/yolo-instance";

export const PUT = defineRoute({
  auth: "root",
  body: zYoloRuntimePut,
  handler: ({ body, session }) => putYoloMaxRuntime(body, session!),
});
