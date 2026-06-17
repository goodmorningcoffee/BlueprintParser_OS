// [refactor jun17 P1.3] Thin shell — behavior in services/annotations.ts. validate-before-auth
// (projectId/annotationIds 400 before the 401), so the shell does NO auth; the service validates
// fields → resolves access → runs a single project-scoped DELETE. The legacy raw-pg-leak 500 in
// the delete catch is now a generic envelope 500 (server-logged cause).
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { batchDeleteAnnotations } from "@/server/services/annotations";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => batchDeleteAnnotations(body),
});
