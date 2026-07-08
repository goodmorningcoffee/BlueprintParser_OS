/**
 * GET/POST/PUT/DELETE /api/admin/llm-config  (per-company LLM provider configs + system prompt)
 *
 * [refactor jul8 S056] Thin shells — behavior lives in services/llm-config.ts (getLlmConfigs /
 * upsertLlmConfig / updateLlmSettings / deleteLlmConfig). auth:"admin" on all 4 (A). GET is
 * bespoke-lite: reads searchParams (NO body → no zLooseBody, no E) so the service parses
 * req.url exactly as legacy. POST/PUT/DELETE body:zLooseBody (E: legacy `await req.json()`
 * threw on malformed → shell "Invalid JSON body"). NO B — legacy had zero catch-500s; the
 * shell's generic INTERNAL 500 is new uniform wrapping, not a leak-retirement. The crypto
 * mask/decrypt quirks, BOTH GET swallow-catches, the root scope-widening branches, and the
 * PUT jsonb spread-merge stay in-service. Solo fold (char: admin-llm-config.route.test.ts LC-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import {
  getLlmConfigs,
  upsertLlmConfig,
  updateLlmSettings,
  deleteLlmConfig,
} from "@/server/services/llm-config";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ req, session }) => getLlmConfigs(req, session!),
});

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => upsertLlmConfig(session!, body),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => updateLlmSettings(session!, body),
});

export const DELETE = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => deleteLlmConfig(session!, body),
});
