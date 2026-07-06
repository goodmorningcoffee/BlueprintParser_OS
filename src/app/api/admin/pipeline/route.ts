/**
 * GET/PUT /api/admin/pipeline
 *
 * [refactor jul6 S037] Thin shells — behavior lives in services/company-settings.ts
 * (getPipelineConfig/putPipelineConfig). auth:"admin" (A). PUT body:zLooseBody (E);
 * the "pipeline object required" field check stays in-service, byte-verbatim. Part of
 * the ADMIN B1 six-clone batch (char: __tests__/admin-config.route.test.ts PIPE-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getPipelineConfig, putPipelineConfig } from "@/server/services/company-settings";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getPipelineConfig(session!),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ session, body }) => putPipelineConfig(session!, body),
});
