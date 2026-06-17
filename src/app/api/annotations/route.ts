// [refactor jun17 P1.3] Thin shell — all behavior lives in services/annotations.ts.
// POST is validate-before-auth (and polymorphic: single record vs batch), so the shell does
// NO auth (auth:"none") and the service validates fields → resolves access → inserts. There is
// no GET on this family (annotation reads come via pages-window). See services/annotations.ts
// for the frozen-quirk notes.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { createAnnotation } from "@/server/services/annotations";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => createAnnotation(body),
});
