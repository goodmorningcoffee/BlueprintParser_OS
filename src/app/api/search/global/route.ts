// [refactor jun17 P1.3 family 6/7] Thin shell — behavior in services/search.ts.
// CROSS-PROJECT search. auth-FIRST: auth:"session" (the shell throws UNAUTHORIZED before the handler
// runs, so a signed-out caller — even with a valid q — gets 401, matching legacy requireAuth-first
// ordering), then the service validates q + scopes to session.user.companyId. There is no project
// resolution and no 404 path (cross-company pages simply don't match the company_id filter).
import { defineRoute } from "@/server/api/defineRoute";
import { globalSearch } from "@/server/services/search";

export const GET = defineRoute({
  auth: "session",
  // session is non-null under auth:"session" (the shell 401s before the handler).
  handler: ({ req, session }) => {
    const url = new URL(req.url);
    return globalSearch(session!, url.searchParams.get("q"));
  },
});
