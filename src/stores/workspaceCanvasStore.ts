import { create } from "zustand";

// [TP-3 WP-3.O] Canvas-side state of the Tables & Notes workspace (PLAN §3.1 WorkspaceCanvasLayer). LEAF store:
// zustand + types only. It sits beside `tablesWorkspaceStore`, whose `correction` owns the box draws that the
// panel arms there ("+ Region" = "draw-region", WP-3.L; "+ Add continuation box" = "draw-continuation", WP-3.M).
// This store holds only what no sibling store has:
//   armed   a "Draw cells" box draw bound to ONE workspace item: "draw-rows" / "draw-cols" (WP-3.N's CorrectionBar
//           → a `user-boxes` op per box). The canvas disarms it when the workspace closes, the selection moves or
//           the item's draft is gone.
// A drawn box never carries its own parse request: a draft whose `result` is null is (re-)parsed by WP-3.M's
// `useEngineParse`, built from the draft (VERIFY F1).

export type CanvasDrawMode = "draw-rows" | "draw-cols";

export interface CanvasArmed {
  mode: CanvasDrawMode;
  /** The workspace item (draft key) the box belongs to. */
  itemKey: string;
}

interface WorkspaceCanvasState {
  armed: CanvasArmed | null;
  arm: (mode: CanvasDrawMode, itemKey: string) => void;
  disarm: () => void;
}

const defaults = { armed: null };

export const useWorkspaceCanvasStore = create<WorkspaceCanvasState>((set, get) => ({
  ...defaults,
  arm: (mode, itemKey) => set({ armed: { mode, itemKey } }),
  disarm: () => {
    if (get().armed) set({ armed: null });
  },
}));

/** Test/reset helper. */
export function resetWorkspaceCanvasStore(): void {
  useWorkspaceCanvasStore.setState({ ...defaults });
}
