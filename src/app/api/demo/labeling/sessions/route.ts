// [refactor jul3 P1.5] Thin shell — behavior lives in services/labeling.ts (listDemoLabelingSessions,
// the DELIBERATELY-ISOLATED public twin of listLabelingSessions). auth:"none" = fully public (the
// isDemo gate is the service's; a miss returns [] at 200, NOT 404 — frozen twin divergence). NO zod
// query — the service's imperative check keeps the verbatim "projectId required" message.
import { defineRoute } from "@/server/api/defineRoute";
import { listDemoLabelingSessions } from "@/server/services/labeling";

export const GET = defineRoute({
  auth: "none",
  handler: ({ req }) =>
    listDemoLabelingSessions(new URL(req.url).searchParams.get("projectId")),
});
