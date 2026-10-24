import { create } from "zustand";
import type { BboxMinMax } from "@/types";

// [classifier-builder 2026-10-24] Viewer state for the Tables panel's proposals list: the row under the
// pointer (soft outline on the canvas) and the FOCUSED proposal (green box, other annotations dimmed,
// viewport fitted to the box). Leaf store: it never fetches and never navigates. ProposalFocusLayer clears
// focus when the page or project changes; Esc / Clear / focusing another row move or end it.

export interface ProposalFocusTarget {
  publicId: string;
  proposalId: string;
  pageNumber: number;
  bbox: BboxMinMax;
}

interface ProposalFocusState {
  hover: ProposalFocusTarget | null;
  focus: ProposalFocusTarget | null;
  /** Bumped by every focusProposal so re-clicking the focused row re-fits the viewport. */
  fitRequest: number;
  setHover: (hover: ProposalFocusTarget | null) => void;
  focusProposal: (focus: ProposalFocusTarget) => void;
  clearFocus: () => void;
}

export const useProposalFocusStore = create<ProposalFocusState>((set) => ({
  hover: null,
  focus: null,
  fitRequest: 0,
  setHover: (hover) => set({ hover }),
  focusProposal: (focus) => set((state) => ({ focus, fitRequest: state.fitRequest + 1 })),
  clearFocus: () => set({ focus: null }),
}));
