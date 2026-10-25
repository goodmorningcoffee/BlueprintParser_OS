import { create } from "zustand";
import type { BboxMinMax } from "@/types";

// [shape-tags 2026-10-25] A parse HINT handed from the proposals list to the Auto Parse flow: "Accept with tags"
// on a proposal whose tag column the classifier found asks the next /api/table-parse of that region for the
// shape-centre row builder (`rowSource: "shape-centres"`) and pre-selects the column's YOLO class for Map Tags.
// Leaf store (never fetches, never navigates); the hint is keyed by page + region so a stale one is ignored,
// and it is cleared once a parse of that region has used it.

export interface TableParseHint {
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

/** The hint that applies to a region parse on `pageNumber` (same page, IoU ≥ .5), or null. */
export function tableParseHintFor(pageNumber: number, bbox: readonly number[] | null | undefined): TableParseHint | null {
  const hint = useTableParseHintStore.getState().hint;
  if (!hint || hint.pageNumber !== pageNumber || !bbox || bbox.length !== 4) return null;
  return iou(hint.bbox, bbox as BboxMinMax) >= 0.5 ? hint : null;
}

/** Request-body fields for /api/table-parse of this region: `{ rowSource }` when a hint applies, else nothing. */
export function tableParseRequestHints(pageNumber: number, bbox: readonly number[] | null | undefined): { rowSource?: "shape-centres" } {
  const hint = tableParseHintFor(pageNumber, bbox);
  return hint ? { rowSource: hint.rowSource } : {};
}
