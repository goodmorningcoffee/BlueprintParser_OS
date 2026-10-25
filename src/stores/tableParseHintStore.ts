import { create } from "zustand";
import type { BboxMinMax } from "@/types";

// [shape-tags 2026-10-25] A parse HINT handed from the proposals list to the Auto Parse flow: "Accept with tags"
// on a proposal whose tag column the classifier found asks the next /api/table-parse of that region for the
// shape-centre row builder (`rowSource: "shape-centres"`) and pre-selects the column's YOLO class for Map Tags.
// Leaf store (never fetches, never navigates). [fix round] The hint is keyed by PROJECT + page + region, so a
// hint never leaks into another project or another box on the same page number, and it is CONSUMED (cleared)
// by the first Auto Parse request that uses it (`consumeTableParseHints`), so later parses of that region run
// the default methods unless the proposal is accepted with tags again.

export interface TableParseHint {
  publicId: string;
  pageNumber: number;
  bbox: BboxMinMax;
  rowSource: "shape-centres";
  /** The column's shape class for Map Tags (`yolo-with-inner-text` on yolo_primitive). */
  tagYoloClass?: { model: string; className: string };
}

interface TableParseHintState {
  hint: TableParseHint | null;
  setHint: (hint: TableParseHint | null) => void;
}

export const useTableParseHintStore = create<TableParseHintState>((set) => ({
  hint: null,
  setHint: (hint) => set({ hint }),
}));

const iou = (a: BboxMinMax, b: BboxMinMax): number => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
};

/** Whether `hint` is for this project's region on `pageNumber` (same page, IoU ≥ .5). */
export function hintMatches(hint: TableParseHint | null, publicId: string | null | undefined, pageNumber: number, bbox: readonly number[] | null | undefined): hint is TableParseHint {
  if (!hint || !publicId || hint.publicId !== publicId || hint.pageNumber !== pageNumber || !bbox || bbox.length !== 4) return false;
  return iou(hint.bbox, bbox as BboxMinMax) >= 0.5;
}

/** The hint that applies to a region parse of this project on `pageNumber`, or null. Does not consume it. */
export function tableParseHintFor(publicId: string | null | undefined, pageNumber: number, bbox: readonly number[] | null | undefined): TableParseHint | null {
  const hint = useTableParseHintStore.getState().hint;
  return hintMatches(hint, publicId, pageNumber, bbox) ? hint : null;
}

export type TableParseRequestHints = { rowSource?: "shape-centres" };

/** Request-body fields for /api/table-parse of this region: `{ rowSource }` when a hint applies, else nothing. Does not consume it. */
export function tableParseRequestHints(publicId: string | null | undefined, pageNumber: number, bbox: readonly number[] | null | undefined): TableParseRequestHints {
  const hint = tableParseHintFor(publicId, pageNumber, bbox);
  return hint ? { rowSource: hint.rowSource } : {};
}

/**
 * The request-body fields for each region of one Auto Parse run, computed once when the request shape is frozen;
 * a hint that one of the regions uses is cleared (consumed) here.
 */
export function consumeTableParseHints(publicId: string | null | undefined, pageNumber: number, regions: ReadonlyArray<readonly number[]>): TableParseRequestHints[] {
  const out = regions.map((bbox) => tableParseRequestHints(publicId, pageNumber, bbox));
  if (out.some((h) => h.rowSource)) useTableParseHintStore.getState().setHint(null);
  return out;
}
