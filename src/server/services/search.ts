// [refactor jun17 P1.3 family 6/7] Search service — the two /api/search routes' behavior.
//
// The two search route files (search[/route], search/global) are now thin `defineRoute` shells;
// ALL behavior lives here. No P0.3 char file existed for search, so the NEW
// src/app/api/__tests__/search.route.test.ts written WITH this migration IS the freeze.
//
// Two DIFFERENT shapes — do NOT unify them:
//   • searchProjectPages = PROJECT-SCOPED full-text search. Legacy validated projectId+q BEFORE
//     resolveProjectAccess (validate-before-auth), so the route is auth:"none" and this service does
//     field-validation → zPublicId → resolveProjectOrThrow internally (the takeoff/qto create-path
//     recipe — declarative auth would resolve access BEFORE the field 400 and invert precedence).
//     resolveProjectAccess is called WITHOUT allowDemo — a signed-out caller on a DEMO project gets
//     401, NOT a public read (demo search lives in /api/demo/search, folded later in P1.4). It DOES
//     root-bypass (resolveProjectAccess's root-admin branch), so a root admin reads ANY company's project (200)
//     — the OPPOSITE of the qto/takeoff-LIST manual-lookup routes (which 404 root cross-company).
//     Frozen exactly: missing→404, signed-out→401, wrong-company-non-root→404, root-any→200, own→200.
//   • globalSearch = CROSS-PROJECT search. Legacy was AUTH-FIRST (requireAuth before the q 400), so
//     the route is auth:"session" (the shell 401s before the handler) and this service only validates
//     q + binds session.user.companyId. No project resolution, no 404/tenancy path — cross-company
//     pages just don't match the company_id filter (always 200, even with zero results).
//
// Sanctioned diffs ONLY (happy paths byte-identical):
//   A envelope flips {error:string} → {error:{code,message}} (the shell does it); the 400 message
//     strings are preserved byte-for-byte.
//   B (searchProjectPages only) a non-uuid projectId that legacy fed straight into the pg uuid column
//     (→ unhandled "invalid input syntax for type uuid" 500) becomes a clean 400 via zPublicId.
//     N/A to globalSearch (no publicId input — scope is session.user.companyId).
//   C neither legacy route had a try/catch — an unexpected DB error was a raw 500 (dev stack-leak
//     risk); now the shell's outer catch logs server-side + returns the generic INTERNAL 500.
//
// Frozen quirks (do NOT "fix" them) — see the inline FQ tags below: exact-phrase echo keeps the
// surrounding quotes; single-word-quoted falls into the default highlight branch; stemMatch strips
// ALL non-alphanumeric (incl. hyphens) and requires exact equality for ≤2-char words; the
// consecutive-phrase loop double-counts overlapping runs (matchCount counts pushes, not unique
// words); snippet falls back to ""; global's total_words is computed-but-dead; global's matchCount
// === pageCount (both COUNT(pg.id), NO DISTINCT); global ORDER BY match_count DESC has no tie-breaker.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import { resolveProjectOrThrow } from "@/server/api/access";
import { zPublicId } from "@/server/api/schemas";
import type { AuthSession } from "@/lib/api-utils";
// SearchWordMatch is the canonical EXPORTED type in @/types (the client useSearch.ts consumes it
// too) — imported here, NOT re-declared, so the service can never drift from the client's shape.
import type { SearchWordMatch, TextractPageData } from "@/types";

interface SearchResult {
  pageNumber: number;
  pageName: string;
  snippet: string;
  rank: number;
  matchCount: number;
  wordMatches: SearchWordMatch[];
}

interface GlobalSearchResult {
  projectId: string;
  projectName: string;
  matchCount: number;
  pageCount: number;
}

// Cross-project demo-gallery result. Structurally identical to GlobalSearchResult, but kept SEPARATE
// per the "do NOT unify" directive above — the two SQLs differ (gallery filters is_demo=true + public,
// global filters company_id + auth-scoped) and must be free to drift independently.
interface GallerySearchResult {
  projectId: string;
  projectName: string;
  matchCount: number;
  pageCount: number;
}

// ── GET /api/search?projectId=<publicId>&q=<term> ──────────────────────────────────────
/**
 * Project-scoped full-text search. Order (frozen validate-before-auth):
 *   1. combined field 400 (`!projectPublicId || !query || query.length < 2`) — fires BEFORE auth so
 *      a signed-out caller with a missing/short query gets 400, not 401. Message verbatim.
 *   2. zPublicId pre-parse — a non-uuid id → clean 400 "Invalid project id" (sanctioned diff B;
 *      legacy was a pg-uuid-cast 500). AFTER the field 400 so a missing/short q still wins (legacy
 *      ordering: the combined guard precedes the access call).
 *   3. resolveProjectOrThrow({publicId}, {allowDemo}) — allowDemo is OPT-IN (default false). /api/search
 *      passes nothing → its frozen NO-allowDemo posture is unchanged (demo signed-out → 401; root-bypass).
 *      [refactor jun17 P1.4 demo fold] the /api/demo/search in-project branch passes {allowDemo:true} so an
 *      unauthenticated caller on a demo project resolves to scope==="demo" instead of 401 — this is the
 *      ONLY behavioral lever the demo fold needs (search has no demo-slim fields, so scope never changes
 *      the result body). A non-demo/missing project still 404/401s exactly as before.
 *   4. the two tsvector branches + wordMatches build, byte-identical. Returns the TRIMMED q as
 *      `query` (FQ-1: incl. surrounding quotes in exact-phrase mode — NOT the unquoted searchText).
 */
export async function searchProjectPages(
  projectPublicId: string | null,
  rawQuery: string | null,
  options?: { allowDemo?: boolean },
): Promise<{ query: string; results: SearchResult[] }> {
  // `q?.trim()` byte-for-byte from legacy: a missing q (null) → undefined → !query branch.
  const query = rawQuery?.trim();

  if (!projectPublicId || !query || query.length < 2) {
    throw new ApiError("VALIDATION", "projectId and q (min 2 chars) required");
  }

  // sanctioned diff B — clean 400 instead of the legacy pg-uuid-cast 500. AFTER the field 400 above.
  const parsed = zPublicId.safeParse(projectPublicId);
  if (!parsed.success) throw new ApiError("VALIDATION", "Invalid project id");

  // allowDemo opt-in (default false → /api/search unchanged: demo projects not publicly searchable there,
  // root-bypasses). [refactor jun17 P1.4] the demo mirror passes {allowDemo:true} → demo project + signed
  // out resolves to scope==="demo" (200), not 401; a non-demo project ignores allowDemo and still 401s
  // signed-out (resolveProjectAccess's `isDemo && allowDemo` branch is false) — the demo fold's lone diff.
  const { project } = await resolveProjectOrThrow({ publicId: parsed.data }, { allowDemo: options?.allowDemo });

  // Exact phrase mode: user wraps the query in double quotes.
  // "door schedule" → exact phrase (phraseto_tsquery, consecutive highlight)
  // door schedule   → both words independently (plainto_tsquery, highlight each)
  const phraseMatch = query.match(/^"(.+)"$/);
  const isExactPhrase = !!phraseMatch;
  const searchText = phraseMatch ? phraseMatch[1] : query;

  const queryTerms = searchText
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  // plainto_tsquery: pages with ALL terms (AND), order-independent.
  // phraseto_tsquery: terms adjacent and in order. Both branches frozen verbatim incl. ts_headline opts.
  const searchResults = await db.execute(
    isExactPhrase
      ? sql`
          SELECT
            page_number,
            name,
            textract_data,
            ts_headline('english', raw_text, phraseto_tsquery('english', ${searchText}),
              'MaxWords=20, MinWords=10, StartSel=<mark>, StopSel=</mark>') as snippet,
            ts_rank(search_vector, phraseto_tsquery('english', ${searchText})) as rank
          FROM pages
          WHERE project_id = ${project.id}
            AND search_vector @@ phraseto_tsquery('english', ${searchText})
            AND (page_intelligence #>> '{duplicateOf,hiddenAt}') IS NULL
          ORDER BY rank DESC
        `
      : sql`
          SELECT
            page_number,
            name,
            textract_data,
            ts_headline('english', raw_text, plainto_tsquery('english', ${searchText}),
              'MaxWords=20, MinWords=10, StartSel=<mark>, StopSel=</mark>') as snippet,
            ts_rank(search_vector, plainto_tsquery('english', ${searchText})) as rank
          FROM pages
          WHERE project_id = ${project.id}
            AND search_vector @@ plainto_tsquery('english', ${searchText})
            AND (page_intelligence #>> '{duplicateOf,hiddenAt}') IS NULL
          ORDER BY rank DESC
        `
  );

  const results: SearchResult[] = searchResults.rows.map((row: any) => {
    const textractData = row.textract_data as TextractPageData | null;
    const wordMatches: SearchWordMatch[] = [];

    if (textractData?.words) {
      if (isExactPhrase && queryTerms.length > 1) {
        // Exact phrase: consecutive word sequences matching in order. FQ: i advances by 1, so
        // overlapping runs push the same words more than once — matchCount counts pushed objects,
        // NOT unique words. Single-word exact-phrase (queryTerms.length===1) NEVER reaches here.
        const words = textractData.words;
        for (let i = 0; i <= words.length - queryTerms.length; i++) {
          let allMatch = true;
          for (let j = 0; j < queryTerms.length; j++) {
            if (!stemMatch(words[i + j].text, queryTerms[j])) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            for (let j = 0; j < queryTerms.length; j++) {
              wordMatches.push({
                text: words[i + j].text,
                bbox: words[i + j].bbox,
              });
            }
          }
        }
      } else {
        // Default (incl. single-word exact-phrase, FQ-2): highlight every word matching ANY term.
        for (const word of textractData.words) {
          if (queryTerms.some((term) => stemMatch(word.text, term))) {
            wordMatches.push({
              text: word.text,
              bbox: word.bbox,
            });
          }
        }
      }
    }

    return {
      pageNumber: row.page_number as number,
      pageName: (row.name as string) || `Page ${row.page_number}`, // FQ-6: falsy name → `Page N`
      snippet: (row.snippet as string) || "", // FQ: null/empty ts_headline output → ""
      rank: row.rank as number, // ts_rank float passed through raw (no rounding)
      matchCount: wordMatches.length,
      wordMatches,
    };
  });

  return { query, results };
}

// ── GET /api/search/global?q=<term> ────────────────────────────────────────────────────
/**
 * Cross-project full-text search over the caller's company. Auth is the shell's auth:"session"
 * (401 before this runs — auth-FIRST), so `session` is guaranteed non-null. Order: q 400 (verbatim
 * message) → bind session.user.companyId → aggregate SQL. No project resolution, no 404 path: a
 * company with no matching pages (or another company's pages) just yields 200 {results:[]}.
 * Frozen quirks: total_words is computed-but-never-read; matchCount and pageCount are the SAME
 * COUNT(pg.id) (no DISTINCT) so they're always equal; ORDER BY match_count DESC has no tie-breaker.
 */
export async function globalSearch(
  session: AuthSession,
  rawQuery: string | null,
): Promise<{ query: string; results: GlobalSearchResult[] }> {
  const query = rawQuery?.trim();

  if (!query || query.length < 2) {
    throw new ApiError("VALIDATION", "q (min 2 chars) required");
  }

  const companyId = session.user.companyId;

  const searchResults = await db.execute(sql`
    SELECT
      p.public_id AS project_id,
      p.name AS project_name,
      COUNT(pg.id)::int AS page_count,
      SUM(
        array_length(
          regexp_split_to_array(
            lower(pg.raw_text),
            '\\s+'
          ),
          1
        )
      )::int AS total_words,
      COUNT(pg.id)::int AS match_count
    FROM pages pg
    JOIN projects p ON pg.project_id = p.id
    WHERE p.company_id = ${companyId}
      AND p.status = 'completed'
      AND pg.search_vector @@ plainto_tsquery('english', ${query})
      AND (pg.page_intelligence #>> '{duplicateOf,hiddenAt}') IS NULL
    GROUP BY p.id, p.public_id, p.name
    ORDER BY match_count DESC
  `);

  const results: GlobalSearchResult[] = searchResults.rows.map((row: any) => ({
    projectId: row.project_id as string,
    projectName: row.project_name as string,
    matchCount: row.match_count as number,
    pageCount: row.page_count as number,
  }));

  return { query, results };
}

// ── GET /api/demo/search (cross-project gallery branch, no projectId) ────────────────────
/**
 * Cross-project PUBLIC demo-gallery search — aggregates every is_demo + completed project whose pages
 * match the query, ordered by match count. [refactor jun18 P1.4 demo fold] extracted VERBATIM from the
 * inline SQL in /api/demo/search's no-projectId branch. Option B (owner-locked 2026-06-18): the public
 * auth:"none" demo endpoint + its 60/min/IP rate rule STAY put; ONLY this internal SQL moves into the
 * service layer (no new endpoint, no client switch, no mirror delete) — a zero-live-behavior-change
 * de-duplication that makes demo/search a fully-thin shell (both branches now delegate here).
 *
 * `query` arrives PRE-TRIMMED + PRE-VALIDATED by the route (the demo-specific 2-200 char guard — incl.
 * the >200 cap searchProjectPages lacks — fires there BEFORE the branch split), so this fn does NO
 * re-validation and adds NO length cap. Frozen quirks (do NOT "fix"): COUNT(DISTINCT pg.id) === COUNT(pg.id)
 * because pg.id is unique per joined row → pageCount always equals matchCount (the DISTINCT is a verbatim
 * no-op); ORDER BY match_count DESC has no tie-breaker; the query is echoed back verbatim. NOT unified
 * with globalSearch (different filters: is_demo + public here vs company_id + session there).
 */
export async function searchGallery(
  query: string,
): Promise<{ query: string; results: GallerySearchResult[] }> {
  const searchResults = await db.execute(sql`
    SELECT
      p.public_id AS project_id,
      p.name AS project_name,
      COUNT(DISTINCT pg.id)::int AS page_count,
      COUNT(pg.id)::int AS match_count
    FROM pages pg
    JOIN projects p ON pg.project_id = p.id
    WHERE p.is_demo = true
      AND p.status = 'completed'
      AND pg.search_vector @@ plainto_tsquery('english', ${query})
      AND (pg.page_intelligence #>> '{duplicateOf,hiddenAt}') IS NULL
    GROUP BY p.id, p.public_id, p.name
    ORDER BY match_count DESC
  `);

  const results: GallerySearchResult[] = searchResults.rows.map((row: any) => ({
    projectId: row.project_id as string,
    projectName: row.project_name as string,
    matchCount: row.match_count as number,
    pageCount: row.page_count as number,
  }));

  return { query, results };
}

/**
 * Stem-aware word matching. PostgreSQL tsvector stems words (doors→door) but Textract stores the
 * original form; prefix matching bridges the two ("doors" matches "DOOR" via term.startsWith(w),
 * "door" matches "DOORS" via w.startsWith(term)). Moved verbatim from search/route.ts; EXPORTED so
 * the P1.4 demo fold can drop the duplicate inline copy in demo/search/route.ts (a third copy lives
 * there until then). FQ-3: strips ALL non-alphanumeric (incl. hyphens) before compare; words ≤2
 * chars (either side) require exact equality to avoid false positives.
 */
export function stemMatch(wordText: string, term: string): boolean {
  const w = wordText.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length === 0) return false;
  if (w.length <= 2 || term.length <= 2) return w === term;
  return w.startsWith(term) || term.startsWith(w);
}
