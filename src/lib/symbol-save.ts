/**
 * Which saved symbol-search rows a new symbol-search Save replaces (TP-1 WP-1.C, K12).
 *
 * The Save used to delete every `symbol-search` row on each page it saved to, whatever template,
 * whoever saved it. It now names rows: an existing `symbol-search` row is replaced only when a new
 * match on the same page covers the same spot (IoU ≥ SYMBOL_REPLACE_IOU), so re-saving a search
 * does not double its rows while another template's matches elsewhere on the page survive. The
 * server narrows the list further to the caller's own rows (`services/annotations.ts`).
 *
 * Boxes are normalised MinMax `[x0, y0, x1, y1]` on both sides. Pure and client-safe.
 */

export const SYMBOL_SEARCH_SOURCE = "symbol-search";
export const SYMBOL_REPLACE_IOU = 0.5;

export interface SymbolSaveExistingRow {
  id: number;
  pageNumber: number;
  source: string;
  bbox: readonly number[];
}

export interface SymbolSaveNewRow {
  pageNumber: number;
  bbox: readonly number[];
}

/** Intersection over union of two MinMax boxes; 0 when either is empty. */
export function bboxIou(a: readonly number[], b: readonly number[]): number {
  const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (!(iw > 0) || !(ih > 0)) return 0;
  const inter = iw * ih;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/** Ids of existing symbol-search rows that a new match on the same page overlaps; ascending. */
export function symbolSaveReplaceIds(
  existing: readonly SymbolSaveExistingRow[],
  incoming: readonly SymbolSaveNewRow[],
): number[] {
  const byPage = new Map<number, SymbolSaveNewRow[]>();
  for (const row of incoming) {
    const list = byPage.get(row.pageNumber);
    if (list) list.push(row);
    else byPage.set(row.pageNumber, [row]);
  }
  const ids = existing
    .filter((row) => row.source === SYMBOL_SEARCH_SOURCE)
    .filter((row) => (byPage.get(row.pageNumber) ?? []).some((n) => bboxIou(n.bbox, row.bbox) >= SYMBOL_REPLACE_IOU))
    .map((row) => row.id);
  return [...new Set(ids)].sort((a, b) => a - b);
}
