/**
 * POST / DELETE /api/projects/[id]/proposals/verdict — record or undo one user label on a stored
 * classifier proposal. Thin shell — behavior lives in services/proposal-verdicts.ts.
 * allowDemo:true only so the service's canonical all-role demo denial (assertProjectWritable) answers a
 * demo project with one 403 instead of a role-dependent 401/404; private projects need a scoped session.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteProposalVerdict, recordProposalVerdict } from "@/server/services/proposal-verdicts";

export const POST = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => recordProposalVerdict(project!, session, body),
});

export const DELETE = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => deleteProposalVerdict(project!, session, body),
});
