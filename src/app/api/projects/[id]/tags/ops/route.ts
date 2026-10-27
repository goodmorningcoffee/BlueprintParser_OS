/**
 * POST /api/projects/[id]/tags/ops — id-keyed yoloTags edits under the project row lock (table
 * pipeline WP-2.D1; K19, K40). Thin shell — behavior lives in services/tag-ops.ts.
 * allowDemo:true only so the service's canonical all-role demo denial (assertProjectWritable) answers a
 * demo project with one 403 instead of a role-dependent 401/404; private projects need a scoped session.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { postTagOps } from "@/server/services/tag-ops";

export const POST = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => postTagOps(project!, session, body),
});
