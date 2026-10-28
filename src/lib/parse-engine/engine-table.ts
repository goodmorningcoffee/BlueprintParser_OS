/**
 * Table assembly (table pipeline WP-3.D; PLAN §1.4 R1–R12, §2.1). Server-side, pure, deterministic (E-7).
 *
 * One box (plus continuation `parts`, R11) of one page → a `StructureTableModel`, the per-method alternatives and
 * the method stamps:
 *
 * 1. **evidence for the box.** A paid Textract crop (`crops.textract`, thorough) replaces the page's stored Textract
 *    tables for this box (it is the fresher, crop-sized read) and its words become `MethodWords` for cells that have
 *    no page word (E-1 exception); on a page with NO words in the box (scanned, not OCR'd) the crop words ARE the
 *    words. Crop rulings (`crops.rulings`, standard) become one hypothesis on each axis.
 * 2. **rows** — `fuse.ts` `fuseRows` (R1–R8, R10, R12), or `parts.ts` `fuseRowsForParts` with `parts` (R11; crop
 *    hypotheses cover the main box only, so they are not passed to a multi-part fusion: flag
 *    `crop-methods-main-box-only`; part 0's header, when only its text shows it, is read first (step 5's rule) and
 *    passed as the header hint, so the later parts' repeated header is dropped). Weights: `profile.ts`.
 * 3. **columns** (R7 "columns always") — on part 0: `x-starts` (table-relative), `textract-cells`, `primitive-grid`,
 *    `rulings`. Each hypothesis' INTERIOR lines (its own outer two dropped, the rest inside the box by more than the
 *    table-relative gap) are clustered
 *    by `fuseBoundaries` within `tableRelativeGap(W)`; the outer lines are the box edges (the user's box). When no
 *    cluster reaches the weighted majority, the strongest single hypothesis (w · conf) is used (flag
 *    `cols-fallback`). At most 40 columns (cap; flag `truncated`).
 * 4. **ids** — rows `r<n>`, columns `c<n>`, re-matched to `request.prior` at band IoU ≥ .5 (`assemble.ts`); a corrected
 *    prior is matched through its `opsBase` (the machine bands), never its corrected bands.
 * 5. **header rows** — the fused count (Textract `hdr`, LAYOUT title, the request hint, the rows above the first
 *    shape); with none, `headers.ts` `detectHeaderRows` over the cell text (keyword ≻ caps), skipping the printed
 *    title row (`title.ts` `titleBottom`). Rows above the header block are kept as header rows (the title band).
 * 6. **spans** — the coinciding Textract table's merged cells mapped onto this grid (`spansFromBoxes`).
 * 7. **cells and labels** — `assemble.ts` (E-1 text from words; K06 labels; roles from labels).
 * 8. **tag column** — `tag-column.ts` `pickTagColumn` (R9: user ≻ shape ≻ header ≻ body) over the body rows and
 *    the fused shape set (R10).
 * 9. **quality** — conf = mean of the row conf (shape regime .9, else the mean conf of the row sources) and the
 *    column conf (mean conf of the column sources); agreement = mean agreement of the row alternatives; flags =
 *    row flags ∪ column flags ∪ `paid-evidence-skipped` (set by the caller).
 */

import { assembleCells, cellTextMatrix, spansFromBoxes, type ColWord, type MethodWords } from "./cells";
import { rulingsHypothesis } from "./cols/rulings";
import { pickTextractTable, textractCellsColumns } from "./cols/textract-cells";
import { primitiveGridColumns } from "./cols/primitive-grid";
import { tableRelativeGap, xStartColumns } from "./cols/x-starts";
import { boundaryAgreement, fuseBoundaries, fuseRows, rowsInputFor } from "./fuse";
import { centreIn } from "./geometry";
import { detectHeaderRows } from "./headers";
import { fuseRowsForParts } from "./parts";
import { fuseShapes } from "./shapes";
import { pickTagColumn } from "./tag-column";
import {
  assembleTable,
  rematchBands,
  rowsOfPart,
  type IdSpan,
  type TableGeometry,
} from "./assemble";
import type { ParseEngineProfile } from "./profile";
import {
  METHOD_IDS,
  PARSE_ENGINE_CAPS,
  type BboxMinMax,
  type EnginePageEvidence,
  type MethodId,
  type ParseAlternative,
  type ParseRequest,
  type StructureRow,
  type StructureTableModel,
  type StructureTitle,
} from "./types";
import type { CropRulings, ColumnHypothesis } from "./types-cols";
import type { CropTextractEvidence } from "./types-crop";
import type { FusedRows, RowHypothesis } from "./types-rows";

export const TABLE_ASSEMBLY_VERSION = 1;

/** One method's stamp line (merged over both axes by the caller). */
export interface MethodRun { id: MethodId; v: number; conf: number; used: boolean; error?: string }

export interface TableParseInput {
  ev: EnginePageEvidence;
  request: ParseRequest;
  kind: StructureTableModel["kind"];
  classId: string | null;
  title?: StructureTitle;
  /** Bottom of the printed title row inside the box (`title.ts`), for the header skip. */
  titleBottom: number | null;
  profile: ParseEngineProfile;
  textractCrop?: CropTextractEvidence;
  rulings?: { value: CropRulings; box: BboxMinMax };
}

export interface TableParseOutput {
  model: StructureTableModel;
  alternatives: ParseAlternative[];
  /** The words the model's text was read from (the client's `applyOps` preview words). */
  words: ColWord[];
  methods: MethodRun[];
  fused: FusedRows;
  /** The Textract table that coincides with the box (index into the evidence used), when one does. */
  textractCover: number | null;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** The evidence the box is read from (step 1). */
function boxEvidence(input: TableParseInput): { ev: EnginePageEvidence; methodWords: MethodWords[] } {
  const { ev, request, textractCrop } = input;
  if (!textractCrop) return { ev, methodWords: [] };
  const boxes = [request.bbox, ...(request.parts ?? [])];
  const pageHasWords = ev.words.some((w) => boxes.some((b) => centreIn(w.b, b)));
  const cropWords = textractCrop.words.map((w) => ({ t: w.t, b: w.b }));
  const out: EnginePageEvidence = {
    ...ev,
    textractTables: textractCrop.tables.length ? textractCrop.tables : ev.textractTables,
    ...(pageHasWords ? {} : { words: textractCrop.words, lines: textractCrop.lines }),
  };
  return { ev: out, methodWords: pageHasWords ? [{ method: "textract-cells", words: cropWords }] : [] };
}

/** Lines strictly inside `[lo + gap, hi − gap]`. */
const interior = (lines: readonly number[], lo: number, hi: number, gap: number): number[] => lines.filter((x) => x > lo + gap && x < hi - gap);

interface ColumnFusion { colLines: number[]; sources: MethodId[]; conf: number; flags: string[]; hyps: ColumnHypothesis[] }

/** Step 3: R7 over the column hypotheses of the main box. */
function fuseColumns(words: readonly ColWord[], ev: EnginePageEvidence, bbox: BboxMinMax, rulings: ColumnHypothesis | null, profile: ParseEngineProfile): ColumnFusion {
  const gap = tableRelativeGap(bbox[2] - bbox[0]);
  const hyps: ColumnHypothesis[] = [
    xStartColumns(words, bbox, { mode: "table-relative" }),
    textractCellsColumns(ev.textractTables, bbox),
    primitiveGridColumns(ev.primitives, bbox),
    ...(rulings ? [rulings] : []),
  ];
  const voters = hyps.filter((h) => !h.error && h.colLines.length >= 2);
  // a method's own outer lines (the box edges, a Textract table's or the rulings' frame) separate nothing
  const lines = voters.map((h) => ({ method: h.method, conf: h.conf, lines: interior(h.colLines.slice(1, -1), bbox[0], bbox[2], gap) }));
  const fused = fuseBoundaries(lines, gap, profile.cols);
  const flags: string[] = [];
  let inner = fused.map((b) => b.at);
  let sources = [...new Set(fused.flatMap((b) => b.methods))].sort() as MethodId[];
  if (inner.length === 0) {
    const w = (m: MethodId): number => profile.cols[m] ?? 0.5;
    const best = [...lines].filter((l) => l.lines.length > 0).sort((a, b) => w(b.method) * b.conf - w(a.method) * a.conf || (a.method < b.method ? -1 : 1))[0];
    if (best) {
      inner = best.lines;
      sources = [best.method];
      flags.push("cols-fallback");
    } else if (voters.length) {
      sources = [voters[0].method]; // every voter saw one column
    }
  }
  inner = [...new Set(inner.map((x) => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b);
  let colLines = [bbox[0], ...inner, bbox[2]];
  if (colLines.length - 1 > PARSE_ENGINE_CAPS.cols) {
    colLines = [...colLines.slice(0, PARSE_ENGINE_CAPS.cols), bbox[2]];
    flags.push("truncated");
  }
  const conf = mean(voters.filter((h) => sources.includes(h.method)).map((h) => h.conf));
  return { colLines, sources, conf, flags, hyps };
}

/** The rulings crop as a column hypothesis (both axes) and a row hypothesis. */
function rulingsHyps(r: TableParseInput["rulings"], bbox: BboxMinMax): { col: ColumnHypothesis | null; row: RowHypothesis | null } {
  if (!r) return { col: null, row: null };
  const h = rulingsHypothesis(r.value, r.box, bbox);
  const row: RowHypothesis | null = h.rowLines?.length ? { method: "rulings", methodVersion: h.methodVersion, conf: h.conf, rowLines: h.rowLines } : null;
  return { col: h, row };
}

/** Rows with ids (step 4), in part order. */
function mintRows(fused: FusedRows, prior: PriorBands | null): StructureRow[] {
  const bands = fused.rows.map((r) => ({ a: r.y0, b: r.y1, part: r.part ?? 0 }));
  const ids = rematchBands(bands, prior?.rows ?? [], "r", prior?.rowIds ?? []);
  return fused.rows.map((r, i) => {
    const row: StructureRow = { id: ids[i], y0: r.y0, y1: r.y1, role: r.role };
    if (r.part) row.part = r.part;
    if (r.key) row.key = r.key;
    return row;
  });
}

interface PriorBands {
  rows: { id: string; a: number; b: number; part: number }[];
  cols: { id: string; a: number; b: number }[];
  /** Every id the prior uses: a band that matches nothing never takes an id an op minted (it would then re-land). */
  rowIds: string[];
  colIds: string[];
}

/**
 * The bands ids re-match against: a corrected prior's `opsBase` (the machine bands its ops were recorded on), else its
 * own bands. Re-matching against corrected bands would hand a fresh full row the id an `add-line` minted for its
 * lower part, and the replayed op would then edit the wrong row (WP-3.D verify HIGH-1).
 */
function priorBands(request: ParseRequest): PriorBands | null {
  const p = request.prior;
  if (!p || (p.kind !== "schedule" && p.kind !== "keynote" && p.kind !== "legend")) return null;
  const t: StructureTableModel = p;
  const rows = t.opsBase?.rows ?? t.rows;
  const cols = t.opsBase?.cols ?? t.cols;
  return {
    rows: rows.map((r) => ({ id: r.id, a: r.y0, b: r.y1, part: r.part ?? 0 })),
    cols: cols.map((c) => ({ id: c.id, a: c.x0, b: c.x1 })),
    rowIds: t.rows.map((r) => r.id),
    colIds: t.cols.map((c) => c.id),
  };
}

/**
 * Step 5: the header block of one part's rows read from their cell text (`detectHeaderRows`: keyword ≻ caps), the
 * printed title row skipped; returns the number of leading rows that are header (title band included), 0 for none
 * or when every row would be header.
 */
function textHeaderRows(rows: readonly { y0: number; y1: number }[], colLines: readonly number[], words: readonly ColWord[], titleBottom: number | null): number {
  if (rows.length < 2 || colLines.length < 2) return 0;
  const rowLines = [rows[0].y0, ...rows.map((r) => r.y1)];
  const rowIds = rows.map((_, i) => `r${i + 1}`);
  const colIds = colLines.slice(1).map((_, i) => `c${i + 1}`);
  const cells = assembleCells({ rowLines, colLines, rowIds, colIds, words, src: "ocr-lines" });
  const matrix = cellTextMatrix(cells, rowIds, colIds);
  const skip = titleBottom === null ? 0 : rows.filter((r) => r.y1 <= titleBottom + 1e-9).length;
  const pick = detectHeaderRows({ rows: matrix, skip });
  const n = pick.count > 0 ? pick.start + pick.count : 0;
  return n < rows.length ? n : 0;
}

/** Parse one table box (see the file header). */
export function parseTable(input: TableParseInput): TableParseOutput {
  const { request, profile, kind } = input;
  const bbox = request.bbox;
  const parts = (request.parts ?? []).slice(0, PARSE_ENGINE_CAPS.parts);
  const { ev, methodWords } = boxEvidence(input);
  const hints = { proposalId: request.hints?.proposalId, headerRows: request.hints?.headerRows, tagCol: request.hints?.tagCol };
  const rul = rulingsHyps(input.rulings, bbox);
  const extraFlags: string[] = [];

  // 3. columns (part 0; they do not depend on the rows)
  const boxes = [bbox, ...parts];
  const words: ColWord[] = ev.words.filter((w) => boxes.some((b) => centreIn(w.b, b))).map((w) => ({ t: w.t, b: w.b }));
  const mainWords = words.filter((w) => centreIn(w.b, bbox));
  const cols = fuseColumns(mainWords, ev, bbox, rul.col, profile);

  // 2. rows. R11 drops a later part's repeated header only when part 0's header is known before the part fusion,
  // so with parts and no fused / hinted header the header rows of part 0 are read first (step 5's rule) and passed on.
  let fused: FusedRows;
  if (parts.length) {
    let partHints = hints;
    if (hints.headerRows === undefined) {
      const main = fuseRows(rowsInputFor(ev, bbox, hints), { weights: profile.rows });
      const n = main.headerRows > 0 ? 0 : textHeaderRows(main.rows, cols.colLines, mainWords, input.titleBottom);
      if (n > 0) partHints = { ...hints, headerRows: n };
    }
    fused = fuseRowsForParts(ev, bbox, parts, partHints, { weights: profile.rows });
    if (rul.row) extraFlags.push("crop-methods-main-box-only");
  } else {
    fused = fuseRows(rowsInputFor(ev, bbox, hints), { weights: profile.rows, extraHypotheses: rul.row ? [rul.row] : [] });
  }

  // 4. ids
  const prior = priorBands(request);
  const rows = mintRows(fused, prior);
  const colBands = cols.colLines.slice(0, -1).map((x, i) => ({ a: x, b: cols.colLines[i + 1] }));
  const colIds = rematchBands(colBands, prior?.cols ?? [], "c", prior?.colIds ?? []);
  const geomCols = colBands.map((b, i) => ({ id: colIds[i], x0: b.a, x1: b.b }));

  // 6. spans from the coinciding Textract table
  const tx = cols.hyps.find((h) => h.method === "textract-cells" && !h.error);
  const rows0 = rowsOfPart(rows, 0);
  const rowLines0 = rows0.length ? [rows0[0].y0, ...rows0.map((r) => r.y1)] : [];
  const merged = (tx?.cells ?? []).filter((c) => c.rs > 1 || c.cs > 1).map((c) => c.b);
  const spans: IdSpan[] = rowLines0.length >= 2 ? spansFromBoxes(merged, rowLines0, cols.colLines).map((s) => ({ row: rows0[s.r].id, col: geomCols[s.c].id, rs: s.rs, cs: s.cs })) : [];

  const src: MethodId = tx && cols.sources.includes("textract-cells") && fused.sources.includes("textract-cells")
    ? "textract-cells"
    : fused.regime === "shape" ? "shape-centres" : fused.sources.includes("rulings") && cols.sources.includes("rulings") ? "rulings" : "ocr-lines";
  const flags = new Set<string>([...fused.flags, ...cols.flags, ...extraFlags]);
  if (rows.length === 0) flags.add("empty");
  const rowConf = fused.regime === "shape" ? 0.9 : mean(fused.hypotheses.filter((h) => fused.sources.includes(h.method)).map((h) => h.conf));
  const quality = {
    conf: r3((rowConf + cols.conf) / 2),
    agreement: r3(mean(fused.alternatives.map((a) => a.agreement))),
    flags: [...flags].sort(),
  };
  const base = {
    kind, bbox, ...(parts.length ? { parts } : {}),
    words, methodWords, src,
    ...(input.title ? { title: input.title } : {}),
    ...(input.classId ? { classId: input.classId } : {}),
    sources: { rows: [...fused.sources], cols: [...cols.sources] },
    quality,
  };
  const geometry: TableGeometry = { rows, cols: geomCols, spans };
  let model = assembleTable({ ...base, geometry });

  // 5. header rows when the fusion knew none
  if (fused.headerRows === 0 && request.hints?.headerRows === undefined && rows0.length > 1) {
    const n = textHeaderRows(rows0, cols.colLines, mainWords, input.titleBottom);
    if (n > 0) {
      for (let i = 0; i < n; i++) rows0[i].role = "header";
      model = assembleTable({ ...base, geometry: { rows, cols: geomCols, spans } });
    }
  }

  // 8. tag column (R9)
  const body = model.rows.filter((r) => r.role === "body" || r.role === "section");
  const matrixBody = cellTextMatrix(model.cells, body.map((r) => r.id), model.cols.map((c) => c.id));
  const shapes = fuseShapes(ev.shapes, bbox);
  const pick = pickTagColumn({
    kind,
    cols: model.cols.map((c) => ({ x0: c.x0, x1: c.x1, label: c.labelRaw || c.label })),
    body: matrixBody,
    bodyBands: body.map((r) => [r.y0, r.y1] as const),
    shapes: shapes.map((s) => ({ b: s.b, cls: s.cls })),
    user: request.hints?.tagCol ?? null,
  });
  if (pick) {
    model = {
      ...model,
      tag: {
        col: model.cols[pick.col].id, src: pick.src, scope: pick.scope,
        ...(pick.shapeClass ? { shapeClass: pick.shapeClass } : {}),
        ...(pick.pattern ? { pattern: pick.pattern } : {}),
      },
    };
  }

  const alternatives = alternativesOf(fused, cols, bbox);
  const methods = methodRuns(fused, cols);
  const pickTx = pickTextractTable(ev.textractTables, bbox);
  return { model, alternatives, words, methods, fused, textractCover: pickTx ? pickTx.cover : null };
}

/** R12: one alternative per method that proposed geometry on either axis, in METHOD order. */
function alternativesOf(fused: FusedRows, cols: ColumnFusion, bbox: BboxMinMax): ParseAlternative[] {
  const gap = tableRelativeGap(bbox[2] - bbox[0]);
  const fusedInner = interior(cols.colLines, bbox[0], bbox[2], gap);
  const out: ParseAlternative[] = [];
  for (const m of METHOD_IDS) {
    const r = fused.alternatives.find((a) => a.method === m);
    const c = cols.hyps.find((h) => h.method === m && !h.error && h.colLines.length >= 2);
    if (!r && !c) continue;
    const rowLines = r ? r.rowLines.slice(0, PARSE_ENGINE_CAPS.alternativeRows + 1) : [];
    const colLines = c ? c.colLines.slice(0, PARSE_ENGINE_CAPS.cols + 1) : [];
    out.push({
      method: m,
      rows: Math.max(0, rowLines.length - 1),
      cols: Math.max(0, colLines.length - 1),
      agreement: r ? r.agreement : boundaryAgreement(interior(colLines, bbox[0], bbox[2], gap), fusedInner, gap),
      conf: r3(Math.max(r?.conf ?? 0, c?.conf ?? 0)),
      geometry: { rowLines, colLines },
    });
  }
  return out;
}

/** Stamp lines for every method that ran on either axis (merged by id). */
function methodRuns(fused: FusedRows, cols: ColumnFusion): MethodRun[] {
  const by = new Map<MethodId, MethodRun>();
  const add = (id: MethodId, v: number, conf: number, used: boolean, error?: string): void => {
    const cur = by.get(id);
    if (!cur) { by.set(id, { id, v, conf: r3(conf), used, ...(error ? { error } : {}) }); return; }
    cur.v = Math.max(cur.v, v);
    cur.conf = r3(Math.max(cur.conf, conf));
    cur.used = cur.used || used;
    if (!error) delete cur.error;
  };
  for (const h of fused.hypotheses) add(h.method, h.methodVersion, h.conf, fused.sources.includes(h.method), h.error);
  for (const h of cols.hyps) add(h.method, h.methodVersion, h.conf, cols.sources.includes(h.method), h.error);
  return METHOD_IDS.filter((m) => by.has(m)).map((m) => by.get(m)!);
}
