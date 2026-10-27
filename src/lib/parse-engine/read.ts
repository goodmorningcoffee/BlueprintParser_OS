/**
 * The one structure reader for a saved region (table pipeline PLAN §2.3; WP-3.H, C1-B2).
 *
 * `readStructure(region)` returns the committed `data.structure` only while the stored legacy projection
 * still hashes to `data.links.viewHash` (`legacy-view.ts`). Otherwise — a classic save, or an engine
 * region that a classic editor changed afterwards — it lifts the legacy data with `fromLegacy` and flags
 * the result `origin: "classic"` (the second case also `editedInClassic`, which the inbox shows as
 * "edited in Classic").
 *
 * `fromLegacy` is the ONE place every legacy shape is lifted, so classic saves enter the keyed-item index:
 *   keynote: Manual/Auto `{headers:["Key","Description"], rows, keynotes[], isPageSpecific}` · Guided
 *            `{headers:["Column 1",…], rows}` (no printed header row) · the bare `{keynotes[]}` list;
 *   notes:   `{Key,Note}` · `{Key,Value}` · `Column N` · `{Key,Note,ColN}` grids · the pre-Stage-3
 *            `{title, notes: string[]}` list;
 *   spec:    `SpecData.sections[{sectionHeader, body}]` (the `1.01`/`A.`/`1.` path flattened into `body`
 *            is re-split into keyed paragraphs);
 *   schedule / legend grids, and the legend `{symbols[{yoloClass, description}]}` list.
 * Geometry a legacy row never stored (no `rowBoundaries`) is spread evenly over the box and flagged
 * `lifted-geometry`. Over-cap models are truncated with the flag `truncated` (§2.1 caps).
 *
 * Client-safe (E-8): imports only the parse-engine subset. Pure and deterministic.
 */

import { dedupeHeaderLabels, viewHash } from "./legacy-view";
import {
  PARSE_ENGINE_CAPS,
  type BboxMinMax,
  type Paragraph,
  type ParagraphBlock,
  type RegionLinks,
  type StructureCell,
  type StructureCol,
  type StructureKind,
  type StructureModel,
  type StructureParagraphDoc,
  type StructureRow,
  type StructureTableModel,
} from "./types";

/** The fields of a stored `ParsedRegion` this reader needs (structural: `@/types` is outside the subset). */
export interface StoredRegionLike {
  id?: string;
  type?: string;
  category?: string;
  bbox?: readonly number[] | null;
  confidence?: number;
  data?: unknown;
}

export interface ReadStructureResult {
  /** null when the stored data has nothing liftable. */
  model: StructureModel | null;
  origin: "workspace" | "classic";
  /** The region carries an engine `structure` whose legacy projection was changed after commit. */
  editedInClassic: boolean;
  links?: RegionLinks;
}

export const LIFTED_FLAG = "from-legacy";
export const LIFTED_GEOMETRY_FLAG = "lifted-geometry";
export const TRUNCATED_FLAG = "truncated";

const KINDS: readonly StructureKind[] = ["schedule", "keynote", "legend", "notes", "spec"];

// ── keys ────────────────────────────────────────────────────────────────────────────────────────

/** Item-key normalisation for the keyed-item index: "K-01" → "K01", "(4)" → "4", "A." → "A", "2.3" stays. */
export function itemKeyNorm(key: string | null | undefined): string {
  if (typeof key !== "string") return "";
  return key.trim().toUpperCase().replace(/^[([{]+/, "").replace(/[)\]}.:,;]+$/, "").replace(/[\s\-_]/g, "");
}

/** Block-header normalisation: upper case, single spaces, no trailing colon. */
export function headerNorm(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const n = header.toUpperCase().replace(/\s+/g, " ").replace(/[\s:]+$/, "").trim();
  return n || null;
}

/** A MasterFormat section number in a header ("SECTION 08 71 00 - DOOR HARDWARE") → "08 71 00", else null. */
export function specSectionOf(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const m = /(?:^|[^\d])(\d{2})\s?(\d{2})\s?(\d{2})(?![\d])/.exec(text);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : null;
}

/** The `specSections` index key of a section number: digits only ("08 71 00" → "087100"). */
export function sectionNorm(section: string): string {
  return section.replace(/\D/g, "");
}

/** A leading item key on a legacy note / spec line: "1.", "(4)", "A.", "1.01", "K-01". */
const LEADING_KEY = /^\s*(\(\s*[A-Za-z0-9]{1,3}\s*\)|[A-Z]{1,2}-\d{1,3}\.?|\d{1,3}(?:\.\d{1,3})+\.?|\d{1,3}[.)]|[A-Za-z][.)])\s+(.*)$/;

export function splitLeadingKey(line: string): { key: string | null; rest: string } {
  const m = LEADING_KEY.exec(line);
  if (!m) return { key: null, rest: line.trim() };
  const key = m[1].replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1").replace(/[.)]$/, "");
  return { key: key || null, rest: m[2].trim() };
}

// ── readStructure ───────────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isModel(v: unknown): v is StructureModel {
  const m = asRecord(v);
  if (!m || m.v !== 1 || !KINDS.includes(m.kind as StructureKind)) return false;
  return m.kind === "notes" || m.kind === "spec"
    ? Array.isArray(m.paragraphs) && Array.isArray(m.blocks)
    : Array.isArray(m.rows) && Array.isArray(m.cols) && Array.isArray(m.cells);
}

export function readStructure(region: StoredRegionLike): ReadStructureResult {
  const data = asRecord(region.data);
  const links = asRecord(data?.links) as RegionLinks | null;
  const structure = data?.structure;
  if (isModel(structure)) {
    if (links && typeof links.viewHash === "string" && viewHash(data) === links.viewHash) {
      return { model: structure, origin: "workspace", editedInClassic: false, links };
    }
    return { model: fromLegacy(region), origin: "classic", editedInClassic: true, ...(links ? { links } : {}) };
  }
  return { model: fromLegacy(region), origin: "classic", editedInClassic: false };
}

// ── fromLegacy ──────────────────────────────────────────────────────────────────────────────────

function boxOf(region: StoredRegionLike): BboxMinMax {
  const b = region.bbox;
  if (Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return [b[0], b[1], b[2], b[3]];
  }
  return [0, 0, 1, 1];
}

function numbers(v: unknown): number[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : null;
}

/** `n` bands from stored boundaries when they fit (`n + 1` values, or `n + 2` with a leading header band), else an even split. */
function bands(stored: number[] | null, n: number, lo: number, hi: number, skipLeading: boolean): { at: number[]; lifted: boolean } {
  if (stored && stored.length === n + 1) return { at: stored, lifted: false };
  if (skipLeading && stored && stored.length === n + 2) return { at: stored.slice(1), lifted: false };
  const step = n > 0 ? (hi - lo) / n : 0;
  return { at: Array.from({ length: n + 1 }, (_, i) => lo + step * i), lifted: n > 0 };
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

function quality(region: StoredRegionLike, flags: string[]): StructureTableModel["quality"] {
  const conf = typeof region.confidence === "number" && Number.isFinite(region.confidence) ? region.confidence : 0;
  return { conf, agreement: 1, flags: [LIFTED_FLAG, ...flags] };
}

function titleOf(text: unknown): StructureModel["title"] | undefined {
  return typeof text === "string" && text.trim() ? { text: text.trim(), src: "user", conf: 1 } : undefined;
}

const GUIDED_HEADER = /^Column \d+$/;

interface GridInput {
  kind: StructureTableModel["kind"];
  headers: string[];
  rows: Record<string, unknown>[];
  tagColumn?: string;
  scope: "sheet" | "project";
  colBoundaries: number[] | null;
  rowBoundaries: number[] | null;
  title?: unknown;
  symbolKeys?: (string | null)[];
}

function liftGrid(region: StoredRegionLike, g: GridInput): StructureTableModel {
  const bbox = boxOf(region);
  const flags: string[] = [];
  let headersRaw = g.headers;
  let rowsIn = g.rows;
  if (headersRaw.length > PARSE_ENGINE_CAPS.cols) { headersRaw = headersRaw.slice(0, PARSE_ENGINE_CAPS.cols); flags.push(TRUNCATED_FLAG); }
  const headerRows = headersRaw.length > 0 && !headersRaw.every((h) => GUIDED_HEADER.test(h)) ? 1 : 0;
  if (rowsIn.length + headerRows > PARSE_ENGINE_CAPS.rows) {
    rowsIn = rowsIn.slice(0, PARSE_ENGINE_CAPS.rows - headerRows);
    if (!flags.includes(TRUNCATED_FLAG)) flags.push(TRUNCATED_FLAG);
  }
  const labels = dedupeHeaderLabels(headersRaw);
  const xs = bands(g.colBoundaries, labels.length, bbox[0], bbox[2], false);
  const ys = bands(g.rowBoundaries, rowsIn.length + headerRows, bbox[1], bbox[3], headerRows === 0);
  if (xs.lifted || ys.lifted) flags.push(LIFTED_GEOMETRY_FLAG);
  const cols: StructureCol[] = labels.map((label, i) => ({ id: `c${i}`, x0: xs.at[i], x1: xs.at[i + 1], label, labelRaw: str(headersRaw[i]) }));
  const tagIdx = g.tagColumn !== undefined ? headersRaw.findIndex((h) => h === g.tagColumn) : -1;
  const rows: StructureRow[] = [];
  const cells: StructureCell[] = [];
  if (headerRows) {
    rows.push({ id: "r0", y0: ys.at[0], y1: ys.at[1], role: "header" });
    cols.forEach((c) => cells.push({ row: "r0", col: c.id, text: clip(c.labelRaw, PARSE_ENGINE_CAPS.cellText), src: "edit" }));
  }
  rowsIn.forEach((rec, j) => {
    const i = j + headerRows;
    const id = `r${i}`;
    const row: StructureRow = { id, y0: ys.at[i], y1: ys.at[i + 1], role: "body" };
    cols.forEach((c, ci) => {
      const text = clip(str(rec[headersRaw[ci]]), PARSE_ENGINE_CAPS.cellText);
      cells.push({ row: id, col: c.id, text, src: "edit" });
      if (ci === tagIdx && text.trim()) row.key = { kind: "text", text: text.trim() };
    });
    const symbol = g.symbolKeys?.[j];
    if (symbol) row.key = { kind: "symbol", shapeBbox: [bbox[0], row.y0, bbox[2], row.y1], yoloClass: symbol };
    rows.push(row);
  });
  const model: StructureTableModel = {
    v: 1, kind: g.kind, bbox, rows, cols, cells, headerRows,
    sources: { rows: [], cols: [] },
    quality: quality(region, flags),
  };
  const title = titleOf(g.title);
  if (title) model.title = title;
  if (tagIdx >= 0) model.tag = { col: cols[tagIdx].id, src: "user", scope: g.scope };
  return model;
}

interface LiftedParagraph { key: string | null; text: string; blockIdx: number }

function keyPathOf(key: string | null, stack: string[], spec: boolean): { keyPath: string[]; depth: number } {
  if (!key) return { keyPath: stack.filter(Boolean), depth: stack.length };
  if (!spec) return { keyPath: [key], depth: 0 };
  // Spec hierarchy: "1.01" article › "A" paragraph › "1" sub-paragraph › "a" sub-sub-paragraph.
  const k = key;
  const level = /^\d+\.\d+$/.test(k) ? 0 : /^[A-Z]$/.test(k) ? 1 : /^\d+$/.test(k) ? 2 : /^[a-z]$/.test(k) ? 3 : 0;
  stack.length = Math.min(stack.length, level);
  while (stack.length < level) stack.push("");
  stack.push(k);
  return { keyPath: stack.filter(Boolean), depth: level };
}

function liftParagraphs(
  region: StoredRegionLike,
  kind: "notes" | "spec",
  blockHeaders: (string | null)[],
  items: LiftedParagraph[],
  rowBoundaries: number[] | null,
  title: unknown,
): StructureParagraphDoc {
  const bbox = boxOf(region);
  const flags: string[] = [];
  let list = items;
  if (list.length > PARSE_ENGINE_CAPS.paragraphs) { list = list.slice(0, PARSE_ENGINE_CAPS.paragraphs); flags.push(TRUNCATED_FLAG); }
  const ys = bands(rowBoundaries, list.length, bbox[1], bbox[3], true);
  if (ys.lifted) flags.push(LIFTED_GEOMETRY_FLAG);
  const blocks: ParagraphBlock[] = blockHeaders.map((h, i) => ({ id: `b${i + 1}`, header: h, headerNorm: headerNorm(h), b: bbox }));
  const stacks = new Map<number, string[]>();
  const paragraphs: Paragraph[] = list.map((it, i) => {
    const stack = stacks.get(it.blockIdx) ?? [];
    stacks.set(it.blockIdx, stack);
    const { keyPath, depth } = keyPathOf(it.key, stack, kind === "spec");
    const text = clip(it.text, PARSE_ENGINE_CAPS.paragraphText);
    return {
      id: `p${i + 1}`, blockId: blocks[it.blockIdx]?.id ?? "b1", key: it.key, keyPath,
      keyNorm: it.key ? (kind === "spec" ? keyPath.join(".") : itemKeyNorm(it.key)) : "",
      depth, text, b: [bbox[0], ys.at[i], bbox[2], ys.at[i + 1]],
      lineCount: Math.max(1, text.split("\n").length),
    };
  });
  const doc: StructureParagraphDoc = {
    v: 1, kind, bbox, blocks: blocks.length ? blocks : [{ id: "b1", header: null, headerNorm: null, b: bbox }], paragraphs,
    sources: { segment: [] }, quality: quality(region, flags),
  };
  const t = titleOf(title);
  if (t) doc.title = t;
  if (kind === "spec") {
    const section = blockHeaders.map(specSectionOf).find(Boolean) ?? specSectionOf(typeof title === "string" ? title : null);
    if (section) doc.spec = { section };
  }
  return doc;
}

function gridOf(data: Record<string, unknown>): { headers: string[]; rows: Record<string, unknown>[] } | null {
  if (!Array.isArray(data.headers) || !Array.isArray(data.rows)) return null;
  return {
    headers: data.headers.map(str),
    rows: data.rows.filter((r): r is Record<string, unknown> => !!asRecord(r)),
  };
}

/** Grid notes (`{Key,Note}`, `{Key,Value}`, `Column N`, `{Key,Note,ColN}`) → keyed paragraphs. */
function notesFromGrid(data: Record<string, unknown>, grid: { headers: string[]; rows: Record<string, unknown>[] }): LiftedParagraph[] {
  const tag = typeof data.tagColumn === "string" && grid.headers.includes(data.tagColumn) ? data.tagColumn : grid.headers.find((h) => /^key$/i.test(h.trim()));
  const textCols = grid.headers.filter((h) => h !== tag);
  return grid.rows.map((rec) => {
    const key = tag ? str(rec[tag]).trim() || null : null;
    const text = textCols.map((h) => str(rec[h]).trim()).filter(Boolean).join(" ");
    if (key || tag) return { key, text, blockIdx: 0 };
    const split = splitLeadingKey(text);
    return { key: split.key, text: split.rest, blockIdx: 0 };
  });
}

/** Split a flattened spec `body` into keyed paragraphs (a keyed line opens one; other lines continue it). */
function specParagraphs(body: string, blockIdx: number): LiftedParagraph[] {
  const out: LiftedParagraph[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const { key, rest } = splitLeadingKey(line);
    if (key || out.length === 0 || out[out.length - 1].blockIdx !== blockIdx) out.push({ key, text: key ? rest : line, blockIdx });
    else out[out.length - 1].text += `\n${line}`;
  }
  return out;
}

/** Lift any legacy `ParsedRegion.data` into a structure model (`origin: "classic"`); null when nothing is liftable. */
export function fromLegacy(region: StoredRegionLike): StructureModel | null {
  const data = asRecord(region.data);
  if (!data) return null;
  const type = KINDS.includes(region.type as StructureKind) ? (region.type as StructureKind) : "schedule";
  const title = data.tableName ?? data.title;
  const colB = numbers(data.colBoundaries);
  const rowB = numbers(data.rowBoundaries);
  const grid = gridOf(data);

  if (type === "spec") {
    const sections = Array.isArray(data.sections) ? data.sections.map(asRecord).filter((s): s is Record<string, unknown> => !!s) : [];
    if (!sections.length) return null;
    const items = sections.flatMap((s, i) => specParagraphs(str(s.body), i));
    return liftParagraphs(region, "spec", sections.map((s) => str(s.sectionHeader).trim() || null), items, null, title);
  }
  if (type === "notes") {
    if (grid) return liftParagraphs(region, "notes", [typeof title === "string" ? title : null], notesFromGrid(data, grid), rowB, title);
    if (Array.isArray(data.notes)) {
      const items = data.notes.map(str).map((n) => splitLeadingKey(n)).map((s) => ({ key: s.key, text: s.rest, blockIdx: 0 }));
      return liftParagraphs(region, "notes", [typeof title === "string" ? title : null], items, rowB, title);
    }
    return null;
  }
  if (type === "keynote") {
    const scope = data.isPageSpecific === false ? "project" : "sheet";
    if (grid) {
      const tagColumn = typeof data.tagColumn === "string" ? data.tagColumn : grid.headers[0];
      return liftGrid(region, { kind: "keynote", ...grid, tagColumn, scope, colBoundaries: colB, rowBoundaries: rowB, title });
    }
    if (Array.isArray(data.keynotes)) {
      const rows = data.keynotes.map(asRecord).filter((k): k is Record<string, unknown> => !!k).map((k) => ({ Key: str(k.key), Description: str(k.description) }));
      return liftGrid(region, { kind: "keynote", headers: ["Key", "Description"], rows, tagColumn: "Key", scope, colBoundaries: colB, rowBoundaries: rowB, title });
    }
    return null;
  }
  if (type === "legend") {
    if (grid) {
      const tagColumn = typeof data.tagColumn === "string" ? data.tagColumn : undefined;
      return liftGrid(region, { kind: "legend", ...grid, tagColumn, scope: "sheet", colBoundaries: colB, rowBoundaries: rowB, title });
    }
    if (Array.isArray(data.symbols)) {
      const syms = data.symbols.map(asRecord).filter((s): s is Record<string, unknown> => !!s);
      const rows = syms.map((s) => ({ Symbol: str(s.yoloClass), Description: str(s.description) }));
      return liftGrid(region, {
        kind: "legend", headers: ["Symbol", "Description"], rows, tagColumn: "Symbol", scope: "sheet",
        colBoundaries: colB, rowBoundaries: rowB, title, symbolKeys: syms.map((s) => str(s.yoloClass) || null),
      });
    }
    return null;
  }
  if (!grid) return null;
  const tagColumn = typeof data.tagColumn === "string" ? data.tagColumn : undefined;
  return liftGrid(region, { kind: "schedule", ...grid, tagColumn, scope: "project", colBoundaries: colB, rowBoundaries: rowB, title });
}
