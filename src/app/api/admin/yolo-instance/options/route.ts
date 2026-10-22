/**
 * GET /api/admin/yolo-instance/options  (ROOT ONLY — YOLO instance picker + cost-estimate data)
 *
 * [2026-10-22] Thin shell — behavior lives in services/yolo-instance.ts (getYoloInstanceOptions):
 * the current instance + timeout, the allowlist annotated with LIVE processing-job quotas and
 * on-demand $/h (cached ~1 h; `?refresh=1` re-reads AWS), and past-run timing. AWS failures degrade
 * to the code table inside the service; this route never reaches the YOLO run path.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getYoloInstanceOptions } from "@/server/services/yolo-instance";

export const GET = defineRoute({
  auth: "root",
  handler: ({ req }) => getYoloInstanceOptions(req.url),
});
