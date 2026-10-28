/**
 * POST / DELETE /api/projects/[id]/parse-engine/verdict — a workspace verdict on one inbox item (table
 * pipeline TP-3 WP-3.F): a text region (content-keyed `textRegionVerdicts`) or a classifier proposal
 * (delegated to the proposal verdict service), then the page's inbox slice is refreshed in the same
 * transaction. Thin shell — behavior lives in services/parse-engine/verdict.ts.
 * allowDemo:true only so the service's canonical all-role demo denial (assertProjectWritable) answers a
 * demo project with one 403 instead of a role-dependent 401/404.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteWorkspaceVerdict, recordWorkspaceVerdict } from "@/server/services/parse-engine/verdict";

export const POST = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => recordWorkspaceVerdict(project!, session, body),
});

export const DELETE = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => deleteWorkspaceVerdict(project!, session, body),
});
