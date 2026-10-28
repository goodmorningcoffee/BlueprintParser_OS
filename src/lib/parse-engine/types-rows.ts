/**
 * Row-stage sibling types (table pipeline WP-3.A; PLAN §1.4 R1–R8, R10–R12, §1.6 rule 13).
 *
 * `types.ts` is owned by WP-2.E and only WP-3.D edits it, so the row methods, the fused shape set and the
 * fusion step declare their shapes here. Everything is a plain data type; the only runtime values are the
 * R8 initial weights, which `profile.ts` (WP-3.D) may override through `FuseRowsOptions.weights`.
 *
 * Imports only `./types` (type-only), so this module is as pure as the contract it extends.
 */

import type { BboxMinMax, EnginePageEvidence, EngineShape, Hypothesis, MethodId, RowKey, RowRole } from "./types";

/** A word as the row stage reads it: the engine word (MinMax box, 0–1 confidence, line id). */
export type RowsWord = EnginePageEvidence["words"][number];

/** A visual line inside the box (from `lines.wordsToLines`): text, box and the indices into the box words. */
export interface RowsLine { text: string; b: BboxMinMax; wordIdx: number[] }

/**
 * The slice of one page's evidence a row method reads for one box. Built once by `fuse.ts` (`rowsInputFor`)
 * from an `EnginePageEvidence` and a request box, so every method sees the same words, lines and `h`.
 */
export interface RowsInput {
  /** The request box (MinMax, normalised). */
  box: BboxMinMax;
  /** Page words whose centre lies inside the box (closed edges), in page order. */
  words: RowsWord[];
  /** Visual lines of those words, top to bottom (line-aware reading order). */
  lines: RowsLine[];
  /** Median visual line height inside the box (`h` in the §1.4 rules); `DEFAULT_LINE_HEIGHT` when no line. */
  h: number;
  textractTables: EnginePageEvidence["textractTables"];
  layout: EnginePageEvidence["layout"] | undefined;
  /** The page's raw tag shapes (both sources, undeduped); `shapes.ts` fuses them (R10). */
  shapes: EngineShape[];
  primitives: EnginePageEvidence["primitives"];
  proposals: EnginePageEvidence["proposals"];
  hints?: { proposalId?: string; headerRows?: number; tagCol?: number };
}

/** A row hypothesis: the contract's geometry plus the row-only extras the fusion step reads (sibling fields). */
export interface RowHypothesis extends Hypothesis {
  /** Row boundaries, n + 1 for n rows, sorted, inside the box. Absent or empty when the method cast no vote. */
  rowLines?: number[];
  /** Bands a method knows to be section rows (LAYOUT `section-header`, a one-cell Textract row): `[y0, y1]`. */
  sections?: [number, number][];
  /** The bottom of the header band, when the method knows it (Textract `hdr` rows, a LAYOUT title). */
  headerBottom?: number;
}

/** One fused tag shape (R10): yolo ∪ classical, IoU .5 dedupe, in-table shapes kept. */
export interface FusedShape {
  b: BboxMinMax;
  cls: string;
  /** The source whose box was kept: always yolo for a yolo/classical double (it carries the live box); classical only when yolo did not see it. */
  src: "yolo" | "classical";
  /** Both sources saw this shape (the dropped twin's crop read is folded into `text` when the kept one had none). */
  both: boolean;
  text: string | null;
  textSrc: "inside" | "crop" | null;
}

/** The column of fused shapes that anchors the rows (R2 regime input). */
export interface FusedShapeColumn {
  shapes: FusedShape[];           // top to bottom
  shapeClass: string;             // majority class
  /** Horizontal extent of the column: the tag column's x-range for the R4 key-text test. */
  x0: number; x1: number;
  pitch: number | null;           // median centre gap (null below 2 shapes)
  gapCv: number | null;           // coefficient of variation of the gaps (null below 3 shapes)
}

/** One fused row before cells exist. `key` is set only in the shape regime (R3) or from an anchor (R6). */
export interface FusedRow {
  y0: number; y1: number;
  role: RowRole;
  key?: RowKey;
  /** Per-row flags (`shape-missing`, `key-from-crop`, `key-repaired`, `anchor`). */
  flags: string[];
  part?: number;
}

/** R12: one method's own geometry beside the fused rows (the client's pin-source preview). */
export interface RowAlternative {
  method: MethodId;
  rows: number;
  /** Boundary agreement with the fused rows (symmetric F1 at 0.35 h; 1 = identical). */
  agreement: number;
  conf: number;
  rowLines: number[];
}

export type RowRegime = "shape" | "cluster";

export interface FusedRows {
  regime: RowRegime;
  rows: FusedRow[];
  /** n + 1 boundaries for n rows (the first is the top of row 0, the last the bottom of the last row). */
  rowLines: number[];
  headerRows: number;
  /** Every method that was asked, in METHOD order; a failed one carries `error` and no `rowLines`. */
  hypotheses: RowHypothesis[];
  /** The methods whose boundaries survived into the fused rows. */
  sources: MethodId[];
  alternatives: RowAlternative[];
  /** The shape column the shape regime used (also the tag column for WP-3.B), when R2 held. */
  shapeColumn?: FusedShapeColumn;
  /** Model-level flags (§1.4 R12): `rows-disagree`, `shape-missing`, `section-rows:n`, `key-from-crop`, `truncated`, … */
  flags: string[];
  /** Median visual line height used for every length in the rules. */
  h: number;
}

/** R8 initial row weights (`profile.ts` may refit them, WP-3.Q; never on the sets it is scored on). */
export const DEFAULT_ROW_WEIGHTS: Readonly<Partial<Record<MethodId, number>>> = Object.freeze({
  "textract-cells": 1.0,
  rulings: 1.0,
  "hanging-indent": 0.6,
  "primitive-grid": 0.6,
  "ocr-lines": 0.5,
  layout: 0.4,
  img2table: 0.7,
  tatr: 0.8,
});

/** Fallback `h` when a box holds no visual line (a typical schedule line on a normalised sheet). */
export const DEFAULT_LINE_HEIGHT = 0.008;

/** The methods WP-3.A runs on stored evidence (instant budget), in the order their hypotheses are listed. */
export const ROW_METHODS: readonly MethodId[] = ["ocr-lines", "shape-centres", "textract-cells", "layout", "primitive-grid", "hanging-indent"];
