/**
 * POST /api/admin/llm-config/test  (LLM connection test — tiny probe, nothing saved)
 *
 * [refactor jul8 S060] Thin shell — behavior lives in services/llm-config-test.ts
 * (testLlmConnection). auth:"admin" + body:zLooseBody (A on auth + the one 400 literal;
 * E on malformed JSON). ★ Ex-EVICTION: the {success:false, error, responseTime} bodies are
 * DOMAIN data at 200 — produced by the in-service try/catch and passed through the shell
 * untouched (only THROWN errors get the envelope). NO B. Solo fold (char:
 * admin-llm-config-test.route.test.ts LT-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { testLlmConnection } from "@/server/services/llm-config-test";

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body }) => testLlmConnection(body),
});
