/**
 * GET /api/demo/admin  (public read-only demo-scoped admin bundle)
 *
 * [refactor jul8 S060] Thin auth:"none" shell (Option B) — behavior lives in
 * services/demo-landing.ts (getDemoAdminBundle), INCLUDING the Reddit-launch security scrub
 * (isDemo-only projects · minimal model shape · no users · demo-scoped yoloStatus ·
 * pipelineConfig demo-subsection only — DA-2 pins the key-sets negatively). Sole sanctioned
 * diff A: the "No demo projects" 404 flat error → envelope. Shell-fold (char:
 * demo-landing.route.test.ts DA-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getDemoAdminBundle } from "@/server/services/demo-landing";

export const GET = defineRoute({
  auth: "none",
  handler: () => getDemoAdminBundle(),
});
