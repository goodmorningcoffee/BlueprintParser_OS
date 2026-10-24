/**
 * GET /api/projects/[id]/cross-set  (viewer: "Same sheet in other sets", read-only)
 *
 * [cross-set F3 2026-10-24] Thin shell — behavior lives in services/cross-set-links.ts
 * (getProjectCrossSetLinks). auth:{project} like the v1 graph route: the links name sheets of other
 * private sets, so demo stays off. Every target project is re-checked against the caller's access at
 * read time; one the caller cannot open is dropped, never named. Reads S3 by a key derived from the
 * project's dataUrl; nothing here writes.
 *   ?page=N  one page's links (default: every page + the project-level copy_of rows)
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { getProjectCrossSetLinks } from "@/server/services/cross-set-links";

export const GET = defineRoute({
  auth: { project: { param: "id" } },
  query: z.object({ page: z.coerce.number().int().positive().optional() }),
  handler: ({ project, query, session }) => getProjectCrossSetLinks(project!, query, session),
});
