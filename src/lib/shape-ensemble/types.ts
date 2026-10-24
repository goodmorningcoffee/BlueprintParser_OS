// [tag-mapping v2 / shape ensemble 2026-10-24] Types of the per-page shape ensemble
// (src/lib/shape-ensemble/). Kept out of src/types/index.ts (zero MAX_LINES headroom); consumers
// import from "@/lib/shape-ensemble". Geometry is MinMax page fractions [minX, minY, maxX, maxY].
//
// Measured basis (research/shapes/REPORT.md, 390 corpus pages, pixel referee N=40/40/20):
//   yolo_primitive tag classes 55 % precise alone (74 % at conf ≥ .5), classical OpenCV shapes 35 %,
//   a shape BOTH detectors fired on 85 %; classical never exceeds 200 px and YOLO's floor is
//   ≈ 60-70 page px; Textract has no word inside ~44 % of real bubbles while the per-crop Tesseract
//   read (the classical arm's `text`) covers 93 %; classical false positives are schedule / title
//   block cells (28 % of classical shapes sit inside a detected table).

import type { BboxMinMax } from "@/types";
import type { ZoneKind } from "@/lib/page-zones";

/** Bump when a fusion rule or the summary shape changes; consumers ignore other versions. */
export const SHAPE_ENSEMBLE_VERSION = 1;

/** Which detector(s) produced the shape. */
export type ShapeSource = "yolo" | "classical" | "both";

/** Where the inner text came from and whether the two readers agreed. */
export type ShapeTextSource =
  | "crop"            // per-crop OCR only (classical arm); no Textract word inside
  | "textract"        // Textract word(s) inside only (YOLO arm without a crop read)
  | "both-agree"      // both present, equal or an OCR-confusion away → higher trust
  | "both-disagree";  // both present, different; `text` holds the preferred read

/** What the shape most likely is on the sheet. */
export type ShapeKind =
  | "tag"              // a tag bubble candidate (the default)
  | "detail_callout"   // number-in-circle over a sheet number: "3 over R-3" (owner rule 1)
  | "detail_title"     // number-in-circle beside a view name + scale ("12  ADMIN SUITE  1/4" = 1'-0"", owner rule 1)
  | "legend_key";      // inside a detected legend / table: a symbol-legend key, not a plan tag

/** One yolo_primitive detection as the yolo / reprocess loops already hold it. */
export interface EnsembleYoloInput {
  name: string;
  bbox: BboxMinMax;
  confidence: number;
  modelName?: string;
  /** annotations.id when known (map-tags); omitted in the post-YOLO loop. */
  annotationId?: number;
}

/** One classical shape-parse result (`pages.keynotes[]` / a source='shape-parse' row). */
export interface EnsembleClassicalInput {
  shape: string;
  /** The per-crop OCR read (Tesseract in scripts/extract_keynotes.py). */
  text: string;
  bbox: BboxMinMax;
  annotationId?: number;
}

export interface ShapeEnsembleConfig {
  /** IoU at which a classical and a YOLO box are the same shape (research §2: one-to-one greedy). */
  matchIou: number;
  /** Classical-only shapes are kept only when their long side is below this page fraction
   *  (≈ 70 px on a 10,800 px sheet — YOLO's measured floor). */
  classicalMaxLongSide: number;
  /** A textless YOLO-only shape needs at least this confidence (research §6: 74 % at ≥ .5). */
  textlessMinConfidence: number;
  /** YOLO classes whose textless detections are dropped regardless of confidence
   *  (7 of 10 textless symbol false positives were squares / rectangles). */
  textlessDroppedClasses: readonly string[];
  /** Confidence floor given to a shape both detectors found (85 % measured precision). */
  bothConfidence: number;
  /** Confidence bonus when the crop read and the Textract read agree. */
  agreeBonus: number;
  /** Confidence given to a classical-only shape that survived every gate. */
  classicalOnlyConfidence: number;
}

export interface EnsembleShape {
  /** "y<annotationId|index>" / "c<annotationId|index>" / "y…+c…" — stable within one build. */
  id: string;
  bbox: BboxMinMax;
  /** YOLO class when YOLO saw it (its label wins — 20/22 vs 10/14 referee), else the classical label. */
  cls: string;
  source: ShapeSource;
  /** Fused 0-1 confidence (see ShapeEnsembleConfig). */
  confidence: number;
  kind: ShapeKind;
  /** Preferred inner text (upper-cased, trimmed), or null when neither reader saw glyphs. */
  text: string | null;
  textSource: ShapeTextSource | null;
  cropText: string | null;
  textractText: string | null;
  zone: ZoneKind;
  /** Long side as a page fraction (max of width, height). */
  longSide: number;
  yoloAnnotationId: number | null;
  classicalAnnotationId: number | null;
  /** Set for `detail_callout`: the detail number and the sheet it lives on. */
  callout?: { detail: string; sheet: string };
}

export interface ShapeEnsembleDrops {
  /** Centre inside a detected table / title block (pageZones or a regionsV2 table). */
  inTable: number;
  inTitleBlock: number;
  /** Classical-only shape above `classicalMaxLongSide` with no YOLO match. */
  classicalLarge: number;
  /** Classical-only shape with no crop read. */
  classicalTextless: number;
  /** YOLO-only shape with no text below `textlessMinConfidence` or in a dropped class. */
  yoloTextless: number;
  /** YOLO detections outside the tag classes (arches, spatial areas, grid, …). */
  notTagClass: number;
}

export interface ShapeEnsembleResult {
  shapes: EnsembleShape[];
  drops: ShapeEnsembleDrops;
  counts: { yolo: number; classical: number; both: number; callouts: number; detailTitles: number; legendKeys: number };
}

/** Compact projection persisted as `pageIntelligence.shapes`. Short keys: a page can hold hundreds. */
export interface ShapeEnsembleSummary {
  v: typeof SHAPE_ENSEMBLE_VERSION;
  computedAt: string;
  counts: ShapeEnsembleResult["counts"];
  drops: ShapeEnsembleDrops;
  /** Highest-confidence first, capped at SHAPE_SUMMARY_CAP; `truncated` counts the rest. */
  shapes: CompactShape[];
  truncated: number;
}

export interface CompactShape {
  /** bbox */
  b: BboxMinMax;
  /** class */
  c: string;
  /** source: y | c | b */
  s: "y" | "c" | "b";
  /** confidence, 2 decimals */
  k: number;
  /** text (null when none) */
  t: string | null;
  /** text source: c crop | x textract | a agree | d disagree */
  ts: "c" | "x" | "a" | "d" | null;
  /** kind: t tag | d detail_callout | v detail_title | l legend_key */
  kd: "t" | "d" | "v" | "l";
  z: ZoneKind;
  /** callout sheet (detail_callout only) */
  sh?: string;
}
