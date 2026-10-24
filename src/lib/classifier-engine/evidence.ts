/**
 * classifier-engine/evidence.ts — what a recipe reads: the page's OCR words grouped into rows,
 * the sheet number and discipline, the title block, the detector zones, the page's CSI triggers,
 * and, per candidate box, the bands (header / columns / body / above) plus the CSI codes tagged
 * on the box's OWN words (PLAN "schedule-kind rule" step 1 — the page-level list is capped by
 * maxCodesPerPage and misses codes inside tables).
 *
 * Pure and client-safe: the CSI tagger is injected (`BoxTagger`; ./csi-box-tagger.ts builds the
 * real one from the v2 KB). Page evidence is built once per page and shared by every recipe and
 * candidate; box CSI tagging is cached per bbox key.
 */

import type { BboxMinMax, CsiCode, KeynoteShapeData, TextractPageData, TextractWord } from "@/types";
import type { ChannelKind } from "@/lib/pdf-channels/types";
import { computePageZones, ZONE_MODEL_PATTERN, type PageZones } from "@/lib/page-zones";
import type { RegionDetection, RegionV2Signals, RegionsV2 } from "@/lib/region-classifier-v2/types";
import { center, inside, ltwhToMinMax } from "@/lib/region-classifier-v2/geometry";
import { tokenize, type TokenCounts } from "@/lib/region-classifier-v2/l2-score";
import { extractDisciplinePrefix } from "@/lib/page-utils";
import type { CandidateSource, DerivedName, SignalScope } from "./types";
import { deriveName } from "./derive-name";
import { migrateTextRegionType } from "@/lib/text-region-migrate";

/** One CSI code as the box tagger / page triggers yield it. */
export interface CsiCodeLike { code: string; division: string }

/** Tags the words of one box; `null` result = tagger unavailable (fall back to the page's triggers). */
export type BoxTagger = (words: readonly TextractWord[], context: { discipline?: string; drawingNumber?: string }) => readonly CsiCodeLike[] | null;

export interface ClassifierPageInput {
  pageNumber: number;
  detections: readonly RegionDetection[];
  zones?: PageZones;
  textractData?: Pick<TextractPageData, "words" | "tables"> | null;
  /** `pages.csiCodes` — trigger bboxes locate the page-level codes (fallback when no tagger). */
  csiCodes?: readonly CsiCode[] | null;
  /** The page's fresh region v2 record — the "regions-v2" candidate source. */
  regionsV2?: RegionsV2 | null;
  /** User-committed regions (`pageIntelligence.parsedRegions`, LTWH bboxes) — the "parsed-regions" source. */
  parsedRegions?: ReadonlyArray<{ bbox?: readonly number[] | null }> | null;
  /** `pages.drawingNumber` — the sheet number. */
  drawingNumber?: string | null;
  /** `pageIntelligence.channels.kind` when the PDF census ran. */
  channelKind?: ChannelKind | null;
  /** `pages.keynotes` — classical shape-parse shapes (optional second source for "shapes" signals). */
  keynotes?: readonly KeynoteShapeData[] | null;
  tagger?: BoxTagger | null;
  // ── additive (2b heuristic port): optional page-level inputs of the legacy heuristic rules ──
  /** `pages.rawText` — read by "text" signals (absent → the OCR words joined). */
  rawText?: string | null;
  /** `pageIntelligence.textRegions` — read by "text-region" signals (legacy type names migrated). */
  textRegions?: ReadonlyArray<{ type?: string | null }> | null;
  /** Whether YOLO ran on this page (yolo `noDetections`). Absent → `detections.length > 0`. */
  yoloAvailable?: boolean;
}

export interface EvWord { up: string; bbox: BboxMinMax; c: [number, number]; h: number; raw: TextractWord }
export interface EvLine { words: EvWord[]; text: string; bbox: BboxMinMax; c: [number, number]; h: number }
export interface EvDetection { name: string; bbox: BboxMinMax; c: [number, number]; confidence: number; modelName: string }
export interface BandText { tokens: TokenCounts; text: string; words: EvWord[] }

export interface PageEvidence {
  pageNumber: number;
  words: EvWord[];
  /** Median OCR word height (page units); .01 when there are no words. */
  lineHeight: number;
  detections: EvDetection[];
  zones: PageZones;
  /** Detected title blocks (zone + every yolo_medium title_block), like region v2. */
  titleBlocks: BboxMinMax[];
  sheetNumber: string | null;
  discipline: string | null;
  channelKind: ChannelKind | null;
  /** CSI trigger marks on the page (centre + the code), from `pages.csiCodes`. */
  pageCsi: Array<{ c: [number, number]; code: CsiCodeLike }>;
  textractTables: BboxMinMax[];
  shapes: Array<{ label: string; c: [number, number] }>;
  scopes: { page: BandText; titleBlock: BandText; sheetTitle: BandText };
  tagger: BoxTagger | null;
  boxCsiCache: Map<string, BoxCsi>;
  // ── additive (2b) ──
  rawText: string;
  textRegionTypes: Set<string>;
  /** Every code of `pages.csiCodes` once; division = the code's first two digits (whitespace stripped). */
  pageCodes: CsiCodeLike[];
  yoloAvailable: boolean;
}

export interface BoxCsi { codes: CsiCodeLike[]; source: "tagger" | "page" }

export interface Candidate {
  source: CandidateSource["type"];
  bbox: BboxMinMax;
  anchorBbox: BboxMinMax;
  regionId?: string;
  structure?: RegionV2Signals & { structureScore: number };
  detConfidence?: number;
}

export interface CandidateEvidence extends Candidate {
  words: EvWord[];
  rows: EvLine[][];
  bands: Record<Exclude<SignalScope, "page" | "titleBlock" | "sheetTitle">, BandText>;
  derivedName?: DerivedName;
  csi: BoxCsi;
}

const ROW_TOL = 0.5;
/** Wider than csi-detect's 1.2: title words are set loose, and a split title loses its name. */
const LINE_GAP = 1.6;
/** Lines just above the box count as "above" within this many line heights. */
const ABOVE_LINES = 2.5;
/**
 * Rows within this many line heights of the FIRST row may hold the title. Measured from the first row,
 * not the box top: the detector pads the box, and on the labelled corpus the title row sat just past
 * 3 line heights from the padded top on most boxes, so the header band was empty and the title words
 * fell into the column band ([2a fix round] the header signal never fired on them).
 */
const HEADER_LINES = 3;
const COLUMN_ROWS = 2;

const bandOf = (words: readonly EvWord[]): BandText => ({
  tokens: tokenize(words.map((w) => w.up)),
  text: ` ${words.map((w) => w.up).join(" ")} `,
  words: [...words],
});

function toWord(w: TextractWord): EvWord | null {
  if (!w || typeof w.text !== "string" || !Array.isArray(w.bbox) || w.bbox.length !== 4 || !w.bbox.every((v) => Number.isFinite(v))) return null;
  const bbox = ltwhToMinMax(w.bbox);
  return { up: w.text.toUpperCase(), bbox, c: center(bbox), h: Math.max(w.bbox[3], 1e-4), raw: w };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function lineOf(ws: EvWord[]): EvLine {
  const bbox: BboxMinMax = [Math.min(...ws.map((w) => w.bbox[0])), Math.min(...ws.map((w) => w.bbox[1])), Math.max(...ws.map((w) => w.bbox[2])), Math.max(...ws.map((w) => w.bbox[3]))];
  return { words: ws, text: ws.map((w) => w.up).join(" "), bbox, c: center(bbox), h: median(ws.map((w) => w.h)) };
}

/**
 * Words → rows of line segments (top to bottom, left to right): a word joins a row when its vertical
 * centre is within half the taller height; inside a row a gap wider than LINE_GAP × the row's median
 * word height starts a new segment (so "DOOR NO | FRAME | HDWR" are three segments of one row).
 * Same rule as csi-detect's `linesFromWordsByGeometry`, kept here so this module stays client-safe.
 */
export function groupRows(words: readonly EvWord[]): EvLine[][] {
  const sorted = [...words].sort((a, b) => a.c[1] - b.c[1] || a.bbox[0] - b.bbox[0]);
  const rowsW: EvWord[][] = [];
  for (const w of sorted) {
    const row = rowsW[rowsW.length - 1];
    const ref = row?.[0];
    if (ref && Math.abs(w.c[1] - ref.c[1]) <= ROW_TOL * Math.max(w.h, ref.h)) row.push(w);
    else rowsW.push([w]);
  }
  return rowsW.map((row) => {
    row.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const mh = median(row.map((w) => w.h));
    const segs: EvWord[][] = [];
    for (const w of row) {
      const seg = segs[segs.length - 1];
      if (seg && w.bbox[0] - seg[seg.length - 1].bbox[2] <= LINE_GAP * mh) seg.push(w);
      else segs.push([w]);
    }
    return segs.map(lineOf);
  });
}

export function buildPageEvidence(input: ClassifierPageInput): PageEvidence {
  const zones = input.zones ?? computePageZones(input.detections);
  const titleBlocks: BboxMinMax[] = zones.titleBlock && zones.source === "detector" ? [zones.titleBlock] : [];
  const detections: EvDetection[] = [];
  const shapes: PageEvidence["shapes"] = [];
  for (const d of input.detections) {
    const bbox: BboxMinMax = [d.minX, d.minY, d.maxX, d.maxY];
    if (!bbox.every((v) => Number.isFinite(v)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) continue;
    const modelName = d.modelName ?? "";
    const c = center(bbox);
    detections.push({ name: d.name, bbox, c, confidence: d.confidence ?? 0, modelName });
    if (ZONE_MODEL_PATTERN.test(modelName) && d.name === "title_block" && !titleBlocks.some((t) => t.every((v, i) => v === bbox[i]))) titleBlocks.push(bbox);
    if (modelName === "yolo_primitive") shapes.push({ label: d.name, c });
  }
  for (const k of input.keynotes ?? []) {
    if (k?.shape && Array.isArray(k.bbox) && k.bbox.length === 4) shapes.push({ label: k.shape, c: center(k.bbox as BboxMinMax) });
  }
  const words: EvWord[] = [];
  for (const w of input.textractData?.words ?? []) { const ew = toWord(w); if (ew) words.push(ew); }
  const lineHeight = median(words.map((w) => w.h)) || 0.01;
  const tbWords = words.filter((w) => titleBlocks.some((t) => inside(w.c, t)));
  // The sheet title is not parsed anywhere in BP; the title block's three tallest lines stand in for it.
  const tbRows = groupRows(tbWords).flat().sort((a, b) => b.h - a.h).slice(0, 3);
  const pageCsi: PageEvidence["pageCsi"] = [];
  for (const code of input.csiCodes ?? []) {
    // [2b fix] tolerate malformed stored rows (null entry, non-array triggers): one bad code must not throw the page.
    if (!code || !Array.isArray(code.triggers)) continue;
    const division = (code.division || code.code || "").slice(0, 2);
    for (const t of code.triggers) {
      if (t?.bbox) pageCsi.push({ c: center(ltwhToMinMax(t.bbox)), code: { code: code.code, division } });
    }
  }
  const sheetNumber = typeof input.drawingNumber === "string" && input.drawingNumber.trim() ? input.drawingNumber.trim() : null;
  const discipline = sheetNumber ? extractDisciplinePrefix(sheetNumber) : null;
  return {
    pageNumber: input.pageNumber, words, lineHeight, detections, zones, titleBlocks, sheetNumber,
    discipline: discipline && discipline !== "OTHER" ? discipline : null,
    channelKind: input.channelKind ?? null, pageCsi,
    textractTables: (input.textractData?.tables ?? []).flatMap((t) => (t?.bbox ? [ltwhToMinMax(t.bbox)] : [])),
    shapes,
    scopes: { page: bandOf(words), titleBlock: bandOf(tbWords), sheetTitle: bandOf(tbRows.flatMap((l) => l.words)) },
    tagger: input.tagger ?? null,
    boxCsiCache: new Map(),
    rawText: typeof input.rawText === "string" ? input.rawText : words.map((w) => w.raw.text).join(" "),
    textRegionTypes: new Set((input.textRegions ?? []).flatMap((r) => (r && typeof r.type === "string" ? [migrateTextRegionType(r.type) ?? r.type] : []))),
    pageCodes: (input.csiCodes ?? []).flatMap((c) => (c && typeof c.code === "string" ? [{ code: c.code, division: c.code.substring(0, 2).replace(/\s/g, "") }] : [])),
    yoloAvailable: input.yoloAvailable ?? input.detections.length > 0,
  };
}

export const bboxKey = (b: BboxMinMax): string => b.map((v) => Math.round(v * 1e4) / 1e4).join(",");

/** CSI codes of the box's own words (tagger), else the page triggers whose centre lies inside. Cached per box. */
export function boxCsi(page: PageEvidence, bbox: BboxMinMax, words: readonly EvWord[]): BoxCsi {
  const key = bboxKey(bbox);
  const hit = page.boxCsiCache.get(key);
  if (hit) return hit;
  let out: BoxCsi | null = null;
  if (page.tagger && words.length) {
    const tagged = page.tagger(words.map((w) => w.raw), {
      ...(page.discipline ? { discipline: page.discipline } : {}), ...(page.sheetNumber ? { drawingNumber: page.sheetNumber } : {}),
    });
    if (tagged) out = { codes: tagged.map((c) => ({ code: c.code, division: (c.division || c.code).slice(0, 2) })), source: "tagger" };
  }
  if (!out) out = { codes: page.pageCsi.filter((m) => inside(m.c, bbox)).map((m) => m.code), source: "page" };
  page.boxCsiCache.set(key, out);
  return out;
}

/** The bands of one candidate: rows inside the box, the title row, the column-header rows, the rest, and the lines just above. */
export function buildCandidateEvidence(page: PageEvidence, cand: Candidate): CandidateEvidence {
  const S = cand.bbox;
  const words = page.words.filter((w) => inside(w.c, S));
  const rows = groupRows(words);
  const lh = median(words.map((w) => w.h)) || page.lineHeight;
  const aboveWords = page.words.filter((w) => !inside(w.c, S) && w.c[1] < S[1] && w.c[1] >= S[1] - ABOVE_LINES * lh && w.c[0] >= S[0] && w.c[0] <= S[2]);
  const aboveRows = groupRows(aboveWords);
  const firstTop = Math.max(S[1], rows[0]?.[0].bbox[1] ?? S[1]);
  const headerRows = rows.filter((r) => r[0].bbox[1] < firstTop + HEADER_LINES * lh).slice(0, 3);
  const derived = deriveName({ headerRows, aboveRows, lineHeight: lh });
  let headerIdx = -1;
  if (derived?.source === "header") headerIdx = rows.findIndex((r) => r.some((l) => l.text === derived.line) || r.map((l) => l.text).join(" ") === derived.line);
  const header = headerIdx >= 0 ? rows[headerIdx] : [];
  const columnRows = rows.slice(headerIdx + 1, headerIdx + 1 + COLUMN_ROWS);
  const bodyRows = rows.slice(headerIdx + 1 + COLUMN_ROWS);
  const flat = (rs: EvLine[][]) => rs.flat().flatMap((l) => l.words);
  const derivedName: DerivedName | undefined = derived ? { text: derived.text, confidence: derived.confidence, source: derived.source } : undefined;
  return {
    ...cand, words, rows,
    bands: { box: bandOf(words), header: bandOf(flat([header])), columns: bandOf(flat(columnRows)), body: bandOf(flat(bodyRows)), above: bandOf(flat(aboveRows)) },
    derivedName,
    csi: boxCsi(page, S, words),
  };
}

export function scopeText(page: PageEvidence, cand: CandidateEvidence, where: SignalScope): BandText {
  if (where === "page" || where === "titleBlock" || where === "sheetTitle") return page.scopes[where];
  return cand.bands[where];
}
