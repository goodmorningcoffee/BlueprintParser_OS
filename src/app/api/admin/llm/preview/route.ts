/**
 * POST /api/admin/llm/preview
 *
 * Builds context for a project+page using the same logic as the chat route, but returns
 * section metadata instead of calling the LLM. Used by the LLM/Context admin tab preview tool.
 *
 * [refactor jul6 S048] Thin shell — behavior lives in services/llm-preview.ts
 * (previewLlmContext). auth:"admin" (A). body:zLooseBody (E: legacy `await req.json()` → shell
 * "Invalid JSON body"). The companyId-scoped project lookup (404 "Not found"), the
 * "projectId required" validation, and the full context assembly stay in-service. Solo fold
 * (char: admin-llm-preview.route.test.ts LP-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { previewLlmContext } from "@/server/services/llm-preview";

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => previewLlmContext(body, session!),
});
