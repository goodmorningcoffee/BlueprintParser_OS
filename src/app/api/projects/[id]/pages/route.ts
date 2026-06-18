// [refactor jun18 P1.5] Thin shell — behavior lives in services/pages.ts `getPageWindow`.
//
// auth:"none" is MANDATORY (NOT auth:{project}): the legacy route validated the page RANGE (400)
// BEFORE resolving access (401/404) — route.ts:25 before :32. A declarative auth:{project} spec runs
// auth at shell step 2, BEFORE query validation at step 3, which would invert that frozen
// range-before-auth precedence. So the service validates the range imperatively, THEN resolves access
// (the same reason all five pages/* handlers are auth:"none"). The service returns a RAW NextResponse
// so its Cache-Control header survives the shell's `result instanceof Response` passthrough
// (defineRoute.ts:248). See getPageWindow's docstring for the full frozen-quirk + sanctioned-diff list.
import { defineRoute } from "@/server/api/defineRoute";
import { getPageWindow } from "@/server/services/pages";

export const GET = defineRoute({
  auth: "none",
  handler: ({ req, params }) => getPageWindow(req, params.id),
});
