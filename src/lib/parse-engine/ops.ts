/**
 * Correction ops (table pipeline PLAN §1.1 rows 12 and 20, §1.3 E-2, §2.1; WP-3.D fills the WP-2.E stub, rule 13).
 * Pure and client-safe (E-8): the workspace previews every op in the browser by re-applying the op list to the last
 * `ParseResult` (its model, its `alternatives[].geometry` and its region `words`); the commit (WP-3.G) re-applies
 * the same list on the server. No op needs a fetch.
 *
 * Ops are applied AFTER fusion and always win. They are keyed by minted ids (`r<n>`, `c<n>`, `p<n>`), never by
 * index, so a list recorded on one parse lands on a re-parse whose ids were re-matched through `prior`.
 *
 * Tables are applied in two phases, so a text edit survives a later line move:
 * 1. **geometry**, in list order — `pin-source` (an alternative's lines on that axis, a column pin framed by the box
 *    edges as fusion does; `method: null` = back to the fused axis), `set-lines` (an axis wholesale: classic Guided import, replay), `move-line` (the boundary BELOW row
 *    / RIGHT of column `after`; on the last row / column it moves the outer edge), `add-line` (splits the band that
 *    holds `at` strictly inside; the upper / left part keeps its id, the other part gets a new id), `remove-line`
 *    (merges `after` with the next band of the same part; `after` keeps its id), `user-boxes` ("Draw cells": the
 *    drawn row / column boxes become the axis, a box per band, gaps split at their middle; an empty list leaves that
 *    axis alone), `merge-cells` (a span anchored at row × col; `rs = cs = 1` unmerges), `set-header-rows` (the first
 *    n rows of part 0 are the header). Axis replacements act on part 0 (the main box; `alternatives` are measured
 *    there); re-matched ids keep their key and CSI. When any geometry op lands, the cells are re-assembled from the
 *    result's words and the labels re-read from the header rows (`assemble.ts`, the engine's own step);
 * 2. **overlays**, in list order on the final grid — `set-tag-col`, `set-tag-scope`, `set-col-role`, `rename-col`
 *    (K06-unique), `edit-cell` (src `edit`), `set-row-key`, `set-csi`, `set-title`, `set-kind` (same family only:
 *    schedule / keynote / legend, or notes / spec).
 * Paragraph documents take their ops in list order: `split-paragraph` (lines `[atLine…]` become a new paragraph,
 * keyed by its first line's key when it has one), `merge-paragraph` (the paragraph joins the PREVIOUS paragraph of
 * its block, its printed key becoming text), `set-paragraph-key`, `mark-block-header` (the line at `lineIndex` of
 * `paragraphLines(doc, words)` heads a new block; the paragraphs after it in its block move under it), `set-csi`,
 * `set-title`, `set-kind`.
 *
 * When the ops change any band (id or extent), the result carries `opsBase`: the base's band ids, the ids the ops were
 * recorded on. A re-parse with the result as `prior` re-matches against them (`engine-table.ts`, `engine-paragraphs.ts`),
 * so replaying the same list mints the same ids again (WP-3.D verify HIGH-1).
 *
 * An op whose target no longer exists (an id gone, a cross-family `set-kind`, an index out of range) does not land:
 * `applyOpsDetailed` reports `landed[i] = false` and leaves the model as it was for that op. The commit refuses a
 * rebase only when an op no longer lands (PLAN §5 WP-3.G step 3). `add-line` / `remove-line` / `split-paragraph` /
 * `merge-paragraph` are not idempotent by nature (a second "remove the line after r2" removes the next one); every
 * other op is.
 */

import {
  assembleTable,
  geometryOf,
  leadingHeaderRows,
  nextId,
  rematchBands,
  rowsOfPart,
  type TableGeometry,
} from "./assemble";
import { centreIn, unionBox } from "./geometry";
import { renamedHeader } from "./headers";
import { wordsToLines, type WordLine } from "./lines";
import { matchKey, normaliseHeader, normaliseKey } from "./paragraphs/keys";
import {
  PARSE_ENGINE_CAPS,
  type Axis,
  type BboxMinMax,
  type CorrectionOp,
  type MethodId,
  type Paragraph,
  type ParagraphOpsBase,
  type ParseResult,
  type StructureModel,
  type StructureParagraphDoc,
  type StructureRow,
  type StructureTableModel,
  type TableOpsBase,
} from "./types";

export interface ApplyOpsResult {
  model: StructureModel;
  /** One entry per op: did it land on this model? */
  landed: boolean[];
}

type Words = ParseResult["words"];
type Op<K extends CorrectionOp["op"]> = Extract<CorrectionOp, { op: K }>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isTable = (m: StructureModel): m is StructureTableModel => m.kind === "schedule" || m.kind === "keynote" || m.kind === "legend";
const TABLE_KINDS = new Set(["schedule", "keynote", "legend"]);
const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Sorted, de-duplicated, finite lines; null when fewer than 2 (one band). */
function cleanLines(at: readonly number[]): number[] | null {
  const xs = [...new Set(at.filter(finiteNum).map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b);
  return xs.length >= 2 ? xs : null;
}

/** Lines from drawn boxes: a box per band, consecutive boxes meet at the middle of their gap (or overlap). */
function linesFromBoxes(boxes: readonly BboxMinMax[], lo: 0 | 1): number[] | null {
  const hi = (lo + 2) as 2 | 3;
  const bs = boxes.filter((b) => Array.isArray(b) && b.length === 4 && b.every(finiteNum) && b[hi] > b[lo]).map((b) => [b[lo], b[hi]] as const).sort((a, b) => a[0] - b[0]);
  if (!bs.length) return null;
  const lines = [bs[0][0]];
  for (let i = 0; i + 1 < bs.length; i++) lines.push((bs[i][1] + bs[i + 1][0]) / 2);
  lines.push(bs[bs.length - 1][1]);
  return cleanLines(lines);
}

// ── tables ──────────────────────────────────────────────────────────────────────────────────────

/** Replace part 0's rows (or the columns) with `lines`; ids re-matched to the current axis. `null` → the base model's axis. */
function replaceAxis(g: TableGeometry, axis: Axis, lines: number[] | null, base: StructureTableModel): void {
  if (axis === "cols") {
    if (lines === null) { g.cols = base.cols.map((c) => ({ id: c.id, x0: c.x0, x1: c.x1 })); return; }
    const bands = lines.slice(0, -1).map((a, i) => ({ a, b: lines[i + 1] })).slice(0, PARSE_ENGINE_CAPS.cols);
    const ids = rematchBands(bands, g.cols.map((c) => ({ id: c.id, a: c.x0, b: c.x1 })), "c");
    g.cols = bands.map((b, i) => ({ id: ids[i], x0: b.a, x1: b.b }));
    return;
  }
  const others = g.rows.filter((r) => (r.part ?? 0) !== 0);
  if (lines === null) { g.rows = [...base.rows.filter((r) => (r.part ?? 0) === 0).map((r) => ({ ...r })), ...others]; return; }
  const cur = rowsOfPart(g.rows, 0);
  const header = leadingHeaderRows(g.rows);
  const bands = lines.slice(0, -1).map((a, i) => ({ a, b: lines[i + 1], part: 0 })).slice(0, PARSE_ENGINE_CAPS.rows);
  const ids = rematchBands(bands, cur.map((r) => ({ id: r.id, a: r.y0, b: r.y1, part: 0 })), "r", others.map((r) => r.id));
  const byId = new Map(cur.map((r) => [r.id, r]));
  const rows: StructureRow[] = bands.map((b, i) => {
    const old = byId.get(ids[i]);
    const role: StructureRow["role"] = i < header ? "header" : old && (old.role === "section" || old.role === "footer") ? old.role : "body";
    const row: StructureRow = { id: ids[i], y0: b.a, y1: b.b, role };
    if (old?.key) row.key = old.key;
    if (old?.csi) row.csi = old.csi;
    return row;
  });
  g.rows = [...rows, ...others];
}

type Band = { id: string; lo: number; hi: number; part: number };

function bandsOf(g: TableGeometry, axis: Axis): Band[] {
  return axis === "rows" ? g.rows.map((r) => ({ id: r.id, lo: r.y0, hi: r.y1, part: r.part ?? 0 })) : g.cols.map((c) => ({ id: c.id, lo: c.x0, hi: c.x1, part: 0 }));
}

function setBand(g: TableGeometry, axis: Axis, id: string, lo: number, hi: number): void {
  if (axis === "rows") { const r = g.rows.find((x) => x.id === id)!; r.y0 = lo; r.y1 = hi; }
  else { const c = g.cols.find((x) => x.id === id)!; c.x0 = lo; c.x1 = hi; }
}

function moveLine(g: TableGeometry, op: Op<"move-line">): boolean {
  if (!finiteNum(op.at)) return false;
  const bands = bandsOf(g, op.axis);
  const i = bands.findIndex((b) => b.id === op.after);
  if (i < 0) return false;
  const cur = bands[i];
  const next = bands[i + 1] && bands[i + 1].part === cur.part ? bands[i + 1] : null;
  if (!(op.at > cur.lo)) return false;
  if (next) {
    if (!(op.at < next.hi)) return false;
    setBand(g, op.axis, next.id, op.at, next.hi);
  }
  setBand(g, op.axis, cur.id, cur.lo, op.at);
  return true;
}

function addLine(g: TableGeometry, op: Op<"add-line">): boolean {
  if (!finiteNum(op.at)) return false;
  if (op.axis === "cols") {
    const i = g.cols.findIndex((c) => op.at > c.x0 && op.at < c.x1);
    if (i < 0 || g.cols.length >= PARSE_ENGINE_CAPS.cols) return false;
    const c = g.cols[i];
    g.cols.splice(i + 1, 0, { id: nextId("c", g.cols.map((x) => x.id)), x0: op.at, x1: c.x1 });
    c.x1 = op.at;
    return true;
  }
  const i = g.rows.findIndex((r) => op.at > r.y0 && op.at < r.y1);
  if (i < 0 || g.rows.length >= PARSE_ENGINE_CAPS.rows) return false;
  const r = g.rows[i];
  const lower: StructureRow = { id: nextId("r", g.rows.map((x) => x.id)), y0: op.at, y1: r.y1, role: r.role === "section" ? "body" : r.role };
  if (r.part) lower.part = r.part;
  // a shape key stays with the band that holds its shape
  if (r.key && r.key.kind !== "text" && (r.key.shapeBbox[1] + r.key.shapeBbox[3]) / 2 >= op.at) { lower.key = r.key; delete r.key; }
  r.y1 = op.at;
  g.rows.splice(i + 1, 0, lower);
  return true;
}

function removeLine(g: TableGeometry, op: Op<"remove-line">): boolean {
  if (op.axis === "cols") {
    const i = g.cols.findIndex((c) => c.id === op.after);
    if (i < 0 || i + 1 >= g.cols.length) return false;
    const gone = g.cols[i + 1];
    g.cols[i].x1 = gone.x1;
    g.cols.splice(i + 1, 1);
    g.spans = g.spans.filter((s) => s.col !== gone.id);
    return true;
  }
  const i = g.rows.findIndex((r) => r.id === op.after);
  const next = g.rows[i + 1];
  if (i < 0 || !next || (next.part ?? 0) !== (g.rows[i].part ?? 0)) return false;
  const r = g.rows[i];
  r.y1 = next.y1;
  if (!r.key && next.key) r.key = next.key;
  g.rows.splice(i + 1, 1);
  g.spans = g.spans.filter((s) => s.row !== next.id);
  return true;
}

function mergeCells(g: TableGeometry, op: Op<"merge-cells">): boolean {
  if (!g.rows.some((r) => r.id === op.row) || !g.cols.some((c) => c.id === op.col)) return false;
  if (!Number.isInteger(op.rs) || !Number.isInteger(op.cs) || op.rs < 1 || op.cs < 1) return false;
  g.spans = g.spans.filter((s) => !(s.row === op.row && s.col === op.col));
  if (op.rs > 1 || op.cs > 1) g.spans.unshift({ row: op.row, col: op.col, rs: op.rs, cs: op.cs }); // the user's span wins an overlap
  return true;
}

function setHeaderRows(g: TableGeometry, n: number): boolean {
  const rows0 = rowsOfPart(g.rows, 0);
  if (!Number.isInteger(n) || n < 0 || n > rows0.length) return false;
  rows0.forEach((r, i) => {
    if (i < n) r.role = "header";
    else if (r.role === "header") r.role = "body";
  });
  return true;
}

/** Phase 1 for one op; `null` = not a geometry op. */
function geometryOp(g: TableGeometry, op: CorrectionOp, base: ParseResult, baseModel: StructureTableModel): boolean | null {
  switch (op.op) {
    case "pin-source": {
      if (op.method === null) { replaceAxis(g, op.axis, null, baseModel); return true; }
      const alt = base.alternatives.find((a) => a.method === op.method);
      let lines = alt ? cleanLines(op.axis === "rows" ? alt.geometry.rowLines : alt.geometry.colLines) : null;
      // columns: the box edges are the outer lines, as in fusion (a method's own frame is not a separator)
      if (lines && op.axis === "cols") {
        const [x0, , x1] = baseModel.bbox;
        lines = cleanLines([x0, ...lines.slice(1, -1).filter((x) => x > x0 && x < x1), x1]);
      }
      if (!lines) return false;
      replaceAxis(g, op.axis, lines, baseModel);
      return true;
    }
    case "set-lines": {
      const lines = Array.isArray(op.at) ? cleanLines(op.at) : null;
      if (!lines) return false;
      replaceAxis(g, op.axis, lines, baseModel);
      return true;
    }
    case "move-line": return moveLine(g, op);
    case "add-line": return addLine(g, op);
    case "remove-line": return removeLine(g, op);
    case "user-boxes": {
      const rows = linesFromBoxes(op.rows ?? [], 1);
      const cols = linesFromBoxes(op.cols ?? [], 0);
      if (!rows && !cols) return false;
      if (rows) replaceAxis(g, "rows", rows, baseModel);
      if (cols) replaceAxis(g, "cols", cols, baseModel);
      return true;
    }
    case "merge-cells": return mergeCells(g, op);
    case "set-header-rows": return setHeaderRows(g, op.n);
    default: return null;
  }
}

/** The grid's text source for re-assembled cells: the base cells' commonest machine `src`. */
function gridSrc(model: StructureTableModel): MethodId {
  const count = new Map<MethodId, number>();
  for (const c of model.cells) if (c.src !== "edit") count.set(c.src, (count.get(c.src) ?? 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best ? best[0] : "ocr-lines";
}

function addFlag<T extends { quality: { flags: string[] } }>(m: T, flag: string): T {
  return m.quality.flags.includes(flag) ? m : { ...m, quality: { ...m.quality, flags: [...m.quality.flags, flag].sort() } };
}

function overlayTable(m: StructureTableModel, op: CorrectionOp): boolean {
  const colIdx = (id: string): number => m.cols.findIndex((c) => c.id === id);
  const row = (id: string): StructureRow | undefined => m.rows.find((r) => r.id === id);
  switch (op.op) {
    case "set-tag-col": {
      if (op.col === null) { delete m.tag; return true; }
      if (colIdx(op.col) < 0) return false;
      m.tag = { col: op.col, src: "user", scope: m.tag?.scope ?? (m.kind === "schedule" ? "project" : "sheet") };
      return true;
    }
    case "set-tag-scope": {
      if (!m.tag || (op.scope !== "sheet" && op.scope !== "project")) return false;
      m.tag = { ...m.tag, scope: op.scope };
      return true;
    }
    case "set-col-role": {
      const i = colIdx(op.col);
      if (i < 0) return false;
      if (op.role === null) delete m.cols[i].role;
      else m.cols[i].role = op.role;
      return true;
    }
    case "rename-col": {
      const i = colIdx(op.col);
      if (i < 0 || typeof op.label !== "string") return false;
      m.cols[i].label = renamedHeader(m.cols.map((c) => c.label), i, op.label);
      return true;
    }
    case "edit-cell": {
      const r = m.rows.findIndex((x) => x.id === op.row);
      const c = colIdx(op.col);
      if (r < 0 || c < 0 || typeof op.text !== "string") return false;
      const text = op.text.slice(0, PARSE_ENGINE_CAPS.cellText);
      const ri = new Map(m.rows.map((x, i) => [x.id, i]));
      const ci = new Map(m.cols.map((x, i) => [x.id, i]));
      // a covered band edits its span's anchor
      const owner = m.cells.find((x) => {
        const a = ri.get(x.row);
        const b = ci.get(x.col);
        return a !== undefined && b !== undefined && a <= r && r < a + (x.rs ?? 1) && b <= c && c < b + (x.cs ?? 1);
      });
      if (owner) { owner.text = text; owner.src = "edit"; return true; }
      m.cells.push({ row: op.row, col: op.col, text, src: "edit" });
      m.cells.sort((a, b) => (ri.get(a.row)! - ri.get(b.row)!) || (ci.get(a.col)! - ci.get(b.col)!));
      return true;
    }
    case "set-row-key": {
      const r = row(op.row);
      if (!r || typeof op.text !== "string") return false;
      const text = op.text.trim();
      if (!text) delete r.key;
      else r.key = r.key?.kind === "shape-text" ? { ...r.key, text, textSource: "user" } : { kind: "text", text };
      return true;
    }
    case "set-csi": {
      const r = op.target?.row ? row(op.target.row) : undefined;
      if (!r || !Array.isArray(op.codes)) return false;
      r.csi = clone(op.codes);
      return true;
    }
    case "set-title": return setTitle(m, op);
    case "set-kind": {
      if (!TABLE_KINDS.has(op.kind)) return false;
      m.kind = op.kind as StructureTableModel["kind"];
      if (op.classId) m.classId = op.classId;
      return true;
    }
    default: return false;
  }
}

function setTitle(m: StructureModel, op: Op<"set-title">): boolean {
  if (typeof op.text !== "string") return false;
  const text = op.text.trim();
  if (!text) delete m.title;
  else m.title = { text, src: "user", conf: 1 };
  return true;
}

function applyTableOps(base: ParseResult, model: StructureTableModel, ops: readonly CorrectionOp[], landed: boolean[]): StructureTableModel {
  const g = geometryOf(model);
  let changed = false;
  const overlays: number[] = [];
  ops.forEach((op, i) => {
    const r = geometryOp(g, op, base, model);
    if (r === null) { overlays.push(i); return; }
    landed[i] = r;
    changed = changed || r;
  });
  let out: StructureTableModel = clone(model);
  if (changed) {
    out = assembleTable({
      kind: model.kind, bbox: model.bbox, ...(model.parts ? { parts: model.parts } : {}),
      geometry: g, words: base.words, src: gridSrc(model),
      ...(model.title ? { title: model.title } : {}),
      ...(model.classId ? { classId: model.classId } : {}),
      ...(model.tag ? { tag: model.tag } : {}),
      ...(model.notes ? { notes: model.notes } : {}),
      sources: model.sources, quality: model.quality,
    });
    out = clone(out);
    if (model.tag && !out.tag) out = addFlag(out, "tag-column-removed");
  }
  for (const i of overlays) landed[i] = overlayTable(out, ops[i]);
  return out;
}

// ── paragraphs ──────────────────────────────────────────────────────────────────────────────────

/** A paragraph's visual lines, read from the region words whose centre lies in its box. */
function linesOf(p: Pick<Paragraph, "b">, words: Words): WordLine[] {
  return wordsToLines(words.filter((w) => centreIn(w.b, p.b)));
}

/**
 * The line numbering `mark-block-header` uses: every paragraph's visual lines, in paragraph order (`p` = paragraph
 * id, `line` = index inside it). The workspace's paragraph preview lists lines in this order.
 */
export function paragraphLines(doc: StructureParagraphDoc, words: Words): { p: string; line: number; text: string; b: BboxMinMax }[] {
  return doc.paragraphs.flatMap((p) => linesOf(p, words).map((l, line) => ({ p: p.id, line, text: l.text, b: l.b })));
}

const joinText = (lines: readonly WordLine[]): string => lines.map((l) => l.text).filter(Boolean).join(" ").slice(0, PARSE_ENGINE_CAPS.paragraphText);

/** Paragraph text from lines, the printed key token dropped from the first line when it is `key`. */
function textWithoutKey(lines: readonly WordLine[], key: string | null): string {
  if (!lines.length) return "";
  const km = key ? matchKey(lines[0].text) : null;
  const first = km && km.key === key ? km.rest : lines[0].text;
  return [first, ...lines.slice(1).map((l) => l.text)].filter(Boolean).join(" ").slice(0, PARSE_ENGINE_CAPS.paragraphText);
}

/** The printed text of a paragraph including its key (words when present, else key + text). */
function rawText(p: Paragraph, words: Words): string {
  const lines = linesOf(p, words);
  return lines.length ? joinText(lines) : [p.key ?? "", p.text].filter(Boolean).join(" ");
}

function boxOf(lines: readonly WordLine[], fallback: BboxMinMax): BboxMinMax {
  const u = unionBox(lines.map((l) => l.b));
  return u ? [u[0], u[1], u[2], u[3]] : fallback;
}

/** Split `doc.paragraphs[i]` before line `at`; returns the new paragraph, or null. */
function splitAt(doc: StructureParagraphDoc, i: number, at: number, words: Words): Paragraph | null {
  const p = doc.paragraphs[i];
  const lines = linesOf(p, words);
  if (!Number.isInteger(at) || at < 1 || at >= lines.length || doc.paragraphs.length >= PARSE_ENGINE_CAPS.paragraphs) return null;
  const head = lines.slice(0, at);
  const tail = lines.slice(at);
  const km = matchKey(tail[0].text);
  const key = km ? km.key : null;
  const q: Paragraph = {
    id: nextId("p", doc.paragraphs.map((x) => x.id)),
    blockId: p.blockId,
    key,
    keyPath: key ? [...p.keyPath.slice(0, -1), key] : [],
    keyNorm: normaliseKey(key),
    depth: p.depth,
    text: textWithoutKey(tail, key),
    b: boxOf(tail, p.b),
    lineCount: tail.length,
  };
  p.text = textWithoutKey(head, p.key);
  p.b = boxOf(head, p.b);
  p.lineCount = head.length;
  doc.paragraphs.splice(i + 1, 0, q);
  return q;
}

function markBlockHeader(doc: StructureParagraphDoc, lineIndex: number, words: Words): boolean {
  const all = paragraphLines(doc, words);
  const hit = Number.isInteger(lineIndex) ? all[lineIndex] : undefined;
  if (!hit) return false;
  let i = doc.paragraphs.findIndex((p) => p.id === hit.p);
  if (hit.line > 0) {
    if (!splitAt(doc, i, hit.line, words)) return false;
    i += 1;
  }
  const target = doc.paragraphs[i];
  const lines = linesOf(target, words);
  const oldBlock = target.blockId;
  const block = { id: nextId("b", doc.blocks.map((b) => b.id)), header: hit.text, headerNorm: normaliseHeader(hit.text), b: hit.b };
  if (lines.length > 1) {
    const rest = lines.slice(1);
    const km = matchKey(rest[0].text);
    target.key = km ? km.key : null;
    target.keyPath = target.key ? [target.key] : [];
    target.keyNorm = normaliseKey(target.key);
    target.depth = 0;
    target.text = textWithoutKey(rest, target.key);
    target.b = boxOf(rest, target.b);
    target.lineCount = rest.length;
  } else {
    doc.paragraphs.splice(i, 1);
  }
  for (let k = i; k < doc.paragraphs.length && doc.paragraphs[k].blockId === oldBlock; k++) doc.paragraphs[k].blockId = block.id;
  const at = doc.blocks.findIndex((b) => b.id === oldBlock);
  doc.blocks.splice(at < 0 ? doc.blocks.length : at + 1, 0, block);
  return true;
}

function paragraphOp(doc: StructureParagraphDoc, op: CorrectionOp, words: Words): boolean {
  const idx = (id: string): number => doc.paragraphs.findIndex((p) => p.id === id);
  switch (op.op) {
    case "split-paragraph": {
      const i = idx(op.p);
      return i >= 0 && splitAt(doc, i, op.atLine, words) !== null;
    }
    case "merge-paragraph": {
      const i = idx(op.p);
      if (i < 1) return false;
      const p = doc.paragraphs[i];
      const prev = doc.paragraphs[i - 1];
      if (prev.blockId !== p.blockId) return false;
      prev.text = [prev.text, rawText(p, words)].filter(Boolean).join(" ").slice(0, PARSE_ENGINE_CAPS.paragraphText);
      prev.b = [Math.min(prev.b[0], p.b[0]), Math.min(prev.b[1], p.b[1]), Math.max(prev.b[2], p.b[2]), Math.max(prev.b[3], p.b[3])];
      prev.lineCount += p.lineCount;
      doc.paragraphs.splice(i, 1);
      return true;
    }
    case "set-paragraph-key": {
      const i = idx(op.p);
      if (i < 0) return false;
      const p = doc.paragraphs[i];
      const key = typeof op.key === "string" && op.key.trim() ? op.key.trim() : null;
      if (key === null) {
        p.text = rawText(p, words);
        p.key = null;
        p.keyPath = [];
        p.keyNorm = "";
        return true;
      }
      const lines = linesOf(p, words);
      if (p.key === null && lines.length) p.text = textWithoutKey(lines, key);
      p.key = key;
      p.keyPath = p.keyPath.length ? [...p.keyPath.slice(0, -1), key] : [key];
      p.keyNorm = normaliseKey(key);
      return true;
    }
    case "mark-block-header": return markBlockHeader(doc, op.lineIndex, words);
    case "set-csi": {
      const i = op.target?.p ? idx(op.target.p) : -1;
      if (i < 0 || !Array.isArray(op.codes)) return false;
      doc.paragraphs[i].csi = clone(op.codes);
      return true;
    }
    case "set-title": return setTitle(doc, op);
    case "set-kind": {
      if (op.kind !== "notes" && op.kind !== "spec") return false;
      doc.kind = op.kind;
      if (op.kind === "notes") delete doc.spec;
      return true;
    }
    default: return false;
  }
}

// ── entry points ────────────────────────────────────────────────────────────────────────────────

/** Apply `ops` on top of the fused model in `base` and report which ops landed (see the file header). Pure. */
// ── the machine ids the ops were recorded on (`opsBase`) ──────────────────────────────────────────

function tableIds(m: StructureTableModel): TableOpsBase {
  return {
    rows: m.rows.map((r) => ({ id: r.id, y0: r.y0, y1: r.y1, ...(r.part ? { part: r.part } : {}) })),
    cols: m.cols.map((c) => ({ id: c.id, x0: c.x0, x1: c.x1 })),
  };
}

function paragraphIds(d: StructureParagraphDoc): ParagraphOpsBase {
  return { blocks: d.blocks.map((b) => ({ id: b.id, b: [...b.b] as BboxMinMax })), paragraphs: d.paragraphs.map((p) => ({ id: p.id, b: [...p.b] as BboxMinMax })) };
}

/**
 * `out.opsBase` = the base's own `opsBase` when it has one (the earliest machine bands win), else the base's bands
 * when the ops changed any band id or extent; absent when they changed none (ids then re-match on `out` itself).
 */
function withOpsBase<M extends StructureModel>(base: M, out: M, ids: (m: M) => object): M {
  delete out.opsBase;
  if (base.opsBase) { out.opsBase = clone(base.opsBase); return out; }
  const b = ids(base);
  if (JSON.stringify(b) !== JSON.stringify(ids(out))) out.opsBase = b as M["opsBase"];
  return out;
}

export function applyOpsDetailed(base: ParseResult, ops: readonly CorrectionOp[]): ApplyOpsResult {
  const landed = ops.map(() => false);
  const list = ops.slice(0, PARSE_ENGINE_CAPS.ops);
  if (isTable(base.model)) return { model: withOpsBase(base.model, applyTableOps(base, base.model, list, landed), tableIds), landed };
  const doc = clone(base.model);
  list.forEach((op, i) => { landed[i] = paragraphOp(doc, op, base.words); });
  return { model: withOpsBase(base.model, doc, paragraphIds), landed };
}

/** Apply `ops` in order, by id, on top of the fused model in `base` (user corrections always win). Pure. */
export function applyOps(base: ParseResult, ops: readonly CorrectionOp[]): StructureModel {
  return applyOpsDetailed(base, ops).model;
}
