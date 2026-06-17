// [refactor jun17 P1.3] Thin shell — behavior in services/pages.ts (updatePageIntelligence).
// PATCH = validate-before-auth (auth:"none"). The canonical dual-accept route: publicId wins over
// numeric projectId, allowDemo:true with an imperative demo-write 403 gate in the service.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { updatePageIntelligence } from "@/server/services/pages";

export const PATCH = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => updatePageIntelligence(body),
});
