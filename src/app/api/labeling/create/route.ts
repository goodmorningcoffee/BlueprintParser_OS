// [refactor jul3 P1.5] Thin shell — behavior lives in services/labeling.ts (createLabelingSessions).
// auth:"none" at the shell: the service calls auth() ITSELF, AFTER its demo preflight, so a demo
// target is denied for every caller role before the legacy AUTH-FIRST sequence (requireAuth before
// req.json()+field checks — the projects.ts shape, NOT the validate-before-auth families).
// body:zLooseBody so the service runs its own imperative field validation with the verbatim legacy
// messages; malformed JSON = the shell's BAD_REQUEST 400 (diff E — legacy: uncaught SyntaxError 500).
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { createLabelingSessions } from "@/server/services/labeling";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => createLabelingSessions(body),
});
