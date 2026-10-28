/**
 * The legacy projection of a structure model (table pipeline PLAN §1.3 E-5, §2.3; WP-3.H).
 *
 * Every commit writes `ParsedRegion.data = {...legacyView(model), structure, links, engine, recipe, ops}`,
 * so every consumer that has not moved to the engine keeps reading the shapes it always read:
 *   schedule → ScheduleData `{headers, rows, tagColumn, rowCount, columnCount, colBoundaries, rowBoundaries}`
 *   keynote  → the Manual/Auto KeynoteData shape: the grid above + `keynotes[{key, description}]` + `isPageSpecific`
 *   legend   → the grid + `symbols[{yoloClass, description}]` when rows are keyed by a YOLO symbol
 *   notes    → NotesData `{headers: ["Key","Note"], rows: [{Key, Note}], tagColumn: "Key", …}`
 *   spec     → SpecData `{sections: [{sectionHeader, body}]}`
 * Header labels are deduped (K06, `parse-engine/headers` `uniqueHeaders`, the one copy; client-safe, E-8),
 * and table projections always carry `colBoundaries`/`rowBoundaries` (K14).
 *
 * `viewHash(data)` hashes the LEGACY part of a stored `data` object (every key except the engine's own
 * `structure/links/engine/recipe/ops`). Commit stores it in `links.viewHash`; `readStructure` trusts
 * `data.structure` only while the stored projection still hashes to it, so a later classic edit makes the
 * region read as "edited in Classic" (`read.ts`). Pure and deterministic (E-7): sorted-key JSON, no clock.
 */

import { uniqueHeaders } from "./headers";
import type { Paragraph, StructureModel, StructureParagraphDoc, StructureTableModel } from "./types";

/** The keys an engine commit adds next to the projection (`RegionDataExt`); never part of the view. */
export const REGION_DATA_EXT_KEYS = ["structure", "links", "engine", "recipe", "ops"] as const;

export interface LegacyGridView {
  headers: string[];
  rows: Record<string, string>[];
  tagColumn?: string;
  tableName?: string;
  rowCount: number;
  columnCount: number;
  colBoundaries: number[];
  rowBoundaries: number[];
}
export interface LegacyKeynoteView extends LegacyGridView {
  keynotes: { key: string; description: string }[];
  isPageSpecific: boolean;
}
export interface LegacyLegendView extends LegacyGridView {
  symbols?: { yoloClass: string; description: string }[];
}
export interface LegacyNotesView {
  headers: ["Key", "Note"];
  rows: { Key: string; Note: string }[];
  tagColumn: "Key";
  tableName?: string;
  rowCount: number;
  columnCount: 2;
  rowBoundaries?: number[];
}
export interface LegacySpecView {
  sections: { sectionHeader: string; body: string }[];
  tableName?: string;
}
export type LegacyView = LegacyGridView | LegacyKeynoteView | LegacyLegendView | LegacyNotesView | LegacySpecView;

export interface LegacyViewOptions {
  /** The region's display name (`tableName`); defaults to the model's title. */
  tableName?: string;
}

/**
 * K06 header dedupe. One implementation: `parse-engine/headers` `uniqueHeaders` (WP-3.B moved it there from
 * `lib/table-headers.ts`, which re-exports it). Kept under this name for `read.ts`; parity-tested.
 */
export function dedupeHeaderLabels(headers: readonly string[]): string[] {
  return uniqueHeaders(headers);
}

function isParagraphDoc(model: StructureModel): model is StructureParagraphDoc {
  return model.kind === "notes" || model.kind === "spec";
}

/** Project a committed model to the legacy `data` shape its kind has always been read as. */
export function legacyView(model: StructureModel, options: LegacyViewOptions = {}): LegacyView {
  const tableName = options.tableName ?? model.title?.text;
  if (isParagraphDoc(model)) return model.kind === "spec" ? specView(model, tableName) : notesView(model, tableName);
  return tableView(model, tableName);
}

function withName<T extends object>(view: T, tableName: string | undefined): T {
  return tableName ? { ...view, tableName } : view;
}

function rowBandBoundaries(bands: { y0: number; y1: number }[]): number[] {
  if (bands.length === 0) return [];
  return [bands[0].y0, ...bands.map((b) => b.y1)];
}

function tableView(model: StructureTableModel, tableName: string | undefined): LegacyGridView | LegacyKeynoteView | LegacyLegendView {
  const cols = [...model.cols].sort((a, b) => a.x0 - b.x0);
  const headers = dedupeHeaderLabels(cols.map((c) => c.label));
  const labelOf = new Map(cols.map((c, i) => [c.id, headers[i]]));
  const cellText = new Map(model.cells.map((c) => [`${c.row}\u0000${c.col}`, c.text]));
  const multiPart = (model.parts?.length ?? 0) > 1;
  const bands = model.rows.filter((r) => !multiPart || (r.part ?? 0) === 0).sort((a, b) => a.y0 - b.y0);
  const body = model.rows.filter((r) => r.role !== "header");
  const rows = body.map((r) => {
    const rec: Record<string, string> = {};
    for (const c of cols) rec[labelOf.get(c.id) as string] = cellText.get(`${r.id}\u0000${c.id}`) ?? "";
    return rec;
  });
  const tagLabel = model.tag ? labelOf.get(model.tag.col) : undefined;
  const grid: LegacyGridView = withName({
    headers,
    rows,
    ...(tagLabel ? { tagColumn: tagLabel } : {}),
    rowCount: rows.length,
    columnCount: headers.length,
    colBoundaries: cols.length ? [cols[0].x0, ...cols.map((c) => c.x1)] : [],
    rowBoundaries: rowBandBoundaries(bands),
  }, tableName);
  if (model.kind === "keynote") {
    const keyLabel = tagLabel ?? headers[0];
    const keynotes = rows.map((rec) => ({
      key: (keyLabel ? rec[keyLabel] : "") ?? "",
      description: headers.filter((h) => h !== keyLabel).map((h) => rec[h]).filter((t) => t && t.trim()).join(" "),
    }));
    return { ...grid, keynotes, isPageSpecific: (model.tag?.scope ?? "sheet") === "sheet" };
  }
  if (model.kind === "legend") {
    const symbols: { yoloClass: string; description: string }[] = [];
    body.forEach((r, i) => {
      if (r.key?.kind !== "symbol" || !r.key.yoloClass) return;
      const rec = rows[i];
      symbols.push({ yoloClass: r.key.yoloClass, description: headers.map((h) => rec[h]).filter((t) => t && t.trim()).join(" ") });
    });
    return symbols.length ? { ...grid, symbols } : grid;
  }
  return grid;
}

/** A paragraph as a flattened legacy line; a bare letter or number key gets its printed period back ("A." / "1."). */
function paragraphLine(p: Paragraph): string {
  if (!p.key) return p.text;
  const key = /^([A-Za-z]|\d+)$/.test(p.key) ? `${p.key}.` : p.key;
  return `${key} ${p.text}`.trim();
}

function notesView(model: StructureParagraphDoc, tableName: string | undefined): LegacyNotesView {
  const paragraphs = [...model.paragraphs];
  const rows = paragraphs.map((p) => ({ Key: p.key ?? "", Note: p.text }));
  const bands = paragraphs.map((p) => ({ y0: p.b[1], y1: p.b[3] }));
  const monotonic = bands.every((b, i) => i === 0 || b.y0 >= bands[i - 1].y0);
  return withName({
    headers: ["Key", "Note"] as ["Key", "Note"],
    rows,
    tagColumn: "Key" as const,
    rowCount: rows.length,
    columnCount: 2 as const,
    ...(bands.length && monotonic ? { rowBoundaries: rowBandBoundaries(bands) } : {}),
  }, tableName ?? model.blocks.find((b) => b.header)?.header ?? undefined);
}

function specView(model: StructureParagraphDoc, tableName: string | undefined): LegacySpecView {
  const fallbackHeader = model.spec?.section ? `SECTION ${model.spec.section}` : (tableName ?? "");
  const sections = model.blocks.map((block) => ({
    sectionHeader: block.header ?? fallbackHeader,
    body: model.paragraphs.filter((p) => p.blockId === block.id).map(paragraphLine).join("\n"),
  }));
  const orphans = model.paragraphs.filter((p) => !model.blocks.some((b) => b.id === p.blockId));
  if (orphans.length) sections.push({ sectionHeader: fallbackHeader, body: orphans.map(paragraphLine).join("\n") });
  return withName({ sections }, tableName);
}

// ── viewHash ────────────────────────────────────────────────────────────────────────────────────

/** JSON with sorted object keys and `undefined` members dropped, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
}

/** cyrb53 (public-domain string hash), seeded; 53 bits as 14 hex digits. Not cryptographic: it detects edits. */
function cyrb53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The legacy part of a stored region `data`: every key except the engine extension keys. */
export function legacyPart(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (!(REGION_DATA_EXT_KEYS as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}

/** `links.viewHash` of a legacy projection (or of a full stored `data`; the extension keys are ignored). */
export function viewHash(data: unknown): string {
  const text = canonicalJson(legacyPart(data));
  return `vh1:${cyrb53(text, 1)}${cyrb53(text, 2)}`;
}
