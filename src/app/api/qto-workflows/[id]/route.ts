// [refactor jun17 P1.3] Thin shell — behavior in services/qto-workflows.ts. Indirect lookup
// (workflow → its parent project): auth:"none"; the service fetches the workflow by Number(id)
// (NO integer guard — legacy quirk; a non-numeric id → NaN → pg int-cast THROWS → the shell's
// leak-free INTERNAL 500), 404 if missing, then resolves access on the parent project (no demo
// bypass). PUT body is zLooseBody (the service does its own ordered field validation). NO demo
// write-gate on [id] — an authenticated owning-company member/admin may PUT/DELETE.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteQtoWorkflow, getQtoWorkflow, updateQtoWorkflow } from "@/server/services/qto-workflows";

export const GET = defineRoute({
  auth: "none",
  handler: ({ params }) => getQtoWorkflow(params.id),
});

export const PUT = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ params, body }) => updateQtoWorkflow(params.id, body),
});

export const DELETE = defineRoute({
  auth: "none",
  handler: ({ params }) => deleteQtoWorkflow(params.id),
});
