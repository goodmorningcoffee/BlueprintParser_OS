// [refactor jul3 P1.5] Thin shell — behavior lives in services/labeling.ts (createLabelingSessions).
// auth:"session" = legacy AUTH-FIRST (requireAuth before req.json()+field checks — the projects.ts
// shape, NOT the validate-before-auth families). body:zLooseBody so the service runs its own
// imperative field validation with the verbatim legacy messages; malformed JSON = the shell's
// BAD_REQUEST 400 (sanctioned diff E — legacy was an uncaught SyntaxError 500). The demo-gate
// NextResponse returns through the shell's Response passthrough verbatim.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { createLabelingSessions } from "@/server/services/labeling";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => createLabelingSessions(body),
});
