/**
 * GET /api/demo/config  (public header-link config for the demo landing page)
 *
 * [refactor jul8 S060] Thin auth:"none" shell (Option B: public demo endpoints stay) —
 * behavior lives in services/demo-landing.ts (getDemoHeaderLinks). The whole-body
 * swallow-catch → defaults @200 stays in-service (LOAD-BEARING — never a 500). No error
 * paths, no body, ZERO sanctioned diffs. Shell-fold (char: demo-landing.route.test.ts DC-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getDemoHeaderLinks } from "@/server/services/demo-landing";

export const GET = defineRoute({
  auth: "none",
  handler: () => getDemoHeaderLinks(),
});
