/**
 * GET / POST / DELETE /api/projects/[id]/parse-labels — the verdict bar's ✓ / ✗ on a saved parsed region
 * (table pipeline TP-2 WP-2.F). Thin shell — behavior lives in services/parse-labels.ts.
 *   GET ?page=N → `{ page, labels: { regionId → {verdict, at, was?} } }` (slim; "corrected" inferred on read).
 * GET: auth:{project} (member of the project's company, or root) and no allowDemo; the service also refuses a
 * demo project (labels carry user ids). POST/DELETE: allowDemo:true only so the service's canonical all-role
 * demo denial (assertProjectWritable) answers a demo project with one 403 instead of a role-dependent 401/404.
 */
import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteParseLabel, getParseLabels, recordParseLabel } from "@/server/services/parse-labels";

export const GET = defineRoute({
  auth: { project: { param: "id" } },
  query: z.object({ page: z.coerce.number().int().positive() }),
  handler: ({ project, query }) => getParseLabels(project!, query),
});

export const POST = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => recordParseLabel(project!, session, body),
});

export const DELETE = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ body, session, project }) => deleteParseLabel(project!, session, body),
});
