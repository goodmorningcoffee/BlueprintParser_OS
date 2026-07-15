// [refactor jun17 P1.3 family 6/7] Thin shell — behavior in services/search.ts.
// PROJECT-SCOPED full-text search. validate-before-auth: auth:"none" + the service does the
// combined field 400 → zPublicId → resolveProjectOrThrow (NO allowDemo) internally, so the legacy
// "projectId and q (min 2 chars) required" 400 still precedes the 401/404. The raw query params are
// passed through untrimmed — the service trims so trim+validate+echo stay co-located and byte-exact.
import { defineRoute } from "@/server/api/defineRoute";
import { searchProjectPages } from "@/server/services/search";

export const GET = defineRoute({
  auth: "none",
  handler: ({ req }) => {
    const url = new URL(req.url);
    return searchProjectPages(
      url.searchParams.get("projectId"),
      url.searchParams.get("q"),
      { allowDemo: false },
    );
  },
});
