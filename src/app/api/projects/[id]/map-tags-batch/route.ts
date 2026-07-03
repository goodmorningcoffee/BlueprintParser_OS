// [refactor jul3 P1.5] Thin shell — behavior lives in services/map-tags.ts (mapTagsBatch).
// auth:"none" is MANDATORY: legacy ran req.json() + the whole field-validation cascade BEFORE
// resolveProjectAccess (an invalid body 400s even signed-out) — the service validates first and
// resolves access itself (resolveProjectOrThrow allowDemo:true — a public read on demo projects).
// body:zLooseBody: malformed JSON = the shell's BAD_REQUEST 400 (sanctioned diff E — legacy's
// unguarded req.json() was a raw 500). The engine stays in @/lib/tag-mapping, untouched.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { mapTagsBatch } from "@/server/services/map-tags";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body, params }) => mapTagsBatch(body, params.id),
});
