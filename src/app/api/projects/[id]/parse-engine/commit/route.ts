/**
 * POST /api/projects/[id]/parse-engine/commit — the Tables & Notes workspace's Accept: re-run the recipe (paid
 * methods from the crop cache only), apply the corrections, save the region (legacy projection + structure),
 * its label, the proposal / text-region verdict, page CSI and the region's tags. Thin shell — behavior lives in
 * services/parse-engine/commit.ts. [TP-3 WP-3.G]
 * A refusal (stale / conflict / rebased / ops-lost / paid-expired) is a 409 with the error envelope plus a body.
 * allowDemo:true only so the service's canonical all-role demo denial (assertProjectWritable) answers a demo
 * project with one 403 instead of a role-dependent 401/404.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { postParseEngineCommit } from "@/server/services/parse-engine/commit";

export const POST = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ req, body, session, project, scope }) => postParseEngineCommit({ req, body, project: project!, session, scope }),
});
