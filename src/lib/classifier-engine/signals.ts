/**
 * classifier-engine/signals.ts — one `SignalSpec` → a value in [0, 1] plus a short evidence
 * string, read from the page / candidate evidence. Every spec type of types.ts is handled here;
 * an unknown type (a recipe from a newer build) yields 0 with a detail saying so. Pure.
 */

import type { BboxMinMax } from "@/types";
import { ZONE_CONTAINMENT_THRESHOLD, containmentRatio } from "@/lib/page-zones";
import { area, cover, inside, inter, overlapSmaller } from "@/lib/region-classifier-v2/geometry";
import { isWholeWordMatch } from "@/lib/text-match-utils";
import { migrateTextRegionType } from "@/lib/text-region-migrate";
import { columnWords, scopeText, shapesInside, type CandidateEvidence, type PageEvidence } from "./evidence";
import { bestShapeColumn, columnTextShares } from "./shape-column";
import { yoloSpatialHolds } from "./spatial";
import type { SignalSpec } from "./types";

export interface SignalValue { value: number; detail?: string }

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Python-style non-overlapping phrase count inside a " "-padded upper-case text. */
function countPhrase(text: string, phrase: string): number {
  const needle = ` ${phrase} `;
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); }
  return n;
}

/** CSI section prefix ("08 71", "0871", "08 71 00") → digits, compared on the code's digits. */
const digits = (s: string): string => s.replace(/[^0-9]/g, "");

function wordsSignal(spec: Extract<SignalSpec, { type: "words" }>, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  const band = scopeText(page, cand, spec.where);
  const saturation = spec.saturation && spec.saturation > 0 ? spec.saturation : 1;
  let sum = 0;
  const hits: string[] = [];
  for (const [term, w] of Object.entries(spec.terms)) {
    const key = term.toUpperCase().trim();
    if (!key) continue;
    const n = key.includes(" ") ? countPhrase(band.text, key) : band.tokens.get(key) ?? 0;
    if (n > 0) { sum += w * Math.sqrt(Math.min(3, n)); hits.push(n > 1 ? `${key}×${n}` : key); }
  }
  const value = r3(1 - Math.exp(-sum / saturation));
  return { value, detail: hits.length ? `${spec.where}: ${hits.slice(0, 5).join(", ")}` : undefined };
}

function csiSignal(spec: Extract<SignalSpec, { type: "csi" }>, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  const codes = spec.where === "pageCodes" ? page.pageCodes : spec.where === "page" ? page.pageCsi.map((m) => m.code) : cand.csi.codes;
  const divs = new Set((spec.divisions ?? []).map((d) => d.slice(0, 2)));
  const prefixes = (spec.sectionPrefixes ?? []).map(digits).filter(Boolean);
  const matching = codes.filter((c) => divs.has((c.division || c.code).slice(0, 2)) || prefixes.some((p) => digits(c.code).startsWith(p)));
  const minCodes = spec.minCodes ?? 1;
  const src = spec.where === "box" ? (cand.csi.source === "tagger" ? "box" : "box (page triggers)") : "page";
  if (!codes.length || codes.length < minCodes || !matching.length) return { value: 0, detail: codes.length ? `${src}: 0 of ${codes.length} codes match` : undefined };
  const what = [...(spec.divisions ?? []).map((d) => `Div ${d}`), ...(spec.sectionPrefixes ?? [])].join("/");
  if (spec.measure === "presence") return { value: 1, detail: `${src}: ${matching.length} ${what} codes` };
  if (spec.measure === "count") return { value: r3(Math.min(3, matching.length) / 3), detail: `${src}: ${matching.length} ${what} codes` };
  return { value: r3(matching.length / codes.length), detail: `${src}: ${pct(matching.length / codes.length)} of ${codes.length} codes are ${what}` };
}

function sheetSignal(spec: Extract<SignalSpec, { type: "sheet" }>, page: PageEvidence): SignalValue {
  if (!page.sheetNumber) return { value: 0 };
  if (spec.disciplines?.length && !(page.discipline && spec.disciplines.map((d) => d.toUpperCase()).includes(page.discipline))) return { value: 0, detail: `sheet ${page.discipline ?? "?"}` };
  if (spec.numberPattern) {
    let ok = false;
    try { ok = new RegExp(spec.numberPattern, "i").test(page.sheetNumber); } catch { ok = false; }
    if (!ok) return { value: 0 };
  }
  return { value: 1, detail: `sheet ${page.sheetNumber}` };
}

function yoloSignal(spec: Extract<SignalSpec, { type: "yolo" }>, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  if (!page.yoloAvailable && spec.noDetections !== undefined) return { value: clamp01(spec.noDetections), detail: "YOLO did not run" };
  const anyClass = spec.classes.includes("*");
  const classes = new Set(spec.classes);
  const S = cand.bbox;
  const w = S[2] - S[0];
  const h = S[3] - S[1];
  const near: BboxMinMax = [S[0] - w, S[1] - h, S[2] + w, S[3] + h];
  const dets = page.detections.filter((d) => (anyClass || classes.has(d.name))
    && (!spec.model || d.modelName === spec.model) && d.confidence >= (spec.minConfidence ?? 0)
    && (spec.where === "page" || (spec.where === "inside" ? inside(d.c, S) : spec.where === "near" ? inside(d.c, near) && !inside(d.c, S) : inter(d.bbox, S) > 0)));
  if (!dets.length) return { value: 0 };
  const label = `${dets.length} ${[...new Set(dets.map((d) => d.name))].join("/")} ${spec.where}`;
  switch (spec.measure) {
    case "presence": return { value: 1, detail: label };
    case "count": return { value: r3(Math.min(3, dets.length) / 3), detail: label };
    case "maxConfidence": return { value: r3(Math.max(...dets.map((d) => d.confidence))), detail: label };
    case "cover": return { value: r3(area(S) > 0 ? cover(S, dets.map((d) => d.bbox)) : 0), detail: label };
    default: return { value: 0 };
  }
}

function structureSignal(spec: Extract<SignalSpec, { type: "structure" }>, cand: CandidateEvidence): SignalValue {
  if (!cand.structure) return { value: 0, detail: "no region v2 structure" };
  const raw = cand.structure[spec.feature];
  const v = typeof raw === "boolean" ? (raw ? 1 : 0) : typeof raw === "number" ? raw : 0;
  let value: number;
  if (spec.min !== undefined || spec.max !== undefined) {
    const lo = spec.min ?? 0;
    const hi = spec.max ?? 1;
    value = hi > lo ? clamp01((v - lo) / (hi - lo)) : v >= hi ? 1 : 0;
  } else if (spec.scale) value = clamp01(v / spec.scale);
  else value = clamp01(v);
  return { value: r3(value), detail: `${spec.feature} ${typeof raw === "number" ? r3(raw) : String(raw)}` };
}

function textractSignal(spec: Extract<SignalSpec, { type: "textract-table" }>, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  const minRows = spec.minRows ?? 0;
  const best = page.textractTables.reduce((m, t) => (t.rowCount >= minRows ? Math.max(m, overlapSmaller(cand.bbox, t.bbox)) : m), 0);
  const min = spec.minContainment ?? 0.5;
  return best >= min ? { value: r3(best), detail: `Textract table coincides (${pct(best)})` } : { value: 0 };
}

/** [shape-tags] A column of tag shapes in the box's left part (shape-column.ts). */
function shapeColumnSignal(spec: Extract<SignalSpec, { type: "shape-column" }>, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  const col = bestShapeColumn(shapesInside(page, cand.bbox), cand.bbox, spec.source, { leftShare: spec.leftShare, minShapes: spec.minShapes });
  if (!col) return { value: 0 };
  const label = `${col.n} ${col.shapeClass} column (${col.source})`;
  switch (spec.measure) {
    case "count": return { value: r3(Math.min(1, col.n / 8)), detail: label };
    case "regular": {
      const ok = col.gapCv !== null && col.gapCv <= (spec.maxGapCv ?? 0.5);
      return { value: ok ? 1 : 0, detail: `${label}, gap CV ${col.gapCv === null ? "n/a" : r3(col.gapCv)}` };
    }
    case "textInside": case "textRight": {
      const shares = columnTextShares(col, columnWords(cand));
      const v = spec.measure === "textInside" ? shares.textInside : shares.textRight;
      return { value: r3(v), detail: `${label}, ${pct(v)} with text ${spec.measure === "textInside" ? "inside" : "to the right"}` };
    }
    default: return { value: 0 };
  }
}

/**
 * [table pipeline WP-3.A, PLAN §1.5] Textract containment of a box: the best intersection / smaller-area
 * overlap with any stored table of ≥ `minRows` rows (the `textract-table` signal's rule), 0 when none.
 * Exported for the engine's `textract-cells` weighting; `textractSignal` is unchanged.
 */
export function textractContainment(box: BboxMinMax, tables: readonly { bbox: BboxMinMax; rowCount: number }[], minRows = 0): number {
  return tables.reduce((m, t) => (t.rowCount >= minRows ? Math.max(m, overlapSmaller(box, t.bbox)) : m), 0);
}

/** Sorted 1-D clusters: a gap wider than `tol` starts a new one. [WP-3.A] Exported as `ocrGridClusters` (PLAN §1.5). */
function clusters1d(values: readonly number[], tol: number): number[][] {
  const out: number[][] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const cur = out[out.length - 1];
    if (cur && v - cur[cur.length - 1] <= tol) cur.push(v);
    else out.push([v]);
  }
  return out;
}

export const ocrGridClusters = clusters1d;

/** [shape-tags] The box's OCR words as a grid (region v2 geometry.textGrid's rules on word boxes). */
function ocrGridSignal(spec: Extract<SignalSpec, { type: "ocr-grid" }>, cand: CandidateEvidence): SignalValue {
  const words = cand.words;
  if (words.length < 6) return { value: 0, detail: `${words.length} words` };
  const hs = words.map((w) => w.h).sort((a, b) => a - b);
  const mh = Math.max(hs[Math.floor(hs.length / 2)], 1e-4);
  const rows = clusters1d(words.map((w) => w.c[1]), 0.6 * mh).filter((c) => c.length >= 2);
  const cols = clusters1d(words.map((w) => w.bbox[0]), 0.5 * mh).filter((c) => c.length >= 3).length;
  const label = `${rows.length} rows × ${cols} cols`;
  switch (spec.measure) {
    case "rows": return { value: r3(Math.min(1, rows.length / (spec.scale ?? 8))), detail: label };
    case "cols": return { value: r3(Math.min(1, cols / (spec.scale ?? 4))), detail: label };
    case "grid": return { value: r3(Math.min(1, (rows.length * cols) / (spec.scale ?? 24))), detail: label };
    case "regularity": {
      if (rows.length < 3) return { value: 0, detail: label };
      const centres = rows.map((c) => c.reduce((a, b) => a + b, 0) / c.length).sort((a, b) => a - b);
      const pitch = centres.slice(1).map((c, i) => c - centres[i]);
      const m = pitch.reduce((a, b) => a + b, 0) / pitch.length;
      const sd = Math.sqrt(pitch.reduce((a, p) => a + (p - m) ** 2, 0) / pitch.length);
      const v = m > 0 ? clamp01(1 - sd / m) : 0;
      return { value: r3(v), detail: `${label}, pitch CV ${r3(m > 0 ? sd / m : 0)}` };
    }
    default: return { value: 0 };
  }
}

function shapesSignal(spec: Extract<SignalSpec, { type: "shapes" }>, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  const set = new Set(spec.shapes);
  const S = cand.bbox;
  const leftEdge = S[0] + 0.3 * (S[2] - S[0]);
  const n = page.shapes.filter((s) => set.has(s.label) && inside(s.c, S) && (spec.where === "inside" || s.c[0] <= leftEdge)).length;
  const min = Math.max(1, spec.min ?? 3);
  return n ? { value: r3(Math.min(1, n / min)), detail: `${n} ${spec.shapes.join("/")} ${spec.where}` } : { value: 0 };
}

function zoneSignal(spec: Extract<SignalSpec, { type: "zone" }>, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  const min = spec.minContainment ?? ZONE_CONTAINMENT_THRESHOLD;
  const boxes = spec.zone === "titleBlock" ? page.titleBlocks : spec.zone === "drawing" ? page.zones.drawings : [];
  if (spec.zone === "margin") {
    const c = [(cand.bbox[0] + cand.bbox[2]) / 2, (cand.bbox[1] + cand.bbox[3]) / 2];
    const m = Math.min(c[0], 1 - c[0], c[1], 1 - c[1]);
    return m <= 0.05 ? { value: 1, detail: "page margin" } : { value: 0 };
  }
  const best = boxes.reduce((m, b) => Math.max(m, containmentRatio(cand.bbox, b)), 0);
  return best >= min ? { value: 1, detail: `${pct(best)} inside ${spec.zone}` } : { value: 0 };
}

function textSignal(spec: Extract<SignalSpec, { type: "text" }>, page: PageEvidence): SignalValue {
  // Empty / non-string terms never match (as in the legacy engine, so an "all" list holding one cannot pass).
  const terms = Array.isArray(spec.terms) ? spec.terms : [];
  if (!terms.length) return { value: 0 };
  const hits = terms.filter((t) => typeof t === "string" && isWholeWordMatch(page.rawText, t));
  const ok = spec.mode === "all" ? hits.length === terms.length : hits.length > 0;
  return ok ? { value: 1, detail: `page text: ${hits.slice(0, 5).join(", ")}` } : { value: 0 };
}

function textRegionSignal(spec: Extract<SignalSpec, { type: "text-region" }>, page: PageEvidence): SignalValue {
  const hit = (spec.regionTypes ?? []).map((t) => migrateTextRegionType(t) ?? t).find((t) => page.textRegionTypes.has(t));
  return hit ? { value: 1, detail: `OCR region ${hit}` } : { value: 0 };
}

export function evaluateSignal(spec: SignalSpec, cand: CandidateEvidence, page: PageEvidence): SignalValue {
  switch (spec.type) {
    case "words": return wordsSignal(spec, cand, page);
    case "csi": return csiSignal(spec, cand, page);
    case "sheet": return sheetSignal(spec, page);
    case "yolo": return yoloSignal(spec, cand, page);
    case "structure": return structureSignal(spec, cand);
    case "textract-table": return textractSignal(spec, cand, page);
    case "shape-column": return shapeColumnSignal(spec, cand, page);
    case "ocr-grid": return ocrGridSignal(spec, cand);
    case "shapes": return shapesSignal(spec, cand, page);
    case "zone": return zoneSignal(spec, cand, page);
    case "text": return textSignal(spec, page);
    case "text-region": return textRegionSignal(spec, page);
    case "yolo-spatial": return yoloSpatialHolds(spec, page.detections) ? { value: 1, detail: `${spec.classA} ${spec.operator} ${spec.classB}` } : { value: 0 };
    case "channel": return page.channelKind && spec.pageKinds.includes(page.channelKind) ? { value: 1, detail: `page kind ${page.channelKind}` } : { value: 0 };
    default: return { value: 0, detail: `unknown signal type ${(spec as { type?: string }).type ?? "?"}` };
  }
}
