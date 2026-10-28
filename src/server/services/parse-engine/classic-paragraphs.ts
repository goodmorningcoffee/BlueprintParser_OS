/**
 * Notes / spec on the paragraph engine for the CLASSIC tools (table pipeline WP-3.J; PLAN §3.4 U12/U13/U18/U19,
 * §2.4 "promote classifier path"; K31–K35).
 *
 * - **Classic Accept** (`POST /api/regions/promote` with `sourceTextRegionId`, `regions.ts`) under
 *   `tools.notesClassifier` / `tools.specClassifier = "engine"`: `paragraphs/segment.ts` (through `runParseEngine`,
 *   `instant` budget, the request's kind) replaces `parseNotesFromRegion` / `bindSpecSectionsInRegion` and the
 *   stored `TextRegion.grid`. The region's `data` is the legacy projection (`legacy-view.ts`, E-5) plus the engine
 *   extension: `structure`, `links` (`origin: "classic-engine"`, `viewHash` over the stored legacy part, so
 *   `readStructure` trusts it until a classic editor changes it), `engine` (the stamp) and `recipe`
 *   (`origin: "text-region"`). CSI uses the same detectors the legacy Accept uses, on the projected text.
 * - **Notes Auto / Spec Auto** (`/api/notes-parse`, `/api/spec-parse`) under `tools.notesAuto` / `tools.specAuto`:
 *   the same parse; the response keeps the legacy route shape (the classic parsers read only those fields) and adds
 *   `structure` and `engine`. The Guided `/propose` routes stay on the legacy binders.
 *
 * Evidence is built from the page row the caller already holds (`buildPageEvidence`, no YOLO rows: notes and spec
 * read only words, lines and LAYOUT; the kind is always given), so nothing new is read inside the promote lock and
 * the paragraphs equal a workspace parse of the same box. Its `evidenceHash` therefore omits YOLO shapes: it is
 * stamped for provenance, not compared (only a workspace draft's hash is compared, at commit).
 */

import { ApiError } from "@/server/api/envelope";
import { detectCsiCodes, detectCsiFromGrid } from "@/lib/csi-detect";
import type { CompanyCsiContext } from "@/lib/csi-company-db";
import { logger } from "@/lib/logger";
import { runParseEngine } from "@/lib/parse-engine/engine";
import { legacyView, viewHash, type LegacyNotesView, type LegacySpecView } from "@/lib/parse-engine/legacy-view";
import type { BboxMinMax, ParseRecipe, ParseRequest, ParseResult, RegionLinks, StructureParagraphDoc } from "@/lib/parse-engine/types";
import type { CsiCode, TextractPageData } from "@/types";
import { buildPageEvidence } from "./evidence";

export type ParagraphKind = "notes" | "spec";

type CsiCtx = Pick<CompanyCsiContext, "config" | "db"> | null | undefined;

/**
 * WP-3.F's text-region content key, `tr:${type}:${x0},${y0},${x1},${y1}` (MinMax, two decimals). WP-3.F is not in
 * this branch's base; at integration this repoints to `parse-engine/text-region-verdicts.ts` `textRegionKey`.
 */
const q2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
export const textRegionKeyOf = (type: string, b: readonly number[]): string => `tr:${type}:${b.map(q2).join(",")}`;

const validBox = (b: readonly number[]): boolean =>
  b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1];

export interface ParagraphParseArgs {
  page: number;
  /** The box (MinMax, E-4). */
  bbox: BboxMinMax;
  kind: ParagraphKind;
  textractData: TextractPageData;
}

/**
 * Parse one notes / spec box on the engine (instant budget, kind given). null when the box is empty or the
 * segmenter reads no paragraph in it (the legacy binders' "nothing bound" outcome).
 */
export async function parseParagraphBox(args: ParagraphParseArgs): Promise<{ result: ParseResult; request: ParseRequest } | null> {
  if (!validBox(args.bbox)) return null;
  const td = args.textractData as TextractPageData & { layout?: unknown };
  const ev = buildPageEvidence({
    pageNumber: args.page, drawingNumber: null, keynotes: null, csiCodes: null,
    words: td.words ?? null, tables: td.tables ?? null, layout: td.layout ?? null,
    pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
  });
  const request: ParseRequest = { page: args.page, bbox: [...args.bbox] as BboxMinMax, kind: args.kind, budget: "instant" };
  const result = await runParseEngine(ev, request);
  const model = result.model as StructureParagraphDoc;
  if (model.kind !== args.kind || model.paragraphs.length === 0) return null;
  return { result, request };
}

/** Spec-view section text, as the legacy routes join it (`sectionHeader\nbody`, blank line between). */
const specBodyText = (view: LegacySpecView): string => view.sections.map((s) => `${s.sectionHeader}\n${s.body}`).join("\n\n");

/** Top of each projected spec section (the legacy spec binder's `rowBoundaries`: one top per section). */
function specSectionTops(model: StructureParagraphDoc): number[] {
  const tops = model.blocks.map((b) => b.b[1]);
  const orphans = model.paragraphs.filter((p) => !model.blocks.some((b) => b.id === p.blockId));
  if (orphans.length) tops.push(Math.min(...orphans.map((p) => p.b[1])));
  return tops;
}

// ── Classic Accept ─────────────────────────────────────────────────────────────────────────────

export interface ClassicAcceptArgs {
  kind: ParagraphKind;
  page: number;
  /** The accepted text region (LTWH box as stored, its classifier type). */
  textRegion: { type: string; bbox: [number, number, number, number] };
  /** The page's OCR (null → the legacy "no OCR" refusals). */
  textractData: TextractPageData | null;
  tableName: string;
  /** `overrides.csiTags ?? []`: non-empty suppresses detection (the legacy seed rule). */
  csiSeed: CsiCode[];
  csiCtx: CsiCtx;
  /** The region this Accept replaces (`overrides.regionId` upsert), for the revision. */
  previous?: { data?: unknown } | null;
  at: string;
}

const NOTES_REFUSAL = "Could not bind grid from textRegion — try the Parser Manual mode instead";
const SPEC_NO_OCR = "Page has no OCR data for spec binding";
const SPEC_REFUSAL = "Could not detect spec section headers in region — try the Parser Manual mode instead";

function previousRevision(previous: { data?: unknown } | null | undefined): number {
  const links = (previous?.data as { links?: { revision?: unknown } } | undefined)?.links;
  return typeof links?.revision === "number" && Number.isInteger(links.revision) && links.revision > 0 ? links.revision : 0;
}

/**
 * The Classic Accept of a notes / spec text region on the engine → the region `data` and its CSI. Throws the same
 * 400 messages as the legacy binders (`regions.ts` diff B).
 */
export async function classicAcceptOnEngine(args: ClassicAcceptArgs): Promise<{ data: Record<string, unknown>; csiTags: CsiCode[] }> {
  const { kind } = args;
  if (!args.textractData) throw new ApiError("VALIDATION", kind === "spec" ? SPEC_NO_OCR : NOTES_REFUSAL);
  const [l, t, w, h] = args.textRegion.bbox;
  const bbox: BboxMinMax = [l, t, l + w, t + h];
  const parsed = await parseParagraphBox({ page: args.page, bbox, kind, textractData: args.textractData });
  if (!parsed) throw new ApiError("VALIDATION", kind === "spec" ? SPEC_REFUSAL : NOTES_REFUSAL);
  const { result, request } = parsed;
  const view = legacyView(result.model, { tableName: args.tableName });

  let csiTags = args.csiSeed;
  if (csiTags.length === 0) {
    try {
      csiTags = kind === "spec"
        ? detectCsiCodes(specBodyText(view as LegacySpecView), undefined, args.csiCtx?.config, args.csiCtx?.db)
        : detectCsiFromGrid((view as LegacyNotesView).headers, (view as LegacyNotesView).rows, args.csiCtx?.config, args.csiCtx?.db);
    } catch (err) {
      logger.warn("[regions/promote] CSI detect failed (non-fatal):", err);
    }
  }

  const legacy: Record<string, unknown> = kind === "spec" ? { ...view, csiTags } : { ...view };
  const recipe: ParseRecipe = { request, origin: "text-region" };
  const links: RegionLinks = {
    origin: "classic-engine",
    revision: previousRevision(args.previous) + 1,
    viewHash: viewHash(legacy),
    textRegionKey: textRegionKeyOf(args.textRegion.type, bbox),
    acceptedAt: args.at, // no `acceptedBy`: parsedRegions reach every page-window viewer (as commit.ts)
  };
  return { data: { ...legacy, structure: result.model, links, engine: result.stamp, recipe }, csiTags };
}

// ── Notes Auto / Spec Auto ─────────────────────────────────────────────────────────────────────

export interface AutoArgs {
  page: number;
  /** The drawn box (MinMax, as the routes receive it). */
  regionBbox: [number, number, number, number];
  textractData: TextractPageData;
  csiCtx: CsiCtx;
}

/** `/api/notes-parse` on the engine: the legacy response shape (+ `structure`, `engine`). */
export async function notesAutoOnEngine(args: AutoArgs): Promise<Record<string, unknown>> {
  const parsed = await parseParagraphBox({ page: args.page, bbox: args.regionBbox, kind: "notes", textractData: args.textractData });
  if (!parsed) return { headers: [], rows: [], csiTags: [], note: "No numbered items detected in region" };
  const { result } = parsed;
  const view = legacyView(result.model) as LegacyNotesView;
  let csiTags: { code: string; description: string }[] = [];
  try {
    csiTags = detectCsiFromGrid(view.headers, view.rows, args.csiCtx?.config, args.csiCtx?.db).map((c) => ({ code: c.code, description: c.description }));
  } catch (err) {
    logger.warn("[notes-parse] CSI detect failed (non-fatal):", err);
  }
  return {
    headers: [...view.headers],
    rows: view.rows,
    ...(view.rowBoundaries ? { rowBoundaries: view.rowBoundaries } : {}),
    csiTags,
    structure: result.model,
    engine: result.stamp,
  };
}

/** `/api/spec-parse` on the engine: the legacy response shape (+ `structure`, `engine`). */
export async function specAutoOnEngine(args: AutoArgs): Promise<Record<string, unknown>> {
  const parsed = await parseParagraphBox({ page: args.page, bbox: args.regionBbox, kind: "spec", textractData: args.textractData });
  if (!parsed) return { sections: [], csiTags: [], note: "No spec section headers detected in region" };
  const { result } = parsed;
  const model = result.model as StructureParagraphDoc;
  const view = legacyView(model) as LegacySpecView;
  let csiTags: CsiCode[] = [];
  try {
    csiTags = detectCsiCodes(specBodyText(view), { context: { pageKind: "spec" } }, args.csiCtx?.config, args.csiCtx?.db);
  } catch (err) {
    logger.warn("[spec-parse] CSI detect failed (non-fatal):", err);
  }
  return { sections: view.sections, rowBoundaries: specSectionTops(model), csiTags, structure: model, engine: result.stamp };
}
