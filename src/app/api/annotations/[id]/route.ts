// [refactor jun17 P1.3] Thin shell — behavior in services/annotations.ts. Indirect lookup
// (annotation → its project), so the shell does NO auth; the service fetches the annotation
// (404 if missing) then resolves access on its parent project. No id validation here (parseInt
// NaN → pg cast → generic 500), matching the legacy route. DELETE declares no body schema so a
// bodyless DELETE isn't rejected by zod (the shell still reads + ignores any body).
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteAnnotation, updateAnnotation } from "@/server/services/annotations";

export const PUT = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ params, body }) => updateAnnotation(params.id, body),
});

export const DELETE = defineRoute({
  auth: "none",
  handler: ({ params }) => deleteAnnotation(params.id),
});
