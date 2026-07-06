/**
 * GET/PUT /api/admin/llm/config
 *
 * [refactor jul6 S037] Thin shells — behavior lives in services/company-settings.ts
 * (getLlmConfig/putLlmConfig; GET's domain-knowledge file read ported verbatim).
 * auth:"admin" (A). PUT body:zLooseBody (E); the "llm config object required" field
 * check stays in-service, byte-verbatim. Part of the ADMIN B1 six-clone batch
 * (char: __tests__/admin-config.route.test.ts LLM-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getLlmConfig, putLlmConfig } from "@/server/services/company-settings";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getLlmConfig(session!),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ session, body }) => putLlmConfig(session!, body),
});
