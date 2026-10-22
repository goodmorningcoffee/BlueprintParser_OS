/**
 * GET /api/admin/yolo-debug?jobName=…  (ROOT ONLY, read-only)
 *
 * [2026-10-22 owner: "a debug statement printer I can copy and paste from the /admin AI Models tab"]
 * Thin shell — behavior lives in services/yolo-debug.ts: the job's per-project rows, leases and
 * compute_usage, the YOLO image digest, and the job's last CloudWatch lines (or why they cannot be read).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getYoloDebug, zYoloDebugQuery } from "@/server/services/yolo-debug";

export const GET = defineRoute({
  auth: "root",
  query: zYoloDebugQuery,
  handler: ({ query, session }) => getYoloDebug(query, session!),
});
