/**
 * GET /api/yolo/status
 *
 * [refactor jul6 S031] Thin shell — behavior lives in services/yolo.ts (yoloStatus).
 * auth:"session": legacy requireAuth-first (401 flat → envelope, diff A). Query read
 * imperatively in the service to keep the exact "jobName required" message. The fixed
 * "Failed to check status" catch is retired (diff B, S015 fixed-literal precedent).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { yoloStatus } from "@/server/services/yolo";

export const GET = defineRoute({
  auth: "session",
  handler: ({ req }) => yoloStatus(req),
});
