/**
 * POST /api/ai/chat (SSE stream) + DELETE /api/ai/chat
 *
 * [refactor jul5 S025] Thin shell — ALL behavior lives in services/ai-chat.ts
 * (chatPost / chatDelete). The SECOND stream-kind route through the shell (S024
 * symbol-search play).
 *
 * auth:"none" is MANDATORY on both methods: the legacy cascade validates BEFORE auth
 * (message-400 / projectId-400 fire signed-out), the global branch needs the RAW
 * session (scope:"global" + anon deliberately falls THROUGH to the scoped path, FC-4),
 * and isDemo is a SCOPE property (FC-3) — none of which declarative project-auth can
 * express. The service resolves access itself.
 *
 * kind:"stream" on POST: the engines' SSE Response (and the demo-gate's flat 403
 * NextResponse) ride defineRoute's `result instanceof Response` passthrough, which fires
 * before the kind check; the kind only arms the INTERNAL safety net. DELETE is
 * a plain json route: {success:true} wrapped by the shell = byte-identical to legacy.
 *
 * body:zLooseBody — the shell owns POST body-parse (sanctioned diff E); the service
 * runs the legacy field cascade itself. Path must stay /api/ai/chat: the RATE_RULES entry in
 * lib/middleware-rate-limit.ts caps POST /api/ai/chat at 30/user/hr, and EXACT_MAP in
 * lib/admin-logs/feature-map.ts keys on the same literal.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { chatPost, chatDelete } from "@/server/services/ai-chat";

export const POST = defineRoute({
  auth: "none",
  kind: "stream",
  body: zLooseBody,
  handler: ({ body }) => chatPost(body),
});

export const DELETE = defineRoute({
  auth: "none",
  handler: ({ req }) => chatDelete(req),
});
