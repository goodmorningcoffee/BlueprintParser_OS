/**
 * parse-engine/fuse.ts — row fusion (table pipeline WP-3.A; PLAN §1.4 R1–R8, R10, R12). Pure, deterministic
 * (E-7): the same evidence and box give a byte-equal result.
 *
 * `rowsInputFor` slices one page's evidence to a box (words whose centre lies inside, their visual lines, the
 * median line height `h`). `runRowMethods` runs every instant method on stored evidence (R1: a failed method
 * records `error` and casts no vote). `fuseRows` then:
 *
 * - **R10 / R2** fuses the tag shapes (`shapes.ts`), finds the shape column and decides the regime: ≥ 3 shapes
 *   in one column covering ≥ 60 % of the body lines.
 * - **Shape regime** (R3–R6): `shapeCentreRows` builds the midpoint bands over the live shapes plus the R6
 *   anchor centres (`rows/anchor-prior.ts`), with section rows cut out (R5). Then, against every other
 *   method's boundaries: a band edge within 0.5 h of a `textract-cells` / `rulings` boundary **snaps** to it
 *   (R5); a boundary strictly inside a band (> 0.35 h from both edges) is **vetoed** (R4), unless the sub-band
 *   below it holds key text in the tag column that fits the sibling keys' pattern (`pattern-infer`), in which
 *   case the band is split there and the lower row is flagged `shape-missing`. Lines above the first band
 *   become header rows, lines below the last band footer rows (both cut per visual line).
 * - **Cluster regime** (R7): every voting method's boundaries are clustered within 0.35 h; a cluster scores
 *   `S = Σ w_m · conf_m` over distinct methods and survives when `S ≥ θ = 0.5 × Σ w_m` over the methods that
 *   ran (a weighted majority; R8 weights, overridable by `profile.ts`). Its position is the conf-weighted mean.
 *   Header rows come from `textract-cells` (`hdr`) or the request hint; known section bands label rows.
 * - **R12**: `alternatives[]` (each voting method's own geometry with an agreement score) and the flags
 *   `rows-disagree` (best non-source alternative agreement < .7), `shape-missing`, `section-rows:n`,
 *   `key-from-crop`, `truncated` (> 500 rows, stored cut).
 *
 * `fuseBoundaries` (the R7 step) is exported for WP-3.B's columns ("columns always", table-relative gap).
 * Standard/thorough hypotheses (`rulings`, `img2table`, `tatr`) arrive through `opts.extraHypotheses` from the
 * server run service (rule 11: heavy work runs before any project write, never here).
 */

import { inferTagPattern, patternAccepts, tagSignature } from "@/lib/tag-mapping/primitives/pattern-infer";
import { centreIn } from "./geometry";
import { wordsToLines } from "./lines";
import { anchorCentres } from "./rows/anchor-prior";
import { hangingIndentRows } from "./rows/hanging-indent";
import { layoutRows } from "./rows/layout";
import { ocrLinesRows, type OcrLinesMode } from "./rows/ocr-lines";
import { primitiveGridRows } from "./rows/primitive-grid";
import { midpointBands, readShapeKeys, shapeCentreRows } from "./rows/shape-centres";
import { textractCellRows } from "./rows/textract-cells";
import { fuseShapes, fusedShapeColumn, shapeRegimeHolds } from "./shapes";
import { PARSE_ENGINE_CAPS, type BboxMinMax, type EnginePageEvidence, type MethodId } from "./types";
import {
  DEFAULT_LINE_HEIGHT,
  DEFAULT_ROW_WEIGHTS,
  type FusedRow,
  type FusedRows,
  type RowAlternative,
  type RowHypothesis,
  type RowsInput,
  type RowsLine,
} from "./types-rows";

/** A key of its own when no sibling pattern can be inferred: one short mark-like token (`101`, `D-7`, `3.2`, `A`). */
export const KEY_TOKEN_RE = /^[A-Z0-9][A-Z0-9.\-\/]{0,11}$/;
/** R7 cluster tolerance and R4 veto margin, in `h`. */
export const CLUSTER_TOL_H = 0.35;
/** R5 snap distance, in `h`. */
export const SNAP_TOL_H = 0.5;
/** R12: an alternative below this agreement makes the rows "disagree". */
export const DISAGREE_BELOW = 0.7;
/** The methods a midpoint boundary snaps to (R5). */
const SNAP_METHODS: ReadonlySet<MethodId> = new Set<MethodId>(["textract-cells", "rulings"]);

export interface FuseRowsOptions {
  weights?: Readonly<Partial<Record<MethodId, number>>>;
  /** `legacy` = byte parity with ocr-positions (the `tablesRoute = legacy` path never calls fusion; this is for measurement). */
  ocrMode?: OcrLinesMode;
  /** Hypotheses from standard/thorough methods the server gathered (`rulings`, `img2table`, `tatr`). */
  extraHypotheses?: readonly RowHypothesis[];
  /** Minimum shapes for a column (default 3, also the R2 minimum). */
  minShapes?: number;
}

const yc = (b: BboxMinMax): number => (b[1] + b[3]) / 2;
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const uniqSorted = (xs: readonly number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

/** The box slice of a page's evidence every row method reads (see the file header). */
export function rowsInputFor(ev: EnginePageEvidence, box: BboxMinMax, hints?: RowsInput["hints"]): RowsInput {
  const words = ev.words.filter((w) => centreIn(w.b, box));
  const lines: RowsLine[] = wordsToLines(words.map((w) => ({ t: w.t, b: w.b }))).map((l) => ({ text: l.text, b: l.b, wordIdx: l.wordIdx }));
  const hs = lines.map((l) => l.b[3] - l.b[1]).filter((h) => h > 0);
  const h = hs.length > 0 ? median(hs) : DEFAULT_LINE_HEIGHT;
  return {
    box, words, lines, h,
    textractTables: ev.textractTables, layout: ev.layout, shapes: ev.shapes, primitives: ev.primitives, proposals: ev.proposals,
    hints,
  };
}

/** R1: every instant method on stored evidence, in `ROW_METHODS` order (`shape-centres` is added by `fuseRows`). */
export function runRowMethods(input: RowsInput, ocrMode: OcrLinesMode = "lines"): RowHypothesis[] {
  return [ocrLinesRows(input, ocrMode), textractCellRows(input), layoutRows(input), primitiveGridRows(input), hangingIndentRows(input)];
}

const votes = (h: RowHypothesis): boolean => !h.error && Array.isArray(h.rowLines) && h.rowLines.length >= 2;

export interface FusedBoundary { at: number; methods: MethodId[]; score: number }

/**
 * R7: cluster every voting hypothesis' boundaries within `tol`; a cluster scores `Σ w·conf` over distinct
 * methods (one vote per method, at its mean position in the cluster) and survives at `≥ 0.5 × Σ w` over the
 * methods that voted. Returns the survivors in position order.
 */
export function fuseBoundaries(
  hyps: readonly { method: MethodId; conf: number; lines: readonly number[] }[],
  tol: number,
  weights: Readonly<Partial<Record<MethodId, number>>> = DEFAULT_ROW_WEIGHTS,
): FusedBoundary[] {
  const w = (m: MethodId): number => weights[m] ?? 0.5;
  const voters = hyps.filter((h) => h.lines.length > 0);
  if (voters.length === 0) return [];
  const theta = 0.5 * voters.reduce((s, h) => s + w(h.method), 0);
  const cands = voters.flatMap((h) => h.lines.map((y) => ({ y, m: h.method, conf: h.conf }))).sort((a, b) => a.y - b.y || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));
  const clusters: (typeof cands)[] = [];
  let cur: typeof cands = [];
  let mean = 0;
  for (const c of cands) {
    if (cur.length > 0 && Math.abs(c.y - mean) <= tol) { cur.push(c); mean += (c.y - mean) / cur.length; }
    else { if (cur.length) clusters.push(cur); cur = [c]; mean = c.y; }
  }
  if (cur.length) clusters.push(cur);
  const out: FusedBoundary[] = [];
  for (const cl of clusters) {
    const perMethod = new Map<MethodId, { sum: number; n: number; conf: number }>();
    for (const c of cl) {
      const e = perMethod.get(c.m) ?? { sum: 0, n: 0, conf: c.conf };
      e.sum += c.y; e.n++;
      perMethod.set(c.m, e);
    }
    let score = 0, wsum = 0, pos = 0;
    const methods: MethodId[] = [];
    for (const [m, e] of [...perMethod].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const wt = w(m) * e.conf;
      score += wt; wsum += wt; pos += wt * (e.sum / e.n);
      methods.push(m);
    }
    if (score + 1e-12 >= theta && wsum > 0) out.push({ at: pos / wsum, methods, score });
  }
  return out;
}

/** Symmetric boundary F1 between two line sets at tolerance `tol` (1 = identical; 0 when either is empty). */
export function boundaryAgreement(a: readonly number[], b: readonly number[], tol: number): number {
  if (a.length === 0 || b.length === 0) return 0;
  const hit = (xs: readonly number[], ys: readonly number[]): number => xs.filter((x) => ys.some((y) => Math.abs(x - y) <= tol)).length;
  const p = hit(a, b) / a.length;
  const r = hit(b, a) / b.length;
  return p + r > 0 ? Math.round(((2 * p * r) / (p + r)) * 1000) / 1000 : 0;
}

/** Visual lines whose centre lies in `[y0, y1)` as one row per line, top to bottom, tiling exactly `[y0, y1]`. */
function rowsPerLine(lines: readonly RowsLine[], y0: number, y1: number, role: FusedRow["role"]): FusedRow[] {
  const inZone = lines.filter((l) => yc(l.b) >= y0 && yc(l.b) < y1).sort((a, b) => yc(a.b) - yc(b.b));
  const rows: FusedRow[] = [];
  inZone.forEach((l, i) => {
    const top = i === 0 ? y0 : rows[i - 1].y1;
    const cut = i === inZone.length - 1 ? y1 : Math.min(y1, Math.max(top, (l.b[3] + inZone[i + 1].b[1]) / 2));
    rows.push({ y0: top, y1: Math.max(top, cut), role, flags: [] });
  });
  return rows;
}

function headerBottomOf(hyps: readonly RowHypothesis[], input: RowsInput): number | null {
  const tx = hyps.find((h) => h.method === "textract-cells" && votes(h));
  if (tx?.headerBottom !== undefined) return tx.headerBottom;
  const ly = hyps.find((h) => h.method === "layout" && votes(h));
  if (ly?.headerBottom !== undefined) return ly.headerBottom;
  const n = input.hints?.headerRows;
  if (n && n > 0) {
    const ocr = hyps.find((h) => h.method === "ocr-lines" && votes(h));
    if (ocr?.rowLines && ocr.rowLines.length > n) return ocr.rowLines[n];
  }
  return null;
}

/** R2, Textract half: the shapes must account for this share of the Textract body rows inside their span. */
export const SHAPE_REGIME_MIN_ROW_SHARE = 0.6;

/**
 * R2 against Textract: when a coinciding Textract table (conf ≥ .9) lays out the body rows, a column of M shapes
 * anchors the rows only if M ≥ 60 % of the KEYED Textract body rows inside the shapes' span (`textractRowsInSpan`). Measured on
 * the private G-TAB gold (WP-3.A): a handful of callout bubbles in a 20-row ruled schedule otherwise took the whole
 * table into the shape regime (5 rows for 20). Without Textract the span test alone decides.
 */
export function shapesAnchorTextractRows(col: ReturnType<typeof fusedShapeColumn>, tx: RowHypothesis | undefined, input: RowsInput): boolean {
  if (!col) return false;
  if (!tx || !votes(tx) || tx.conf < 0.9) return true;
  const n = textractRowsInSpan(col, tx, input).keyed;
  return n === 0 || col.shapes.length >= SHAPE_REGIME_MIN_ROW_SHARE * n;
}

/** A tag column of box-like shapes needs distinct keys: this share of the texted shapes must be distinct. */
export const TAG_COLUMN_MIN_DISTINCT = 0.8;
/** When Textract sees more rows than there are shapes, at least this share of the shapes must carry key text. */
export const TAG_COLUMN_MIN_TEXT_SHARE = 0.5;
const BOX_LIKE: ReadonlySet<string> = new Set(["rectangle", "square"]);

/**
 * R2, tag-column half (MEASURED on the private G-TAB gold, WP-3.A): a column of shapes anchors the rows only when it
 * reads like a TAG column. Box-like classes (`rectangle`, `square`) double as table cells and check boxes, so they
 * must carry key text on ≥ 50 % of the shapes and ≥ 80 % of those keys must be distinct (a mark column is unique;
 * a column of cells repeats). When a coinciding Textract table (conf ≥ .9) lays out MORE body rows in the span (all
 * of them, keyed or not) than there are shapes, the shapes must carry key text on ≥ 50 % of them: textless symbols
 * (a few diamonds in a 17-row ruled table) have no sibling pattern, so the R4 key-text exception could never recover
 * the rows they miss, and Textract wins.
 */
export function shapeColumnIsTagLike(col: NonNullable<ReturnType<typeof fusedShapeColumn>>, keys: readonly { key: string | null }[], tx: RowHypothesis | undefined, textractRowsInSpan: number): boolean {
  const texted = keys.map((k) => k.key?.trim().toUpperCase() ?? "").filter(Boolean);
  const textShare = texted.length / Math.max(1, keys.length);
  const withTextract = !!tx && votes(tx);
  // box-like shapes are suspect only where a Textract table shows there ARE cells; a square-keyed symbol legend without one is a legend
  if (withTextract && BOX_LIKE.has(col.shapeClass)) {
    if (textShare < TAG_COLUMN_MIN_TEXT_SHARE) return false;
    if (new Set(texted).size < TAG_COLUMN_MIN_DISTINCT * texted.length) return false;
  }
  if (withTextract && tx.conf >= 0.9 && textractRowsInSpan > col.shapes.length && textShare < TAG_COLUMN_MIN_TEXT_SHARE) return false;
  return true;
}

/** A band holding more lines than this, and than 3 × the median band, is "overfull" (shapes missing under it). */
export const OVERFULL_BAND_LINES = 4;

/**
 * R2, density half (MEASURED on the private G-TAB gold, WP-3.A): a column whose midpoint bands leave TWO or more
 * bands overfull (> max(4, 3 × the median band's line count) visual lines) has shapes missing under them — a
 * legend with 10 detected pills for 20 rows — and does not anchor the rows. One overfull band is allowed: a tall
 * last row keeps its trailing lines (K13).
 */
export function shapesCoverLinesEvenly(col: NonNullable<ReturnType<typeof fusedShapeColumn>>, input: RowsInput): boolean {
  const bands = midpointBands(col.shapes.map((s) => s.b), input.box, input.words.map((w) => w.b));
  const counts = bands.map((b) => input.lines.filter((l) => yc(l.b) >= b[1] && yc(l.b) < b[3]).length);
  const sorted = [...counts].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const limit = Math.max(OVERFULL_BAND_LINES, 3 * med);
  return counts.filter((c) => c > limit).length < 2;
}

/**
 * Textract body rows inside the shapes' midpoint-band span that hold a word in the shape column's x-range (0 without
 * a voting Textract table). Only KEYED rows count: when Textract splits a wrapped row into its lines, the extra rows
 * have nothing in the tag column (the R4 veto case), while rows the shapes missed carry their own key (R4 exception).
 */
function textractRowsInSpan(col: NonNullable<ReturnType<typeof fusedShapeColumn>>, tx: RowHypothesis | undefined, input: RowsInput): { all: number; keyed: number } {
  if (!tx || !votes(tx)) return { all: 0, keyed: 0 };
  const bands = midpointBands(col.shapes.map((s) => s.b), input.box, input.words.map((w) => w.b));
  const top = Math.min(...bands.map((b) => b[1]));
  const bottom = Math.max(...bands.map((b) => b[3]));
  const tagWordYs = input.words.filter((w) => { const cx = (w.b[0] + w.b[2]) / 2; return cx >= col.x0 && cx <= col.x1; }).map((w) => yc(w.b));
  const lines = tx.rowLines!;
  let all = 0, keyed = 0;
  for (let i = Math.max(0, tx.headerRows ?? 0); i + 1 < lines.length; i++) {
    const mid = (lines[i] + lines[i + 1]) / 2;
    if (mid < top || mid > bottom) continue;
    all++;
    if (tagWordYs.some((y) => y >= lines[i] && y < lines[i + 1])) keyed++;
  }
  return { all, keyed };
}

/** Fuse the rows of one box (see the file header). */
export function fuseRows(input: RowsInput, opts: FuseRowsOptions = {}): FusedRows {
  const weights = opts.weights ?? DEFAULT_ROW_WEIGHTS;
  const h = input.h;
  const tol = CLUSTER_TOL_H * h;
  const base = runRowMethods(input, opts.ocrMode ?? "lines");
  const hyps: RowHypothesis[] = [...base, ...(opts.extraHypotheses ?? [])];
  const headerBottom = headerBottomOf(hyps, input);
  const knownSections = hyps.filter(votes).flatMap((hyp) => hyp.sections ?? []);

  // R10 / R2
  const tx = hyps.find((hyp) => hyp.method === "textract-cells" && votes(hyp));
  const fused = fuseShapes(input.shapes, input.box, tx?.cells?.map((c) => c.b) ?? []);
  const col = fusedShapeColumn(fused, opts.minShapes);
  const colKeys = col ? readShapeKeys(col.shapes.map((sh) => ({ bbox: sh.b, text: sh.text })), input.words.map((w) => ({ t: w.t, b: w.b }))) : [];
  const regime = col && shapeRegimeHolds(col, input, headerBottom) && shapesAnchorTextractRows(col, tx, input)
    && shapeColumnIsTagLike(col, colKeys, tx, textractRowsInSpan(col, tx, input).all) && shapesCoverLinesEvenly(col, input) ? "shape" : "cluster";
  const flags = new Set<string>();
  let rows: FusedRow[] = [];
  let headerRows = 0;
  let sources: MethodId[] = [];

  if (regime === "shape" && col) {
    const anchors = anchorCentres(input, fused);
    const sc = shapeCentreRows(input, col, anchors, { headerBottom, knownSections })!;
    hyps.splice(1, 0, sc.hypothesis); // METHOD order: after ocr-lines
    const body = sc.rows;
    const others = hyps.filter((hyp) => hyp.method !== "shape-centres" && votes(hyp));
    const snapLines = uniqSorted(others.filter((hyp) => SNAP_METHODS.has(hyp.method)).flatMap((hyp) => hyp.rowLines!));
    const snapped = new Set<MethodId>();
    // R5 snap: a band edge within 0.5 h of a textract/rulings boundary moves onto it.
    const snap = (y: number): number => {
      let best = y, d = SNAP_TOL_H * h + 1e-12;
      for (const s of snapLines) { const dd = Math.abs(s - y); if (dd < d) { d = dd; best = s; } }
      if (best !== y) for (const hyp of others) if (SNAP_METHODS.has(hyp.method) && hyp.rowLines!.includes(best)) snapped.add(hyp.method);
      return best;
    };
    for (let i = 0; i < body.length; i++) {
      if (i > 0) { const y = snap(body[i].y0); body[i].y0 = y; body[i - 1].y1 = y; }
    }
    if (body.length > 0) { body[0].y0 = snap(body[0].y0); body[body.length - 1].y1 = snap(body[body.length - 1].y1); }
    for (let i = 1; i < body.length; i++) { body[i].y0 = Math.max(body[i].y0, body[i - 1].y1); body[i].y1 = Math.max(body[i].y1, body[i].y0); }

    // R4 veto with the key-text exception.
    const siblingKeys = sc.centres.map((c) => c.key.key).filter((k): k is string => !!k);
    const pattern = siblingKeys.length >= 2 ? inferTagPattern(siblingKeys) : null;
    const siblingShapes = new Set(siblingKeys.map((k) => tagSignature(k.trim().toUpperCase())));
    /**
     * Does `txt` read as a key of its own? The sibling pattern when one can be inferred, or the same character shape as
     * a sibling key (`tagSignature`: letters/digits/separators — an inferred pattern over few keys is a literal
     * alternation that a ninth mark of the same shape fails, MEASURED on the private G-TAB gold); with no siblings, a
     * short single mark-like token.
     */
    const fitsKey = (txt: string): boolean =>
      (pattern ? patternAccepts(pattern, txt) : false) || (siblingShapes.size > 0 ? siblingShapes.has(tagSignature(txt)) : KEY_TOKEN_RE.test(txt));
    /** The tag-column text of a band: the first LINE in the tag column that fits the sibling pattern, else every tag-column word joined. */
    const keyTextIn = (y0: number, y1: number): string | null => {
      const ws = input.words.filter((w) => { const cx = (w.b[0] + w.b[2]) / 2; const cyy = yc(w.b); return cx >= sc.tagX[0] && cx <= sc.tagX[1] && cyy >= y0 && cyy < y1; })
        .sort((a, b) => yc(a.b) - yc(b.b) || a.b[0] - b.b[0]);
      if (ws.length === 0) return null;
      {
        for (const l of input.lines) {
          if (yc(l.b) < y0 || yc(l.b) >= y1) continue;
          const t = l.wordIdx.map((i) => input.words[i]).filter((w) => ws.includes(w)).map((w) => w.t.trim()).filter(Boolean).join(" ").toUpperCase();
          if (t && fitsKey(t)) return t;
        }
      }
      return ws.map((w) => w.t.trim()).filter(Boolean).join(" ").toUpperCase() || null;
    };
    /** Keys the rows already hold (siblings and the keys split out so far): a sub-band repeating one is not a row of its own. */
    const known = new Set(sc.centres.map((c) => c.key.key?.toUpperCase()).filter((k): k is string => !!k));
    const foreign = uniqSorted(others.flatMap((hyp) => hyp.rowLines!));
    const methodsAt = (y: number): MethodId[] => others.filter((hyp) => hyp.rowLines!.includes(y)).map((hyp) => hyp.method);
    const sortedLines = [...input.lines].sort((a, b) => yc(a.b) - yc(b.b));
    /** White space at a cut: the nearest line top below minus the nearest line bottom above (negative when lines overlap it). */
    const gapAt = (y: number): number => {
      const above = sortedLines.filter((l) => yc(l.b) < y).pop();
      const below = sortedLines.find((l) => yc(l.b) > y);
      return above && below ? below.b[1] - above.b[3] : 0;
    };
    const rowKeyText = (r: FusedRow): string | null => (r.key && r.key.kind !== "symbol" ? r.key.text?.toUpperCase() ?? null : null);
    const split: FusedRow[] = [];
    for (const row of body) {
      let cur = row;
      if (cur.role === "body") {
        // R4: a foreign boundary strictly inside the band is vetoed, unless the sub-band below it holds key text of
        // its OWN (not this row's key, not inside this row's shape) that fits the sibling keys' pattern. The split for
        // one such key is placed on the strongest evidence: a Textract / ruling edge first (the lowest one above the
        // key), else the line boundary with the widest white gap.
        for (;;) {
          const own = cur.key?.kind === "shape-text" ? yc(cur.key.shapeBbox) : null;
          const curKey = rowKeyText(cur);
          const cands = foreign
            .filter((y) => y - cur.y0 > CLUSTER_TOL_H * h && cur.y1 - y > CLUSTER_TOL_H * h)
            .filter((y) => own === null || own < y || own >= cur.y1)
            .map((y) => ({ y, key: keyTextIn(y, cur.y1) }))
            .filter((c): c is { y: number; key: string } => c.key !== null && c.key !== curKey && !known.has(c.key) && fitsKey(c.key));
          if (cands.length === 0) break;
          const key = cands[0].key; // the topmost key below the current row's own
          const group = cands.filter((c) => c.key === key);
          const strong = group.filter((c) => methodsAt(c.y).some((m) => SNAP_METHODS.has(m)));
          const pick = strong.length > 0
            ? strong[strong.length - 1]
            : group.reduce((a, c) => (gapAt(c.y) > gapAt(a.y) + 1e-12 ? c : a), group[0]);
          split.push({ ...cur, y1: pick.y });
          cur = { y0: pick.y, y1: cur.y1, role: "body", key: { kind: "text", text: key }, flags: ["shape-missing"] };
          known.add(key);
          flags.add("shape-missing");
        }
      }
      split.push(cur);
    }
    // Rows above the first band and below the last: the other methods' boundaries inside the zone, fused under the
    // R7 majority (a boundary that separates no lines is dropped), else one row per visual line. A zone row whose
    // tag-column text is a key of its own (fits the sibling pattern, not a sibling) is a body row whose shape the
    // detector missed (MEASURED on the private G-TAB gold: the first rows of a schedule often have no live shape).
    const firstTop = split[0]?.y0 ?? input.box[1];
    const lastBottom = split[split.length - 1]?.y1 ?? input.box[3];
    const zoneRows = (y0: number, y1: number, role: "header" | "footer"): FusedRow[] => {
      if (!(y1 > y0) || !input.lines.some((l) => yc(l.b) >= y0 && yc(l.b) < y1)) return [];
      const inner = fuseBoundaries(others.map((hyp) => ({ method: hyp.method, conf: hyp.conf, lines: hyp.rowLines!.filter((y) => y > y0 + tol && y < y1 - tol) })), tol, weights).map((b) => b.at);
      const edges = uniqSorted([y0, ...inner, y1]).filter((y, i, arr) => i === 0 || i === arr.length - 1 || input.lines.some((l) => yc(l.b) >= arr[i - 1] && yc(l.b) < y));
      const out: FusedRow[] = [];
      for (let i = 0; i + 1 < edges.length; i++) {
        if (!input.lines.some((l) => yc(l.b) >= edges[i] && yc(l.b) < edges[i + 1])) continue;
        const txt = keyTextIn(edges[i], edges[i + 1]);
        const isKey = txt !== null && !known.has(txt) && fitsKey(txt);
        out.push(isKey ? { y0: edges[i], y1: edges[i + 1], role: "body", key: { kind: "text", text: txt! }, flags: ["shape-missing"] } : { y0: edges[i], y1: edges[i + 1], role, flags: [] });
        if (isKey) { known.add(txt!); flags.add("shape-missing"); }
      }
      if (out.length === 0) return rowsPerLine(input.lines, y0, y1, role);
      // tile the zone exactly
      out[0].y0 = y0;
      out[out.length - 1].y1 = y1;
      return out;
    };
    const header = zoneRows(Math.min(firstTop, ...input.lines.map((l) => l.b[1])), firstTop, "header");
    const footer = zoneRows(lastBottom, Math.max(lastBottom, ...input.lines.map((l) => l.b[3])) + 1e-9, "footer");
    rows = [...header, ...split, ...footer];
    headerRows = header.filter((r) => r.role === "header").length;
    sources = ["shape-centres", ...[...snapped].sort()];
    if (sc.sectionCount > 0) flags.add(`section-rows:${sc.sectionCount}`);
    if (sc.centres.some((c) => c.key.flags.includes("key-from-crop"))) flags.add("key-from-crop");
  } else {
    // R7 weighted clustering.
    const voters = hyps.filter(votes);
    const fusedB = fuseBoundaries(voters.map((hyp) => ({ method: hyp.method, conf: hyp.conf, lines: hyp.rowLines! })), tol, weights);
    let lines = fusedB.map((b) => b.at);
    const contentTop = input.lines.length ? Math.min(...input.lines.map((l) => l.b[1])) : input.box[1];
    const contentBottom = input.lines.length ? Math.max(...input.lines.map((l) => l.b[3])) : input.box[3];
    if (lines.length === 0 || contentTop < lines[0] - tol) lines = [contentTop, ...lines];
    if (contentBottom > lines[lines.length - 1] + tol) lines = [...lines, contentBottom];
    lines = uniqSorted(lines);
    const tx = voters.find((hyp) => hyp.method === "textract-cells");
    headerRows = tx?.headerRows ?? input.hints?.headerRows ?? 0;
    for (let i = 0; i + 1 < lines.length; i++) {
      const y0 = lines[i], y1 = lines[i + 1];
      const mid = (y0 + y1) / 2;
      const role: FusedRow["role"] = i < headerRows ? "header" : knownSections.some(([s0, s1]) => mid >= s0 && mid <= s1) ? "section" : "body";
      rows.push({ y0, y1, role, flags: [] });
    }
    headerRows = Math.min(headerRows, rows.length);
    const sections = rows.filter((r) => r.role === "section").length;
    if (sections > 0) flags.add(`section-rows:${sections}`);
    sources = [...new Set(fusedB.flatMap((b) => b.methods))].sort();
  }

  if (rows.length > PARSE_ENGINE_CAPS.rows) { rows = rows.slice(0, PARSE_ENGINE_CAPS.rows); flags.add("truncated"); }
  const rowLines = rows.length ? [rows[0].y0, ...rows.map((r) => r.y1)] : [];
  const inner = rowLines.slice(1, -1);
  const alternatives: RowAlternative[] = hyps.filter(votes).map((hyp) => {
    const own = hyp.rowLines!.slice(0, PARSE_ENGINE_CAPS.alternativeRows + 1);
    return { method: hyp.method, rows: Math.max(0, own.length - 1), agreement: boundaryAgreement(own.slice(1, -1), inner, tol), conf: hyp.conf, rowLines: own };
  });
  // R12: the best alternative other than the regime driver (shape-centres IS the fused geometry) must agree ≥ .7
  const foreignAlts = alternatives.filter((a) => a.method !== "shape-centres");
  if (foreignAlts.length > 0 && Math.max(...foreignAlts.map((a) => a.agreement)) < DISAGREE_BELOW) flags.add("rows-disagree");

  return {
    regime, rows, rowLines, headerRows, hypotheses: hyps, sources, alternatives,
    shapeColumn: regime === "shape" && col ? col : undefined,
    flags: [...flags].sort(), h,
  };
}
