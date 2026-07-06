/**
 * GET/PUT /api/admin/demo/config
 *
 * [refactor jul6 S037] Thin shells — behavior lives in services/company-settings.ts
 * (getDemoConfig/putDemoConfig). auth:"admin" (A: flat errors → envelope, literals
 * byte-same). PUT body:zLooseBody (E: raw parse pre-auth; non-object → VALIDATION);
 * the "demo object required" field check stays in-service, byte-verbatim. Part of the
 * ADMIN B1 six-clone batch (char: __tests__/admin-config.route.test.ts DEMO-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getDemoConfig, putDemoConfig } from "@/server/services/company-settings";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getDemoConfig(session!),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ session, body }) => putDemoConfig(session!, body),
});
