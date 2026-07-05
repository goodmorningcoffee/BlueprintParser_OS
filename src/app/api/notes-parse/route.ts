/**
 * POST /api/notes-parse
 *
 * [refactor jul5 S026] Thin shell — behavior lives in services/notes-parse.ts (notesParse).
 * auth:"none" MANDATORY: the legacy field+bbox 400 cascade fires BEFORE access (validate-
 * before-auth); declarative project-auth would invert it. body:zLooseBody — the shell owns
 * body-parse (sanctioned diff E); the service re-runs the legacy truthy cascade byte-exact.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { notesParse } from "@/server/services/notes-parse";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => notesParse(body),
});
