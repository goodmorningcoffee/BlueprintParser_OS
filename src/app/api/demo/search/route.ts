// [refactor jun17 P1.4 demo fold] Thin shell — the public demo full-text search.
//
// The IN-PROJECT branch (projectId present) now shares the migrated services/search.ts `searchProjectPages`
// (called with {allowDemo:true}); the demo route's duplicate in-project search logic AND its local
// `stemMatch` copy are GONE (the exported one in search.ts is the single source of truth — char-frozen
// identical in demo-search.route.test.ts before this change). Sanctioned diffs for the in-project branch:
//   • envelope flips {error:string} → {error:{code,message}} (the shell does it; messages byte-exact);
//   • a non-uuid projectId (was an unhandled pg uuid-cast throw) → clean 400 "Invalid project id" (zPublicId);
//   • a signed-out caller on a NON-DEMO project goes 404 → 401 (allowDemo only rescues isDemo rows;
//     resolveProjectAccess then requires auth for the non-demo row). Demo projects are unaffected (200).
//   • an AUTHED owner/admin/root on a NON-DEMO project goes 404 → 200 — same root cause (allowDemo does
//     not rescue the non-demo row, so resolveProjectAccess resolves their REAL access). Benign and
//     UNREACHABLE in practice (useSearch.ts only sends a projectId when isDemo===true); a cross-company
//     non-root caller still 404s (tenancy preserved). Locked in demo-search.route.test.ts so the
//     sanctioned-diff set is provably complete (this is the last divergence — there are no others).
//
// The CROSS-PROJECT gallery branch (no projectId) has NO authed twin — globalSearch is auth:"session" +
// company-scoped (and uses COUNT(pg.id), not the gallery's COUNT(DISTINCT)). [refactor jun18 P1.4] its SQL
// now lives in services/search.ts `searchGallery` (internals-only de-dup, Option B); folding the public
// ENDPOINT itself onto a gallery route (+ a replacement rate rule, the demo/page.tsx client switch, and
// DELETING this mirror) is still a separate, owner-gated step. The shared `q must be 2-200 chars` validation
// (incl. the >200 cap that searchProjectPages does NOT have) lives here so both branches keep the
// demo-specific message byte-exact, and fires before the branch exactly as the legacy route did.
import { defineRoute } from "@/server/api/defineRoute";
import { ApiError } from "@/server/api/envelope";
import { searchProjectPages, searchGallery } from "@/server/services/search";

export const GET = defineRoute({
  auth: "none",
  handler: async ({ req }) => {
    const url = new URL(req.url);
    const projectPublicId = url.searchParams.get("projectId");
    const query = url.searchParams.get("q")?.trim();

    // Shared demo validation (both branches): the >200 cap is demo-specific (searchProjectPages has none).
    if (!query || query.length < 2 || query.length > 200) {
      throw new ApiError("VALIDATION", "q must be 2-200 chars");
    }

    // In-project: delegate to the shared service with allowDemo. searchProjectPages re-validates (no-op
    // here), does the zPublicId 400 (non-uuid → "Invalid project id"), resolveProjectOrThrow(allowDemo:true)
    // (demo → scope "demo" 200; non-demo/missing → 401/404), then the byte-identical search + wordMatches.
    if (projectPublicId) {
      return searchProjectPages(projectPublicId, query, { allowDemo: true });
    }

    // Cross-project PUBLIC gallery (is_demo + completed). [refactor jun18 P1.4] the SQL + row-map now live
    // in services/search.ts `searchGallery`; `query` is already trimmed + validated (2-200) above, so the
    // branch delegates directly. The shell envelopes the returned plain object exactly as the inline code did.
    return searchGallery(query);
  },
});
