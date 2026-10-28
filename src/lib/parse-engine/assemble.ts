/**
 * Table model assembly from geometry (table pipeline WP-3.D; PLAN §1.3 E-1, E-2, E-5; §2.1). Pure, client-safe
 * (E-8: imports only the client-safe subset), deterministic (E-7).
 *
 * The engine (`engine-table.ts`, server) and the correction ops (`ops.ts`, client preview AND server commit) both
 * end in the same step: a row list + a column list + merged-cell spans, all keyed by MINTED ids, become a
 * `StructureTableModel` whose cell text is assembled ONCE from page words (`cells.ts`, E-1) and whose column
 * labels come from the header rows (`headers.ts`, K06 dedupe). One function, so an op previewed in the browser and
 * re-applied by the commit give the same model.
 *
 * Conventions:
 * - `rows` are in part order, top to bottom inside a part (`part` absent = 0). Inside one part the rows tile their
 *   band list (`[rows[0].y0, …rows[i].y1]`); a gap between two rows falls into the lower one.
 * - `cols` carry PART-0 x positions; a later part reads them mapped by relative x (R11, the `parts.ts` rule
 *   `mapXToPart`, repeated here because `parts.ts` imports the fusion step, which is not client-safe).
 * - header rows are the LEADING `role:"header"` rows of part 0. Labels are read per visual line ("tier") of the
 *   header block; a top tier that is the printed title (its text is the model's title, or one filled cell on a grid
 *   of ≥ 3 columns that is not a group label) stays inside a header row but never becomes part of a column label.
 * - E-1 exception: a cell with no page word takes a method's own words — a paid crop's words (`methodWords`), or a
 *   row's shape key read from the shape's crop (`textSource: "crop"`), which lands in the cell holding the shape.
 * - ids: `r<n>`, `c<n>`, `p<n>`, `b<n>`; minted once (PLAN §1.1 row 6). `rematchBands` / `rematchBoxes` reuse a
 *   prior id at band IoU ≥ .5 (§2.1 "Ids"); `nextId` mints past the highest id in use.
 */

import { assembleCells, cellTextMatrix, type CellSpan, type ColWord, type MethodWords } from "./cells";
import { headerLabels, headerSpansFromWords } from "./headers";
import { wordsToLines } from "./lines";
import {
  PARSE_ENGINE_CAPS,
  type BboxMinMax,
  type MethodId,
  type StructureCell,
  type StructureCol,
  type StructureRow,
  type StructureTableModel,
} from "./types";

/** A merged cell keyed by ids (anchor row / column, sizes in bands). */
export interface IdSpan { row: string; col: string; rs: number; cs: number }

export interface TableGeometry {
  rows: StructureRow[];
  /** Part-0 x positions; `label`/`labelRaw`/`group` are recomputed from the header rows, `role` kept when set. */
  cols: { id: string; x0: number; x1: number; role?: StructureCol["role"] }[];
  spans: IdSpan[];
}

export interface AssembleTableInput {
  kind: StructureTableModel["kind"];
  bbox: BboxMinMax;
  parts?: BboxMinMax[];
  geometry: TableGeometry;
  /** Region words (page words; a scanned page's crop words), MinMax. */
  words: readonly ColWord[];
  methodWords?: readonly MethodWords[];
  /** The method whose geometry the grid is (cell `src` for page-word cells). */
  src: MethodId;
  title?: StructureTableModel["title"];
  classId?: string;
  tag?: StructureTableModel["tag"];
  notes?: StructureTableModel["notes"];
  sources: StructureTableModel["sources"];
  quality: StructureTableModel["quality"];
}

/** Band IoU at which a re-parsed row / column / paragraph keeps a prior id (§2.1). */
export const REMATCH_IOU = 0.5;
/** A leading header row with one filled cell on a grid of at least this many columns is a title band, not a label tier. */
export const TITLE_TIER_MIN_COLS = 3;

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Map an x inside `from` to the same relative position inside `to` (R11; same rule as `parts.ts` `mapXToPart`). */
export function mapXToBox(x: number, from: BboxMinMax, to: BboxMinMax): number {
  const w = from[2] - from[0];
  const rel = w > 0 ? (x - from[0]) / w : 0;
  return to[0] + rel * (to[2] - to[0]);
}

/** The numeric part of a minted id (`r12` → 12), or 0. */
export function idNumber(id: string, prefix: string): number {
  if (!id.startsWith(prefix)) return 0;
  const n = Number(id.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The next free id of a prefix past every id in `taken`. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  let max = 0;
  for (const id of taken) max = Math.max(max, idNumber(id, prefix));
  return `${prefix}${max + 1}`;
}

const iou1 = (a0: number, a1: number, b0: number, b1: number): number => {
  const inter = Math.min(a1, b1) - Math.max(a0, b0);
  const union = Math.max(a1, b1) - Math.min(a0, b0);
  return inter > 0 && union > 0 ? inter / union : 0;
};

const iou2 = (a: readonly number[], b: readonly number[]): number => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const area = (x: readonly number[]): number => Math.max(0, x[2] - x[0]) * Math.max(0, x[3] - x[1]);
  const u = area(a) + area(b) - inter;
  return u > 0 ? inter / u : 0;
};

/**
 * Ids for `bands` (new geometry) given `prior` bands with ids: greedy by IoU (highest first, ties by index), a prior
 * id is reused at IoU ≥ .5 inside the same `group` (a part index); the rest get fresh ids past every id in use.
 */
function rematch<T, P extends { id: string }>(items: readonly T[], prior: readonly P[], score: (a: T, b: P) => number, prefix: string, reserved: Iterable<string> = []): string[] {
  const pairs: { i: number; j: number; s: number }[] = [];
  items.forEach((a, i) => prior.forEach((b, j) => {
    const s = score(a, b);
    if (s >= REMATCH_IOU) pairs.push({ i, j, s });
  }));
  pairs.sort((x, y) => y.s - x.s || x.i - y.i || x.j - y.j);
  const out: (string | null)[] = items.map(() => null);
  const usedPrior = new Set<number>();
  for (const p of pairs) {
    if (out[p.i] !== null || usedPrior.has(p.j)) continue;
    out[p.i] = prior[p.j].id;
    usedPrior.add(p.j);
  }
  const taken = new Set<string>([...prior.map((b) => b.id), ...reserved]);
  return out.map((id) => {
    if (id !== null) return id;
    const fresh = nextId(prefix, taken);
    taken.add(fresh);
    return fresh;
  });
}

/** Row / column ids by 1-D band IoU, inside the same part. */
export function rematchBands(
  bands: readonly { a: number; b: number; part?: number }[],
  prior: readonly { id: string; a: number; b: number; part?: number }[],
  prefix: string,
  reserved: Iterable<string> = [],
): string[] {
  return rematch(bands, prior, (x, y) => ((x.part ?? 0) === (y.part ?? 0) ? iou1(x.a, x.b, y.a, y.b) : 0), prefix, reserved);
}

/** Paragraph / block ids by 2-D box IoU. */
export function rematchBoxes(boxes: readonly { b: readonly number[] }[], prior: readonly { id: string; b: readonly number[] }[], prefix: string, reserved: Iterable<string> = []): string[] {
  return rematch(boxes, prior, (x, y) => iou2(x.b, y.b), prefix, reserved);
}

/** The box a part index reads (0 = the main box). */
export function partBox(bbox: BboxMinMax, parts: readonly BboxMinMax[] | undefined, part: number | undefined): BboxMinMax {
  const k = part ?? 0;
  return k > 0 && parts && parts[k - 1] ? parts[k - 1] : bbox;
}

/** Rows of one part, in order. */
export function rowsOfPart(rows: readonly StructureRow[], part: number): StructureRow[] {
  return rows.filter((r) => (r.part ?? 0) === part);
}

/** n + 1 boundaries of a part's rows (the band list `cells.ts` reads). */
export function rowLinesOf(rows: readonly StructureRow[]): number[] {
  return rows.length ? [rows[0].y0, ...rows.map((r) => r.y1)] : [];
}

/** n + 1 boundaries of the part-0 columns. */
export function colLinesOf(cols: readonly { x0: number; x1: number }[]): number[] {
  return cols.length ? [cols[0].x0, ...cols.map((c) => c.x1)] : [];
}

/** The number of leading header rows of part 0. */
export function leadingHeaderRows(rows: readonly StructureRow[]): number {
  let n = 0;
  for (const r of rows) {
    if ((r.part ?? 0) !== 0 || r.role !== "header") break;
    n++;
  }
  return n;
}

function partCount(rows: readonly StructureRow[]): number {
  return rows.reduce((m, r) => Math.max(m, (r.part ?? 0) + 1), 1);
}

/** Cells of every part (text from words, E-1), sparse, in part then row-major order. */
function assembleAllCells(input: AssembleTableInput): StructureCell[] {
  const { geometry } = input;
  const colIds = geometry.cols.map((c) => c.id);
  const colLines0 = colLinesOf(geometry.cols);
  // E-1 exception: a shape key read from the shape's CROP (no page word inside the shape) stands in for the cell
  const cropKeys = geometry.rows.flatMap((r) => (r.key?.kind === "shape-text" && r.key.textSource === "crop" && r.key.text ? [{ t: r.key.text, b: r.key.shapeBbox }] : []));
  const methodWords: MethodWords[] = [...(input.methodWords ?? []), ...(cropKeys.length ? [{ method: "shape-centres" as const, words: cropKeys }] : [])];
  const out: StructureCell[] = [];
  const nParts = partCount(geometry.rows);
  for (let k = 0; k < nParts; k++) {
    const rows = rowsOfPart(geometry.rows, k);
    if (!rows.length || colLines0.length < 2) continue;
    const box = partBox(input.bbox, input.parts, k);
    const colLines = k === 0 ? colLines0 : colLines0.map((x) => mapXToBox(x, input.bbox, box));
    const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
    const colIndex = new Map(colIds.map((id, i) => [id, i]));
    const spans: CellSpan[] = [];
    for (const s of geometry.spans) {
      const r = rowIndex.get(s.row);
      const c = colIndex.get(s.col);
      if (r === undefined || c === undefined) continue;
      spans.push({ r, c, rs: s.rs, cs: s.cs });
    }
    out.push(...assembleCells({
      rowLines: rowLinesOf(rows),
      colLines,
      rowIds: rows.map((r) => r.id),
      colIds,
      words: input.words,
      src: input.src,
      spans,
      methodWords,
    }));
  }
  return out;
}

const normText = (t: string): string => t.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * The header TIERS of the header block: one per visual line of its words (a header printed on two lines in one fused
 * row is two tiers, so a group label over two columns is read as a group), cut at the middle of each line gap.
 */
function headerTiers(header: readonly StructureRow[], colLines: readonly number[], words: readonly ColWord[]): number[] {
  const y0 = header[0].y0;
  const y1 = header[header.length - 1].y1;
  const x0 = colLines[0];
  const x1 = colLines[colLines.length - 1];
  const inside = words.filter((w) => {
    const cx = (w.b[0] + w.b[2]) / 2;
    const cy = (w.b[1] + w.b[3]) / 2;
    return cy >= y0 && cy < y1 && cx >= x0 && cx <= x1;
  });
  const lines = wordsToLines(inside).sort((a, b) => a.b[1] - b.b[1]);
  const cuts: number[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const cut = (lines[i].b[3] + lines[i + 1].b[1]) / 2;
    if (cut > y0 && cut < y1 && (cuts.length === 0 || cut > cuts[cuts.length - 1])) cuts.push(cut);
  }
  return [y0, ...cuts, y1];
}

/**
 * Column labels from the header rows, read tier by tier (`headerTiers`). Top tiers that are the printed title are
 * skipped: a tier whose text is the model's title, or a tier with a single filled cell on a grid of ≥ 3 columns that
 * is not a group label (a run over 2 … n − 1 columns). Group spans come from the header words
 * (`headerSpansFromWords`) and from merged cells inside the header block.
 */
function labelColumns(geometry: TableGeometry, words: readonly ColWord[], title: string | undefined): StructureCol[] {
  const cols = geometry.cols;
  const ncols = cols.length;
  const colLines = colLinesOf(cols);
  const header = geometry.rows.slice(0, leadingHeaderRows(geometry.rows));
  let tierLines = header.length && ncols ? headerTiers(header, colLines, words) : [];
  const tierIds = tierLines.slice(1).map((_, i) => `t${i + 1}`);
  const colIds = cols.map((c) => c.id);
  const tierCells = tierLines.length >= 2 ? assembleCells({ rowLines: tierLines, colLines, rowIds: tierIds, colIds, words, src: "ocr-lines" }) : [];
  let tiers = cellTextMatrix(tierCells, tierIds, colIds).map((r) => r.map((t) => t.replace(/\n/g, " ")));
  let spans: CellSpan[] = tierLines.length >= 3 ? headerSpansFromWords(words, tierLines, colLines) : [];
  const titleNorm = title ? normText(title) : "";
  const isTitleTier = (t: number): boolean => {
    const filled = tiers[t].filter((x) => x.trim() !== "");
    if (filled.length === 0) return false;
    if (titleNorm && normText(filled.join(" ")) === titleNorm) return true;
    if (filled.length !== 1 || ncols < TITLE_TIER_MIN_COLS) return false;
    return !spans.some((s) => s.r === t && s.cs >= 2 && s.cs < ncols);
  };
  let first = 0;
  while (first < tiers.length - 1 && isTitleTier(first)) first++;
  if (first > 0) {
    tiers = tiers.slice(first);
    tierLines = tierLines.slice(first);
    spans = spans.filter((s) => s.r >= first).map((s) => ({ ...s, r: s.r - first }));
  }
  // a merged cell inside the header block (Textract's stored spans) spans its columns in the first tier it covers
  const colIndex = new Map(cols.map((c, i) => [c.id, i]));
  for (const s of geometry.spans) {
    const row = header.find((r) => r.id === s.row);
    const c = colIndex.get(s.col);
    if (!row || c === undefined || s.cs < 2) continue;
    const t = tierLines.slice(0, -1).findIndex((y, i) => { const mid = (y + tierLines[i + 1]) / 2; return mid >= row.y0 && mid < row.y1; });
    if (t >= 0) spans.push({ r: t, c, rs: 1, cs: s.cs });
  }
  const labels = headerLabels({ tiers, cols: ncols, spans });
  return cols.map((c, i) => {
    const l = labels[i];
    const col: StructureCol = { id: c.id, x0: c.x0, x1: c.x1, label: l.label, labelRaw: l.labelRaw };
    if (l.group) col.group = l.group;
    const role = c.role ?? l.role;
    if (role) col.role = role;
    return col;
  });
}

/** Enforce the stored-model caps (§2.1) on cells and columns; flags `truncated`. */
export function capTableModel(model: StructureTableModel): StructureTableModel {
  let truncated = false;
  let cols = model.cols;
  if (cols.length > PARSE_ENGINE_CAPS.cols) {
    cols = cols.slice(0, PARSE_ENGINE_CAPS.cols);
    truncated = true;
  }
  const keep = new Set(cols.map((c) => c.id));
  let cells = model.cells.filter((c) => keep.has(c.col));
  if (cells.length > PARSE_ENGINE_CAPS.cells) {
    cells = cells.slice(0, PARSE_ENGINE_CAPS.cells);
    truncated = true;
  }
  cells = cells.map((c) => {
    if (c.text.length <= PARSE_ENGINE_CAPS.cellText) return c;
    truncated = true;
    return { ...c, text: c.text.slice(0, PARSE_ENGINE_CAPS.cellText) };
  });
  if (!truncated && cols === model.cols && cells.length === model.cells.length) return { ...model, cells };
  const flags = truncated && !model.quality.flags.includes("truncated") ? [...model.quality.flags, "truncated"].sort() : model.quality.flags;
  return { ...model, cols, cells, quality: { ...model.quality, flags } };
}

/** The table model of a geometry (cells from words, labels from the header rows). */
export function assembleTable(input: AssembleTableInput): StructureTableModel {
  const rows = input.geometry.rows.map((r) => ({ ...r, y0: r6(r.y0), y1: r6(r.y1) }));
  const geometry: TableGeometry = { ...input.geometry, rows, cols: input.geometry.cols.map((c) => ({ ...c, x0: r6(c.x0), x1: r6(c.x1) })) };
  const cells = assembleAllCells({ ...input, geometry });
  const cols = labelColumns(geometry, input.words, input.title?.text);
  const colIds = new Set(cols.map((c) => c.id));
  const model: StructureTableModel = {
    v: 1,
    kind: input.kind,
    bbox: input.bbox,
    ...(input.parts?.length ? { parts: input.parts } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.classId ? { classId: input.classId } : {}),
    rows,
    cols,
    cells,
    headerRows: leadingHeaderRows(rows),
    ...(input.tag && colIds.has(input.tag.col) ? { tag: input.tag } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    sources: input.sources,
    quality: input.quality,
  };
  return capTableModel(model);
}

/** The geometry a stored model carries (inverse of `assembleTable` up to text and labels). */
export function geometryOf(model: StructureTableModel): TableGeometry {
  return {
    rows: model.rows.map((r) => ({ ...r })),
    // roles are re-read from the labels; a user role is an op (`set-col-role`) and is re-applied after assembly
    cols: model.cols.map((c) => ({ id: c.id, x0: c.x0, x1: c.x1 })),
    spans: model.cells.filter((c) => (c.rs ?? 1) > 1 || (c.cs ?? 1) > 1).map((c) => ({ row: c.row, col: c.col, rs: c.rs ?? 1, cs: c.cs ?? 1 })),
  };
}
