/**
 * region-classifier-v2/classify.ts — detector-first region classifier (shadow mode).
 *
 * Port of corpus_v2 `regions_rc.py` (tables) + `regions_rc2.py` (legends / notes), re-weighted by
 * the 2026-10-24 measurement (research/regions/REPORT.md). The order of operations is the
 * inverse of BP2's text-first classifier:
 *   L1  the yolo_medium box IS the region (`tables` → table; `symbol_legend` → legend; `text_box`
 *       → notes). Anything ≥ 70 % inside a detected title block is dropped (51 % of detector
 *       tables; 12/12 referee-checked drops were right): the page-zones title block (the best
 *       detection, or the fixed corner when none was detected) AND every other yolo_medium
 *       `title_block` detection — sheets often carry 2–5 (stamps, agency boxes), and the Python
 *       reference drops against all of them. The box widens toward yolo_primitive
 *       grid / vertical_area / horizontal_area boxes (≥ 30 % cover, ≤ 2× per side) and a
 *       STRUCTURE score says how table-like / legend-like the box is from detector signals only.
 *   L2  OCR words + CSI codes inside the box are scored against the editable class rows
 *       (src/data/region-classes.v2.json); below the bar → `unclassified`.
 *
 * Structure score (v0, hand weights expressed as a logistic — the measured signal blocks only):
 *   tables  σ(−3.0 + 3.0·conf + 1.0·grid + 0.9·words + 1.1·textract + 0.75·areaCover + 0.8·tags)
 *   legend/notes σ(−2.5 + 3.0·conf + 0.75·areaCover + 0.9·shapes/6 + 1.0·[legendColumn ∨ keyShapes] + 0.6·words)
 *   grid = min(1, rows/6) · min(1, cols/3) over yolo_text boxes; words = ln(1+n)/ln(101) capped at 1.
 *   Dropped on purpose (ablation: removing them IMPROVED AUC .86 → .91 / .90): rc's `lined`
 *   (area box IoU ≥ .5) and `ct` (text_box cover); `din` (drawings containment) was inert.
 *   Weights follow the sign and rough size of the n=96 logistic fit (eval_results.json); they are
 *   NOT calibrated probabilities — that needs the ~300-box labelled set (REPORT §8).
 *
 * Pure: no DB, no I/O, no logger. Deterministic for a given input, so callers can compare with
 * the stored value and skip the write when nothing changed.
 */

import type { BboxMinMax } from "@/types";
import { computePageZones, containmentRatio, ZONE_CONTAINMENT_THRESHOLD, type PageZones } from "@/lib/page-zones";
import {
  REGION_CLASS_TABLE, REGION_CLASSES_HASH, TABLE_ROWS, TEXT_ROWS,
  type ClassFamily, type PreparedRow,
} from "./classes";
import { area, center, cover, inside, iou, inter, ltwhToMinMax, overlapSmaller, round5, textGrid, widenToward } from "./geometry";
import { fallbackClass, scoreRows, tokenize, type TokenCounts } from "./l2-score";
import {
  REGIONS_V2_VERSION, UNCLASSIFIED,
  type RegionClassifierInput, type RegionDetection, type RegionsV2, type RegionV2, type RegionV2Anchor,
  type RegionV2Kind, type RegionV2Signals,
} from "./types";

// ═══════════════════════════════════════════════════════════════════
// Vocabulary (models/classes_medium.txt, classes_primitives.txt)
// ═══════════════════════════════════════════════════════════════════

const MODEL_MEDIUM = "yolo_medium";
const MODEL_PRIMITIVE = "yolo_primitive";
const MODEL_TEXT = "yolo_text";
const AREA_CLASSES = new Set(["grid", "vertical_area", "horizontal_area"]);
/** regions_rc.py TAGSHAPES — shape tags a schedule carries (door tags, keynote bubbles). */
const TAG_SHAPES = new Set(["circle", "hexagon", "diamond", "square", "triangle", "arch_sheet_circle", "oval", "pill"]);
/** regions_rc2.py SHAPES / KEY — legend rows and keynote keys. */
const LEGEND_SHAPES = new Set([...TAG_SHAPES, "rectangle", "dot_small_circle"]);
const KEY_SHAPES = new Set(["circle", "hexagon", "diamond", "arch_sheet_circle"]);

const ANCHOR_CLASSES: Record<string, RegionV2Anchor> = { tables: "tables", symbol_legend: "symbol_legend", text_box: "text_box" };

/** IoU at or above which two kept regions are the same box (regions_rc.py l1_page). */
export const DUPLICATE_IOU = 0.6;
/** A text box this far inside a kept legend is part of the legend (regions_rc2.py). */
const FOLD_INTO_LEGEND = 0.8;
/** A text box overlapping a kept table by this much (overlap / smaller) is table text. */
const TABLE_TEXT_OVERLAP = 0.5;

// ═══════════════════════════════════════════════════════════════════
// Structure score
// ═══════════════════════════════════════════════════════════════════

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const wordsTerm = (n: number): number => Math.min(1, Math.log1p(n) / Math.log(101));

export function tableStructureScore(s: RegionV2Signals): number {
  const grid = Math.min(1, s.textRows / 6) * Math.min(1, s.textCols / 3);
  const logit = -3.0 + 3.0 * s.detConf + 1.0 * grid + 0.9 * wordsTerm(s.words) + 1.1 * s.textractTable
    + 0.75 * s.areaCover + 0.8 * Math.min(1, s.tagShapes / 5);
  return Math.round(sigmoid(logit) * 1000) / 1000;
}

export function textStructureScore(s: RegionV2Signals): number {
  const logit = -2.5 + 3.0 * s.detConf + 0.75 * s.areaCover + 0.9 * Math.min(1, s.shapes / 6)
    + (s.legendColumn || s.keyShapes ? 1.0 : 0) + 0.6 * wordsTerm(s.words);
  return Math.round(sigmoid(logit) * 1000) / 1000;
}

// ═══════════════════════════════════════════════════════════════════
// Page context
// ═══════════════════════════════════════════════════════════════════

interface Mark { bbox: BboxMinMax; c: [number, number] }
interface Word extends Mark { text: string }

interface PageContext {
  zones: PageZones;
  /** The zone title block plus every other yolo_medium `title_block` detection. */
  titleBlocks: BboxMinMax[];
  areas: Array<{ label: string; bbox: BboxMinMax }>;
  textBoxes: BboxMinMax[];
  tagCentres: [number, number][];
  shapeCentres: Array<{ label: string; c: [number, number] }>;
  words: Word[];
  csi: Array<Mark & { division: string }>;
  textractTables: BboxMinMax[];
  titleBlockText: string;
  sheetCounts: Map<string, number>;
}

const toBbox = (d: RegionDetection): BboxMinMax | null => {
  const b: BboxMinMax = [d.minX, d.minY, d.maxX, d.maxY];
  if (!b.every((n) => typeof n === "number" && Number.isFinite(n)) || b[2] <= b[0] || b[3] <= b[1]) return null;
  return b;
};

function buildContext(input: RegionClassifierInput): PageContext {
  const zones = input.zones ?? computePageZones(input.detections);
  const ctx: PageContext = {
    zones, titleBlocks: zones.titleBlock ? [zones.titleBlock] : [], areas: [], textBoxes: [], tagCentres: [], shapeCentres: [],
    words: [], csi: [], textractTables: [], titleBlockText: "", sheetCounts: new Map(),
  };
  const perModel = new Map<string, number>();
  for (const d of input.detections) {
    const bbox = toBbox(d);
    if (!bbox) continue;
    const key = `${d.modelName ?? ""}\u0000${d.name}`;
    perModel.set(key, (perModel.get(key) ?? 0) + 1);
    if (d.modelName === MODEL_MEDIUM && d.name === "title_block") {
      if (!ctx.titleBlocks.some((tb) => tb.every((v, i) => v === bbox[i]))) ctx.titleBlocks.push(bbox);
    } else if (d.modelName === MODEL_PRIMITIVE) {
      if (AREA_CLASSES.has(d.name)) ctx.areas.push({ label: d.name, bbox });
      const c = center(bbox);
      if (TAG_SHAPES.has(d.name)) ctx.tagCentres.push(c);
      if (LEGEND_SHAPES.has(d.name)) ctx.shapeCentres.push({ label: d.name, c });
    } else if (d.modelName === MODEL_TEXT) {
      ctx.textBoxes.push(bbox);
    }
  }
  for (const [key, n] of perModel) {
    const label = key.slice(key.indexOf("\u0000") + 1);
    ctx.sheetCounts.set(label, Math.max(ctx.sheetCounts.get(label) ?? 0, n));
  }
  const tbWords: string[] = [];
  for (const w of input.textractData?.words ?? []) {
    if (!w?.bbox || typeof w.text !== "string") continue;
    const bbox = ltwhToMinMax(w.bbox);
    const c = center(bbox);
    ctx.words.push({ bbox, c, text: w.text });
    if (ctx.titleBlocks.some((tb) => inside(c, tb))) tbWords.push(w.text.toUpperCase());
  }
  ctx.titleBlockText = tbWords.join(" ");
  for (const code of input.csiCodes ?? []) {
    const division = (code.division || code.code || "").slice(0, 2);
    for (const t of code.triggers ?? []) {
      if (!t?.bbox) continue;
      const bbox = ltwhToMinMax(t.bbox);
      ctx.csi.push({ bbox, c: center(bbox), division });
    }
  }
  for (const t of input.textractData?.tables ?? []) {
    if (t?.bbox) ctx.textractTables.push(ltwhToMinMax(t.bbox));
  }
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════
// L1 candidates
// ═══════════════════════════════════════════════════════════════════

interface Candidate {
  anchor: RegionV2Anchor;
  T: BboxMinMax;
  S: BboxMinMax;
  signals: RegionV2Signals;
  structure: number;
  evidence: string[];
}

const label = (k: string): string => k.replace(/_/g, " ");
const listCounts = (m: Record<string, number>): string =>
  Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${label(k)} ${v}`).join(", ");

function candidate(anchor: RegionV2Anchor, det: RegionDetection, T: BboxMinMax, ctx: PageContext): Candidate {
  const conf = det.confidence ?? 0;
  const widened = widenToward(T, ctx.areas);
  const S = widened.bbox;
  const ca = cover(T, ctx.areas.filter((a) => inter(T, a.bbox) > 0).map((a) => a.bbox));
  const grid = textGrid(ctx.textBoxes.filter((b) => inside(center(b), S)));
  const wordsIn = ctx.words.filter((w) => inside(w.c, S));
  const csiIn = ctx.csi.filter((m) => inside(m.c, S));
  const tx = ctx.textractTables.reduce((best, b) => Math.max(best, overlapSmaller(S, b)), 0);
  const ntag = ctx.tagCentres.filter((c) => inside(c, S)).length;
  const shapesIn = ctx.shapeCentres.filter((s) => inside(s.c, S));
  const nkey = shapesIn.filter((s) => KEY_SHAPES.has(s.label)).length;
  const nleft = shapesIn.filter((s) => s.c[0] <= S[0] + 0.3 * (S[2] - S[0])).length;
  const tokens = tokenize(wordsIn.map((w) => w.text));
  const signals: RegionV2Signals = {
    detConf: Math.round(conf * 1000) / 1000,
    areaCover: Math.round(ca * 1000) / 1000,
    textLines: grid.lines, textRows: grid.rows, textCols: grid.cols,
    words: wordsIn.length,
    textractTable: Math.round(tx * 1000) / 1000,
    tagShapes: ntag,
    shapes: shapesIn.length,
    legendColumn: nleft >= 3 && nleft >= 0.5 * shapesIn.length,
    keyShapes: nkey >= 2,
    scheduleWord: tokens.has("SCHEDULE") || tokens.has("SCHED"),
    csiCodes: csiIn.length,
  };
  const isTable = anchor === "tables";
  const ev = [`detector ${isTable ? "table box" : anchor === "symbol_legend" ? "symbol legend" : "text box"} (conf ${conf.toFixed(2)})`];
  if (Object.keys(widened.support).length) ev.push(`area boxes over it: ${listCounts(widened.support)} (cover ${Math.round(ca * 100)}%)`);
  if (Object.keys(widened.grown).length) ev.push(`box widened toward ${listCounts(widened.grown)}`);
  if (isTable) {
    if (ntag) ev.push(`${ntag} shape tags inside`);
    if (grid.lines) ev.push(`yolo_text: ${grid.lines} text lines, ${grid.rows} rows × ${grid.cols} aligned columns${grid.rows >= 3 && grid.cols >= 2 ? " (text grid)" : ""}`);
    if (tx > 0) ev.push(`Textract table coincides (${Math.round(tx * 100)}%)`);
  } else {
    if (shapesIn.length) ev.push(`${shapesIn.length} shape marks inside`);
    if (signals.legendColumn) ev.push(`legend column: ${nleft} shapes in the left 30 %`);
    if (signals.keyShapes) ev.push(`key shapes: ${nkey} circle / hexagon / diamond`);
  }
  ev.push(`${wordsIn.length} OCR words${csiIn.length ? `, ${csiIn.length} CSI codes` : ""}`);
  return { anchor, T, S, signals, structure: isTable ? tableStructureScore(signals) : textStructureScore(signals), evidence: ev };
}

// ═══════════════════════════════════════════════════════════════════
// L2 naming
// ═══════════════════════════════════════════════════════════════════

interface Named { className: string; nameScore: number; raw: RegionV2["nameRaw"]; evidence: string[]; drop?: "label" | "table-text" }

function name(cand: Candidate, ctx: PageContext, family: ClassFamily, rows: readonly PreparedRow[], keptTables: readonly Candidate[]): Named {
  const wordsIn = ctx.words.filter((w) => inside(w.c, cand.S));
  const tokens: TokenCounts = tokenize(wordsIn.map((w) => w.text));
  const text = ` ${wordsIn.map((w) => w.text.toUpperCase()).join(" ")} `;
  const csiDivisions = ctx.csi.filter((m) => inside(m.c, cand.S)).map((m) => m.division);
  const isTable = cand.anchor === "tables";
  const l2 = scoreRows(
    { tokens, text, csiDivisions, titleBlockText: ctx.titleBlockText, sheetCounts: ctx.sheetCounts, tagShapes: isTable ? cand.signals.tagShapes : undefined },
    family, rows,
  );
  const raw = { best: l2.best.cls, score: l2.best.score, second: l2.second, hits: l2.best.hits };
  const evidence: string[] = [];
  if (l2.cls) {
    evidence.push(`named "${l2.cls}" from ${l2.best.hits.slice(0, 5).join(", ")}${l2.best.priors.length ? `; ${l2.best.priors.join("; ")}` : ""}`);
    return { className: l2.cls, nameScore: l2.m, raw, evidence };
  }
  if (isTable) {
    evidence.push(l2.scheduleWord ? "SCHEDULE inside, but no class row cleared the bar" : "no class row cleared the bar");
    return { className: UNCLASSIFIED, nameScore: l2.m, raw, evidence };
  }
  if (cand.anchor === "text_box") {
    const fb = fallbackClass(family.fallback, {
      tokens, wordCount: wordsIn.length, csiCount: csiDivisions.length,
      overlapsTable: keptTables.some((t) => overlapSmaller(cand.S, t.S) >= TABLE_TEXT_OVERLAP),
    });
    if (fb) {
      evidence.push(fb.evidence);
      const rule = family.fallback?.rules.find((r) => r.name === fb.name);
      if (rule?.if_rebuilt_table) return { className: fb.name, nameScore: l2.m, raw, evidence, drop: "table-text" };
      if (family.fallback?.labelClasses?.includes(fb.name)) return { className: fb.name, nameScore: l2.m, raw, evidence, drop: "label" };
      return { className: fb.name, nameScore: l2.m, raw, evidence };
    }
  }
  evidence.push("no class row cleared the bar");
  return { className: UNCLASSIFIED, nameScore: l2.m, raw, evidence };
}

function kindOf(anchor: RegionV2Anchor, className: string): RegionV2Kind {
  if (anchor === "tables") return "table";
  if (className === "keynotes") return "keynotes";
  if (anchor === "symbol_legend" || className === "symbol legend") return "legend";
  return "notes";
}

function regionId(pageNumber: number, anchor: RegionV2Anchor, T: BboxMinMax): string {
  const s = `${pageNumber}:${anchor}:${T.map(round5).join(",")}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `rv2-${h.toString(16).padStart(8, "0")}`;
}

// ═══════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════

export function classifyRegionsV2(input: RegionClassifierInput): RegionsV2 {
  const ctx = buildContext(input);
  const stats = { rawTables: 0, rawLegends: 0, rawTextBoxes: 0, inTitleBlock: 0, labelsDropped: 0, merged: 0 };
  const tables: Candidate[] = [];
  const texts: Candidate[] = [];
  for (const d of input.detections) {
    const anchor = ANCHOR_CLASSES[d.name];
    if (!anchor || d.modelName !== MODEL_MEDIUM) continue;
    const T = toBbox(d);
    if (!T || area(T) <= 0) continue;
    if (anchor === "tables") stats.rawTables++; else if (anchor === "symbol_legend") stats.rawLegends++; else stats.rawTextBoxes++;
    if (ctx.titleBlocks.some((tb) => containmentRatio(T, tb) >= ZONE_CONTAINMENT_THRESHOLD)) { stats.inTitleBlock++; continue; }
    (anchor === "tables" ? tables : texts).push(candidate(anchor, d, T, ctx));
  }

  // Tables: strongest first, IoU ≥ .6 duplicates collapse (regions_rc.py).
  tables.sort((a, b) => b.structure - a.structure);
  const keptTables: Candidate[] = [];
  for (const c of tables) {
    if (keptTables.some((k) => iou(c.S, k.S) >= DUPLICATE_IOU)) { stats.merged++; continue; }
    keptTables.push(c);
  }
  // Legends first, then text boxes by structure; duplicates collapse; a text box ≥ 80 % inside a
  // kept legend folds into it (regions_rc2.py).
  texts.sort((a, b) => (a.anchor === "symbol_legend" ? 0 : 1) - (b.anchor === "symbol_legend" ? 0 : 1) || b.structure - a.structure);
  const keptTexts: Candidate[] = [];
  for (const c of texts) {
    if (keptTexts.some((k) => iou(c.S, k.S) >= DUPLICATE_IOU)) { stats.merged++; continue; }
    const legend = keptTexts.find((k) => k.anchor === "symbol_legend" && inter(c.S, k.S) >= FOLD_INTO_LEGEND * area(c.S));
    if (c.anchor === "text_box" && legend) { legend.evidence.push("text box folded in"); stats.merged++; continue; }
    keptTexts.push(c);
  }

  const regions: RegionV2[] = [];
  const emit = (c: Candidate, n: Named) => {
    regions.push({
      id: regionId(input.pageNumber, c.anchor, c.T),
      kind: kindOf(c.anchor, n.className),
      anchor: c.anchor,
      bbox: c.S.map(round5) as BboxMinMax,
      anchorBbox: c.T.map(round5) as BboxMinMax,
      structureScore: c.structure,
      className: n.className,
      nameScore: n.nameScore,
      nameRaw: n.raw,
      signals: c.signals,
      evidence: [...c.evidence, ...n.evidence],
      modelVersion: REGIONS_V2_VERSION,
    });
  };
  for (const c of keptTables) emit(c, name(c, ctx, REGION_CLASS_TABLE.tables, TABLE_ROWS, keptTables));
  for (const c of keptTexts) {
    const n = name(c, ctx, REGION_CLASS_TABLE.text, TEXT_ROWS, keptTables);
    if (n.drop === "label") { stats.labelsDropped++; continue; }
    if (n.drop === "table-text") { stats.merged++; continue; }
    emit(c, n);
  }
  return { version: REGIONS_V2_VERSION, classesHash: REGION_CLASSES_HASH, regions, stats };
}

/** Type guard for a stored `pageIntelligence.regionsV2` value (jsonb, so shape is not guaranteed). */
export function isRegionsV2(value: unknown): value is RegionsV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === "string" && typeof v.classesHash === "string" && Array.isArray(v.regions)
    && v.regions.every((r) => r && typeof r === "object" && Array.isArray((r as RegionV2).bbox) && typeof (r as RegionV2).kind === "string")
    && !!v.stats && typeof v.stats === "object";
}

/** The regions persisted on a page by the post-YOLO step / intelligence reprocess, or undefined. */
export function storedRegionsV2(pageIntelligence: unknown): RegionsV2 | undefined {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return undefined;
  const stored = (pageIntelligence as Record<string, unknown>).regionsV2;
  return isRegionsV2(stored) ? stored : undefined;
}
