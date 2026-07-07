/**
 * POST /api/admin/users/reset-password
 *
 * Root admin force-resets a user's password. Requires the root admin to confirm their OWN
 * password as a security measure.
 *
 * [refactor jul7 S051] Thin shell — behavior lives in services/users-reset-password.ts
 * (resetUserPassword). auth:"admin" (A) — ⚠️ the root restriction is a SECONDARY in-service
 * isRootAdmin check ("Root admin required"/403), NOT the shell auth level. body:zLooseBody
 * (E: legacy `await req.json()` → shell "Invalid JSON body"). The min-8 rule, the self-password
 * bcrypt verify, the target check, and bcrypt.hash(12) stay in-service. Solo fold (char:
 * admin-users-reset-password.route.test.ts RP-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { resetUserPassword } from "@/server/services/users-reset-password";

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => resetUserPassword(body, session!),
});
