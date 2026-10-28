/**
 * GET /api/projects/[id]/parse-engine/verdicts?page=N — the page's content-keyed text-region verdicts
 * (`pageIntelligence.textRegionVerdicts`, which the page window never ships), slim and without user ids
 * (table pipeline TP-3 WP-3.F). Thin shell — behavior lives in services/parse-engine/verdict.ts.
 * auth:{project} with no allowDemo; the service also refuses a demo project.
 */
import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { getTextRegionVerdicts } from "@/server/services/parse-engine/verdict";

export const GET = defineRoute({
  auth: { project: { param: "id" } },
  query: z.object({ page: z.coerce.number().int().positive() }),
  handler: ({ project, query }) => getTextRegionVerdicts(project!, query),
});
