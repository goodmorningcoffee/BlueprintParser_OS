// [refactor jun16 P1.2] Thin shell — behavior in services/takeoff.ts. Indirect lookup
// (group → its project), so the shell does NO auth; the service validates the id (400
// "invalid id"), fetches the group (404 if missing), then resolves access on its parent.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteTakeoffGroup, updateTakeoffGroup } from "@/server/services/takeoff";

export const PUT = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ params, body }) => updateTakeoffGroup(params.id, body),
});

export const DELETE = defineRoute({
  auth: "none",
  handler: ({ params }) => deleteTakeoffGroup(params.id),
});
