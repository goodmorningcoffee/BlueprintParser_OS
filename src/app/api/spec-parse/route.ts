/**
 * POST /api/spec-parse
 *
 * [refactor jul5 S026] Thin shell — behavior lives in services/spec-parse.ts (specParse).
 * auth:"none" MANDATORY: validate-before-auth (field+bbox 400s precede access).
 * body:zLooseBody — shell owns body-parse (sanctioned diff E).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { specParse } from "@/server/services/spec-parse";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => specParse(body),
});
