// [refactor jun17 P1.3] Thin shell — behavior in services/pages.ts (rerunPageTextract).
// POST = force-refresh a page's cached Textract result (debug/diagnostic). auth:"none" +
// validate-before-auth; dbId from the body `projectId` PLUS a NEW optional `publicId`; NO allowDemo.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { rerunPageTextract } from "@/server/services/pages";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => rerunPageTextract(body),
});
