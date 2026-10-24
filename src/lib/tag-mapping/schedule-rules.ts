/**
 * schedule-rules.ts — [tag-mapping v2 2026-10-24] The labelfactory schedule rules that apply where
 * tag mapping READS a parsed schedule (research/archive_ideas/REPORT.md I-4, each measured on
 * 6 projects / 470 sheets):
 *
 *   (b) header keywords only NOMINATE a column role; the BODY arbitrates — the most int-parsable
 *       column is the quantity, the quantity is never the tag, lettered marks ≻ letter-only ≻ digits;
 *   (c) sheet-number guard, schedule side: a tag column whose values are the project's sheet numbers
 *       is a drawing list — its tags are sheet references (owner: "drawing lists use the sheet-number
 *       column"), never plan tags to count;
 *   (f) a `qty` grid asserts cardinality; an `enumerating` grid (type catalog) asserts presence only.
 *
 * Not ported here: (a) the table-relative column gap (a parser concern, the rows arrive parsed),
 * (d) duplicate-sheet collapse (services/map-tags.ts excludes hidden duplicates, lib/page-dedup) and
 * (e) the catalog-mention filter (the ensemble drops shapes inside detected tables / legends and
 * region weights already down-rank text inside them).
 */

import { isSheetNumber, isTagLike, normalizeTagText, sheetKeySet } from "@/lib/shape-ensemble";

export type GridKind = "qty" | "enumerating";

export interface ColumnRoles {
  tagColumn: string | null;
  qtyColumn: string | null;
  /** A column naming the sheet / location each row applies to (per-sheet certificates). */
  sheetColumn: string | null;
  grid: GridKind;
  /** True when the tag column holds sheet numbers (a drawing list). */
  drawingList: boolean;
  reasons: string[];
}

const TAG_HEADER = /^(TAG|MARK|SYMBOL|SYM|TYPE|NO\.?|#|NUMBER|NUM|ID|KEY|CODE|DOOR|WINDOW|FIXTURE|ITEM|ROOM|EQUIP(MENT)?|UNIT)\b/;
const QTY_HEADER = /^(QTY|QUANTITY|QUAN|COUNT|NO\.?\s*(OF|REQ)|TOTAL|EA\b)/;
const SHEET_HEADER = /^(SHEET|SHT|DWG|DRAWING|LOCATION|FLOOR|LEVEL|AREA)\b/;

const INT = /^\(?\s*\d{1,4}\s*\)?(\s*(EA|PCS?|NOS?))?\.?$/;

interface ColumnStats {
  header: string;
  nonEmpty: number;
  int: number;
  tagLike: number;
  lettered: number;
  letterOnly: number;
  digitOnly: number;
  sheet: number;
  distinct: number;
  /** 1, 2, 3, … in row order: a row index, never a quantity. */
  rowIndex: boolean;
}

function columnStats(header: string, rows: readonly Record<string, string>[], sheets: ReadonlySet<string>): ColumnStats {
  const s: ColumnStats = { header, nonEmpty: 0, int: 0, tagLike: 0, lettered: 0, letterOnly: 0, digitOnly: 0, sheet: 0, distinct: 0, rowIndex: false };
  const seen = new Set<string>();
  let expectIndex = 1;
  let indexRun = true;
  for (const row of rows) {
    const v = normalizeTagText(row[header] ?? "");
    if (!v) continue;
    s.nonEmpty++;
    seen.add(v);
    if (INT.test(v)) s.int++;
    if (!/^\d+$/.test(v) || parseInt(v, 10) !== expectIndex++) indexRun = false;
    if (isTagLike(v)) {
      s.tagLike++;
      if (/^[A-Z]/.test(v) && /\d/.test(v)) s.lettered++;
      else if (/^[A-Z]+$/.test(v)) s.letterOnly++;
      else if (/^\d+$/.test(v)) s.digitOnly++;
    }
    if (isSheetNumber(v, sheets)) s.sheet++;
  }
  s.distinct = seen.size;
  s.rowIndex = indexRun && s.nonEmpty >= 2;
  return s;
}

/** "4", "(4)", "4 EA" → 4; anything else → null. */
export function parseQuantity(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const v = normalizeTagText(raw);
  if (!INT.test(v)) return null;
  const n = parseInt(v.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide which columns are the tag, the quantity and the sheet. `preferredTagColumn` (the user's
 * or the parser's pick) wins when its body is tag-like; the body overrides a header-only nomination.
 */
export function arbitrateColumnRoles(
  headers: readonly string[],
  rows: readonly Record<string, string>[],
  opts: { sheetNumbers?: readonly (string | null | undefined)[]; preferredTagColumn?: string | null } = {},
): ColumnRoles {
  const sheets = sheetKeySet(opts.sheetNumbers);
  const reasons: string[] = [];
  const stats = headers.map((h) => columnStats(h, rows, sheets));
  const share = (s: ColumnStats, n: number) => (s.nonEmpty > 0 ? n / s.nonEmpty : 0);

  // Quantity: nominated by header, confirmed by body; else the most int-parsable column (≥ 80 %).
  let qty: ColumnStats | null = null;
  const qtyNominees = stats.filter((s) => QTY_HEADER.test(normalizeTagText(s.header)) && share(s, s.int) >= 0.6);
  if (qtyNominees.length > 0) {
    qty = qtyNominees.sort((a, b) => share(b, b.int) - share(a, a.int))[0];
    reasons.push(`qty: header "${qty.header}" nominated, body ${Math.round(share(qty, qty.int) * 100)} % integers`);
  } else {
    // Headers only nominate: a "NO." column whose body is 4, 2, 6 is the quantity; 1, 2, 3 is a row index.
    const body = stats.filter((s) => s.nonEmpty >= 2 && share(s, s.int) >= 0.8 && !s.rowIndex && s.header !== opts.preferredTagColumn)
      .sort((a, b) => share(b, b.int) - share(a, a.int));
    if (body.length > 0) { qty = body[0]; reasons.push(`qty: body arbitrated "${qty.header}" (${Math.round(share(qty, qty.int) * 100)} % integers)`); }
  }

  // Tag: preferred column if tag-like, else header nominee with the best body, else body ranking.
  const tagScore = (s: ColumnStats) => share(s, s.lettered) * 3 + share(s, s.letterOnly) * 2 + share(s, s.digitOnly) + share(s, s.tagLike);
  const candidates = stats.filter((s) => s !== qty && s.nonEmpty > 0);
  let tag: ColumnStats | null = null;
  const preferred = opts.preferredTagColumn ? candidates.find((s) => s.header === opts.preferredTagColumn) : undefined;
  if (preferred && share(preferred, preferred.tagLike) >= 0.5) { tag = preferred; reasons.push(`tag: preferred column "${tag.header}" is tag-like`); }
  if (!tag) {
    const nominees = candidates.filter((s) => TAG_HEADER.test(normalizeTagText(s.header)) && share(s, s.tagLike) >= 0.5)
      .sort((a, b) => tagScore(b) - tagScore(a));
    if (nominees.length > 0) { tag = nominees[0]; reasons.push(`tag: header "${tag.header}" nominated, body tag-like`); }
  }
  if (!tag) {
    const body = candidates.filter((s) => share(s, s.tagLike) >= 0.5).sort((a, b) => tagScore(b) - tagScore(a));
    if (body.length > 0) { tag = body[0]; reasons.push(`tag: body arbitrated "${tag.header}" (lettered ≻ letters ≻ digits)`); }
  }
  if (!tag && preferred) { tag = preferred; reasons.push(`tag: preferred column "${tag.header}" kept (body not tag-like)`); }

  // Sheet-number guard (c): a tag column full of sheet numbers is a drawing list.
  const drawingList = !!tag && sheets.size > 0 && share(tag, tag.sheet) >= 0.6;
  if (drawingList) reasons.push(`drawing list: ${Math.round(share(tag!, tag!.sheet) * 100)} % of "${tag!.header}" are project sheet numbers`);

  // Sheet column: header nominee, or a non-tag column whose values are sheet numbers.
  let sheet: ColumnStats | null = null;
  const sheetCands = stats.filter((s) => s !== tag && s !== qty && s.nonEmpty > 0);
  sheet = sheetCands.find((s) => SHEET_HEADER.test(normalizeTagText(s.header))) ?? sheetCands.find((s) => share(s, s.sheet) >= 0.6) ?? null;
  if (sheet) reasons.push(`sheet: "${sheet.header}"`);

  const grid: GridKind = qty && !drawingList ? "qty" : "enumerating";
  reasons.push(grid === "qty" ? "grid: qty (asserts cardinality)" : "grid: enumerating (asserts presence only)");
  return { tagColumn: tag?.header ?? null, qtyColumn: qty?.header ?? null, sheetColumn: sheet?.header ?? null, grid, drawingList, reasons };
}

/** Split a tag list into plan tags and sheet references (the guard on the plan side). */
export function splitSheetReferences(tags: readonly string[], sheetNumbers: readonly (string | null | undefined)[] | undefined): { tags: string[]; sheetRefs: string[] } {
  const sheets = sheetKeySet(sheetNumbers);
  const out = { tags: [] as string[], sheetRefs: [] as string[] };
  for (const t of tags) (isSheetNumber(t, sheets) ? out.sheetRefs : out.tags).push(t);
  return out;
}
