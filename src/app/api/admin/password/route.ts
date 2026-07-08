/**
 * POST /api/admin/password  (self-service password change for the signed-in user)
 *
 * [refactor jul8 S060] Thin shell — behavior lives in services/change-password.ts
 * (changePassword). ⚠️ auth:"session" NOT "admin": legacy was requireAuth — any signed-in
 * user changes THEIR OWN password (dbId-scoped); an admin gate here would lock members out
 * (PW-1 pins it). body:zLooseBody (E: legacy `await req.json()` threw on malformed → shell
 * "Invalid JSON body"). A: flat literals → envelope byte-verbatim. NO B (no legacy catch).
 * Solo fold (char: admin-password.route.test.ts PW-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { changePassword } from "@/server/services/change-password";

export const POST = defineRoute({
  auth: "session",
  body: zLooseBody,
  handler: ({ body, session }) => changePassword(session!, body),
});
