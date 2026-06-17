// [refactor jun17 P1.3] Thin shell — behavior in services/annotation-groups.ts. Indirect lookup;
// auth:"none". Both methods take { annotationIds: number[] } (body:zLooseBody → service narrows).
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { addGroupMembers, removeGroupMembers } from "@/server/services/annotation-groups";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ params, body }) => addGroupMembers(params.id, body),
});

export const DELETE = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ params, body }) => removeGroupMembers(params.id, body),
});
