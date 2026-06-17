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
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import { resolveProjectOrThrow } from "@/server/api/access";
import { zPublicId } from "@/server/api/schemas";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { detectCsiCodes } from "@/lib/csi-detect";
import { downloadFromS3 } from "@/lib/s3";
import { analyzePageImageWithFallback, extractRawText } from "@/lib/textract";
import { logger } from "@/lib/logger";
import type { CsiCode, TextractPageData } from "@/types";

// ── shared dual-ID resolvers ───────────────────────────────────────────────────────────────

/** publicId path: validate the uuid at the access step (zPublicId → clean 400 "Invalid project
 *  id", closing the S003 pg-uuid-cast 500), then resolve. Mirrors qto-workflows.resolveByPublicId.
 *  Sits AFTER each handler's field validation so the frozen validate-before-auth order holds. */
async function resolveByPublicId(publicId: unknown, opts?: { allowDemo?: boolean }) {
  const parsed = zPublicId.safeParse(publicId);
  if (!parsed.success) throw new ApiError("VALIDATION", "Invalid project id");
  return resolveProjectOrThrow({ publicId: parsed.data }, opts);
}

/** dbId path: coerce + Number.isInteger(>0) guard (sanctioned diff D — closes the latent pg
 *  int-cast 500 the two cast-only POSTs had), then resolve. */
async function resolveByDbId(dbId: unknown, opts?: { allowDemo?: boolean }) {
  const n = typeof dbId === "number" ? dbId : Number(dbId);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("VALIDATION", "Invalid project id");
  return resolveProjectOrThrow({ dbId: n }, opts);
}

/** The unified dual selector (generalized from intelligence's `publicId ? {publicId} : {dbId}`):
 *  a truthy publicId WINS (the canonical, invariant-honoring path); otherwise fall back to the
 *  legacy numeric dbId. Used by the four routes whose legacy `projectId` field is a dbId or
 *  dual. NOTE: pages/update is NOT one of them — its legacy `projectId` is itself a publicId, so
 *  updatePageName resolves both fields through resolveByPublicId directly (never resolveByDbId). */
async function resolveDual(args: { publicId?: unknown; dbId?: unknown }, opts?: { allowDemo?: boolean }) {
  if (args.publicId) return resolveByPublicId(args.publicId, opts);
  return resolveByDbId(args.dbId, opts);
}

// ── POST /api/pages/update ───────────────────────────────────────────────────────────────────
//
/** Rename a single page. publicId-ONLY (the param-name lie: the body field `projectId` carries a
 *  publicId UUID string — PageSidebar sends `projectId: publicId`). NEW additive `publicId` field
 *  also accepted; a truthy one wins, else the legacy `projectId`-as-publicId. NO allowDemo (a demo
 *  project is reachable only by its owning company / root via the auth path — no extra demo gate).
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
  const { project } = await resolveByPublicId(publicId || projectId);

  // Frozen: no pre-read / no 404 for a missing page — a 0-row update still returns success.
  await db
    .update(pages)
    .set({ name })
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)));

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

  const { project: proj, scope } = await resolveDual({ publicId, dbId: projectId }, { allowDemo: true });

  // Frozen demo-write gate: admin/root of the owning company may write demo projects; everyone
  // else (scope "demo" or "member") is blocked. Imperative because the shell cannot express it.
  if (proj.isDemo && scope !== "admin" && scope !== "root") {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }

  const [pageRow] = await db
    .select({
      id: pages.id,
      pageIntelligence: pages.pageIntelligence,
      csiCodes: pages.csiCodes,
    })
    .from(pages)
    .where(and(eq(pages.projectId, proj.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  if (!pageRow) {
    throw new ApiError("NOT_FOUND", "Page not found");
  }

  // Frozen SHALLOW merge (top-level keys only; a nested object under a shared key is REPLACED
  // wholesale — do NOT "fix" into a recursive merge: the CSI merge below reads merged.parsedRegions).
  const existing = (pageRow.pageIntelligence || {}) as Record<string, unknown>;
  const merged = { ...existing, ...intelligence };

  // CSI merge: collect csiTags from parsedRegions and merge into the page-level csiCodes.
  const existingCsi = (pageRow.csiCodes || []) as CsiCode[];
  const parsedRegions = (merged.parsedRegions || []) as Array<{
    csiTags?: Array<{ code: string; description: string; division?: string; trade?: string }>;
  }>;
  const incomingTags = parsedRegions.flatMap((r) => r.csiTags ?? []);
  const newCsi = mergeCsiCodes(existingCsi, incomingTags);

  await db
    .update(pages)
    .set({ pageIntelligence: merged, csiCodes: newCsi })
    .where(eq(pages.id, pageRow.id));

  // Frozen: recompute summaries only when parsedRegions are present in the INCOMING body (not the
  // merged object); the inner try/catch must NOT abort the 200 — a failure logs + leaves summaries
  // null while the write above stays committed. (Sanctioned diff B drops only the OUTER leak catch.)
  let summaries = null;
  if (intelligence.parsedRegions) {
    try {
      summaries = await computeProjectSummaries(proj.id);
    } catch (e) {
      logger.error("[pages/intelligence] Summary recompute failed:", e);
    }
  }

  return { ok: true, csiCodeCount: newCsi.length, summaries };
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

// ── POST /api/pages/textract-rerun ───────────────────────────────────────────────────────────────
//
/** Force-refresh the cached Textract result for one page (debug/diagnostic). dbId from the body
 *  `projectId` PLUS a NEW optional `publicId`; NO allowDemo (demo stays blocked). Frozen gate
 *  order: field 400 → access → no-dataUrl 404 → page-not-found 404 → S3 download → Textract →
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

  const { project } = await resolveDual({ publicId, dbId: projectId });

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

  await db.update(pages).set({ textractData }).where(eq(pages.id, pageRow.id));

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
 *  round-trip). dbId from the body `projectId` PLUS a NEW optional `publicId`; NO allowDemo.
 *  Frozen gate order: field 400 → access → page-not-found 404 → no-OCR-data 400 → detect → write →
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

  const { project } = await resolveDual({ publicId, dbId: projectId });

  const [pageRow] = await db
    .select({ id: pages.id, textractData: pages.textractData, rawText: pages.rawText })
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
    csiCodes = detectCsiCodes(rawText, textractData.words);
  } catch (err) {
    logger.error("[csi-recompute] detectCsiCodes failed:", err);
    // Sanctioned diff B: was `apiError(err.message, 500)` (leak) → generic INTERNAL 500.
    throw new ApiError("INTERNAL", "Internal server error");
  }
  const durationMs = Date.now() - start;

  await db.update(pages).set({ csiCodes }).where(eq(pages.id, pageRow.id));

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
