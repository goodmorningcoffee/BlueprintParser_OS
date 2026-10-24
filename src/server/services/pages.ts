// [refactor jun17 P1.3] Pages service — P1.3 core family 5/7.
//
// The five pages route files (pages/{update, intelligence, textract, textract-rerun,
// csi-recompute}) are now thin `defineRoute` shells; ALL behavior lives here. Behavior is
// preserved EXACTLY against the NEW characterization tests added with this migration
// (pages-{update,intelligence,textract,textract-rerun,csi-recompute}.route.test.ts — no P0.3
// char file existed for this family, so they ARE the freeze). Mirrors the annotations / qto
// recipe (S008/S009/S011) verified against src/server/services/{annotations,qto-workflows}.ts.
//
// Recipe applied: ALL five handlers are `auth:"none"` + service-resolved access. Every route
// validates request fields BEFORE resolving access (validate-before-auth), so a declarative
// `auth:{project}` shell spec would invert the frozen error precedence (the field-400 must fire
// before the 401). The shell therefore stays auth:"none"; the service does field validation,
// THEN resolves access via resolveProjectOrThrow.
//
// ── THE DUAL-ID UNIFICATION (plan 03 §1.3 "unify on dual-ID … flip param-name lies"; 01 §102;
//    02 §140) ──────────────────────────────────────────────────────────────────────────────
// Pre-refactor this family ran THREE id conventions simultaneously (01 §102): publicId-only
// (pages/update — the body field is NAMED `projectId` but carries a publicId UUID *string*, the
// "param-name lie"), dbId-only (textract / textract-rerun / csi-recompute — `projectId` is the
// numeric DB id), and dual-accept (intelligence — `publicId ? {publicId} : {dbId: projectId}`).
// We UNIFY all five on intelligence's dual-accept pattern via the shared helpers below. The
// change is ADDITIVE + NON-BREAKING: each route keeps its CURRENT field meaning and merely GAINS
// an optional `publicId` branch (resolveDual), so existing callers (PageSidebar sends projectId-
// as-publicId; PDFViewer/TextPanel send numeric projectId) are byte-for-byte unaffected. The
// boundary move to publicId-only — removing dbId acceptance + switching the clients to send
// publicId (PDFViewer:81, TextPanel) — is the DEFERRED transition (02 §140), NOT done here.
//
// ── SANCTIONED DIFFS (the ONLY behavior changes; logged for the meta-review) ────────────────
//   (A) envelope flips {error:string} → {error:{code,message}} (the shell does this).
//   (B) leak-drop: the three handlers that interpolated raw `err.message` into a 500 body
//       (intelligence outer catch, textract-rerun Textract catch, csi-recompute detect catch)
//       now log server-side + return the shell's generic INTERNAL 500. The S3-download 500
//       ("Failed to load page image from S3") was ALREADY non-leaking → its specific wording is
//       PRESERVED. The intelligence INNER computeProjectSummaries try/catch is KEPT (it must not
//       abort the 200 — see updatePageIntelligence).
//   (C) non-uuid publicId → clean 400 (zPublicId via resolveByPublicId) instead of pg-uuid-cast
//       500 (S003 class). Applies to update + intelligence's publicId branch + the new publicId
//       branch on the three dbId routes.
//   (D) non-integer dbId → clean 400 (resolveByDbId's Number.isInteger>0 guard) instead of pg
//       int-cast 500 on the two cast-only POSTs. Parallel tightening to (C).
//   (E) body 400-not-500: MALFORMED (non-empty, unparseable) JSON → BAD_REQUEST 400 (the shell's
//       safeParseJsonBody throws it). EMPTY body OR a well-formed NON-OBJECT body (e.g. `42`, `[]`)
//       → VALIDATION 400 (zLooseBody rejects `undefined` / a non-record via zod's record-shape
//       message). Legacy: update/rerun/csi had NO try/catch → unhandled 500; intelligence caught +
//       leaked it. NB the non-object case's MESSAGE text differs from legacy's hand-rolled field-400
//       (STATUS preserved at 400, and no real caller sends such a body) — a cosmetic side effect of
//       the shared zLooseBody contract used by every migrated family. [detector-review jun17: this
//       message-drift + the empty(VALIDATION)-vs-malformed(BAD_REQUEST) code split are logged here.]
// Happy paths are byte-identical. Every other quirk is frozen verbatim (see each handler).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pages, annotations, projects } from "@/lib/db/schema";
import { eq, and, gte, lte, or, isNull } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import {
  resolveByPublicId,
  resolveDual,
  resolveProjectOrThrow,
} from "@/server/api/access";
import {
  assertProjectWritable,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import { zPublicId } from "@/server/api/schemas";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { detectCsiCodes } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB), threaded
// into recomputePageCsi's detect call below (D-1/D-2).
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import { downloadFromS3 } from "@/lib/s3";
import { assertCurrentProjectAssetRead } from "@/server/services/project-assets";
import { analyzePageImageWithFallback, extractRawText } from "@/lib/textract";
import { logger } from "@/lib/logger";
// [refactor jul23 P4.1 U10] log-mode region-data shape observation (never throws, no v-gate).
import { observeRegionDataBatch } from "@/server/services/region-data-observe";
import type { CsiCode, TextractPageData, ClientAnnotation } from "@/types";
import { serializePageWindowIntelligence } from "@/server/services/page-window-serialization";

// ── shared dual-ID resolvers ───────────────────────────────────────────────────────────────
// [refactor jul8 P1-review PR-C1] resolveByPublicId / resolveByDbId / resolveDual were defined
// here; hoisted byte-identical to server/api/access.ts (shared with regions/annotations/
// annotation-groups/takeoff/qto-workflows). Call sites unchanged — opts were already explicit at
// each call in this file. NOTE preserved from the old resolveDual doc: pages/update does NOT use
// resolveDual — its legacy `projectId` field is itself a publicId, so updatePageName resolves both
// fields through resolveByPublicId directly (never resolveByDbId; see comment at its call site).

// ── POST /api/pages/update ───────────────────────────────────────────────────────────────────
//
/** Rename a single page. publicId-ONLY (the param-name lie: the body field `projectId` carries a
 *  publicId UUID string — PageSidebar sends `projectId: publicId`). NEW additive `publicId` field
 *  also accepted; a truthy one wins, else the legacy `projectId`-as-publicId. Resolved with
 *  allowDemo:true, then assertProjectWritable denies EVERY role on a demo project with one 403.
 *  Frozen quirk: a blind composite-WHERE update with NO page-existence read — a missing page is a
 *  silent 0-row no-op that STILL returns {success:true} (PageSidebar is fire-and-forget). */
export async function updatePageName(body: Record<string, unknown>) {
  const { projectId, publicId, pageNumber, name } = body as {
    projectId?: string;
    publicId?: string;
    pageNumber?: number;
    name?: string;
  };

  // validate-before-auth — this 400 fires BEFORE the 401 (frozen). Message verbatim from legacy
  // (update/route.ts:10-15 hand-rolled it; the envelope flip to {code:VALIDATION} is sanctioned).
  // id clause generalized from legacy `!projectId` to accept the new publicId-only path.
  if ((!projectId && !publicId) || !pageNumber || !name) {
    throw new ApiError("VALIDATION", "projectId, pageNumber, and name are required");
  }

  // BOTH fields are publicIds → resolveByPublicId (never resolveByDbId — Number('<uuid>')=NaN
  // would 400 every PageSidebar save). Truthy publicId wins, else the legacy projectId.
  // [refactor jul8 P1-review N-2 → superseded by the P2 authority pass] allowDemo:true is
  // DELIBERATE: a demo project must resolve for EVERY caller role so the denial below is one
  // project-derived 403 rather than a role-dependent 401/404. assertProjectWritable — NOT the
  // absence of allowDemo — is what upholds demo-never-writes here, so do not remove it.
  const { project } = await resolveByPublicId(publicId || projectId, { allowDemo: true });
  const writeCapability = assertProjectWritable(project);

  // Frozen: no pre-read / no 404 for a missing page — a 0-row update still returns success.
  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .update(pages)
      .set({ name })
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)));
  });

  return { success: true };
}

// ── PATCH /api/pages/intelligence ──────────────────────────────────────────────────────────────
//
/** Persist pageIntelligence + merge CSI codes from parsed regions. The canonical dual-accept
 *  route (publicId wins over numeric projectId), allowDemo:true. Frozen quirks: explicit demo-WRITE
 *  403 gate (the shell can't express it — demo bypasses min-scope), shallow (NOT deep) merge of
 *  intelligence, CSI merge from parsedRegions.csiTags, and a CONDITIONAL summaries recompute whose
 *  INNER try/catch must swallow failures without aborting the 200. */
export async function updatePageIntelligence(body: Record<string, unknown>) {
  const { projectId, publicId, pageNumber, intelligence } = body as {
    projectId?: number;
    publicId?: string;
    pageNumber?: number;
    intelligence?: Record<string, unknown>;
  };

  if ((!projectId && !publicId) || !pageNumber || !intelligence) {
    throw new ApiError("VALIDATION", "Missing projectId/publicId, pageNumber, or intelligence");
  }

  const { project: proj } = await resolveDual({ publicId, dbId: projectId }, { allowDemo: true });
  const writeCapability = assertProjectWritable(proj);

  // [refactor jul23 P4.1 U10] Observe the region-data shapes in the INCOMING patch, batch-
  // aggregated (ONE warn per (sink,kind)). Read `intelligence.parsedRegions`, NEVER
  // `merged.parsedRegions` (below): the shallow merge falls `merged.parsedRegions` through to
  // the STORED array whenever the PATCH omits it (a real path — rejectedTextRegionIds-only
  // dismiss / classification-only update), so observing merged would FALSE-POSITIVE canary
  // warns on legacy-drifted stored rows THIS request never writes (recon §2b). Pure-CPU pre-tx
  // (log-mode never throws); the tx opens below and reads its own FOR-UPDATE'd copy.
  const incomingRegions = Array.isArray(intelligence.parsedRegions)
    ? (intelligence.parsedRegions as Array<{ data?: unknown }>)
    : [];
  if (incomingRegions.length) {
    observeRegionDataBatch(
      incomingRegions.map((r) => r?.data),
      "pages.intelligence",
    );
  }

  // [bugfix jul6 H2/DR002] The read-merge-write below was UNLOCKED — a concurrent writer
  // (regions/promote's own tx, or a second PATCH from another tab holding a stale client
  // blob) could interleave between the SELECT and the UPDATE and have its write silently
  // overwritten (lost update; DR002-confirmed HIGH: a stale classifier reject-PATCH could
  // destroy a freshly-promoted parsedRegion). Now a transaction with SELECT ... FOR UPDATE,
  // mirroring services/regions.ts promote — writers serialize, last-write-wins stays the
  // (frozen) semantic, but no write is ever TORN. The merge semantics below are UNTOUCHED.
  const csiCodeCount = await withProjectWrite(writeCapability, proj.id, async (tx) => {
    const [pageRow] = await tx
      .select({
        id: pages.id,
        pageIntelligence: pages.pageIntelligence,
        csiCodes: pages.csiCodes,
      })
      .from(pages)
      .where(and(eq(pages.projectId, proj.id), eq(pages.pageNumber, pageNumber)))
      .for("update")
      .limit(1);

    if (!pageRow) {
      throw new ApiError("NOT_FOUND", "Page not found");
    }

    // Frozen SHALLOW merge (top-level keys only; a nested object under a shared key is REPLACED
    // wholesale — do NOT "fix" into a recursive merge: the CSI merge below reads merged.parsedRegions).
    const existing = (pageRow.pageIntelligence || {}) as Record<string, unknown>;
    // duplicateOf (admin Data tools) and tiles (the tile-pyramid pointer, lib/tiles/keys.ts) are
    // server-owned: a client patch can neither set nor clear them.
    const merged: Record<string, unknown> = { ...existing, ...intelligence, duplicateOf: existing.duplicateOf, tiles: existing.tiles };

    // CSI merge: collect csiTags from parsedRegions and merge into the page-level csiCodes.
    const existingCsi = (pageRow.csiCodes || []) as CsiCode[];
    const parsedRegions = (merged.parsedRegions || []) as Array<{
      csiTags?: Array<{ code: string; description: string; division?: string; trade?: string }>;
    }>;
    const incomingTags = parsedRegions.flatMap((r) => r.csiTags ?? []);
    const newCsi = mergeCsiCodes(existingCsi, incomingTags);

    await tx
      .update(pages)
      .set({ pageIntelligence: merged, csiCodes: newCsi })
      .where(eq(pages.id, pageRow.id));

    return newCsi.length;
  });

  // Frozen: recompute summaries only when parsedRegions are present in the INCOMING body (not the
  // merged object); the inner try/catch must NOT abort the 200 — a failure logs + leaves summaries
  // null while the write above stays committed. (Sanctioned diff B drops only the OUTER leak catch.)
  let summaries = null;
  if (intelligence.parsedRegions) {
    try {
      summaries = await computeProjectSummaries(proj.id, writeCapability);
    } catch (e) {
      logger.error("[pages/intelligence] Summary recompute failed:", e);
    }
  }

  return { ok: true, csiCodeCount, summaries };
}

// ── GET /api/pages/textract ────────────────────────────────────────────────────────────────────
//
/** Lazy-load a single page's textractData. PERF-SACRED contract (PDFViewer:81 lazy-loader).
 *  dbId from `?projectId=<numeric>` PLUS a NEW optional `?publicId=`, allowDemo:true. Reads the
 *  query imperatively (no zod query schema — legacy treats a non-numeric projectId as NaN→falsy→
 *  its own 400, and z.coerce would change that message/precedence). Frozen quirks: a missing /
 *  un-OCR'd page returns 200 {textractData:null} (NEVER a 404), and the Cache-Control header must
 *  survive — so this returns a raw NextResponse (passed through by the shell's `result instanceof
 *  Response` gate), NOT a plain object (the shell's json envelope sets no custom headers). */
export async function getPageTextract(req: Request) {
  const url = new URL(req.url);
  const projectId = Number(url.searchParams.get("projectId"));
  const publicId = url.searchParams.get("publicId");
  const pageNumber = Number(url.searchParams.get("pageNumber"));

  if ((!projectId && !publicId) || !pageNumber) {
    throw new ApiError("VALIDATION", "Missing projectId or pageNumber");
  }

  const { project } = await resolveDual({ publicId, dbId: projectId }, { allowDemo: true });

  const [pageRow] = await db
    .select({ textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  return NextResponse.json(
    { textractData: pageRow?.textractData || null },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}

// ── GET /api/projects/[id]/pages ───────────────────────────────────────────────────────────────────
//
/** [refactor jun18 P1.5] Chunk-window loader (the PDF-viewer hot path: useChunkLoader:78 ±window,
 *  the dashboard bootstrap chunk from=1&to=15, AutoQtoTab). NOTE: this is a `projects/[id]` LEAF
 *  sub-route, NOT one of the original five `pages/*` routes — but it lives HERE because pages.ts owns
 *  the page family (the projects.ts header explicitly defers this leaf). publicId via the [id] path
 *  param; NO allowDemo (the demo twin demo/projects/[id]/pages is the public read — folded LATER).
 *
 *  Like getPageTextract this returns a RAW NextResponse so the Cache-Control header survives the
 *  shell's `result instanceof Response` passthrough (it fires BEFORE the kind check) — a
 *  plain object would be json-enveloped and DROP the header. The mutable composite must revalidate:
 *  a fresh max-age replayed pre-write annotations/page intelligence after reload or range revisit.
 *  `private, no-cache` retains private storage/conditional-revalidation semantics without allowing
 *  that stale overwrite. Frozen quirks (verbatim from legacy
 *  projects/[id]/pages/route.ts): range validated BEFORE access (validate-before-auth → the route
 *  shell MUST stay auth:"none", and NO zod query schema [it would coerce from/to + change the 400
 *  message]); the two queries run in PARALLEL; the annotation visibility OR() (own + the 3
 *  project-scoped machine sources, NOT another member's hand-drawn); the page query's 7 explicit
 *  cols + orderBy; the annotations query's bare db.select() (all cols) then a 6-field map; the
 *  ||null (falsy) normalization on the two jsonb page cols vs the ??null (nullish) on data vs the
 *  raw passthrough on note. Sanctioned diffs: A (error-envelope flip), B (leak-drop — legacy had ZERO
 *  try/catch, so an unexpected DB error escaped as a raw leaky 500; now the shell's generic INTERNAL
 *  500), C (non-uuid id → clean 400 via resolveByPublicId's zPublicId, was a pg-uuid-cast 500), and
 *  later PW-D9 (four server/legacy-only PI keys omitted from the response), and P2.4 cache
 *  correctness (`private, no-cache` replaces the stale five-minute replay policy). Every other 200
 *  field remains frozen. */
export async function getPageWindow(req: Request, idParam: string): Promise<Response> {
  const url = new URL(req.url);
  const from = parseInt(url.searchParams.get("from") || "1", 10);
  const to = parseInt(url.searchParams.get("to") || "9", 10);

  // validate-before-auth — this 400 fires BEFORE the 401/404 (frozen; legacy ran the range check at
  // route.ts:25-30, before resolveProjectAccess at :32). Message verbatim; only the envelope flips.
  if (isNaN(from) || isNaN(to) || from < 1 || to < from || to - from > 50) {
    throw new ApiError("VALIDATION", "Invalid range. Max 50 pages per request.");
  }

  // resolveByPublicId (NO allowDemo) replicates legacy resolveProjectAccess({publicId:id}) exactly
  // (signed-out→401, cross-company→404, root cross-company→200 bypass, demo-signed-out→401) and adds
  // ONLY sanctioned diff C (non-uuid→clean 400 via zPublicId). session is non-null on this path.
  const { project, session } = await resolveByPublicId(idParam);

  // Parallel — both queries need only project.id + the [from,to] page range (legacy Promise.all).
  const [pageRows, rangeAnnotations] = await Promise.all([
    db
      .select({
        pageNumber: pages.pageNumber,
        name: pages.name,
        drawingNumber: pages.drawingNumber,
        keynotes: pages.keynotes,
        csiCodes: pages.csiCodes,
        textAnnotations: pages.textAnnotations,
        pageIntelligence: pages.pageIntelligence,
      })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, project.id),
          gte(pages.pageNumber, from),
          lte(pages.pageNumber, to),
        ),
      )
      .orderBy(pages.pageNumber),
    db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.projectId, project.id),
          gte(annotations.pageNumber, from),
          lte(annotations.pageNumber, to),
          // Frozen visibility: a member sees THEIR OWN annotations plus the project-scoped machine
          // sources (yolo/shape-parse/symbol-search) — but NOT another member's hand-drawn ones.
          // session! is safe: no allowDemo → only the authed success path is reachable (non-null).
          or(
            eq(annotations.creatorId, session!.user.dbId),
            eq(annotations.source, "yolo"),
            eq(annotations.source, "shape-parse"),
            eq(annotations.source, "symbol-search"),
          ),
        ),
      ),
  ]);

  // Raw NextResponse → Cache-Control survives the shell passthrough. PW-D9 changes only the four
  // response-only PI keys below; every other body field remains frozen.
  const response = NextResponse.json({
    from,
    to,
    pages: pageRows.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
      keynotes: p.keynotes,
      csiCodes: p.csiCodes,
      textAnnotations: p.textAnnotations || null,
      // [refactor jul11 P2.2⑦ C4 / PW-D9] Wire-only trim. The DB object stays intact for server
      // consumers; ensemble/user/unknown keys remain available to the viewer.
      pageIntelligence: serializePageWindowIntelligence(p.pageIntelligence),
    })),
    annotations: rangeAnnotations.map((a) => ({
      id: a.id,
      pageNumber: a.pageNumber,
      name: a.name,
      bbox: [a.minX, a.minY, a.maxX, a.maxY],
      note: a.note,
      source: a.source as ClientAnnotation["source"],
      data: a.data ?? null,
    })),
  });
  response.headers.set("Cache-Control", "private, no-cache");
  return response;
}

// ── GET /api/demo/projects/[id]/pages ──────────────────────────────────────────────────────────────
//
/** [refactor jul3 P1.5] PUBLIC demo twin of getPageWindow — DELIBERATELY ISOLATED (the projects.ts
 *  getDemoProject/listDemoProjects doctrine): no session, no companyId, no root bypass; SOLE gate
 *  `and(publicId, isDemo=true)` → 404 on miss (NOTE: the demo/labeling twin returns [] instead —
 *  divergent by legacy design, do NOT harmonize). Do NOT collapse into getPageWindow: the twins
 *  differ in visibility (here `isNull(creatorId) OR machine` — a visitor sees project-scoped + ALL
 *  machine annotations, never a user's hand-drawn; authed = OWN + machine), caching (here NO
 *  Cache-Control — a PLAIN object return is correct and the shell json-envelopes it; the authed twin
 *  MUST return a raw NextResponse to carry its PERF-SACRED header), and query shape (here the legacy
 *  5-col page select + TWO SEPARATE try/catch "migration-safety" re-queries for
 *  textAnnotations/pageIntelligence, all SEQUENTIAL — the authed twin runs ONE 7-col select in a
 *  Promise.all; preserved verbatim, do NOT merge or parallelize). Range validation text/ordering
 *  IDENTICAL to the authed twin (400 BEFORE the lookup). Sanctioned diffs: A (envelope flip on the
 *  two error paths, messages verbatim), B (leak-drop — legacy's only try/catch were the two
 *  migration-safety swallows, KEPT; an unexpected throw was a raw leaky 500, now the shell's generic
 *  INTERNAL 500), C (non-uuid id → clean 400 via zPublicId, was a pg-uuid-cast 500, gated AFTER the
 *  range check), and later PW-D9 (the same four response-only PI omissions as the authenticated
 *  twin). Every other 200 field remains frozen. */
export async function getPageWindowDemo(req: Request, idParam: string) {
  const url = new URL(req.url);
  const from = parseInt(url.searchParams.get("from") || "1", 10);
  const to = parseInt(url.searchParams.get("to") || "9", 10);

  // Range 400 BEFORE the project lookup (frozen precedence; message verbatim, envelope flips).
  if (isNaN(from) || isNaN(to) || from < 1 || to < from || to - from > 50) {
    throw new ApiError("VALIDATION", "Invalid range. Max 50 pages per request.");
  }

  // [diff C] non-uuid → clean 400 (legacy: pg uuid-cast 500), AFTER the range check.
  const parsed = zPublicId.safeParse(idParam);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  // Public isDemo-only gate — non-demo and unknown are BOTH 404 (no existence leak).
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, parsed.data), eq(projects.isDemo, true)))
    .limit(1);

  if (!project) {
    throw new ApiError("NOT_FOUND", "Not found");
  }

  // Legacy 5-col select (NOT the authed twin's 7-col) — the jsonb heavies come from the two
  // migration-safety queries below. SEQUENTIAL by design; do not Promise.all.
  const pageRows = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      keynotes: pages.keynotes,
      csiCodes: pages.csiCodes,
    })
    .from(pages)
    .where(
      and(
        eq(pages.projectId, project.id),
        gte(pages.pageNumber, from),
        lte(pages.pageNumber, to),
      ),
    )
    .orderBy(pages.pageNumber);

  // TWO SEPARATE try/catch "migration safety" re-queries, swallowed to {} — preserved verbatim
  // from legacy (they predate the columns existing everywhere; collapsing them into the main
  // select would change failure behavior).
  const textAnnotationsMap: Record<number, unknown> = {};
  try {
    const taRows = await db
      .select({ pageNumber: pages.pageNumber, textAnnotations: pages.textAnnotations })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, project.id),
          gte(pages.pageNumber, from),
          lte(pages.pageNumber, to),
        ),
      );
    for (const r of taRows) {
      if (r.textAnnotations) textAnnotationsMap[r.pageNumber] = r.textAnnotations;
    }
  } catch { /* migration safety */ }

  const pageIntelligenceMap: Record<number, unknown> = {};
  try {
    const piRows = await db
      .select({ pageNumber: pages.pageNumber, pageIntelligence: pages.pageIntelligence })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, project.id),
          gte(pages.pageNumber, from),
          lte(pages.pageNumber, to),
        ),
      );
    for (const r of piRows) {
      if (r.pageIntelligence) pageIntelligenceMap[r.pageNumber] = r.pageIntelligence;
    }
  } catch { /* migration safety */ }

  const rangeAnnotations = await db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.projectId, project.id),
        gte(annotations.pageNumber, from),
        lte(annotations.pageNumber, to),
        // Frozen DEMO visibility: project-scoped (null creator) OR the machine sources — YOLO
        // annotations carry the running user's creator_id but are conceptually project-scoped, so
        // a read-only demo visitor sees ALL of them (toolbar/tag-mapping discoverability). A
        // user's HAND-DRAWN annotations (creatorId set, source "user") are NEVER shown here.
        or(
          isNull(annotations.creatorId),
          eq(annotations.source, "yolo"),
          eq(annotations.source, "shape-parse"),
          eq(annotations.source, "symbol-search"),
        ),
      ),
    );

  // PLAIN object — the shell json-envelopes it at 200 with NO extra headers (legacy set no
  // Cache-Control; pinned by the char test). PW-D9 changes only the four response-only PI keys.
  return {
    from,
    to,
    pages: pageRows.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
      keynotes: p.keynotes,
      csiCodes: p.csiCodes,
      textAnnotations: textAnnotationsMap[p.pageNumber] || null,
      // Same response-only serializer as the authenticated twin; do not otherwise collapse these
      // services (their auth, query cadence, visibility, and cache contracts intentionally differ).
      pageIntelligence: serializePageWindowIntelligence(pageIntelligenceMap[p.pageNumber]),
    })),
    annotations: rangeAnnotations.map((a) => ({
      id: a.id,
      pageNumber: a.pageNumber,
      name: a.name,
      bbox: [a.minX, a.minY, a.maxX, a.maxY],
      note: a.note,
      source: a.source as ClientAnnotation["source"],
      data: a.data ?? null,
    })),
  };
}

// ── GET /api/projects/[id]/thumbnail/[page] ────────────────────────────────────────────────────────
//
/** [refactor jul3 P1.5] Page-thumbnail proxy (avoids public S3 bucket access from the browser).
 *  A `projects/[id]` LEAF sub-route living here with the other page-image reads. Sole consumer is
 *  an <img src> (PageSidebar.tsx:55) — bodies are never read client-side.
 *
 *  Returns a RAW NextResponse: the AGGRESSIVE Cache-Control (1h browser + 24h SWR) must survive
 *  the shell's Response passthrough (the getPageTextract/getPageWindow precedent — a plain return
 *  would json-envelope the PNG). Frozen: the page-number 400 fires BEFORE access
 *  (validate-before-auth → shell auth:"none"); resolveProjectOrThrow({allowDemo:true}) keeps demo
 *  thumbnails PUBLIC, unknown→404-before-auth, root bypass; the PADDED thumbnails/page_NNNN.png
 *  key (the engine convention — contrast labeling's [LB-1]); a downloadFromS3 failure is a 404
 *  "Thumbnail not found" (NOT a 500 — the legacy catch quirk).
 *
 *  Sanctioned diffs: A — legacy served the three route-LOCAL errors as PLAIN-TEXT bodies
 *  (`new NextResponse("Invalid page number")` etc.) and the access errors as {error:string} JSON;
 *  ALL are now the {error:{code,message}} envelope (a text→JSON content-type change on the local
 *  three; no consumer reads bodies). C — non-uuid id → clean 400 (was the pg-cast 500), gated
 *  AFTER the page-number 400. B — no other catch existed; unexpected throws now hit the shell's
 *  generic INTERNAL 500. */
export async function getPageThumbnail(idParam: string, pageParam: string): Promise<Response> {
  const pageNum = parseInt(pageParam, 10);
  // validate-before-auth (frozen precedence): the page 400 precedes every access outcome.
  if (isNaN(pageNum) || pageNum < 1) {
    throw new ApiError("VALIDATION", "Invalid page number");
  }

  // [diff C] non-uuid → clean 400, AFTER the page check.
  const parsed = zPublicId.safeParse(idParam);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  // allowDemo: demo thumbnails are public; unknown → 404 before auth; root bypass (engine order).
  const { project } = await resolveProjectOrThrow({ publicId: parsed.data }, { allowDemo: true });

  if (!project.dataUrl) {
    throw new ApiError("NOT_FOUND", "Not found");
  }

  // Keep this compatibility alias behind the same current-row, canonical-root,
  // and rebuild admission fence as the viewer's canonical asset gateway.
  await assertCurrentProjectAssetRead(project);

  // PADDED key — the engine's real convention (do NOT "align" with labeling's [LB-1] unpadded bug).
  const s3Key = `${project.dataUrl}/thumbnails/page_${String(pageNum).padStart(4, "0")}.png`;

  let buffer: Buffer;
  try {
    buffer = await downloadFromS3(s3Key);
  } catch {
    // Frozen quirk: a missing/failed thumbnail is a 404, never a 500.
    throw new ApiError("NOT_FOUND", "Thumbnail not found");
  }

  // The buffered S3 wait is still an authority race. Revalidate immediately
  // before admitting the bytes so a withdrawal/rebuild that won is observed.
  await assertCurrentProjectAssetRead(project);

  // This legacy alias must not preserve a withdrawn demo or a pre-rebuild page in browser/shared
  // caches. The generation-qualified asset gateway is now the viewer's canonical consumer.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie, Authorization",
    },
  });
}

// ── POST /api/pages/textract-rerun ───────────────────────────────────────────────────────────────
//
/** Force-refresh the cached Textract result for one page (debug/diagnostic). dbId from the body
 *  `projectId` PLUS a NEW optional `publicId`; resolved with allowDemo:true, then an explicit
 *  isDemo 403 that now DUPLICATES assertProjectWritable's identical FORBIDDEN — kept as-is
 *  (collapsing them is an owner call, not a craft edit). Omitting allowDemo would block only
 *  PUBLIC demo access — an authenticated owner/root still resolves the project — so a gate on
 *  the resolved row is what prevents an expensive demo DB/AWS write. Gate order:
 *  field 400 → access → demo 403 → no-dataUrl 404 → page-not-found 404 → S3 download → Textract →
 *  write → success. The S3-download 500 keeps its specific (non-leaking) wording; the Textract
 *  catch drops its err.message leak (sanctioned diff B). */
export async function rerunPageTextract(body: Record<string, unknown>) {
  const { projectId, publicId, pageNumber } = body as {
    projectId?: number;
    publicId?: string;
    pageNumber?: number;
  };

  if ((!projectId && !publicId) || !pageNumber) {
    throw new ApiError("VALIDATION", "Missing projectId or pageNumber");
  }

  const { project } = await resolveDual({ publicId, dbId: projectId }, { allowDemo: true });
  if (project.isDemo) {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }
  const writeCapability = assertProjectWritable(project);

  if (!project.dataUrl) {
    throw new ApiError("NOT_FOUND", "Project has no dataUrl");
  }

  const [pageRow] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);
  if (!pageRow) {
    throw new ApiError("NOT_FOUND", "Page not found");
  }

  const s3Key = `${project.dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
  let pngBuffer: Buffer;
  try {
    pngBuffer = await downloadFromS3(s3Key);
  } catch (err) {
    logger.error("[textract-rerun] S3 download failed:", err);
    // Already non-leaking pre-refactor — keep the specific wording (distinguishes S3 from Textract).
    throw new ApiError("INTERNAL", "Failed to load page image from S3");
  }

  const start = Date.now();
  let textractData;
  try {
    textractData = await analyzePageImageWithFallback(pngBuffer);
  } catch (err) {
    logger.error("[textract-rerun] Textract call failed:", err);
    // Sanctioned diff B: was `apiError(err.message, 500)` (leak) → generic INTERNAL 500.
    throw new ApiError("INTERNAL", "Internal server error");
  }
  const durationMs = Date.now() - start;

  // Textract is a long external await. The final parent-first boundary revalidates the lifecycle,
  // so a request admitted before publication cannot resume and write into the public generation.
  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .update(pages)
      .set({ textractData })
      .where(and(eq(pages.id, pageRow.id), eq(pages.projectId, project.id)));
  });

  // Frozen stats shape (legacy used native Response.json; returning a plain object lets the shell
  // envelope it to 200 with byte-identical keys).
  return {
    success: true,
    durationMs,
    stats: {
      wordCount: textractData.words?.length ?? 0,
      lineCount: textractData.lines?.length ?? 0,
      tableCount: textractData.tables?.length ?? 0,
    },
    textractData,
  };
}

// ── POST /api/pages/csi-recompute ────────────────────────────────────────────────────────────────
//
/** Force-refresh cached CSI detection for one page from its stored Textract data (no S3/Textract
 *  round-trip). dbId from the body `projectId` PLUS a NEW optional `publicId`; allowDemo:true so
 *  assertProjectWritable can issue ONE role-independent 403 on a demo project. Frozen gate order:
 *  field 400 → access → demo 403 → page-not-found 404 → no-OCR-data 400 → detect → write →
 *  success. detectCsiCodes is called 2-arg (rawText, words) so triggers populate (drives the
 *  stats). The detect catch drops its err.message leak (sanctioned diff B). */
export async function recomputePageCsi(body: Record<string, unknown>) {
  const { projectId, publicId, pageNumber } = body as {
    projectId?: number;
    publicId?: string;
    pageNumber?: number;
  };

  if ((!projectId && !publicId) || !pageNumber) {
    throw new ApiError("VALIDATION", "Missing projectId or pageNumber");
  }

  const { project } = await resolveDual({ publicId, dbId: projectId }, { allowDemo: true });
  const writeCapability = assertProjectWritable(project);

  // [refactor jul9 P2-A C1] Resolve the company's CSI context (config + custom DB)
  // before the detect call (no transaction here; engine stays sync).
  const csiCtx = await getCompanyCsiContext(project.companyId);

  const [pageRow] = await db
    .select({ id: pages.id, textractData: pages.textractData, rawText: pages.rawText, drawingNumber: pages.drawingNumber })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);
  if (!pageRow) throw new ApiError("NOT_FOUND", "Page not found");
  // NB: the em-dash below is U+2014 (—), copied verbatim from legacy (csi-recompute/route.ts:41).
  if (!pageRow.textractData) {
    throw new ApiError("VALIDATION", "Page has no OCR data — run textract-rerun first");
  }

  const textractData = pageRow.textractData as TextractPageData;
  const rawText = pageRow.rawText || extractRawText(textractData);

  const start = Date.now();
  let csiCodes;
  try {
    // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
    csiCodes = detectCsiCodes(rawText, { lines: textractData.lines, context: { drawingNumber: pageRow.drawingNumber } }, csiCtx.config, csiCtx.db);
  } catch (err) {
    logger.error("[csi-recompute] detectCsiCodes failed:", err);
    // Sanctioned diff B: was `apiError(err.message, 500)` (leak) → generic INTERNAL 500.
    throw new ApiError("INTERNAL", "Internal server error");
  }
  const durationMs = Date.now() - start;

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .update(pages)
      .set({ csiCodes })
      .where(and(eq(pages.id, pageRow.id), eq(pages.projectId, project.id)));
  });

  const triggerCount = csiCodes.reduce((n, c) => n + (c.triggers?.length || 0), 0);

  // Frozen stats shape (legacy native Response.json → plain object enveloped to 200).
  return {
    success: true,
    durationMs,
    stats: {
      codeCount: csiCodes.length,
      triggerCount,
      tradeCount: new Set(csiCodes.map((c) => c.trade)).size,
    },
    csiCodes,
  };
}
