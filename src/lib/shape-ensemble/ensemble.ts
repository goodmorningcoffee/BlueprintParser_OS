// [tag-mapping v2 / shape ensemble 2026-10-24] Fuse one page's yolo_primitive tag shapes with its
// classical OpenCV shape-parse results into ONE list — see ./types.ts for the measured basis.
//
// Rules (research/shapes/REPORT.md §8, each one measured):
//   1. YOLO tag classes are the primary source; arches and the spatial classes never enter.
//   2. A classical shape that overlaps a YOLO shape (IoU ≥ .3, one-to-one greedy) is the same
//      shape: YOLO's label wins, confidence ≥ .85, and the crop read becomes the text.
//   3. Classical-only shapes are the small-shape recall arm: kept only below ≈ 70 page px with a
//      glyph read inside, never inside a detected table / title block (83 % of its false
//      positives are cells). Stacked half-circles are first merged into one divided bubble.
//   4. Text: per-crop OCR first, Textract (words centred inside) as the validator — agreement
//      raises confidence; disagreement prefers the tag-like read, else the crop read.
//   5. A textless YOLO-only shape needs conf ≥ .5 and a class other than square / rectangle.
//   6. Shapes inside a detected legend are legend keys, not plan tags; shapes whose text holds a
//      project sheet number beside a detail number are detail callouts ("3 over R-3", owner rule 1).
// Pure: no DB, no I/O.

import type { BboxMinMax, TextractWord } from "@/types";
import { bboxIoU, bboxCenterMinMax, bboxContainsPoint } from "@/lib/bbox-utils";
import { findWordsInBbox, sortWordsReadingOrder } from "@/lib/ocr-utils";
import { zoneOf, type PageZones, type ZoneKind } from "@/lib/page-zones";
import { isTagLike, normalizeTagText, sameRead, sheetKey, sheetKeySet } from "./text-rules";
import type {
  EnsembleClassicalInput,
  EnsembleShape,
  EnsembleYoloInput,
  ShapeEnsembleConfig,
  ShapeEnsembleDrops,
  ShapeEnsembleResult,
  ShapeKind,
  ShapeTextSource,
} from "./types";

/** yolo_primitive classes that are tag bubbles (research §8 rule 1; AutoQtoTab's picker list + the
 *  divided detail bubble and the small dot). */
export const TAG_SHAPE_CLASSES: ReadonlySet<string> = new Set([
  "circle", "arch_sheet_circle", "dot_small_circle",
  "hexagon", "hex_pill",
  "diamond", "triangle",
  "pill", "oval",
  "rectangle", "square",
]);

/** Classical labels, as scripts/extract_keynotes.py emits them, mapped to the YOLO vocabulary. */
const CLASSICAL_CLASS: Record<string, string> = {
  circle: "circle", square: "square", rectangle: "rectangle", diamond: "diamond",
  triangle: "triangle", hexagon: "hexagon", pentagon: "pentagon", oval: "oval", pill: "pill",
  "half-circle": "half-circle",
};

export const DEFAULT_SHAPE_ENSEMBLE_CONFIG: ShapeEnsembleConfig = {
  matchIou: 0.3,
  classicalMaxLongSide: 70 / 10800,
  textlessMinConfidence: 0.5,
  textlessDroppedClasses: ["square", "rectangle"],
  bothConfidence: 0.85,
  agreeBonus: 0.05,
  classicalOnlyConfidence: 0.5,
};

export interface ShapeEnsembleInput {
  yolo: readonly EnsembleYoloInput[];
  classical: readonly EnsembleClassicalInput[];
  /** `pages.textractData.words` — the validator read. */
  words?: readonly TextractWord[] | null;
  /** Detector zones (page-zones.ts). Absent → no table / title-block drop, zone "notes". */
  zones?: PageZones | null;
  /** Extra table boxes (regionsV2 table regions) — a shape centred inside is a cell, dropped. */
  tableBoxes?: readonly BboxMinMax[] | null;
  /** The project's drawing numbers, for detail-callout recognition. */
  sheetNumbers?: readonly (string | null | undefined)[] | null;
}

interface Classical extends EnsembleClassicalInput {
  cls: string;
  index: number;
}

const longSideOf = (b: BboxMinMax): number => Math.max(b[2] - b[0], b[3] - b[1]);
const union = (a: BboxMinMax, b: BboxMinMax): BboxMinMax => [
  Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]),
];

/**
 * Two stacked half-circles (classical reports the upper and lower halves of a divided detail
 * bubble separately) become one `arch_sheet_circle` whose text is "top bottom".
 */
export function mergeHalfBubbles(classical: readonly EnsembleClassicalInput[]): Classical[] {
  const out: Classical[] = [];
  const used = new Set<number>();
  const halves = classical.map((c, i) => ({ c, i })).filter(({ c }) => c.shape === "half-circle");
  for (const { c: top, i } of halves) {
    if (used.has(i)) continue;
    const w = top.bbox[2] - top.bbox[0];
    const cx = (top.bbox[0] + top.bbox[2]) / 2;
    let best: { c: EnsembleClassicalInput; i: number } | null = null;
    for (const cand of halves) {
      if (cand.i === i || used.has(cand.i)) continue;
      const b = cand.c.bbox;
      const sameColumn = Math.abs((b[0] + b[2]) / 2 - cx) <= w * 0.25;
      const touching = Math.abs(b[1] - top.bbox[3]) <= w * 0.15 && b[1] >= top.bbox[1];
      if (sameColumn && touching) { best = cand; break; }
    }
    if (best) {
      used.add(i); used.add(best.i);
      const text = [top.text, best.c.text].map((t) => t.trim()).filter(Boolean).join(" ");
      out.push({ shape: "arch_sheet_circle", text, bbox: union(top.bbox, best.c.bbox), annotationId: top.annotationId, cls: "arch_sheet_circle", index: i });
    }
  }
  classical.forEach((c, i) => {
    if (used.has(i)) return;
    out.push({ ...c, cls: CLASSICAL_CLASS[c.shape] ?? c.shape, index: i });
  });
  return out;
}

/**
 * Textract words centred inside `bbox` that this shape OWNS: a word whose centre is nearer another
 * candidate shape's centre belongs to that shape (two touching bubbles "A1" "D1" — a wide YOLO box
 * must not read its neighbour's glyphs; seen in the corpus spot check).
 */
function textractInside(words: readonly TextractWord[] | null | undefined, bbox: BboxMinMax, allBoxes: readonly BboxMinMax[]): string | null {
  if (!words || words.length === 0) return null;
  const inside = findWordsInBbox(words as TextractWord[], bbox);
  if (inside.length === 0) return null;
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const owned = inside.filter((w) => {
    const wx = w.bbox[0] + w.bbox[2] / 2;
    const wy = w.bbox[1] + w.bbox[3] / 2;
    const mine = Math.hypot(wx - cx, wy - cy);
    // A competitor is a DISTINCT shape (IoU < matchIou): a matched pair or a half-bubble inside a
    // divided bubble is the same shape and never steals its own glyphs.
    return !allBoxes.some((o) => o !== bbox && bboxIoU(o, bbox) < 0.3 && bboxContainsPoint(o, { x: wx, y: wy })
      && Math.hypot(wx - (o[0] + o[2]) / 2, wy - (o[1] + o[3]) / 2) < mine);
  });
  if (owned.length === 0) return null;
  const text = normalizeTagText(sortWordsReadingOrder(owned).map((w) => w.text).join(" "));
  return text || null;
}

const SCALE_WORD = /^SCALE:?$|^N\.?T\.?S\.?$|^\d+\/\d+"?$|^\d+'-?\d*"?$|^=$/;

/**
 * Owner rule 1: a detail TITLE is a number in a bubble with the view name and a scale to its right
 * ("12  ADMIN SUITE  1/4" = 1'-0""). Detected when the bubble holds a bare number and a scale
 * fragment (SCALE, N.T.S., 1/4", =, 1'-0") sits within 8 long-sides to the right, on the bubble's
 * line or the line below it.
 */
export function isDetailTitle(text: string | null, bbox: BboxMinMax, words: readonly TextractWord[] | null | undefined): boolean {
  if (!text || !/^[A-Z]?\d{1,3}$/.test(text) || !words || words.length === 0) return false;
  const long = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  const x0 = bbox[2];
  const x1 = bbox[2] + 8 * long;
  const y0 = bbox[1] - 0.5 * long;
  const y1 = bbox[3] + 1.5 * long;
  let scale = 0;
  for (const w of words) {
    const wx = w.bbox[0] + w.bbox[2] / 2;
    const wy = w.bbox[1] + w.bbox[3] / 2;
    if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
    const t = w.text.toUpperCase().replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
    if (t === "SCALE" || t === "SCALE:" || /^N\.?T\.?S\.?$/.test(t)) return true;
    if (SCALE_WORD.test(t)) scale++;
  }
  return scale >= 2;
}

/** Rule 4: crop first, Textract validates. Returns the chosen text and where it came from. */
export function fuseInnerText(cropText: string | null, textractText: string | null): { text: string | null; source: ShapeTextSource | null; agree: boolean } {
  const crop = cropText ? normalizeTagText(cropText) || null : null;
  const ocr = textractText ? normalizeTagText(textractText) || null : null;
  if (crop && ocr) {
    const pick = isTagLike(ocr) && !isTagLike(crop) ? ocr : crop;
    if (sameRead(crop, ocr)) return { text: pick, source: "both-agree", agree: true };
    return { text: pick, source: "both-disagree", agree: false };
  }
  if (crop) return { text: crop, source: "crop", agree: false };
  if (ocr) return { text: ocr, source: "textract", agree: false };
  return { text: null, source: null, agree: false };
}

/** Rule 6: "<detail> <sheet>" where <sheet> is a project drawing number (or an arch_sheet_circle with two tokens). */
export function detailCalloutOf(text: string | null, cls: string, sheets: ReadonlySet<string>): { detail: string; sheet: string } | null {
  if (!text) return null;
  const tokens = text.split(/[\s/]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const sheetIdx = tokens.findIndex((t) => { const k = sheetKey(t); return k != null && sheets.has(k); });
  if (sheetIdx >= 0) {
    const detail = tokens.filter((_, i) => i !== sheetIdx).join(" ");
    return { detail, sheet: tokens[sheetIdx] };
  }
  if (cls === "arch_sheet_circle" && tokens.length >= 2) {
    return { detail: tokens.slice(0, -1).join(" "), sheet: tokens[tokens.length - 1] };
  }
  return null;
}

export function buildShapeEnsemble(input: ShapeEnsembleInput, config: ShapeEnsembleConfig = DEFAULT_SHAPE_ENSEMBLE_CONFIG): ShapeEnsembleResult {
  const drops: ShapeEnsembleDrops = { inTable: 0, inTitleBlock: 0, classicalLarge: 0, classicalTextless: 0, yoloTextless: 0, notTagClass: 0 };
  const counts = { yolo: 0, classical: 0, both: 0, callouts: 0, detailTitles: 0, legendKeys: 0 };
  const sheets = sheetKeySet(input.sheetNumbers ?? undefined);
  const tableBoxes = input.tableBoxes ?? [];
  const yolo: EnsembleYoloInput[] = [];
  for (const d of input.yolo) {
    if (!TAG_SHAPE_CLASSES.has(d.name)) { drops.notTagClass++; continue; }
    if (d.bbox[2] <= d.bbox[0] || d.bbox[3] <= d.bbox[1]) continue;
    yolo.push(d);
  }
  const classical = mergeHalfBubbles(input.classical);

  // Rule 2: one-to-one greedy IoU match, best pairs first.
  const pairs: Array<{ y: number; c: number; iou: number }> = [];
  for (let y = 0; y < yolo.length; y++) {
    for (let c = 0; c < classical.length; c++) {
      const iou = bboxIoU(yolo[y].bbox, classical[c].bbox);
      if (iou >= config.matchIou) pairs.push({ y, c, iou });
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);
  const yoloMatch = new Map<number, number>();
  const classicalMatch = new Map<number, number>();
  for (const p of pairs) {
    if (yoloMatch.has(p.y) || classicalMatch.has(p.c)) continue;
    yoloMatch.set(p.y, p.c);
    classicalMatch.set(p.c, p.y);
  }

  const allBoxes: BboxMinMax[] = [...yolo.map((d) => d.bbox), ...classical.map((c) => c.bbox)];

  const zoneFor = (bbox: BboxMinMax): ZoneKind => {
    const centre = bboxCenterMinMax(bbox);
    if (tableBoxes.some((t) => bboxContainsPoint(t, centre))) return "table";
    return input.zones ? zoneOf(input.zones, bbox) : "notes";
  };

  const shapes: EnsembleShape[] = [];
  const emit = (shape: Omit<EnsembleShape, "zone" | "kind" | "callout" | "longSide" | "id"> & { id: string }): void => {
    const zone = zoneFor(shape.bbox);
    if (zone === "title_block") { drops.inTitleBlock++; return; }
    if (zone === "table") { drops.inTable++; return; }
    let kind: ShapeKind = zone === "legend" ? "legend_key" : "tag";
    const callout = kind === "tag" ? detailCalloutOf(shape.text, shape.cls, sheets) : null;
    if (callout) kind = "detail_callout";
    else if (kind === "tag" && isDetailTitle(shape.text, shape.bbox, input.words)) kind = "detail_title";
    if (kind === "detail_callout") counts.callouts++;
    if (kind === "detail_title") counts.detailTitles++;
    if (kind === "legend_key") counts.legendKeys++;
    counts[shape.source]++;
    shapes.push({ ...shape, zone, kind, longSide: longSideOf(shape.bbox), ...(callout ? { callout } : {}) });
  };

  for (let y = 0; y < yolo.length; y++) {
    const d = yolo[y];
    const c = yoloMatch.has(y) ? classical[yoloMatch.get(y)!] : null;
    const textractText = textractInside(input.words, d.bbox, allBoxes);
    const fused = fuseInnerText(c?.text ?? null, textractText);
    let confidence = c ? Math.max(d.confidence, config.bothConfidence) : d.confidence;
    if (fused.agree) confidence = Math.min(1, confidence + config.agreeBonus);
    if (!c && !fused.text && (d.confidence < config.textlessMinConfidence || config.textlessDroppedClasses.includes(d.name))) {
      drops.yoloTextless++;
      continue;
    }
    const yId = d.annotationId ?? y;
    emit({
      id: c ? `y${yId}+c${c.annotationId ?? c.index}` : `y${yId}`,
      bbox: d.bbox, cls: d.name, source: c ? "both" : "yolo", confidence: Math.round(confidence * 100) / 100,
      text: fused.text, textSource: fused.source, cropText: c?.text ? normalizeTagText(c.text) || null : null, textractText,
      yoloAnnotationId: d.annotationId ?? null, classicalAnnotationId: c?.annotationId ?? null,
      modelName: d.modelName ?? null,
    });
  }

  for (let ci = 0; ci < classical.length; ci++) {
    if (classicalMatch.has(ci)) continue;
    const c = classical[ci];
    if (longSideOf(c.bbox) >= config.classicalMaxLongSide) { drops.classicalLarge++; continue; }
    const textractText = textractInside(input.words, c.bbox, allBoxes);
    const fused = fuseInnerText(c.text, textractText);
    if (!fused.text) { drops.classicalTextless++; continue; }
    const confidence = fused.agree ? config.classicalOnlyConfidence + config.agreeBonus : config.classicalOnlyConfidence;
    emit({
      id: `c${c.annotationId ?? c.index}`,
      bbox: c.bbox, cls: c.cls, source: "classical", confidence: Math.round(confidence * 100) / 100,
      text: fused.text, textSource: fused.source, cropText: normalizeTagText(c.text) || null, textractText,
      yoloAnnotationId: null, classicalAnnotationId: c.annotationId ?? null,
      modelName: null,
    });
  }

  shapes.sort((a, b) => b.confidence - a.confidence || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  return { shapes, drops, counts };
}
