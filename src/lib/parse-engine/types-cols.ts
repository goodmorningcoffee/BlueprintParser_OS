/**
 * Column / cell / header / tag-column types (table pipeline WP-3.B; PLAN §1.4 R7, R9, R12; §2.1).
 *
 * A SIBLING of `./types.ts` (PLAN §1.6 rule 13: only WP-3.D edits the contract files). Pure types plus
 * a few constants; client-safe (E-8) — it imports only `./types` and types from `./cells` / `./headers`.
 *
 * Line convention (every column method, `cells.ts`, `headers.ts`): an axis of n bands is described by
 * n + 1 sorted line positions, BOTH outer edges included (the legacy `colBoundaries` / `rowBoundaries`
 * shape that `ParseRegionLayer` draws). Band k spans `[lines[k], lines[k + 1])`; the last band is closed
 * on its far edge, so a word centred exactly on the box edge still lands in it.
 */

import type { BboxMinMax, Hypothesis, MethodId, StructureTitle } from "./types";
import type { CellSpan, ColWord, MethodWords } from "./cells";
import type { HeaderLabel, HeaderPick, HeaderSource } from "./headers";

// Defined next to the client-safe code that uses them (so `cells.ts` / `headers.ts` import only the E-8
// subset), re-exported here so every WP-3.B type has one home.
export type { CellSpan, ColWord, HeaderLabel, HeaderPick, HeaderSource, MethodWords };

/** The methods that propose COLUMN lines (§1.4 table). */
export type ColumnMethodId = Extract<MethodId, "x-starts" | "textract-cells" | "rulings" | "primitive-grid">;

/** A column method's proposal: geometry only (E-1). On failure `colLines` is empty and `error` says why (R1: no vote). */
export interface ColumnHypothesis extends Hypothesis {
  method: ColumnMethodId;
  colLines: number[];
}

/**
 * `x-starts` modes.
 * - `legacy`: byte parity with ocr-positions' left-edge column finder (`lib/services/table-parse.ts`
 *   `methodOcrPositions`): every word's left edge, a fixed page-normalised gap of .015.
 * - `table-relative`: cell-start words only, gap `max(.003, .013 × W)` with W the width of the box's
 *   text (the LabelFactory port), columns placed in the white-space gutter.
 */
export type XStartsMode = "legacy" | "table-relative";

/** Where a tag column pick came from (R9 order: user ≻ shape ≻ header ≻ body). */
export type TagColumnSource = "user" | "shape" | "header" | "body";

/** R9 result: the tag column of a table model (index into its columns). */
export interface TagColumnPick {
  col: number;
  src: TagColumnSource;
  shapeClass?: string;
  /** `inferTagPattern` regex source over the column's body values, when one exists. */
  pattern?: string;
  /** Share of the column's non-empty body values that read as tags, 0..1 (3 dp). */
  score: number;
  scope: "sheet" | "project";
}

/** Server title band (`server/services/parse-engine/title.ts`). */
export interface TitlePick {
  title?: StructureTitle;
  /** Bottom of the in-box title line, when the title was read from the box's own header band (else null). */
  titleBottom: number | null;
}

/** Crop rulings as `detect_table_lines.py --crop` reports them: positions normalised to the CROP. */
export interface CropRulings {
  rows: number[];
  cols: number[];
  confidence: number;
  /** The crop the script actually cut (whole pixels), normalised to the page; positions map through it. */
  crop?: BboxMinMax;
  error?: string;
}
