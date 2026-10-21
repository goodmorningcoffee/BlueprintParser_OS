/**
 * GET /api/projects/[id]/page-flags  (viewer: hidden duplicate pages → their canonical page)
 *
 * Thin shell — behavior lives in services/page-duplicates-apply.ts (getPageFlags).
 * auth:{project} (member of the project's company, or root). Demo projects are never marked,
 * so allowDemo stays off.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getPageFlags } from "@/server/services/page-duplicates-apply";

export const GET = defineRoute({
  auth: { project: { param: "id" } },
  handler: ({ project }) => getPageFlags(project!),
});
