// [refactor jun16 P1.2] Thin shell — behavior in services/takeoff.ts. Indirect lookup
// (item → its project), so the shell does NO auth; the service fetches the item (404 if
// missing) then resolves access on its parent project. No id validation here (parseInt
// NaN → 404), matching the legacy route (groups/[id] validates id; items/[id] does not).
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteTakeoffItem, updateTakeoffItem } from "@/server/services/takeoff";

export const PUT = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ params, body }) => updateTakeoffItem(params.id, body),
});

export const DELETE = defineRoute({
  auth: "none",
  handler: ({ params }) => deleteTakeoffItem(params.id),
});
