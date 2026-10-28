/**
 * parse-engine/parts.ts — continuations (table pipeline WP-3.A; PLAN §1.4 R11, C3-M3, owner Q-1 default yes).
 *
 * A schedule printed in two (or more) blocks on one sheet is ONE table: `ParseRequest.parts` carries the later
 * boxes (≤ 4). Rows are fused per part (`fuse.ts`) and appended in part order with their `part` index. Only a
 * HEADER is ever dropped (VERIFY MED-2/MED-3): row i at the top of a later part is dropped when it covers ≥ .8 of
 * the tokens of part 0's header row i (row by row, so each row of a repeated multi-row header is matched on its
 * own; the dropped rows are a prefix, ending at the first row that does not match). When part 0 has no header rows (no stored `hdr`, no hint) there is no header to repeat, and a later row is
 * dropped only when its own part fused it as a header and it matches part 0's row i. A later part's header row
 * that matches nothing is kept as a body row and counted in the `parts-header-unmatched:N` flag. The column
 * model is fitted on part 0 and mapped onto each later part by x relative to its own box (`mapXToPart`,
 * `mapColLinesToPart`, read by WP-3.B / WP-3.D).
 *
 * `rowLines` of the combined result is the concatenation of the parts' boundary lists (they do not form one
 * monotone sequence across parts); `rows[].y0/y1` stay in page coordinates with `part` set. Pure (E-7).
 */

import { fuseRows, rowsInputFor, type FuseRowsOptions } from "./fuse";
import type { BboxMinMax, EnginePageEvidence, MethodId } from "./types";
import type { FusedRow, FusedRows, RowsInput } from "./types-rows";

/** R11: a later part's row i is the repeated header when its tokens cover this share of part 0's header row i's tokens. */
export const REPEATED_HEADER_OVERLAP = 0.8;

const yc = (b: BboxMinMax): number => (b[1] + b[3]) / 2;

/** Map an x inside `from` to the same relative position inside `to`. */
export function mapXToPart(x: number, from: BboxMinMax, to: BboxMinMax): number {
  const w = from[2] - from[0];
  const rel = w > 0 ? (x - from[0]) / w : 0;
  return to[0] + rel * (to[2] - to[0]);
}

/** Part 0's column lines mapped onto part `to` (same relative x). */
export function mapColLinesToPart(colLines: readonly number[], from: BboxMinMax, to: BboxMinMax): number[] {
  return colLines.map((x) => mapXToPart(x, from, to));
}

const tokens = (t: string): string[] => t.toUpperCase().split(/[^A-Z0-9.'"-]+/).filter(Boolean);

/** Share of `reference`'s distinct tokens present in `candidate` (0 when the reference has none). */
export function tokenOverlap(reference: string, candidate: string): number {
  const ref = new Set(tokens(reference));
  if (ref.size === 0) return 0;
  const cand = new Set(tokens(candidate));
  let hit = 0;
  for (const t of ref) if (cand.has(t)) hit++;
  return hit / ref.size;
}

/** The text of the words whose centre lies in a row's band, left to right (a header's labels). */
function rowText(input: RowsInput, row: FusedRow): string {
  return input.words
    .filter((w) => yc(w.b) >= row.y0 && yc(w.b) < row.y1)
    .sort((a, b) => a.b[0] - b.b[0] || a.b[1] - b.b[1])
    .map((w) => w.t.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Fuse the rows of a table printed in `[bbox, ...parts]`: each part fused on its own, repeated headers of the
 * later parts dropped (row by row against part 0's header rows), rows appended in part order with `part` set
 * (0 for the first box).
 */
export function fuseRowsForParts(ev: EnginePageEvidence, bbox: BboxMinMax, parts: readonly BboxMinMax[], hints?: RowsInput["hints"], opts: FuseRowsOptions = {}): FusedRows {
  const boxes = [bbox, ...parts];
  const inputs = boxes.map((b) => rowsInputFor(ev, b, hints));
  const fused = inputs.map((inp) => fuseRows(inp, opts));
  const first = fused[0];
  // part 0's header rows are the reference; without any, part 0's top rows stand in, but only for a later row
  // that its own part fused as a header (a body row is never compared with a body row: MED-2)
  const hasHeader = first.headerRows > 0;
  const refTexts = first.rows.slice(0, hasHeader ? first.headerRows : Math.max(0, ...fused.map((f) => f.headerRows))).map((r) => rowText(inputs[0], r));
  const rows: FusedRow[] = first.rows.map((r) => ({ ...r, part: 0 }));
  const rowLines = [...first.rowLines];
  const flags = new Set(first.flags);
  const sources = new Set<MethodId>(first.sources);
  let dropped = 0;
  let unmatched = 0;
  fused.forEach((f, k) => {
    if (k === 0) return;
    // the repeated header is a prefix of the part: stop at the first row that does not match (the kept rows stay
    // contiguous, so their boundary list below is exact); a header row left behind is flagged, not silently kept
    const window = Math.min(f.rows.length, refTexts.length, hasHeader ? first.headerRows : f.headerRows);
    let skip = 0;
    while (skip < window && (hasHeader || f.rows[skip].role === "header") && tokenOverlap(refTexts[skip], rowText(inputs[k], f.rows[skip])) >= REPEATED_HEADER_OVERLAP) skip++;
    dropped += skip;
    const kept = f.rows.slice(skip).map((r) => {
      if (r.role !== "header") return { ...r, part: k };
      unmatched++;
      return { ...r, role: "body" as const, part: k };
    });
    rows.push(...kept);
    rowLines.push(...(kept.length ? [kept[0].y0, ...kept.map((r) => r.y1)] : []));
    for (const fl of f.flags) flags.add(fl);
    for (const s of f.sources) sources.add(s);
  });
  if (dropped > 0) flags.add(`parts-headers-dropped:${dropped}`);
  if (unmatched > 0) flags.add(`parts-header-unmatched:${unmatched}`);
  if (fused.some((f) => f.regime !== first.regime)) flags.add("parts-regime-mixed");
  return {
    regime: first.regime,
    rows,
    rowLines,
    headerRows: first.headerRows,
    hypotheses: first.hypotheses,
    sources: [...sources].sort(),
    alternatives: first.alternatives,
    shapeColumn: first.shapeColumn,
    flags: [...flags].sort(),
    h: first.h,
  };
}
