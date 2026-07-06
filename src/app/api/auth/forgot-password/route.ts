/**
 * POST /api/auth/forgot-password
 *
 * [refactor jul6 S036] Thin shell — behavior lives in services/password-reset.ts
 * (forgotPassword). auth:"none" (public). body:zLooseBody (diff E; the FIXED "Failed"
 * catch retired → diff B). NO-LEAK + token-hash semantics byte-preserved in the
 * service. Path pinned by the middleware ip rate rule.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { forgotPassword } from "@/server/services/password-reset";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => forgotPassword(body),
});
