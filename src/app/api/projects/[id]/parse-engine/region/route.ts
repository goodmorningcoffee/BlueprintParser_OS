/**
 * DELETE /api/projects/[id]/parse-engine/region — remove one saved region with its label, its tag projection and
 * the page CSI only it carried (K50). Thin shell — behavior lives in services/parse-engine/region-delete.ts.
 * [TP-3 WP-3.G] allowDemo:true only so the service's canonical all-role demo denial (assertProjectWritable)
 * answers a demo project with one 403 instead of a role-dependent 401/404.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteWorkspaceRegion } from "@/server/services/parse-engine/region-delete";

export const DELETE = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => deleteWorkspaceRegion(project!, session, body),
});
