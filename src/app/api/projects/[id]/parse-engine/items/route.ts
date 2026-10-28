/**
 * GET /api/projects/[id]/parse-engine/items?scope=all|sheet&page=N — the Tables & Notes workspace inbox
 * (table pipeline TP-3 WP-3.F). Thin shell — behavior lives in services/parse-engine/items.ts.
 *   scope=all (default): per-sheet groups from the project row only (proposals + the derived index);
 *   scope=sheet&page=N: that sheet's detail, incl. low-confidence classifiedTables / ensembleRegions.
 * auth:{project} with no allowDemo; the service also refuses a demo project.
 */
import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { getWorkspaceItems } from "@/server/services/parse-engine/items";

export const GET = defineRoute({
  auth: { project: { param: "id" } },
  query: z.object({
    scope: z.enum(["all", "sheet"]).default("all"),
    page: z.coerce.number().int().positive().optional(),
  }),
  handler: ({ project, session, query }) => getWorkspaceItems(project!, session, query),
});
