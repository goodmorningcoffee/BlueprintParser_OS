// [refactor jun17 P1.3] Thin shell — behavior in services/annotation-groups.ts.
// GET = unauthenticated demo read (allowDemo handled in the service); auth:"none" + validated
// query (projectId uuid). POST = validate-before-auth create (auth:"none"; service validates →
// resolves access → tx-inserts). See services/annotation-groups.ts for frozen-quirk notes.
import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody, zPublicId } from "@/server/api/schemas";
import { createAnnotationGroup, getAnnotationGroups } from "@/server/services/annotation-groups";

export const GET = defineRoute({
  auth: "none",
  query: z.object({ projectId: zPublicId }),
  handler: ({ query }) => getAnnotationGroups(query.projectId),
});

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => createAnnotationGroup(body),
});
