// [refactor jun17 P1.3] Thin shell — behavior in services/qto-workflows.ts. GET = session-gated
// LIST scoped to the caller's company (manual companyId lookup in the service — NO root bypass, NO
// demo carve-out, matching legacy requireAuth()+filtered query); the query schema also turns a
// non-uuid projectId into a clean 400. POST = validate-before-auth create (auth:"none"; the service
// validates fields → resolves access with allowDemo → demo write-gate 403 → inserts).
import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody, zPublicId } from "@/server/api/schemas";
import { createQtoWorkflow, listQtoWorkflows } from "@/server/services/qto-workflows";

export const GET = defineRoute({
  auth: "session",
  query: z.object({ projectId: zPublicId }),
  // session is non-null under auth:"session" (the shell throws UNAUTHORIZED before the handler runs).
  handler: ({ query, session }) => listQtoWorkflows(query.projectId, session!),
});

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => createQtoWorkflow(body),
});
