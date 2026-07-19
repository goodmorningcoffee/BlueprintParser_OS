import { defineRoute } from "@/server/api/defineRoute";
import { zSplitAnnotationRequest } from "@/server/api/schemas";
import { splitAnnotation } from "@/server/services/annotations";

export const POST = defineRoute({
  auth: "none",
  body: zSplitAnnotationRequest,
  handler: ({ body }) => splitAnnotation(body),
});
