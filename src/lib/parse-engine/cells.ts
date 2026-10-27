/**
 * Cell assembly (table pipeline WP-3.B; PLAN §1.3 E-1; §2.1 StructureCell). Pure, client-safe (E-8: imports
 * only `./lines`, `./geometry`, `./types`, `./types-cols`), deterministic (E-7).
 *
 * Methods propose geometry; text is assembled ONCE, here, from page words (E-1):
 * - the grid is n + 1 row lines × m + 1 column lines (`types-cols.ts` line convention); a word belongs to the
 *   cell whose band holds its CENTRE (half-open, the last band closed on its far edge); a word outside the
 *   grid belongs to no cell;
 * - a merged cell (`CellSpan`) owns every band it covers; the covered cells do not exist on their own;
 * - cell text is `assembleText(words, { lineSep: "\n" })` — line-aware reading order (K07);
 * - E-1 exception: a cell with NO page words takes the words a method brought for the crop (`MethodWords`,
 *   first method in the list that has any), and its `src` names that method.
 * Output is sparse: only cells with text, plus every merged anchor (so spans survive an empty anchor).
 * An absent cell is empty. Row / column ids come from the caller (minted once, PLAN §1.1 row 6).
 *
 * `spansFromBoxes` maps merged-cell boxes from any method (Textract's stored spans, TATR) onto THIS grid by
 * geometry: a box covers the bands whose centre lies inside it.
 */

import { unionBox } from "./geometry";
import { assembleText } from "./lines";
import type { BboxMinMax, MethodId, StructureCell } from "./types";

/** A word as the column / cell modules read it (the `EngineWord` subset; `LineWord`-compatible). */
export interface ColWord { t: string; b: BboxMinMax }

/** A merged cell in grid indices (0-based, `rs`/`cs` ≥ 1). */
export interface CellSpan { r: number; c: number; rs: number; cs: number }

/** Words a method brought for a crop (a live Textract or TATR read), used only where a cell has no page words (E-1 exception). */
export interface MethodWords { method: MethodId; words: readonly ColWord[] }

export const CELLS_VERSION = 1;

/** Index of the band holding `v` (half-open, last band closed), or -1 outside the lines. */
export function bandIndex(v: number, lines: readonly number[]): number {
  const n = lines.length - 1;
  if (n < 1 || !(v >= lines[0]) || !(v <= lines[n])) return -1;
  for (let k = 0; k < n; k++) if (v < lines[k + 1]) return k;
  return n - 1;
}

const centre = (b: readonly number[]): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const finite = (b: readonly number[]): boolean => b.length === 4 && b.every((v) => Number.isFinite(v));

/** The spans a set of merged-cell boxes take on this grid (boxes covering a single band are dropped). */
export function spansFromBoxes(boxes: readonly BboxMinMax[], rowLines: readonly number[], colLines: readonly number[]): CellSpan[] {
  const covered = (lo: number, hi: number, lines: readonly number[]): number[] => {
    const out: number[] = [];
    for (let k = 0; k + 1 < lines.length; k++) {
      const mid = (lines[k] + lines[k + 1]) / 2;
      if (mid >= lo && mid <= hi) out.push(k);
    }
    return out;
  };
  const out: CellSpan[] = [];
  for (const b of boxes) {
    if (!finite(b)) continue;
    const rs = covered(b[1], b[3], rowLines);
    const cs = covered(b[0], b[2], colLines);
    if (!rs.length || !cs.length || (rs.length === 1 && cs.length === 1)) continue;
    out.push({ r: rs[0], c: cs[0], rs: rs[rs.length - 1] - rs[0] + 1, cs: cs[cs.length - 1] - cs[0] + 1 });
  }
  return normaliseSpans(out, rowLines.length - 1, colLines.length - 1);
}

/** Clip spans to the grid and drop any span that overlaps an earlier one (input order wins). */
export function normaliseSpans(spans: readonly CellSpan[], rows: number, cols: number): CellSpan[] {
  const taken = new Set<string>();
  const out: CellSpan[] = [];
  for (const s of spans) {
    if (![s.r, s.c, s.rs, s.cs].every(Number.isInteger) || s.r < 0 || s.c < 0 || s.r >= rows || s.c >= cols) continue;
    const rs = Math.max(1, Math.min(s.rs, rows - s.r));
    const cs = Math.max(1, Math.min(s.cs, cols - s.c));
    if (rs === 1 && cs === 1) continue;
    const keys: string[] = [];
    for (let r = s.r; r < s.r + rs; r++) for (let c = s.c; c < s.c + cs; c++) keys.push(`${r}:${c}`);
    if (keys.some((k) => taken.has(k))) continue;
    keys.forEach((k) => taken.add(k));
    out.push({ r: s.r, c: s.c, rs, cs });
  }
  return out;
}

export interface AssembleCellsInput {
  rowLines: readonly number[];
  colLines: readonly number[];
  /** One id per row band / column band (`r1…`, `c1…`). */
  rowIds: readonly string[];
  colIds: readonly string[];
  /** Page words (MinMax). */
  words: readonly ColWord[];
  /** The method whose geometry the grid is (the cell `src` for page-word cells). */
  src: MethodId;
  spans?: readonly CellSpan[];
  methodWords?: readonly MethodWords[];
  /** Default "\n" (the structure model's convention). */
  lineSep?: string;
}

/** Cells of the grid, text from page words (E-1). Row-major order. */
export function assembleCells(input: AssembleCellsInput): StructureCell[] {
  const nr = input.rowLines.length - 1;
  const nc = input.colLines.length - 1;
  if (nr < 1 || nc < 1 || input.rowIds.length !== nr || input.colIds.length !== nc) return [];
  const sep = input.lineSep ?? "\n";
  const spans = normaliseSpans(input.spans ?? [], nr, nc);
  // owner[r][c] = the anchor "r:c" that owns band (r, c)
  const owner = new Map<string, string>();
  const spanAt = new Map<string, CellSpan>();
  for (const s of spans) {
    spanAt.set(`${s.r}:${s.c}`, s);
    for (let r = s.r; r < s.r + s.rs; r++) for (let c = s.c; c < s.c + s.cs; c++) owner.set(`${r}:${c}`, `${s.r}:${s.c}`);
  }
  const keyOf = (r: number, c: number): string => owner.get(`${r}:${c}`) ?? `${r}:${c}`;
  const bucket = (ws: readonly ColWord[]): Map<string, ColWord[]> => {
    const m = new Map<string, ColWord[]>();
    for (const w of ws) {
      if (!w || !finite(w.b)) continue;
      const [x, y] = centre(w.b);
      const r = bandIndex(y, input.rowLines);
      const c = bandIndex(x, input.colLines);
      if (r < 0 || c < 0) continue;
      const k = keyOf(r, c);
      const list = m.get(k);
      if (list) list.push(w);
      else m.set(k, [w]);
    }
    return m;
  };
  const page = bucket(input.words);
  const methods = (input.methodWords ?? []).map((m) => ({ method: m.method, cells: bucket(m.words) }));

  const out: StructureCell[] = [];
  for (let r = 0; r < nr; r++) {
    for (let c = 0; c < nc; c++) {
      const k = `${r}:${c}`;
      if (keyOf(r, c) !== k) continue; // covered by a span
      const span = spanAt.get(k);
      let src: MethodId = input.src;
      let ws = page.get(k) ?? [];
      if (!ws.length) {
        const m = methods.find((mm) => (mm.cells.get(k) ?? []).length > 0);
        if (m) { ws = m.cells.get(k)!; src = m.method; }
      }
      const text = ws.length ? assembleText(ws.map((w) => ({ t: w.t, b: w.b })), { lineSep: sep }) : "";
      if (!text && !span) continue;
      const cell: StructureCell = { row: input.rowIds[r], col: input.colIds[c], text, src };
      if (span) { cell.rs = span.rs; cell.cs = span.cs; }
      const b = ws.length ? unionBox(ws.map((w) => w.b)) : null;
      if (b) cell.b = b;
      out.push(cell);
    }
  }
  return out;
}

/** Row-major text matrix of a cell list (empty string where absent; a span's text sits in its anchor only). */
export function cellTextMatrix(cells: readonly StructureCell[], rowIds: readonly string[], colIds: readonly string[]): string[][] {
  const ri = new Map(rowIds.map((id, i) => [id, i]));
  const ci = new Map(colIds.map((id, i) => [id, i]));
  const m = rowIds.map(() => colIds.map(() => ""));
  for (const cell of cells) {
    const r = ri.get(cell.row);
    const c = ci.get(cell.col);
    if (r !== undefined && c !== undefined) m[r][c] = cell.text;
  }
  return m;
}
