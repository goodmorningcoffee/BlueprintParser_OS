/**
 * POST /api/register
 *
 * [refactor jul6 S034] Thin shell — behavior lives in services/invite-register.ts
 * (registerUser). auth:"none" — public self-registration gated by the company access
 * key (the SECURITY-SENSITIVE dual hashed/plaintext scan + no-reveal 400 live in the
 * service, byte-preserved). body:zLooseBody (diff E). Path pinned by the middleware
 * ip rate rule on POST /api/register.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { registerUser } from "@/server/services/invite-register";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => registerUser(body),
});
