/**
 * POST /api/notes-parse/propose
 *
 * [refactor jul5 S026] Thin shell — behavior lives in services/notes-parse.ts
 * (notesParsePropose). See ../route.ts for the auth:"none"+zLooseBody rationale.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { notesParsePropose } from "@/server/services/notes-parse";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => notesParsePropose(body),
});
