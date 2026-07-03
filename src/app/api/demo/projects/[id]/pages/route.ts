// [refactor jul3 P1.5] Thin shell — behavior lives in services/pages.ts (getPageWindowDemo, the
// DELIBERATELY-ISOLATED public twin of getPageWindow). auth:"none" = fully public (demo projects
// only — the isDemo gate is the service's). NO zod query (would coerce from/to + change the frozen
// range-400 message, which must fire BEFORE the lookup). Returns a PLAIN object (no Cache-Control —
// unlike the authed twin's raw-NextResponse PERF-SACRED header; the shell json-envelopes at 200).
import { defineRoute } from "@/server/api/defineRoute";
import { getPageWindowDemo } from "@/server/services/pages";

export const GET = defineRoute({
  auth: "none",
  handler: ({ req, params }) => getPageWindowDemo(req, params.id),
});
