/**
 * POST /api/admin/classifiers/run — reprocess scope "classifiers" for ONE project of the caller's
 * company (NDJSON progress stream, the admin-reprocess lease). Body `{ projectId }`. auth:"admin";
 * demo projects refused before the stream opens. Thin shell — services/classifier-builder.ts, which
 * delegates to reprocessProjects (services/reprocess.ts).
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { runClassifiersOnProject } from "@/server/services/classifier-builder";

export const POST = defineRoute({
  auth: "admin",
  kind: "stream",
  body: zLooseBody,
  handler: ({ session, body }) => runClassifiersOnProject(session!, body),
});
