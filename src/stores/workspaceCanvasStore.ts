import { create } from "zustand";
import type { ParseRequest } from "@/lib/parse-engine/types";

// [TP-3 WP-3.O] Canvas-side state of the Tables & Notes workspace (PLAN §3.1 WorkspaceCanvasLayer). LEAF store:
// zustand + types only. It sits beside `tablesWorkspaceStore` (whose `correction` keeps "+ Region" =
// "draw-region", WP-3.L) so this WP adds the other box-draw modes without editing a sibling WP's store:
//   armed          a box draw bound to ONE workspace item: "continuation" (KindBar "+ Add continuation box", R11)
//                  or "draw-rows" / "draw-cols" (CorrectionBar "Draw cells" → a `user-boxes` op per box)
//   parseRequest   the last box the canvas turned into a parse request ("+ Region", a continuation box). The parse
//                  query (WP-3.M `useEngineParse`) runs it; `seq` makes a repeated identical box a new request.

export type CanvasDrawMode = "continuation" | "draw-rows" | "draw-cols";

export interface CanvasArmed {
  mode: CanvasDrawMode;
  /** The workspace item (draft key) the box belongs to. */
  itemKey: string;
}

export interface CanvasParseRequest {
  /** Draft key the result belongs to (a `draw:` key for "+ Region"). */
  key: string;
  request: ParseRequest;
  seq: number;
}

interface WorkspaceCanvasState {
  armed: CanvasArmed | null;
  parseRequest: CanvasParseRequest | null;
  arm: (mode: CanvasDrawMode, itemKey: string) => void;
  disarm: () => void;
  requestParse: (key: string, request: ParseRequest) => void;
  clearParseRequest: (seq: number) => void;
}

const defaults = { armed: null, parseRequest: null };
let requestSeq = 0;

export const useWorkspaceCanvasStore = create<WorkspaceCanvasState>((set, get) => ({
  ...defaults,
  arm: (mode, itemKey) => set({ armed: { mode, itemKey } }),
  disarm: () => set({ armed: null }),
  requestParse: (key, request) => set({ parseRequest: { key, request, seq: ++requestSeq } }),
  clearParseRequest: (seq) => {
    if (get().parseRequest?.seq === seq) set({ parseRequest: null });
  },
}));

/** Test/reset helper. */
export function resetWorkspaceCanvasStore(): void {
  useWorkspaceCanvasStore.setState({ ...defaults });
}
