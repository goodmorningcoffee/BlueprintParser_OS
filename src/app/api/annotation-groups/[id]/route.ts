// [refactor jun17 P1.3] Thin shell — behavior in services/annotation-groups.ts. Indirect lookup
// (group → its project): auth:"none"; the service parses the id (non-numeric → clean 400),
// fetches the group (404), resolves access on the parent project. DELETE has no body schema; it
// reads ?cascade=true|false from the query.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteAnnotationGroup, updateAnnotationGroup } from "@/server/services/annotation-groups";

export const PUT = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ params, body }) => updateAnnotationGroup(params.id, body),
});

export const DELETE = defineRoute({
  auth: "none",
  handler: ({ params, req }) =>
    deleteAnnotationGroup(params.id, new URL(req.url).searchParams.get("cascade") === "true"),
});
