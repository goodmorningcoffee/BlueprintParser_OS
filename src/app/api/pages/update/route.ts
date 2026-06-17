// [refactor jun17 P1.3] Thin shell — behavior in services/pages.ts (updatePageName).
// POST = validate-before-auth rename (auth:"none"; the service validates fields → resolves access).
// publicId-ONLY despite the body field being named `projectId` (the param-name lie): it carries a
// publicId UUID string. NEW additive optional `publicId` field also accepted (dual-ID unification).
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { updatePageName } from "@/server/services/pages";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => updatePageName(body),
});
