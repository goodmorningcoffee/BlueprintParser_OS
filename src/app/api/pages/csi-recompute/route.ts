// [refactor jun17 P1.3] Thin shell — behavior in services/pages.ts (recomputePageCsi).
// POST = force-refresh a page's cached CSI detection from its stored Textract data (admin debug).
// auth:"none" + validate-before-auth; dbId from the body `projectId` PLUS a NEW optional `publicId`;
// NO allowDemo. Uses the exact detectCsiCodes path as the bulk "Re-run All Processes" admin button.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { recomputePageCsi } from "@/server/services/pages";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => recomputePageCsi(body),
});
