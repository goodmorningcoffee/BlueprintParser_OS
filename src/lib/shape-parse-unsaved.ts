// [fix 2026-10-24 admin-ui T1b] The viewer's shape-parse "Save page / Save all pages" buttons POST
// the pending shapes to /api/annotations append-only. Since 2026-10-21 the server persists every
// non-demo scan itself (services/shape-parse.ts → shape-parse-persist.ts) and the page window loads
// pages.keynotes next to the stored rows, so every press (and every reload + press) used to add a
// second copy of each row. A shape counts as SAVED when its page already holds a `shape-parse`
// annotation of the same shape type whose bbox matches; only the others are offered for saving.
//
// annotations.min_x..max_y are `real` columns, so a stored bbox comes back with float4 precision
// while pages.keynotes keeps the float64 the scan produced — the match is within a tolerance, not
// exact. Text is not compared: OCR binding may re-read it without the shape moving.

import type { ClientAnnotation, KeynoteShapeData } from "@/types";

export const SHAPE_PARSE_SOURCE = "shape-parse";

/** float4 keeps ~7 significant digits; normalized coordinates in [0,1] are stable well inside this. */
export const BBOX_MATCH_TOLERANCE = 1e-4;

function sameBbox(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 4; i += 1) {
    if (!(Math.abs(Number(a[i]) - Number(b[i])) <= BBOX_MATCH_TOLERANCE)) return false;
  }
  return true;
}

/** The shapes on `pageNumber` not yet stored as shape-parse annotations, in their original order. */
export function unsavedShapeKeynotes(
  shapes: readonly KeynoteShapeData[],
  pageNumber: number,
  annotations: readonly ClientAnnotation[],
): KeynoteShapeData[] {
  if (shapes.length === 0) return [];
  const savedByShape = new Map<string, ClientAnnotation[]>();
  for (const a of annotations) {
    if (a.pageNumber !== pageNumber || a.source !== SHAPE_PARSE_SOURCE) continue;
    const list = savedByShape.get(a.name);
    if (list) list.push(a);
    else savedByShape.set(a.name, [a]);
  }
  if (savedByShape.size === 0) return [...shapes];
  return shapes.filter((k) => {
    const saved = savedByShape.get(k.shape);
    return !saved || !saved.some((a) => sameBbox(a.bbox, k.bbox));
  });
}

/** Per page, the unsaved shapes; pages with nothing left to save are omitted. */
export function unsavedShapeKeynotesByPage(
  keynotes: Record<number, KeynoteShapeData[] | null | undefined>,
  annotations: readonly ClientAnnotation[],
): Record<number, KeynoteShapeData[]> {
  const out: Record<number, KeynoteShapeData[]> = {};
  for (const [pn, shapes] of Object.entries(keynotes)) {
    const unsaved = unsavedShapeKeynotes(shapes ?? [], Number(pn), annotations);
    if (unsaved.length > 0) out[Number(pn)] = unsaved;
  }
  return out;
}
