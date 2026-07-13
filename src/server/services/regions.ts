// [refactor jun17 P1.3] Regions service — P1.3 core family 7/7 (the LAST core family).
//
// The then-single regions route file (`regions/promote` — the "Stage 4 generic commit" route) became
// a thin `defineRoute` shell; all of that route's behavior lives here in `promoteRegion`. Behavior
// is preserved EXACTLY
// against the NEW characterization test added with this migration (regions-promote.route.test.ts —
// no P0.3 char file existed for this family, so it IS the freeze). Structurally this route is a
// near-twin of pages/intelligence (services/pages.ts `updatePageIntelligence`): validate-before-auth,
// dual-ID accept (publicId | numeric projectId), allowDemo:true with an imperative demo-WRITE 403
// gate, a transactional write, and an out-of-tx summaries recompute whose inner try/catch must not
// abort the 200. Recon ENCODER wf_c65e9d60-a50 (GO / GO_WITH_FIXES, 0 design defects).
//
// Recipe applied (S008/S009/S011/S013/S014): `auth:"none"` + service-resolved access; the two field
// validations run BEFORE access resolution (a declarative `auth:{project}` shell would invert the
// frozen error precedence — the field-400 must fire before the 401/403/404).
//
// ── SANCTIONED DIFFS (the ONLY behavior changes; logged for the meta-review) ────────────────────
//   (A) envelope flips {error:string} → {error:{code,message}} (the shell does this).
//   (B) FUNCTIONAL-ERROR STATUS REMAP (the headline diff). Legacy threw plain Errors INSIDE the try
//       whose messages reached the client at HTTP 500 via a leaky outer catch
//       (`apiError(err.message, 500)`). These five are USER-FACING guidance strings, NOT leaks, so
//       they are re-thrown as TYPED 4xx ApiErrors — the message is preserved BYTE-EXACT (incl. the
//       U+2014 em-dashes and the client-supplied interpolated sourceTextRegionId); only the HTTP
//       status changes:
//         "Page not found"                                                     500 → 404 NOT_FOUND
//         "textRegion <id> not found — reload the page and try again"          500 → 404 NOT_FOUND
//         "Page has no OCR data for spec binding"                              500 → 400 VALIDATION
//         "Could not detect spec section headers in region — try …"           500 → 400 VALIDATION
//         "Could not bind grid from textRegion — try …"                       500 → 400 VALIDATION
//       Grounded in the pages.ts mapping authority (pages.ts:170 "Page not found"→NOT_FOUND;
//       pages.ts:336-337 the near-identical "no OCR data" sibling→VALIDATION). FAITHFUL because every
//       client call-point surfaces ONLY the message text (status-blind — verified across all 7
//       consumers: persistFetch→apiErrorMessage is envelope-agnostic, no consumer branches on the
//       promote status), so the status change is invisible while the guidance message survives.
//       ⚠️ These MUST be NON-INTERNAL ApiErrors: the shell forwards an INTERNAL ApiError's message
//       verbatim at 500 (defineRoute.ts:254-255, contra the envelope.ts:42 JSDoc) and SCRUBS a plain
//       Error to a generic 500 — only a 4xx ApiError both preserves the message AND sets the status.
//   (C) leak-drop on the GENERIC catch: any OTHER (unexpected) throw — a DB error, a binder bug —
//       now falls to the shell's generic INTERNAL 500 (real cause logged server-side, never leaked).
//       The legacy "Promote failed" fallback literal is retired (the shell's "Internal server error"
//       replaces it). Same class as pages.ts diff B.
//   (D) non-uuid publicId → clean 400 "Invalid project id" (zPublicId via resolveByPublicId) instead
//       of a pg-uuid-cast 500 (S003 class). Same as pages.ts diff C.
//   (E) non-integer dbId projectId → clean 400 "Invalid project id" (resolveByDbId Number.isInteger>0
//       guard) instead of a pg int-cast 500. Same as pages.ts diff D.
//   (F) body 400-not-500: MALFORMED JSON → BAD_REQUEST 400; EMPTY / well-formed NON-OBJECT body →
//       VALIDATION 400 (shell safeParseJsonBody + zLooseBody). Legacy `await req.json()` on a
//       malformed body threw → caught → 500. The non-object case's message text drifts from the
//       legacy hand-rolled field-400 (status preserved at 400; no real caller sends such a body) —
//       cosmetic, same as pages.ts diff E.
// Happy paths are byte-identical. Every other quirk is frozen verbatim (see promoteRegion).
//
// [refactor jul8 P1-review PR-C1] BACKLOG discharged: the resolveByPublicId / resolveByDbId /
// resolveDual trio that lived here (and in pages.ts) was hoisted byte-identical to
// server/api/access.ts; this file now imports resolveDual. Behavior identical (opts were already
// explicit at the one call site).
//
// [refactor jul13 P2.4 W1] The family now also owns DELETE /api/regions. Its strict declarative
// access shell delegates the already-authorized numeric project id to deleteParsedRegion below.

import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import { resolveDual } from "@/server/api/access";
import { parseNotesFromRegion } from "@/lib/text-region-classifier";
import { bindSpecSectionsInRegion } from "@/lib/specnote-parser";
import { detectCsiFromGrid, detectCsiCodes } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB). Resolved BEFORE
// the FOR-UPDATE tx (I-1, highest-severity site) and threaded into both detect paths (D-1/D-2).
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { PARSED_REGION_DEFAULT_CONFIDENCE } from "@/lib/spatial-constants";
import { logger } from "@/lib/logger";
import type {
  TextractPageData,
  PageIntelligence,
  ParsedRegion,
  ParsedRegionType,
  CsiCode,
  TextRegion,
  SpecData,
} from "@/types";

// (The shared dual-ID resolver trio previously defined here now lives in server/api/access.ts —
//  see the PR-C1 note in the header. Diffs D/E above are implemented by those shared helpers.)

// ── POST /api/regions/promote ───────────────────────────────────────────────────────────────────
//
/**
 * Stage 4 generic commit. Promotes a classifier-detected textRegion (Classifier Accept path) or a
 * user-parsed grid (Parser Save path) into a committed `ParsedRegion{type}` inside
 * `pageIntelligence.parsedRegions`, AND merges its CSI tags into the page-level `pages.csiCodes` —
 * both writes in ONE `db.transaction` with a SELECT ... FOR UPDATE, so rapid double-clicks cannot
 * produce duplicate region writes. Generic by design: notes / spec / schedule / keynote / legend all
 * commit through here; the `type` field discriminates server-side binder dispatch.
 *
 * Frozen quirks (re-verified vs git HEAD; recon wf_c65e9d60-a50): validate-before-auth ordering;
 * the regionCsiTags seed (`overrides?.csiTags ?? []`) BEFORE the branch + the `.length === 0`
 * auto-detect suppression (a NON-empty override suppresses, an explicit [] does NOT); the LTWH→MinMax
 * bbox conversion ONLY on the Classifier Accept path (Parser Save stores overrides.bbox verbatim);
 * binders receive the ORIGINAL LTWH `textRegion.bbox`; the 3-way grid-present guard
 * (grid && headers.length>0 && rows.length>0); the `type === "notes"` parseNotesFromRegion fallback;
 * `tagColumn` always = `grid.headers[0]`; `headerText ?? defaultTableName(...)` (headerText wins);
 * both CSI auto-detects wrapped in non-fatal try/catch; source always "user", confidence always
 * PARSED_REGION_DEFAULT_CONFIDENCE; sourceTextRegionId set CONDITIONALLY after construction (absent,
 * not =undefined, on the Parser Save path); the `.map` replace-in-place upsert (keyed on regionId);
 * the UNCONDITIONAL out-of-tx summaries recompute with an inner swallow (returns 200 + summaries:null
 * on failure, write still committed). detectCsiFromGrid is the grid binder, detectCsiCodes the spec
 * binder — do NOT swap.
 */
export async function promoteRegion(body: Record<string, unknown>) {
  const {
    projectId,
    publicId,
    pageNumber,
    type,
    sourceTextRegionId,
    overrides,
  } = body as {
    projectId?: number; // dbId (legacy callers)
    publicId?: string; // preferred — every route can resolve it, root-admin-safe
    pageNumber: number;
    type: ParsedRegionType;
    sourceTextRegionId?: string;
    overrides?: {
      bbox?: [number, number, number, number];
      data?: Record<string, unknown>;
      category?: string;
      csiTags?: CsiCode[];
      regionId?: string; // stable id → upsert (re-parse REPLACES instead of duplicating)
    };
  };

  // validate-before-auth — these two 400s fire BEFORE access (frozen precedence). Messages verbatim
  // from the legacy route (the envelope flip to {code:VALIDATION} is sanctioned diff A).
  if ((!projectId && !publicId) || !pageNumber || !type) {
    throw new ApiError("VALIDATION", "Missing projectId/publicId, pageNumber, or type");
  }
  if (!sourceTextRegionId && !(overrides?.data && overrides?.bbox)) {
    throw new ApiError("VALIDATION", "Must provide either sourceTextRegionId OR overrides.{data,bbox}");
  }

  // dual-accept: truthy publicId wins, else numeric projectId. allowDemo:true lets demo READS resolve
  // (scope "demo"); demo WRITES are blocked by the imperative gate below. resolveDual gives D/E free.
  const { project, scope } = await resolveDual({ publicId, dbId: projectId }, { allowDemo: true });

  // Frozen demo-WRITE gate (identical to pages/intelligence): admin/root of the owning company may
  // write demo projects; scope "demo" (signed-out) and "member" (same-company member) are blocked.
  // Imperative because the shell's declarative min-scope cannot express it (demo bypasses min-scope).
  if (project.isDemo && scope !== "admin" && scope !== "root") {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }

  // [refactor jul9 P2-A C1] Resolve the company CSI context (async DB/S3) BEFORE opening
  // the tx that holds the FOR UPDATE row lock at :159 (I-1 — no async detect-dep work may
  // run while the lock is held). The engine stays sync and receives the resolved bundle.
  const csiCtx = await getCompanyCsiContext(project.companyId);

  const result = await db.transaction(async (tx) => {
    const [pageRow] = await tx
      .select({
        id: pages.id,
        pageIntelligence: pages.pageIntelligence,
        csiCodes: pages.csiCodes,
        textractData: pages.textractData,
      })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .for("update")
      .limit(1);

    if (!pageRow) {
      // [diff B] was a thrown Error → leaky 500; now 404 NOT_FOUND, message byte-exact.
      throw new ApiError("NOT_FOUND", "Page not found");
    }

    const currentIntel = (pageRow.pageIntelligence ?? {}) as PageIntelligence;
    const existingCsi = (pageRow.csiCodes ?? []) as CsiCode[];

    let regionBbox: [number, number, number, number];
    let regionData: Record<string, unknown>;
    // Seed BEFORE the branch (applies to BOTH paths). Auto-detect runs ONLY when length === 0 — a
    // non-empty override suppresses it; an explicit [] does NOT (frozen).
    let regionCsiTags: CsiCode[] = overrides?.csiTags ?? [];

    if (sourceTextRegionId) {
      const textRegion = currentIntel.textRegions?.find(
        (tr: TextRegion) => tr.id === sourceTextRegionId,
      );
      if (!textRegion) {
        // [diff B] → 404 NOT_FOUND; message byte-exact incl. the U+2014 em-dash + interpolated id
        // (the id is client-supplied, not a DB secret).
        throw new ApiError(
          "NOT_FOUND",
          `textRegion ${sourceTextRegionId} not found — reload the page and try again`,
        );
      }

      // textRegion.bbox is LTWH; ParsedRegion.bbox stored as MinMax (matches keynote/table convention).
      // Conversion ONLY on this Classifier Accept path — Parser Save stores overrides.bbox verbatim.
      const [tL, tT, tW, tH] = textRegion.bbox;
      regionBbox = [tL, tT, tL + tW, tT + tH];

      if (type === "spec") {
        // Spec branch: section-keyed data, not grid-shape. The binder receives the ORIGINAL LTWH bbox.
        if (!pageRow.textractData) {
          // [diff B] → 400 VALIDATION (precondition failure), message byte-exact.
          throw new ApiError("VALIDATION", "Page has no OCR data for spec binding");
        }
        const td = pageRow.textractData as TextractPageData;
        const bound = bindSpecSectionsInRegion(td.lines, textRegion.bbox);
        if (!bound) {
          // [diff B] → 400 VALIDATION; message byte-exact incl. the U+2014 em-dash.
          throw new ApiError(
            "VALIDATION",
            "Could not detect spec section headers in region — try the Parser Manual mode instead",
          );
        }
        if (regionCsiTags.length === 0) {
          try {
            const bodyText = bound.sections
              .map((s) => `${s.sectionHeader}\n${s.body}`)
              .join("\n\n");
            // [refactor jul9 P2-A C1] 4-arg (undefined middle = no textract words): company config + DB.
            regionCsiTags = detectCsiCodes(bodyText, undefined, csiCtx.config, csiCtx.db);
          } catch (err) {
            logger.warn("[regions/promote] CSI detect failed (non-fatal):", err);
          }
        }
        regionData = {
          sections: bound.sections,
          tableName: textRegion.headerText ?? defaultTableName(type, pageNumber),
          csiTags: regionCsiTags,
        } satisfies SpecData;
      } else {
        // Grid-shape branch: notes / schedule / keynote / legend
        let grid:
          | { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[]; colBoundaries?: number[] }
          | undefined;

        if (textRegion.grid && textRegion.grid.headers.length > 0 && textRegion.grid.rows.length > 0) {
          grid = {
            headers: textRegion.grid.headers,
            rows: textRegion.grid.rows,
            rowBoundaries: textRegion.grid.rowBoundaries,
            colBoundaries: textRegion.grid.colBoundaries,
          };
        } else if (type === "notes" && pageRow.textractData) {
          const td = pageRow.textractData as TextractPageData;
          grid = parseNotesFromRegion(td, textRegion.bbox);
        }

        if (!grid) {
          // [diff B] → 400 VALIDATION; message byte-exact incl. the U+2014 em-dash.
          throw new ApiError(
            "VALIDATION",
            "Could not bind grid from textRegion — try the Parser Manual mode instead",
          );
        }

        if (regionCsiTags.length === 0) {
          try {
            // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
            regionCsiTags = detectCsiFromGrid(grid.headers, grid.rows, csiCtx.config, csiCtx.db);
          } catch (err) {
            logger.warn("[regions/promote] CSI detect failed (non-fatal):", err);
          }
        }

        regionData = {
          headers: grid.headers,
          rows: grid.rows,
          tagColumn: grid.headers[0],
          tableName: textRegion.headerText ?? defaultTableName(type, pageNumber),
          rowCount: grid.rows.length,
          columnCount: grid.headers.length,
          colBoundaries: grid.colBoundaries,
          rowBoundaries: grid.rowBoundaries,
        };
      }
    } else {
      // Parser Save path — client supplies bbox + data directly. NO binder, NO bbox conversion, NO
      // CSI auto-detect. Force-unwrap is safe: the Check-2 validation above guarantees both present.
      regionBbox = overrides!.bbox!;
      regionData = overrides!.data!;
    }

    // Stable id enables upsert: the same overrides.regionId REPLACES the prior ParsedRegion instead
    // of appending a duplicate; absent → a fresh id. Assigned unconditionally across both paths.
    const regionId = overrides?.regionId ?? `parsed-${Date.now()}`;
    const parsedRegion: ParsedRegion = {
      id: regionId,
      type,
      category: overrides?.category ?? inferCategory(type, regionData),
      bbox: regionBbox,
      confidence: PARSED_REGION_DEFAULT_CONFIDENCE,
      source: "user",
      csiTags: regionCsiTags,
      data: regionData as ParsedRegion["data"],
    };
    if (sourceTextRegionId) {
      parsedRegion.sourceTextRegionId = sourceTextRegionId;
    }

    const existingRegions = currentIntel.parsedRegions ?? [];
    const existingIdx = existingRegions.findIndex((r) => r.id === regionId);
    const nextRegions = existingIdx >= 0
      ? existingRegions.map((r, i) => (i === existingIdx ? parsedRegion : r))
      : [...existingRegions, parsedRegion];
    const updatedIntelligence: PageIntelligence = {
      ...currentIntel,
      parsedRegions: nextRegions,
    };
    const newCsi = mergeCsiCodes(existingCsi, regionCsiTags);

    await tx
      .update(pages)
      .set({
        pageIntelligence: updatedIntelligence,
        csiCodes: newCsi,
      })
      .where(eq(pages.id, pageRow.id));

    return { parsedRegion, updatedIntelligence };
  });

  // Frozen: ALWAYS recompute summaries after the tx commits (UNCONDITIONAL — unlike pages/intelligence
  // which gates on parsedRegions). The inner try/catch must NOT abort the 200 — a failure logs +
  // leaves summaries null while the committed write stays. (Sanctioned diff C drops only the OUTER
  // leak catch; this inner non-fatal swallow is frozen behavior.)
  let summaries = null;
  try {
    summaries = await computeProjectSummaries(project.id);
  } catch (err) {
    logger.warn("[regions/promote] Summary recompute failed (non-fatal):", err);
  }

  return {
    ok: true,
    parsedRegion: result.parsedRegion,
    updatedIntelligence: result.updatedIntelligence,
    summaries,
  };
}

// ── DELETE /api/regions ─────────────────────────────────────────────────────

/**
 * Delete a persisted ParsedRegion from one already-authorized project page.
 *
 * The page row is locked before reading its mixed-ownership JSONB so concurrent deletes cannot
 * overwrite one another. Every matching id is removed (old rows can contain duplicates), while
 * sibling order and unrelated PageIntelligence fields are preserved. Page-level CSI codes are
 * deliberately untouched: that merged list has no source ownership information.
 */
export async function deleteParsedRegion(
  projectId: number,
  pageNumber: number,
  regionId: string,
) {
  const result = await db.transaction(async (tx) => {
    const [pageRow] = await tx
      .select({
        id: pages.id,
        pageIntelligence: pages.pageIntelligence,
      })
      .from(pages)
      .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)))
      .for("update")
      .limit(1);

    if (!pageRow) {
      throw new ApiError("NOT_FOUND", "Page not found");
    }

    const currentIntelligence = (pageRow.pageIntelligence ?? {}) as PageIntelligence;
    const currentRegions = currentIntelligence.parsedRegions ?? [];
    const nextRegions = currentRegions.filter((region) => region.id !== regionId);
    const deleted = nextRegions.length !== currentRegions.length;

    if (!deleted) {
      return { deleted: false, updatedIntelligence: currentIntelligence };
    }

    const updatedIntelligence: PageIntelligence = {
      ...currentIntelligence,
      parsedRegions: nextRegions,
    };
    await tx
      .update(pages)
      .set({ pageIntelligence: updatedIntelligence })
      .where(eq(pages.id, pageRow.id));

    return { deleted: true, updatedIntelligence };
  });

  let summaries = null;
  try {
    summaries = await computeProjectSummaries(projectId);
  } catch (err) {
    logger.warn("[regions/delete] Summary recompute failed (non-fatal):", err);
  }

  return {
    ok: true,
    deleted: result.deleted,
    updatedIntelligence: result.updatedIntelligence,
    summaries,
  };
}

function inferCategory(type: ParsedRegionType, data: Record<string, unknown>): string {
  const tableName = data.tableName as string | undefined;
  if (tableName) return tableName.toLowerCase().replace(/\s+/g, "-");
  return `${type}-region`;
}

function defaultTableName(type: ParsedRegionType, pageNumber: number): string {
  const label = type === "notes" ? "Notes" : type === "spec" ? "Spec" : type;
  return `${label} p.${pageNumber}`;
}
