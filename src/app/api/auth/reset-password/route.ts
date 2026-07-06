/**
 * POST /api/auth/reset-password
 *
 * [refactor jul6 S036] Thin shell — behavior lives in services/password-reset.ts
 * (resetPassword). auth:"none" (public, token-gated in-service). body:zLooseBody
 * (diff E; the FIXED "Failed" catch retired → diff B). Path pinned by the middleware
 * ip rate rule.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { resetPassword } from "@/server/services/password-reset";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => resetPassword(body),
});
