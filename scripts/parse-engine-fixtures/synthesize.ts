#!/usr/bin/env -S npx tsx
/**
 * synthesize.ts — layout → synthetic page slice (table-pipeline WP-2.0a; PLAN §1.6 rule 12).
 *
 * BP2 is public, so no real drawing text (OCR words, cell text, titles, notes) may ever be committed under
 * src/, eval/ or scripts/. Parser fixtures are therefore SYNTHETIC: this script keeps the geometry of a page
 * slice and replaces every word with deterministic pseudo-text of the same character classes.
 *
 *   npx tsx scripts/parse-engine-fixtures/synthesize.ts --layouts [--out <dir>] [--check]
 *       render every hand-written layout in ./layouts.ts → <dir>/<id>.synthetic.json
 *       (default dir src/lib/parse-engine/__fixtures__). --check writes nothing and exits 1 on any drift.
 *   npx tsx scripts/parse-engine-fixtures/synthesize.ts --from <real-slice.json> --out <file.synthetic.json>
 *       pseudonymize a real page slice (same `bp-parse-fixture/1` shape, `synthetic:false`). Used by the
 *       docs-repo task that turns private slices into shareable ones. The input never enters BP2.
 *
 * Pseudo-text rules (per whitespace token; the map depends on the token only, so a repeated word stays
 * repeated and duplicate headers stay duplicate):
 *   - generic schedule/notes vocabulary (VOCAB: TAG, MARK, TYPE, NOTES, SECTION, PART, …) is kept, because
 *     the legacy header and section detectors key on it and it names no project;
 *   - key-like tokens are kept: `1.` `2.3` `1.01` `a.` `(b)` `A`;
 *   - numeric tokens are kept: `3'-0"` `08` `1:50` `2.5`;
 *   - tag-like tokens keep their pattern and digits, letters change: `EF-10` → `QX-10`;
 *   - every other letter → a pseudo letter of the same case, every other digit → a pseudo digit,
 *     punctuation kept. Length is preserved.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TextractLine, TextractPageData, TextractTable, TextractWord } from "@/types";
import { LAYOUTS } from "./layouts";

// ─── fixture format ──────────────────────────────────────────────────────────

export type MinMax = [number, number, number, number];
export type FixtureKind = "schedule" | "keynote" | "notes" | "kv-legend" | "spec";

export interface FixtureShape {
  label: string;
  bbox: MinMax;
  source: "yolo" | "classical";
  confidence: number;
  /** The classical arm's crop read, when it has one (pseudonymized like any word). */
  text?: string;
}

export interface ParseFixture {
  schema: "bp-parse-fixture/1";
  id: string;
  synthetic: boolean;
  /** One line, no drawing text: what the layout exercises. */
  title: string;
  kind: FixtureKind;
  /** Probe / defect ids this layout covers (C02, C04, K numbers). */
  probes: string[];
  page: TextractPageData;
  shapes: FixtureShape[];
  /** The user's region (normalized MinMax). */
  region: MinMax;
  /** Manual-tool inputs drawn exactly on the layout's columns and rows (MinMax boxes). */
  manual: { columnBBs: MinMax[]; rowBBs: MinMax[]; columnNames: string[] };
  /** Guided lines a user would end with after adjusting: N+1 row edges (header + body) and M+1 column edges. */
  guided: { rows: number[]; cols: number[] };
  /** What the layout printed, in reading order (pseudonymized with the page). */
  truth: FixtureTruth;
}

export type FixtureTruth =
  | { type: "grid"; headers: string[]; rows: string[][] }
  | { type: "items"; items: { key: string; text: string }[] };

// ─── deterministic randomness ────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — a small seeded PRNG; same seed, same sequence, on every machine. */
export function rng(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── pseudo-text ─────────────────────────────────────────────────────────────

/** Generic schedule / notes / spec vocabulary: kept verbatim (names no project; the legacy detectors key on it). */
export const VOCAB: ReadonlySet<string> = new Set([
  "NO", "NUMBER", "NUM", "TAG", "MARK", "ITEM", "ID", "KEY", "TYPE", "SIZE", "WIDTH", "HEIGHT", "LENGTH", "DEPTH",
  "THICKNESS", "MATERIAL", "FINISH", "COLOR", "REMARKS", "DESCRIPTION", "LOCATION", "QTY", "QUANTITY", "RATING",
  "GLAZING", "NOTES", "NOTE", "SYMBOL", "SYM", "DOOR", "FRAME", "HARDWARE", "HEAD", "JAMB", "SILL", "SET", "GROUP",
  "MANUFACTURER", "MODEL", "ROOM", "NAME", "FLOOR", "WALL", "BASE", "CEILING", "AREA", "PANEL", "CIRCUIT", "VOLTS",
  "WATTS", "CFM", "GENERAL", "KEYNOTES", "KEYNOTE", "LEGEND", "SCHEDULE", "SECTION", "PART", "END", "OF", "SEE",
  "SHEET", "ABBREVIATIONS", "ABBREVIATION", "SYMBOLS", "SPECIFICATIONS", "PRODUCTS", "EXECUTION", "CONSTRUCTION",
  "ELECTRICAL", "MECHANICAL", "PLUMBING", "DEMOLITION", "CONT", "TYP", "AND", "THE", "OR", "TO", "AT", "ON", "IN",
  "FOR", "WITH", "ALL", "PER", "BY",
]);

const KEY_RE = /^[([]?(?:\d{1,3}(?:\.\d{1,3})*|[A-Za-z])[.):\]]?$/;
const NUMERIC_RE = /^[\d.,:;'"\-–/x×#%()+]*\d[\d.,:;'"\-–/x×#%()+]*$/;
const TAG_RE = /^[A-Za-z]{1,3}[-.]?\d{1,4}[A-Za-z]?$/;
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SALT = "bp-parse-fixture/1";

/** The pseudo form of one whitespace-free token (see the header for the rules). */
export function pseudoToken(token: string): string {
  const core = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (!core) return token;
  if (VOCAB.has(core.toUpperCase())) return token;
  if (KEY_RE.test(token) || NUMERIC_RE.test(token)) return token;
  const keepDigits = TAG_RE.test(core);
  // A tag family keeps one prefix: the letters of `EF-1` … `EF-12` are seeded by the letters alone.
  const seed = keepDigits ? core.toUpperCase().replace(/\d/g, "") : core.toUpperCase();
  for (let salt = 0; ; salt++) {
    const next = rng(`${SALT}|${seed}|${salt}`);
    let out = "";
    for (const ch of token) {
      if (ch >= "A" && ch <= "Z") out += UPPER[Math.floor(next() * 26)];
      else if (ch >= "a" && ch <= "z") out += UPPER[Math.floor(next() * 26)].toLowerCase();
      else if (ch >= "0" && ch <= "9") out += keepDigits ? ch : DIGITS[Math.floor(next() * 10)];
      else out += ch;
    }
    const outCore = out.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    // never turn an ordinary word into vocabulary, a key or the original itself
    if (VOCAB.has(outCore.toUpperCase()) || (outCore === core && /[A-Za-z]/.test(core))) continue;
    if (!KEY_RE.test(token) && KEY_RE.test(out)) continue;
    return out;
  }
}

/** Pseudonymize free text token by token; whitespace runs are kept as they are. */
export function pseudoText(text: string): string {
  return text.split(/(\s+)/).map((part) => (/^\s*$/.test(part) ? part : pseudoToken(part))).join("");
}

/** Replace every text in a fixture (page words, lines, table cells, shape reads, manual names, truth); geometry is untouched. */
export function pseudonymizeFixture(fx: ParseFixture): ParseFixture {
  const word = (w: TextractWord): TextractWord => ({ ...w, text: pseudoText(w.text) });
  const page: TextractPageData = {
    words: fx.page.words.map(word),
    lines: fx.page.lines.map((l: TextractLine) => ({
      ...l,
      text: l.words && l.words.length > 0 ? l.words.map((w) => pseudoText(w.text)).join(" ") : pseudoText(l.text),
      words: (l.words ?? []).map(word),
    })),
    ...(fx.page.tables ? {
      tables: fx.page.tables.map((t: TextractTable) => ({ ...t, cells: t.cells.map((c) => ({ ...c, text: pseudoText(c.text) })) })),
    } : {}),
  };
  const truth: FixtureTruth = fx.truth.type === "grid"
    ? { type: "grid", headers: fx.truth.headers.map(pseudoText), rows: fx.truth.rows.map((r) => r.map(pseudoText)) }
    : { type: "items", items: fx.truth.items.map((it) => ({ key: pseudoText(it.key), text: pseudoText(it.text) })) };
  return {
    ...fx,
    synthetic: true,
    page,
    shapes: fx.shapes.map((s) => (s.text === undefined ? s : { ...s, text: pseudoText(s.text) })),
    manual: { ...fx.manual, columnNames: fx.manual.columnNames.map(pseudoText) },
    truth,
  };
}

// ─── geometry helpers ────────────────────────────────────────────────────────

const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const ltwh = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] =>
  [r5(x0), r5(y0), r5(x1 - x0), r5(y1 - y0)];

interface Placed { text: string; x0: number; y0: number; x1: number; y1: number }

class SliceBuilder {
  readonly words: TextractWord[] = [];
  readonly lines: TextractLine[] = [];
  readonly tables: TextractTable[] = [];
  readonly shapes: FixtureShape[] = [];
  private readonly rand: () => number;
  constructor(seed: string, readonly charW: number, readonly lineH: number, readonly jitter: number) {
    this.rand = rng(`layout|${seed}`);
  }

  /** Lay one printed line of `text` from x; returns its words (left to right). */
  placeLine(text: string, x: number, yTop: number, align: "left" | "center" = "left", width = 0): Placed[] {
    const toks = text.split(/\s+/).filter(Boolean);
    if (toks.length === 0) return [];
    const total = toks.reduce((sum, t) => sum + t.length * this.charW, 0) + (toks.length - 1) * this.charW;
    let cursor = align === "center" ? x + Math.max(0, (width - total) / 2) : x;
    const out: Placed[] = [];
    for (const t of toks) {
      const dy = this.jitter ? (this.rand() - 0.5) * 2 * this.jitter : 0;
      const dh = this.jitter ? (this.rand() - 0.5) * this.lineH * 0.3 : 0;
      const w = t.length * this.charW;
      out.push({ text: t, x0: cursor, y0: yTop + dy, x1: cursor + w, y1: yTop + dy + this.lineH + dh });
      cursor += w + this.charW;
    }
    return out;
  }

  /** Commit placed words as Textract WORDs and one LINE per group. */
  commit(groups: Placed[][]): void {
    for (const g of groups) {
      if (g.length === 0) continue;
      const ws: TextractWord[] = g.map((p) => ({ text: p.text, confidence: 99, bbox: ltwh(p.x0, p.y0, p.x1, p.y1) }));
      this.words.push(...ws);
      const x0 = Math.min(...g.map((p) => p.x0));
      const y0 = Math.min(...g.map((p) => p.y0));
      const x1 = Math.max(...g.map((p) => p.x1));
      const y1 = Math.max(...g.map((p) => p.y1));
      this.lines.push({ text: g.map((p) => p.text).join(" "), confidence: 99, words: ws.map((w) => ({ ...w })), bbox: ltwh(x0, y0, x1, y1) });
    }
  }
}

// ─── layouts ─────────────────────────────────────────────────────────────────

export interface LayoutBase {
  id: string;
  title: string;
  kind: FixtureKind;
  probes: string[];
  origin: [number, number];
  charW?: number;
  lineH?: number;
  linePitch?: number;
  jitter?: number;
  /** Distractor text outside the region (title above, a far note): exercises region filtering. */
  distractors?: { text: string; at: [number, number] }[];
}

export type HeaderCell = string | { text: string; span: number };

export interface GridLayout extends LayoutBase {
  type: "grid";
  colWidths: number[];
  /** Header tiers, top first; "\n" breaks a cell into printed lines. */
  header?: HeaderCell[][];
  /** Body rows; "\n" breaks a cell into printed lines. A row with ONE cell is a full-width section row. */
  body: string[][];
  valign?: "top" | "middle";
  align?: ("left" | "center")[];
  rowPad?: number;
  /** Per-body-row extra height (normalized), e.g. a tall last row. */
  rowExtra?: Record<number, number>;
  /** "row": one Textract LINE per printed line across the whole row instead of per cell. */
  lineMode?: "cell" | "row";
  /** A tag shape per body row in column `col`; the key text is printed inside it unless `blind` lists the row. */
  shapes?: { label: string; col: number; size: number; source: "yolo" | "classical"; at: "first-line" | "center"; blind?: number[]; cropText?: boolean };
  /** Emit a Textract TABLE covering header + body (spans honoured). */
  textractTable?: boolean;
  /** Manual column names (default none → "Column A…"). */
  columnNames?: string[];
  /** A second block printed to the right (two-block schedule), same columns and header. */
  secondBlock?: { gap: number; body: string[][] };
}

export interface ItemEntry {
  key?: string;
  text: string;
  /** Nesting level (spec articles / paragraphs): indents the whole entry. */
  level?: number;
  /** A heading line: no key, printed on its own line. */
  heading?: boolean;
}

export interface ItemsLayout extends LayoutBase {
  type: "items";
  /** Text width in characters before a wrap. */
  wrapChars: number;
  /** Hanging indent of wrapped text (key column width), normalized. */
  indent: number;
  /** Extra indent per level, normalized. */
  levelIndent?: number;
  /** Extra vertical gap between entries, normalized. */
  itemGap?: number;
  entries: ItemEntry[];
  /** Split the entries into N side-by-side columns (balanced by count). */
  columns?: number;
  columnGap?: number;
  /** The key is its own Textract LINE (abbreviation legends, key-value). */
  keySeparateLine?: boolean;
  /** Tag shapes around the keys (symbol / bubble-keyed legends); `noKeyText` drops the key word itself. */
  keyShapes?: { label: string; size: number; source: "yolo" | "classical"; noKeyText?: boolean };
}

export type Layout = GridLayout | ItemsLayout;

const DEFAULTS = { charW: 0.0042, lineH: 0.0075, linePitch: 0.0105, rowPad: 0.003, margin: 0.008 };

function cellLines(cell: string): string[] {
  return cell.split("\n").map((s) => s.trim()).filter((s, i, all) => s.length > 0 || all.length === 1);
}

function renderGrid(L: GridLayout): ParseFixture {
  const charW = L.charW ?? DEFAULTS.charW;
  const lineH = L.lineH ?? DEFAULTS.lineH;
  const pitch = L.linePitch ?? DEFAULTS.linePitch;
  const pad = L.rowPad ?? DEFAULTS.rowPad;
  const b = new SliceBuilder(L.id, charW, lineH, L.jitter ?? 0);
  const [ox, oy] = L.origin;
  const nCols = L.colWidths.length;
  const blockW = L.colWidths.reduce((s, w) => s + w, 0);

  const renderBlock = (bx: number, body: string[][], withTable: boolean) => {
    const colX: number[] = [bx];
    for (const w of L.colWidths) colX.push(colX[colX.length - 1] + w);
    const rowEdges: number[] = [oy];
    let y = oy;
    const headerTexts: string[] = Array.from({ length: nCols }, () => "");
    const tableCells: TextractTable["cells"] = [];
    let tRow = 0;
    const lineGroups: Placed[][] = [];
    const placeCell = (text: string, c0: number, c1: number, top: number, contentH: number, alignCol: "left" | "center") => {
      const lines = cellLines(text);
      const off = L.valign === "middle" ? Math.max(0, (contentH - lines.length * pitch) / 2) : 0;
      return lines.map((ln, i) => b.placeLine(ln, colX[c0] + 0.003, top + pad + off + i * pitch, alignCol, colX[c1] - colX[c0] - 0.006));
    };
    const pushRow = (cells: { text: string; c0: number; c1: number }[], extra: number, isHeader: boolean, shapeRow?: number) => {
      const nLines = Math.max(1, ...cells.map((c) => cellLines(c.text).length));
      const contentH = nLines * pitch + extra;
      const top = y;
      const bottom = top + contentH + 2 * pad;
      tRow += 1;
      const perLine: Placed[][] = Array.from({ length: nLines + 4 }, () => []);
      for (const cell of cells) {
        const align = L.align?.[cell.c0] ?? "left";
        const shaped = !isHeader && L.shapes && cell.c0 === L.shapes.col && cells.length > 1;
        let placed: Placed[][];
        if (shaped && shapeRow !== undefined && L.shapes) {
          const s = L.shapes;
          const cx = (colX[cell.c0] + colX[cell.c1]) / 2;
          const cy = s.at === "center" ? (top + bottom) / 2 : top + pad + (L.valign === "middle" ? Math.max(0, (contentH - pitch) / 2) : 0) + lineH / 2;
          const blind = s.blind?.includes(shapeRow) ?? false;
          b.shapes.push({
            label: s.label, bbox: [r5(cx - s.size / 2), r5(cy - s.size / 2), r5(cx + s.size / 2), r5(cy + s.size / 2)],
            source: s.source, confidence: 0.9, ...(s.cropText ? { text: cell.text.replace(/[./]/g, "") } : {}),
          });
          placed = blind ? [] : [b.placeLine(cell.text, cx - (cell.text.length * charW) / 2, cy - lineH / 2)];
        } else {
          placed = placeCell(cell.text, cell.c0, cell.c1, top, contentH, align);
        }
        placed.forEach((ws, i) => {
          if (L.lineMode === "row") perLine[i].push(...ws);
          else lineGroups.push(ws);
        });
        if (isHeader) for (let c = cell.c0; c < cell.c1; c++) headerTexts[c] = `${headerTexts[c]} ${cellLines(cell.text).join(" ")}`.trim();
        if (withTable) {
          tableCells.push({
            row: tRow, col: cell.c0 + 1, rowSpan: 1, colSpan: cell.c1 - cell.c0, text: cellLines(cell.text).join(" "),
            bbox: ltwh(colX[cell.c0], top, colX[cell.c1], bottom), confidence: 95,
          });
        }
      }
      if (L.lineMode === "row") lineGroups.push(...perLine.filter((g) => g.length > 0).map((g) => g.sort((p, q) => p.x0 - q.x0)));
      y = bottom;
      rowEdges.push(r5(y));
    };
    for (const tier of L.header ?? []) {
      let c = 0;
      const cells = tier.map((h) => {
        const span = typeof h === "string" ? 1 : h.span;
        const text = typeof h === "string" ? h : h.text;
        const cell = { text, c0: c, c1: c + span };
        c += span;
        return cell;
      }).filter((cell) => cell.text.length > 0);
      pushRow(cells, 0, true);
    }
    const headerEdgeCount = rowEdges.length;
    const bodyTop = y;
    const rowBBs: MinMax[] = [];
    body.forEach((row, ri) => {
      const cells = row.length === 1
        ? [{ text: row[0], c0: 0, c1: nCols }]
        : row.map((text, ci) => ({ text, c0: ci, c1: ci + 1 })).filter((cell) => cell.text.length > 0);
      const top = y;
      pushRow(cells, L.rowExtra?.[ri] ?? 0, false, ri);
      rowBBs.push([r5(colX[0]), r5(top), r5(colX[nCols]), r5(y)]);
    });
    b.commit(lineGroups);
    if (withTable) {
      const nRows = tRow;
      b.tables.push({ bbox: ltwh(colX[0], oy, colX[nCols], y), cells: tableCells, rowCount: nRows, colCount: nCols });
    }
    const columnBBs: MinMax[] = colX.slice(0, -1).map((x, i) => [r5(x), r5(bodyTop), r5(colX[i + 1]), r5(y)]);
    return { colX, rowEdges, headerTexts, rowBBs, columnBBs, bottom: y, headerEdgeCount };
  };

  const main = renderBlock(ox, L.body, L.textractTable ?? false);
  let right = ox + blockW;
  let bottom = main.bottom;
  if (L.secondBlock) {
    const second = renderBlock(ox + blockW + L.secondBlock.gap, L.secondBlock.body, false);
    right = ox + 2 * blockW + L.secondBlock.gap;
    bottom = Math.max(bottom, second.bottom);
  }
  for (const d of L.distractors ?? []) b.commit([b.placeLine(d.text, d.at[0], d.at[1])]);

  const m = DEFAULTS.margin;
  const truthRows = [...L.body, ...(L.secondBlock?.body ?? [])].map((row) =>
    row.length === 1 ? [cellLines(row[0]).join(" ")] : row.map((cell) => cellLines(cell).join(" ")),
  );
  return {
    schema: "bp-parse-fixture/1",
    id: L.id,
    synthetic: false,
    title: L.title,
    kind: L.kind,
    probes: L.probes,
    page: { words: b.words, lines: b.lines, ...(b.tables.length ? { tables: b.tables } : {}) },
    shapes: b.shapes,
    region: [r5(ox - m), r5(oy - m), r5(right + m), r5(bottom + m)],
    manual: { columnBBs: main.columnBBs, rowBBs: main.rowBBs, columnNames: L.columnNames ?? [] },
    guided: { rows: main.rowEdges.map(r5), cols: main.colX.map(r5) },
    truth: { type: "grid", headers: L.header ? main.headerTexts : [], rows: truthRows },
  };
}

function wrap(text: string, chars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + tok.length > chars) {
      out.push(cur);
      cur = tok;
    } else cur = cur ? `${cur} ${tok}` : tok;
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

function renderItems(L: ItemsLayout): ParseFixture {
  const charW = L.charW ?? DEFAULTS.charW;
  const lineH = L.lineH ?? DEFAULTS.lineH;
  const pitch = L.linePitch ?? DEFAULTS.linePitch;
  const b = new SliceBuilder(L.id, charW, lineH, L.jitter ?? 0);
  const nCols = Math.max(1, L.columns ?? 1);
  const per = Math.ceil(L.entries.length / nCols);
  const colW = L.indent + (L.levelIndent ?? 0) * 3 + L.wrapChars * charW + 0.01;
  const [ox, oy] = L.origin;
  let maxBottom = oy;
  const itemBoxes: MinMax[] = [];
  const groups: Placed[][] = [];
  for (let c = 0; c < nCols; c++) {
    const x = ox + c * (colW + (L.columnGap ?? 0.02));
    let y = oy;
    for (const e of L.entries.slice(c * per, (c + 1) * per)) {
      const lx = x + (e.level ?? 0) * (L.levelIndent ?? 0);
      const top = y;
      if (e.heading) {
        groups.push(b.placeLine(e.text, lx, y));
        y += pitch * 1.3;
      } else {
        const lines = wrap(e.text, L.wrapChars);
        lines.forEach((ln, i) => {
          const text = b.placeLine(ln, lx + L.indent, y);
          if (i === 0 && e.key !== undefined) {
            let keyWords: Placed[] = [];
            if (L.keyShapes) {
              const s = L.keyShapes;
              const cx = lx + Math.min(L.indent / 2, s.size);
              const cy = y + lineH / 2;
              b.shapes.push({ label: s.label, bbox: [r5(cx - s.size / 2), r5(cy - s.size / 2), r5(cx + s.size / 2), r5(cy + s.size / 2)], source: s.source, confidence: 0.9 });
              if (!s.noKeyText) keyWords = b.placeLine(e.key, cx - (e.key.length * charW) / 2, y);
            } else keyWords = b.placeLine(e.key, lx, y);
            if (L.keySeparateLine) groups.push(keyWords, text);
            else groups.push([...keyWords, ...text]);
          } else groups.push(text);
          y += pitch;
        });
      }
      itemBoxes.push([r5(x), r5(top - 0.002), r5(x + colW), r5(y - pitch + lineH + 0.002)]);
      y += L.itemGap ?? 0;
    }
    maxBottom = Math.max(maxBottom, y);
  }
  b.commit(groups.filter((g) => g.length > 0));
  for (const d of L.distractors ?? []) b.commit([b.placeLine(d.text, d.at[0], d.at[1])]);
  const right = ox + nCols * colW + (nCols - 1) * (L.columnGap ?? 0.02);
  const m = DEFAULTS.margin;
  const firstCol = L.entries.slice(0, per);
  const firstColBoxes = itemBoxes.slice(0, per).filter((_, i) => !firstCol[i].heading);
  const top = oy;
  const bottom = maxBottom;
  const keyRight = ox + L.indent - 0.001;
  return {
    schema: "bp-parse-fixture/1",
    id: L.id,
    synthetic: false,
    title: L.title,
    kind: L.kind,
    probes: L.probes,
    page: { words: b.words, lines: b.lines },
    shapes: b.shapes,
    region: [r5(ox - m), r5(oy - m), r5(right + m), r5(bottom + m)],
    manual: {
      columnBBs: [[r5(ox), r5(top), r5(keyRight), r5(bottom)], [r5(keyRight), r5(top), r5(ox + colW), r5(bottom)]],
      rowBBs: firstColBoxes,
      columnNames: [],
    },
    guided: {
      rows: [r5(top - 0.002), ...firstColBoxes.map((bx) => bx[3])],
      cols: [r5(ox - 0.002), r5(keyRight), r5(ox + colW)],
    },
    truth: {
      type: "items",
      items: L.entries.map((e) => ({ key: e.heading ? "" : e.key ?? "", text: e.text.split(/\s+/).filter(Boolean).join(" ") })),
    },
  };
}

/** Render a layout BEFORE pseudonymization (tests compare geometry and character classes against it). */
export function renderRaw(L: Layout): ParseFixture {
  return L.type === "grid" ? renderGrid(L) : renderItems(L);
}

/** Render a layout to its synthetic fixture (pseudonymized; deterministic). */
export function renderLayout(L: Layout): ParseFixture {
  return pseudonymizeFixture(renderRaw(L));
}

// ─── stable JSON (one word / line / cell per line; review-friendly diffs) ─────

export function stableJson(value: unknown): string {
  const inline = (v: unknown): string => JSON.stringify(v);
  const fmt = (v: unknown, ind: string): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    const flat = inline(v);
    if (flat.length <= 140) return flat;
    const next = `${ind} `;
    if (Array.isArray(v)) return `[\n${v.map((x) => next + fmt(x, next)).join(",\n")}\n${ind}]`;
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${fmt(x, next)}`).join(",\n")}\n${ind}}`;
  };
  return `${fmt(value, "")}\n`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export const DEFAULT_FIXTURE_DIR = "src/lib/parse-engine/__fixtures__";

function main(argv: string[]): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--from")) {
    const from = arg("--from");
    const out = arg("--out");
    if (!from || !out || !out.endsWith(".synthetic.json")) {
      console.error("usage: synthesize.ts --from <real-slice.json> --out <file.synthetic.json>");
      return 2;
    }
    const fx = JSON.parse(readFileSync(from, "utf8")) as ParseFixture;
    writeFileSync(out, stableJson(pseudonymizeFixture(fx)));
    console.log(`synthesize: wrote ${out}`);
    return 0;
  }
  if (!argv.includes("--layouts")) {
    console.error("usage: synthesize.ts --layouts [--out <dir>] [--check] | --from <slice.json> --out <file.synthetic.json>");
    return 2;
  }
  const dir = resolve(arg("--out") ?? DEFAULT_FIXTURE_DIR);
  const check = argv.includes("--check");
  mkdirSync(dir, { recursive: true });
  const ids = new Set<string>();
  let drift = 0;
  for (const L of LAYOUTS) {
    if (ids.has(L.id)) throw new Error(`duplicate layout id ${L.id}`);
    ids.add(L.id);
    const file = join(dir, `${L.id}.synthetic.json`);
    const body = stableJson(renderLayout(L));
    let prev = "";
    try { prev = readFileSync(file, "utf8"); } catch { /* new */ }
    if (prev === body) continue;
    drift++;
    if (check) console.error(`synthesize: DRIFT ${file}`);
    else writeFileSync(file, body);
  }
  const stale = readdirSync(dir).filter((f) => f.endsWith(".synthetic.json") && /^syn-/.test(f) && !ids.has(f.replace(/\.synthetic\.json$/, "")));
  for (const f of stale) console.error(`synthesize: STALE ${join(dir, f)} (no layout)`);
  console.log(`synthesize: ${LAYOUTS.length} layouts, ${drift} ${check ? "drifted" : "written"}, ${stale.length} stale`);
  return check && (drift > 0 || stale.length > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
