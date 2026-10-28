/**
 * parse-engine/rows/shape-centres.ts — shape-centre rows, v1 (table pipeline WP-2.C; PLAN §1.4 R3; K13, C2-m4).
 *
 * Pure and deterministic (E-7). Two jobs, both over a column of tag shapes (a bubble, hexagon or box per row):
 *
 * 1. ROW BANDS (R3, K13). `midpointBands`: row i spans [mid(c[i-1], c[i]), mid(c[i], c[i+1])), where c is the
 *    shape-bbox centre, so a description vertically centred on its shape stays in its own row. The legacy rule
 *    cut each row at its shape's TOP edge, which pushed the upper line of every centred row into the row above
 *    and made the first row's upper line the "header" (C02-F2, measured), and ended the last row half a pitch
 *    below its shape, which dropped the trailing lines of a tall last row (C08-F7).
 *    - The first band starts at `opts.top` (the header bottom, when a caller knows it), else half the first
 *      centre gap above the first centre (never below the first shape's top edge), inside the box.
 *    - The last band ends at the bottom of the last row's contiguous run of lines inside the box (walked down
 *      from the last centre; it stops at a centre-to-centre step over 1.5x the median line pitch, so a footnote
 *      under a legend stays out [WP-2.C fix round, MED-2]), and never above half the last centre gap below the
 *      last centre (nor above the last shape's bottom edge), inside the box.
 *    Bands are returned in the INPUT order of the shapes; they are computed on the shapes sorted by centre,
 *    so the bands never overlap or invert whatever order the caller holds.
 *
 *    `shapeRowBands` (what the legacy callers use) adds one guard the plan did not have [WP-2.C deviation]:
 *    a keynote legend whose bubble sits beside the FIRST line of a wrapped note (top-aligned) is geometrically
 *    the same picture as a centred one when the line spacing is uniform, and the midpoint rule moves each
 *    note's last line into the next note (the legacy top-edge rule was right there; synthetic fixture
 *    `syn-notes-keynote-bubbles`). So the column's alignment is chosen ONCE from the description lines (the
 *    words right of the shapes): each rule's cuts are scored by the white space at the cut (in line heights)
 *    plus how short the line just above the cut is (a paragraph's last line is ragged). `top` (cut at each
 *    shape's top edge, as before) is taken only when it scores higher; any tie, or no difference in where the
 *    lines fall, keeps the midpoint rule. The last-band rule above applies to both.
 *
 * 2. ROW KEYS. A row's key is the text of the words whose centre lies inside the shape (line-aware), else the
 *    shape's own crop read (the classical shape-parse arm), flagged `key-from-crop`. The classical crop read
 *    drops `.` and `/`, so a crop key is checked against its siblings' format (the keys read inside other
 *    shapes): `34` among `3.1`, `3.2`, `3.3` is restored to `3.4` and flagged `key-repaired` (C2-m4). A crop key
 *    that already fits, that no single sibling format explains, or whose repair a sibling already holds (keys are
 *    unique), is kept as read.
 *
 * Callers: `classifier-engine/shape-column.ts` `rowBands` (the proposals' tag map) and
 * `lib/services/table-rows-shapes.ts` (the "shape-rows" table-parse method) delegate here; the TP-3 engine's
 * `shape-centres` method reuses these functions. Out of scope for v1 (TP-3 fusion, R4–R6): snapping to Textract
 * or ruling boundaries, section rows, anchors for missing shapes, header detection.
 *
 * Imports: `../lines` (line-aware text), `../geometry`, and the tag-format signature from
 * `tag-mapping/primitives/pattern-infer` (pure; type-only imports beyond it).
 *
 * ── v2 (table pipeline WP-3.A; PLAN §1.4 R2–R6) ─────────────────────────────────────────────────────────────
 * `shapeCentreRows` is the engine's `shape-centres` METHOD over the FUSED shape column (`../shapes.ts`, R10)
 * plus the R6 anchor centres (`./anchor-prior.ts`): the v1 bands (R3, with the alignment guard) over shapes
 * and anchors together, the header bottom as the first band's top when a caller knows it, **section rows**
 * (R5: a line between two shapes with no key that a LAYOUT `SECTION_HEADER` / one-cell Textract row covers,
 * or an all-caps line spanning ≥ 50 % of the box that starts at the tag column) cut out as their own bands, and the row keys (v1 readers;
 * an anchor row takes its stored tag, flagged `anchor`). R4 (veto with the key-text exception) and the R5
 * snapping happen in `../fuse.ts`, because they compare these bands with the other methods' boundaries.
 * v1's exports are unchanged; the legacy callers (`rowBands`, `table-rows-shapes.ts`) stay on them.
 */

import { centreIn } from "../geometry";
import { assembleText, wordsToLines, type LineWord } from "../lines";
import { inferTagPattern, tagSignature } from "@/lib/tag-mapping/primitives/pattern-infer";
import type { RowKey } from "../types";
import type { FusedRow, FusedShapeColumn, RowHypothesis, RowsInput, RowsLine } from "../types-rows";
import type { AnchorCentre } from "./anchor-prior";

type Box = readonly [number, number, number, number];
type Band = [number, number, number, number];

/** How a column's rows sit on their shapes: centred on the shape (R3 midpoints) or starting at its top edge. */
export type BandAlign = "centre" | "top";

export interface MidpointBandOptions {
  /** Top of the first band (the header bottom), when the caller knows it. Clamped into the box. */
  top?: number;
}

export interface ShapeRowBandOptions extends MidpointBandOptions {
  /** Default "auto": chosen from the description lines (see the file header). */
  align?: BandAlign | "auto";
}

const yc = (b: Box): number => (b[1] + b[3]) / 2;
const heightOf = (b: Box): number => b[3] - b[1];

interface Ordered { i: number; c: number; b: Box }

/** The shapes sorted by centre (ties: input order). */
const ordered = (shapeBoxes: readonly Box[]): Ordered[] =>
  shapeBoxes.map((b, i) => ({ i, c: yc(b), b })).sort((a, b) => a.c - b.c || a.i - b.i);

/** The inner cuts (between consecutive shapes) of one rule. */
function innerCuts(order: readonly Ordered[], align: BandAlign): number[] {
  return order.slice(1).map((o, k) => (align === "centre" ? (order[k].c + o.c) / 2 : o.b[1]));
}

/** Allowed centre-to-centre step inside the last row's run of lines, in median line pitches (MED-2 gap stop). */
const LAST_RUN_PITCHES = 1.5;

/**
 * The bottom of the last row's contiguous run of lines: the lines inside the box whose centre is at or below
 * `lastTop`, walked down from the last shape's centre while each line's centre is within 1.5x the median line
 * pitch (consecutive line centres inside the box, never under the median line height; `fallbackPitch` when
 * fewer than two lines) of the line before.
 * A distant word inside the box (a footnote under a legend) is past the gap and stays out of the last row.
 */
function lastRunBottom(last: Ordered, lastTop: number, box: Box, wordBoxes: readonly Box[], fallbackPitch: number): number {
  const lines = wordsToLines(wordBoxes.filter((w) => centreIn(w, box)).map((b) => ({ t: "", b })))
    .map((l) => l.b)
    .sort((p, q) => yc(p) - yc(q));
  const steps = lines.slice(1).map((l, k) => yc(l) - yc(lines[k])).sort((a, b) => a - b);
  const hs = lines.map(heightOf).sort((a, b) => a - b);
  // Lines do not overlap, so the pitch is never under the median line height (offset columns split a line).
  const pitch = steps.length > 0 ? Math.max(steps[Math.floor(steps.length / 2)], hs[Math.floor(hs.length / 2)]) : fallbackPitch;
  const maxStep = LAST_RUN_PITCHES * Math.max(pitch, 1e-6);
  let prev = last.c;
  let bottom = -Infinity;
  for (const l of lines) {
    if (yc(l) < lastTop) continue;
    if (yc(l) - prev > maxStep) break;
    prev = Math.max(prev, yc(l));
    bottom = Math.max(bottom, l[3]);
  }
  return bottom;
}

function bandsFor(order: readonly Ordered[], box: Box, wordBoxes: readonly Box[], align: BandAlign, opts: MidpointBandOptions): Band[] {
  const n = order.length;
  const clampY = (y: number): number => Math.min(box[3], Math.max(box[1], y));
  const first = order[0];
  const last = order[n - 1];
  const firstGap = n > 1 ? order[1].c - first.c : heightOf(first.b);
  const lastGap = n > 1 ? last.c - order[n - 2].c : heightOf(last.b);

  const edges: number[] = new Array(n + 1);
  edges[0] = clampY(opts.top ?? (align === "centre" ? Math.min(first.c - 0.5 * firstGap, first.b[1]) : first.b[1]));
  innerCuts(order, align).forEach((y, k) => { edges[k + 1] = clampY(y); });
  edges[n] = clampY(Math.max(last.c + 0.5 * lastGap, last.b[3], lastRunBottom(last, edges[n - 1], box, wordBoxes, lastGap)));
  // Monotone edges: a clamp, a tall shape after a short one, or an `opts.top` below the first cut never inverts a band.
  for (let k = 1; k <= n; k++) edges[k] = Math.max(edges[k], edges[k - 1]);

  const out: Band[] = new Array(n);
  order.forEach((o, k) => { out[o.i] = [box[0], edges[k], box[2], edges[k + 1]]; });
  return out;
}

/**
 * Midpoint row bands (R3) for shapes in one column of `box`. `wordBoxes` (MinMax) extend the last band down
 * through the last row's contiguous lines inside the box (gap stop: `lastRunBottom`); omit them to end it half a centre gap below the last centre. Each band
 * spans the box's full width. Half-open by convention: a word belongs to band i when
 * `band[1] <= its y-centre < band[3]`.
 */
export function midpointBands(shapeBoxes: readonly Box[], box: Box, wordBoxes: readonly Box[] = [], opts: MidpointBandOptions = {}): Band[] {
  if (shapeBoxes.length === 0) return [];
  return bandsFor(ordered(shapeBoxes), box, wordBoxes, "centre", opts);
}

/**
 * The alignment of a column (see the file header): "top" only when the top-edge cuts score strictly higher
 * than the midpoint cuts on the description lines (words inside the box, right of every shape).
 */
export function shapeBandAlignment(shapeBoxes: readonly Box[], box: Box, wordBoxes: readonly Box[]): BandAlign {
  if (shapeBoxes.length < 2) return "centre";
  const order = ordered(shapeBoxes);
  const colRight = Math.max(...shapeBoxes.map((b) => b[2]));
  const desc = wordBoxes.filter((w) => centreIn(w, box) && (w[0] + w[2]) / 2 > colRight);
  const lines = wordsToLines(desc.map((b) => ({ t: "", b }))).map((l) => l.b).sort((p, q) => yc(p) - yc(q));
  if (lines.length < 2) return "centre";
  const hs = lines.map(heightOf).sort((a, b) => a - b);
  const h = Math.max(hs[Math.floor(hs.length / 2)], 1e-6);
  const left = Math.min(...lines.map((l) => l[0]));
  const right = Math.max(...lines.map((l) => l[2]));
  const width = Math.max(right - left, 1e-6);
  const above = (y: number): number => lines.filter((l) => yc(l) < y).length;

  const mid = innerCuts(order, "centre");
  const top = innerCuts(order, "top");
  if (mid.every((y, k) => above(y) === above(top[k]))) return "centre";
  const score = (cuts: readonly number[]): number => cuts.reduce((sum, y) => {
    const k = above(y);
    if (k === 0 || k === lines.length) return sum;
    const a = lines[k - 1];
    const b = lines[k];
    return sum + Math.max(0, b[1] - a[3]) / h + (right - a[2]) / width;
  }, 0);
  return score(top) > score(mid) + 1e-9 ? "top" : "centre";
}

/** Row bands as the legacy callers use them: `midpointBands`, unless the column is top-aligned (`shapeBandAlignment`). */
export function shapeRowBands(shapeBoxes: readonly Box[], box: Box, wordBoxes: readonly Box[] = [], opts: ShapeRowBandOptions = {}): { bands: Band[]; align: BandAlign } {
  if (shapeBoxes.length === 0) return { bands: [], align: "centre" };
  const align = opts.align && opts.align !== "auto" ? opts.align : shapeBandAlignment(shapeBoxes, box, wordBoxes);
  return { bands: bandsFor(ordered(shapeBoxes), box, wordBoxes, align, opts), align };
}

/** Index of the band holding y (half-open, as `midpointBands` documents), or -1. */
export function bandIndexOf(y: number, bands: readonly Box[]): number {
  for (let i = 0; i < bands.length; i++) if (y >= bands[i][1] && y < bands[i][3]) return i;
  return -1;
}

// ─── Row keys ──────────────────────────────────────────────────────────────────────────────────────────────

export type ShapeKeyFlag = "key-from-crop" | "key-repaired";

export interface ShapeKey {
  /** The row key, or null when the shape holds no word and has no crop read. */
  key: string | null;
  /** Where the key came from. */
  src: "inside" | "crop" | null;
  flags: ShapeKeyFlag[];
}

/** A shape as the key reader needs it: its MinMax box and the classical arm's crop read, when it has one. */
export interface KeyShape {
  bbox: Box;
  text?: string | null;
}

const clean = (t: string): string => t.replace(/\s+/g, " ").trim();
/** Separators a classical crop read loses (C2-m4). */
const CROP_DROPPED = /[./]/;

/** Insert the dropped separators of signature `sig` into `bare` (whose signature is `sig` without them); null if they do not line up. */
function withSeparators(bare: string, sig: string): string | null {
  let out = "";
  let k = 0;
  for (const ch of sig) {
    if (CROP_DROPPED.test(ch)) out += ch;
    else if (k < bare.length) out += bare[k++];
    else return null;
  }
  return k === bare.length ? out : null;
}

/**
 * Restore the separators a crop read dropped, from the sibling keys' formats. Returns the repaired key, or
 * null when the crop key already fits, has a separator of its own, or no single sibling format explains it
 * with a key that no sibling already holds.
 */
export function repairCropKey(crop: string, siblings: readonly string[]): string | null {
  const key = clean(crop).toUpperCase();
  if (!key || CROP_DROPPED.test(key)) return null;
  const sibs = siblings.map((s) => clean(s).toUpperCase()).filter(Boolean);
  if (sibs.length < 2) return null;
  const held = new Set(sibs);
  const pattern = inferTagPattern(sibs);
  if (pattern?.pattern.test(key)) return null;
  const counts = new Map<string, number>();
  for (const s of sibs) counts.set(tagSignature(s), (counts.get(tagSignature(s)) ?? 0) + 1);
  const keySig = tagSignature(key);
  const candidates = [...counts]
    .filter(([sig]) => CROP_DROPPED.test(sig) && sig.replace(/[./]/g, "") === keySig)
    .map(([sig, count]) => ({ cand: withSeparators(key, sig), count }))
    .filter((c): c is { cand: string; count: number } => c.cand !== null && (!pattern || pattern.pattern.test(c.cand)))
    .sort((a, b) => b.count - a.count || (a.cand < b.cand ? -1 : a.cand > b.cand ? 1 : 0));
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[1].count === candidates[0].count && candidates[1].cand !== candidates[0].cand) return null;
  // A key a sibling already holds is never the repair: schedule keys are unique [fix round, LOW-1].
  return held.has(candidates[0].cand) ? null : candidates[0].cand;
}

/**
 * The key of every shape (input order): the words inside it (line-aware), else its crop read flagged
 * `key-from-crop`, repaired against the inside-read siblings when it lost a separator (`key-repaired`).
 */
export function readShapeKeys(shapes: readonly KeyShape[], words: readonly LineWord[]): ShapeKey[] {
  const inside = shapes.map((s) => clean(assembleText(words.filter((w) => centreIn(w.b, s.bbox)))));
  const siblings = inside.filter(Boolean);
  return shapes.map((s, i) => {
    if (inside[i]) return { key: inside[i], src: "inside", flags: [] };
    const crop = clean(s.text ?? "");
    if (!crop) return { key: null, src: null, flags: [] };
    const repaired = repairCropKey(crop, siblings);
    return repaired
      ? { key: repaired, src: "crop", flags: ["key-from-crop", "key-repaired"] }
      : { key: crop, src: "crop", flags: ["key-from-crop"] };
  });
}

// ─── v2: the engine method (R2–R6) ──────────────────────────────────────────────────────────────────────────

export const SHAPE_CENTRES_VERSION = 2;
/** R5: a key-less all-caps line between two shapes is a section row when it spans this share of the box width. */
export const SECTION_MIN_WIDTH_SHARE = 0.5;
/** R5: a section title is short; a line with more words is a description (MEASURED on the classifier corpus: titles 2–6 words, descriptions 10–24). */
export const SECTION_MAX_WORDS = 6;
/** A section band is padded by this many `h` on each side (never past the neighbouring shapes). */
const SECTION_PAD_H = 0.25;

/** One centre the bands are built on: a live fused shape or an R6 anchor. */
export interface ShapeCentre {
  b: Box;
  cls: string;
  origin: "shape" | "anchor";
  key: ShapeKey;
}

export interface ShapeCentreRowsOptions {
  /** The header bottom (Textract `hdr` rows, a LAYOUT title, a hint); the first band starts there. */
  headerBottom?: number | null;
  /** Section bands other methods know (`RowHypothesis.sections` of textract-cells / layout). */
  knownSections?: readonly (readonly [number, number])[];
}

export interface ShapeCentreRows {
  hypothesis: RowHypothesis;
  centres: ShapeCentre[];
  /** Body rows (one per centre) and section rows, in y order; header/footer rows are added by `fuse.ts`. */
  rows: FusedRow[];
  align: BandAlign;
  /** Column x-range (the tag column) for the R4 key-text test. */
  tagX: [number, number];
  sectionCount: number;
}

const lineYc = (l: RowsLine): number => (l.b[1] + l.b[3]) / 2;
const isAllCaps = (t: string): boolean => /[A-Z]/.test(t) && t === t.toUpperCase();

/**
 * R5 section lines between consecutive centres `a` (above) and `b` (below): a line whose centre lies below
 * `a`'s shape and above `b`'s, with no word inside the tag column, that a known section band covers (LAYOUT
 * `SECTION_HEADER`, a one-cell Textract row), or — in a CENTRE-aligned column only — that is all caps, spans
 * ≥ 50 % of the box width, starts at or left of the tag column's right edge and has ≤ 6 words. The guards on the
 * all-caps clause come from a geometry-only probe over the classifier corpus (WP-3.A A/B): all-caps is the default
 * typography on drawings, so without them the clause cut 123 "sections" out of the labelled tag-map candidates —
 * wrapped descriptions under their bubble in top-aligned legends (K27), description continuation lines starting in
 * the description column, and long note lines. Adjacent qualifying lines (gap < h) merge into one band.
 */
function sectionBandsBetween(a: Box, b: Box, input: RowsInput, tagX: [number, number], known: readonly (readonly [number, number])[], align: BandAlign): [number, number][] {
  const out: [number, number][] = [];
  const minW = SECTION_MIN_WIDTH_SHARE * (input.box[2] - input.box[0]);
  const lines = input.lines.filter((l) => lineYc(l) > a[3] && lineYc(l) < b[1]).sort((p, q) => lineYc(p) - lineYc(q));
  for (const l of lines) {
    const hasKey = l.wordIdx.some((i) => { const w = input.words[i]; const cx = (w.b[0] + w.b[2]) / 2; return cx >= tagX[0] && cx <= tagX[1]; });
    if (hasKey) continue;
    const covered = known.some(([y0, y1]) => lineYc(l) >= y0 && lineYc(l) <= y1);
    const caps = align === "centre" && isAllCaps(l.text) && l.b[2] - l.b[0] >= minW && l.b[0] <= tagX[1] && l.wordIdx.length <= SECTION_MAX_WORDS;
    if (!covered && !caps) continue;
    const prev = out[out.length - 1];
    if (prev && l.b[1] - prev[1] < input.h) prev[1] = Math.max(prev[1], l.b[3]);
    else out.push([l.b[1], l.b[3]]);
  }
  return out;
}

/** The row key of a centre as the model stores it. */
function rowKeyOf(c: ShapeCentre): RowKey {
  return { kind: "shape-text", text: c.key.key, shapeClass: c.cls, shapeBbox: [c.b[0], c.b[1], c.b[2], c.b[3]], textSource: c.key.src === "crop" ? "crop" : "inside" };
}

/**
 * The engine's `shape-centres` method (v2): bands over the fused column's shapes plus the anchor centres,
 * section rows cut out between shapes, keys read per centre. `null` when there is no centre.
 */
export function shapeCentreRows(input: RowsInput, col: FusedShapeColumn, anchors: readonly AnchorCentre[], opts: ShapeCentreRowsOptions = {}): ShapeCentreRows | null {
  const lineWords: LineWord[] = input.words.map((w) => ({ t: w.t, b: w.b }));
  const shapeKeys = readShapeKeys(col.shapes.map((s) => ({ bbox: s.b, text: s.text })), lineWords);
  const centres: ShapeCentre[] = col.shapes.map((s, i) => ({ b: s.b, cls: s.cls, origin: "shape", key: shapeKeys[i] }));
  for (const a of anchors) {
    const t = clean(a.tag ?? "");
    centres.push({ b: a.b, cls: a.shapeClass, origin: "anchor", key: t ? { key: t, src: "inside", flags: [] } : { key: null, src: null, flags: [] } });
  }
  if (centres.length === 0) return null;
  centres.sort((p, q) => yc(p.b) - yc(q.b) || p.b[0] - q.b[0]);
  const box = input.box;
  const tagX: [number, number] = [Math.min(col.x0, ...centres.map((c) => c.b[0])), Math.max(col.x1, ...centres.map((c) => c.b[2]))];
  // The first band starts at the header bottom (R3) — unless the header bottom lies ABOVE the first centre's natural
  // band top (half the first gap above it): then rows without a live shape sit between the header and the first shape,
  // and `fuse.ts` reads them from the other methods (MEASURED on the private G-TAB gold: detectors miss the first rows).
  const c0 = yc(centres[0].b);
  const naturalTop = centres.length > 1 ? Math.min(c0 - 0.5 * (yc(centres[1].b) - c0), centres[0].b[1]) : centres[0].b[1];
  const top = opts.headerBottom != null ? Math.max(opts.headerBottom, naturalTop) : undefined;
  const { bands, align } = shapeRowBands(centres.map((c) => c.b), box, input.words.map((w) => w.b), { top });

  // R5 section rows between consecutive centres; the bands above and below are cut at the section's edges.
  const rows: FusedRow[] = [];
  const edges: number[] = [];
  let sectionCount = 0;
  for (let i = 0; i < centres.length; i++) {
    const c = centres[i];
    const band = bands[i];
    const flags = [...c.key.flags, ...(c.origin === "anchor" ? ["anchor"] : [])];
    const row: FusedRow = { y0: band[1], y1: band[3], role: "body", key: rowKeyOf(c), flags };
    rows.push(row);
    if (i + 1 < centres.length) {
      const sections = sectionBandsBetween(c.b, centres[i + 1].b, input, tagX, opts.knownSections ?? [], align);
      let prevBottom = row.y1;
      for (const [sy0, sy1] of sections) {
        const pad = Math.min(SECTION_PAD_H * input.h, Math.max(0, (sy0 - c.b[3]) / 2), Math.max(0, (centres[i + 1].b[1] - sy1) / 2));
        const y0 = Math.max(rows[rows.length - 1].y0, sy0 - pad);
        const y1 = Math.min(bands[i + 1][3], sy1 + pad);
        rows[rows.length - 1].y1 = Math.max(rows[rows.length - 1].y0, Math.min(rows[rows.length - 1].y1, y0));
        rows.push({ y0, y1, role: "section", flags: [] });
        prevBottom = y1;
        sectionCount++;
      }
      // the band below starts where the last section ends (never above its own bottom)
      if (sections.length > 0) bands[i + 1] = [bands[i + 1][0], Math.max(bands[i + 1][1], prevBottom), bands[i + 1][2], Math.max(bands[i + 1][3], prevBottom)];
    }
  }
  // Monotone, then the boundary list.
  for (let k = 1; k < rows.length; k++) { rows[k].y0 = Math.max(rows[k].y0, rows[k - 1].y1); rows[k].y1 = Math.max(rows[k].y1, rows[k].y0); }
  edges.push(rows[0].y0);
  for (const r of rows) edges.push(r.y1);
  const regular = col.gapCv === null || col.gapCv <= 0.5;
  const hypothesis: RowHypothesis = {
    method: "shape-centres",
    methodVersion: SHAPE_CENTRES_VERSION,
    conf: regular ? 0.9 : 0.7,
    rowLines: edges,
    sections: rows.filter((r) => r.role === "section").map((r) => [r.y0, r.y1] as [number, number]),
    rowAnchors: centres.map((c) => ({ y: yc(c.b), key: rowKeyOf(c) })),
  };
  return { hypothesis, centres, rows, align, tagX, sectionCount };
}
