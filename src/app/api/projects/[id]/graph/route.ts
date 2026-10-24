/**
 * GET /api/projects/[id]/graph  (viewer + LLM: the project's knowledge graph, read-only)
 *
 * Thin shell — behavior lives in services/project-graph.ts (getProjectGraph). auth:{project}
 * (member of the project's company, or root), the same spec as page-flags: the graph names sheets,
 * details and tags of a private project, so demo stays off. Reads S3 by a key derived from the
 * project's dataUrl; nothing here writes.
 *   ?view=index (default) | page&page=N | full (company admin / root only: it is the whole graph)
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { getProjectGraph } from "@/server/services/project-graph";

export const GET = defineRoute({
  auth: { project: { param: "id" } },
  query: z.object({
    view: z.enum(["index", "page", "full"]).optional(),
    page: z.coerce.number().int().positive().optional(),
  }),
  handler: ({ project, query, session }) => getProjectGraph(project!, query, session),
});
