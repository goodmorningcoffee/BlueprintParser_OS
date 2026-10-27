/**
 * Column headers (table pipeline WP-3.B; PLAN §1.3 E-5, E-8; §1.4; K06). Pure, client-safe (E-8: imports
 * only `./types` and `./cells`), deterministic (E-7). Never imports `classifier-engine/derive-name`: the
 * printed TITLE is found server-side (`server/services/parse-engine/title.ts`) and arrives here only as a
 * number of rows to skip.
 *
 * 1. `detectHeaderRows` — which rows are the column header, in this order:
 *    - `hint` (the request's `hints.headerRows`, or a user op);
 *    - Textract COLUMN_HEADER flags: the first flagged row in the scan window and the flagged rows under it;
 *    - keywords: the row with the most header-keyword cells in the scan window (ocr-positions' pass 1, the
 *      same token rule and vocabulary), widened UP over header-like rows (a group tier such as DOOR | FRAME)
 *      and DOWN over keyword rows without digits (a label wrapped onto a second line), at most 3 rows;
 *      going up, a row with a single cell on a grid of ≥ 3 columns is a title and stops the widening;
 *    - caps (ocr-positions' pass 2): the first row with ≥ 2 cells, no digits, every cell ≤ 16 characters and
 *      upper case;
 *    - else no header.
 * 2. `headerSpansFromWords` — group-header spans read from geometry: in every tier but the last, a run of
 *    words (gap ≤ .6 × median word height) that covers the centres of ≥ 2 columns spans them.
 * 3. `headerLabels` — per column, the tiers joined top to bottom (a spanning tier repeated into every column
 *    it covers and recorded as `group`), blank → `Column n`, deduped by `uniqueHeaders` (K06), plus a column
 *    `role` from the label (`roleOfLabel`).
 * 4. `uniqueHeaders` / `renamedHeader` — the K06 dedupe (moved here from `lib/table-headers.ts`, which
 *    re-exports them, so client-safe engine modules can use them).
 */

import { bandIndex, type CellSpan, type ColWord } from "./cells";
import type { ColRole } from "./types";

/** Where a header pick came from. */
export type HeaderSource = "hint" | "flags" | "keyword" | "caps" | "none";

/** The header block of a table, in row indices of the grid it was computed on. */
export interface HeaderPick {
  /** First header row (rows above it are a title / pre-header band). */
  start: number;
  /** Number of header rows from `start` (0 = no header). */
  count: number;
  src: HeaderSource;
  conf: number;
}

/** One column's header label (`headerLabels`). */
export interface HeaderLabel {
  /** Deduped (K06): unique across the table, never blank. */
  label: string;
  /** As printed: the header tiers joined top to bottom with " " ("" when nothing is printed). */
  labelRaw: string;
  /** The text of an upper-tier cell that spans this column and at least one other (a group header). */
  group?: string;
  role?: ColRole;
}

export const HEADERS_VERSION = 1;

/** ocr-positions' header vocabulary (`lib/services/table-parse.ts` HEADER_KW), unchanged. */
export const HEADER_KEYWORDS: ReadonlySet<string> = new Set([
  "NO", "NO.", "NUMBER", "NUM", "TAG", "MARK", "ITEM", "TYPE", "SIZE",
  "WIDTH", "HEIGHT", "LENGTH", "DEPTH", "THICKNESS",
  "MATERIAL", "FINISH", "COLOR", "REMARKS", "DESCRIPTION", "LOCATION",
  "QTY", "QUANTITY", "RATING", "GLAZING", "NOTES", "SYMBOL", "SYM",
  "DOOR", "DOORS", "HARDWARE", "HDW", "HDWE", "HDWARE", "SET", "GROUP", "GRP",
  "FRAME", "HEAD", "JAMB", "SILL", "LATCH", "LOCK", "HINGE", "CLOSER",
  "KEY", "KEYING", "CYL", "CYLINDER",
  "MANUFACTURER", "MFG", "MFR", "MANUF", "MODEL", "VENDOR", "SUPPLIER", "BRAND",
  "ROOM", "FLOOR", "CEILING", "WALL", "BASE", "TRIM",
  "CODE", "CLASS", "CATEGORY", "CSI", "SPEC", "SPECIFICATION", "UNIT", "UNITS",
]);

/** A cell is a header keyword when any token (trailing `.,:;` stripped) is in the vocabulary (ocr-positions' rule). */
export function looksLikeHeaderKeyword(cell: string): boolean {
  return cell.toUpperCase().trim().split(/\s+/).some((t) => t !== "" && (HEADER_KEYWORDS.has(t) || HEADER_KEYWORDS.has(t.replace(/[.,:;]+$/, ""))));
}

const nonEmpty = (row: readonly string[]): string[] => row.map((c) => (c ?? "").trim()).filter((c) => c !== "");
const hasDigit = (row: readonly string[]): boolean => nonEmpty(row).some((c) => /\d/.test(c));

/** ocr-positions' pass 2: ≥ 2 cells, no digits, each ≤ 16 characters and upper case. */
export function isCapsHeaderRow(row: readonly string[]): boolean {
  const cells = nonEmpty(row);
  return cells.length >= 2 && !hasDigit(row) && cells.every((c) => c.length <= 16 && c === c.toUpperCase());
}

const keywordScore = (row: readonly string[]): number => row.filter((c) => typeof c === "string" && looksLikeHeaderKeyword(c)).length;

export interface DetectHeaderInput {
  /** Cell text per row, top to bottom (all columns of the grid). */
  rows: readonly (readonly string[])[];
  /** Per row: does it hold a Textract COLUMN_HEADER cell. */
  flags?: readonly boolean[];
  /** Rows at the top to leave out (the title band, `title.ts` `titleBottom`). Default 0. */
  skip?: number;
  /** A fixed header row count (request hint / user op). */
  hint?: number;
  /** Rows scanned for a header after `skip`. Default 5 (ocr-positions). */
  scan?: number;
}

export const MAX_HEADER_TIERS = 3;

/** The header block (see the file header for the rule order). */
export function detectHeaderRows(input: DetectHeaderInput): HeaderPick {
  const rows = input.rows;
  const skip = Math.max(0, Math.min(rows.length, Math.floor(input.skip ?? 0)));
  const end = Math.min(rows.length, skip + (input.scan ?? 5));
  if (input.hint !== undefined && Number.isInteger(input.hint) && input.hint >= 0) {
    return { start: skip, count: Math.min(input.hint, rows.length - skip), src: "hint", conf: 1 };
  }
  const flags = input.flags ?? [];
  for (let r = skip; r < end; r++) {
    if (!flags[r]) continue;
    let n = 0;
    while (r + n < rows.length && flags[r + n] && n < MAX_HEADER_TIERS) n++;
    return { start: r, count: n, src: "flags", conf: 0.9 };
  }
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const isTitle = (row: readonly string[]): boolean => cols >= 3 && nonEmpty(row).length === 1;
  let best = -1;
  let bestScore = 0;
  for (let r = skip; r < end; r++) {
    const s = keywordScore(rows[r]);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  if (best >= 0) {
    let start = best;
    let stop = best + 1;
    while (start - 1 >= skip && stop - (start - 1) <= MAX_HEADER_TIERS && !isTitle(rows[start - 1]) && !hasDigit(rows[start - 1])
      && (keywordScore(rows[start - 1]) > 0 || isCapsHeaderRow(rows[start - 1]))) start--;
    // Down: a single-cell row is fine here (a label wrapped onto a second line); titles sit above.
    while (stop < rows.length && stop + 1 - start <= MAX_HEADER_TIERS && !hasDigit(rows[stop]) && keywordScore(rows[stop]) > 0) stop++;
    return { start, count: stop - start, src: "keyword", conf: 0.8 };
  }
  for (let r = skip; r < end; r++) if (isCapsHeaderRow(rows[r])) return { start: r, count: 1, src: "caps", conf: 0.5 };
  return { start: skip, count: 0, src: "none", conf: 0 };
}

/**
 * Group-header spans from word geometry, in header-tier indices (row 0 = the first header tier). `tierLines`
 * are the header tiers' row lines (count + 1), `colLines` the table's column lines. The last tier never spans.
 */
export function headerSpansFromWords(words: readonly ColWord[], tierLines: readonly number[], colLines: readonly number[]): CellSpan[] {
  const tiers = tierLines.length - 1;
  const ncols = colLines.length - 1;
  if (tiers < 2 || ncols < 2) return [];
  const colMid = Array.from({ length: ncols }, (_, c) => (colLines[c] + colLines[c + 1]) / 2);
  const out: CellSpan[] = [];
  for (let t = 0; t < tiers - 1; t++) {
    const ws = words
      .filter((w) => bandIndex((w.b[1] + w.b[3]) / 2, tierLines) === t && bandIndex((w.b[0] + w.b[2]) / 2, colLines) >= 0)
      .sort((a, b) => a.b[0] - b.b[0] || a.b[1] - b.b[1]);
    if (!ws.length) continue;
    const hs = ws.map((w) => w.b[3] - w.b[1]).sort((a, b) => a - b);
    const gap = 0.6 * hs[Math.floor(hs.length / 2)];
    const runs: [number, number][] = [];
    for (const w of ws) {
      const cur = runs[runs.length - 1];
      if (cur && w.b[0] - cur[1] <= gap) cur[1] = Math.max(cur[1], w.b[2]);
      else runs.push([w.b[0], w.b[2]]);
    }
    for (const [x0, x1] of runs) {
      const covered = colMid.map((m, c) => (m >= x0 && m <= x1 ? c : -1)).filter((c) => c >= 0);
      if (covered.length >= 2) out.push({ r: t, c: covered[0], rs: 1, cs: covered[covered.length - 1] - covered[0] + 1 });
    }
  }
  return out;
}

export interface HeaderLabelsInput {
  /** Header tiers × columns, top to bottom (a span's text in its anchor cell only). */
  tiers: readonly (readonly string[])[];
  /** Number of columns (defaults to the widest tier). */
  cols?: number;
  /** Spans in tier indices (`headerSpansFromWords`, or Textract spans shifted to the header block). */
  spans?: readonly CellSpan[];
}

/** One label per column (see the file header). */
export function headerLabels(input: HeaderLabelsInput): HeaderLabel[] {
  const ncols = input.cols ?? Math.max(0, ...input.tiers.map((t) => t.length));
  const grid = input.tiers.map((t) => Array.from({ length: ncols }, (_, c) => (t[c] ?? "").replace(/\s+/g, " ").trim()));
  const group: (string | undefined)[] = new Array(ncols).fill(undefined);
  for (const s of input.spans ?? []) {
    if (s.r < 0 || s.r >= grid.length || s.c < 0 || s.c >= ncols) continue;
    const text = grid[s.r][s.c] || nonEmpty(grid[s.r].slice(s.c, s.c + s.cs))[0] || "";
    for (let c = s.c; c < Math.min(ncols, s.c + s.cs); c++) {
      grid[s.r][c] = text;
      if (s.cs > 1 && s.r < grid.length - 1 && text && group[c] === undefined) group[c] = text;
      for (let r = s.r + 1; r < Math.min(grid.length, s.r + s.rs); r++) grid[r][c] = ""; // a vertical span reads once
    }
  }
  const raw = Array.from({ length: ncols }, (_, c) => {
    const parts: string[] = [];
    for (const tier of grid) if (tier[c] && parts[parts.length - 1] !== tier[c]) parts.push(tier[c]);
    return parts.join(" ");
  });
  const labels = uniqueHeaders(raw.map((r, c) => r || `Column ${c + 1}`));
  return raw.map((labelRaw, c) => {
    const out: HeaderLabel = { label: labels[c], labelRaw };
    if (group[c]) out.group = group[c];
    const role = roleOfLabel(labelRaw);
    if (role) out.role = role;
    return out;
  });
}

const ROLE_TOKENS: readonly [ColRole, ReadonlySet<string>][] = [
  ["qty", new Set(["QTY", "QUANTITY", "QUAN", "QTYS", "COUNT", "REQD", "EA"])],
  ["tag", new Set(["TAG", "MARK", "SYM", "SYMBOL", "KEY", "ID", "NO", "NUMBER", "NUM", "ITEM", "DESIGNATION", "KEYNOTE"])],
  ["remarks", new Set(["REMARKS", "NOTES", "NOTE", "COMMENTS"])],
  ["description", new Set(["DESCRIPTION", "DESC", "SERVICE"])],
  ["type", new Set(["TYPE"])],
  ["size", new Set(["SIZE", "WIDTH", "HEIGHT", "DIMENSIONS", "DIM"])],
  ["material", new Set(["MATERIAL", "MATL", "FINISH"])],
  ["sheet", new Set(["SHEET", "DETAIL", "DWG"])],
];

/** A column role from its printed label (qty before tag: "NO. REQ'D" is a quantity; LabelFactory's order). */
export function roleOfLabel(label: string): ColRole | undefined {
  const toks = new Set(label.toUpperCase().replace(/['’]/g, "").split(/[^A-Z0-9#]+/).filter(Boolean));
  if (!toks.size) return undefined;
  for (const [role, set] of ROLE_TOKENS) for (const t of toks) if (set.has(t)) return role;
  return undefined;
}

export function uniqueHeaders(headers: readonly string[]): string[] {
  const base = headers.map((h, i) => (typeof h === "string" && h.trim() !== "" ? h : `Column ${i + 1}`));
  const taken = new Set<string>();
  const nextSuffix = new Map<string, number>();
  // Labels as printed claim their key first, so a printed "X (2)" is never renamed to "X (2) (2)"
  // only because an earlier duplicate "X" would have generated it.
  const firstAt = new Map<string, number>();
  base.forEach((h, i) => {
    if (!firstAt.has(h)) firstAt.set(h, i);
  });
  for (const h of firstAt.keys()) taken.add(h);
  return base.map((h, i) => {
    if (firstAt.get(h) === i) return h;
    let n = nextSuffix.get(h) ?? 2;
    while (taken.has(`${h} (${n})`)) n++;
    const label = `${h} (${n})`;
    nextSuffix.set(h, n + 1);
    taken.add(label);
    return label;
  });
}

/**
 * The name a renamed column may take without colliding (K06 on rename): `name` itself when no other
 * column uses it, else the next free `name (n)` by the `uniqueHeaders` rule. The other columns never
 * change, so their row keys stay valid. A blank name becomes `Column <index + 1>`. Exact and
 * case-sensitive, like `uniqueHeaders`.
 */
export function renamedHeader(headers: readonly string[], index: number, name: string): string {
  const taken = new Set(headers.filter((_, i) => i !== index));
  const label = typeof name === "string" && name.trim() !== "" ? name : `Column ${index + 1}`;
  if (!taken.has(label)) return label;
  let n = 2;
  while (taken.has(`${label} (${n})`)) n++;
  return `${label} (${n})`;
}
