import { create } from "zustand";

// Viewer sidebar state for pages an admin hid as duplicates (Admin › Data tools › Duplicates).
// Filled by the project route (useLoadHiddenDuplicates) — this leaf store never fetches — and
// read by PageSidebar. Keyed by publicId so a previous project's flags never leak into the next.

interface HiddenDuplicatesState {
  publicId: string;
  /** hidden page → the canonical page it duplicates */
  hidden: Record<number, number>;
  /** page numbers with no page row (permanently deleted duplicates): never shown */
  missing: Record<number, true>;
  showHidden: boolean;
  setHidden: (publicId: string, hidden: Record<number, number>, missing?: Record<number, true>) => void;
  setShowHidden: (showHidden: boolean) => void;
}

export const useHiddenDuplicatesStore = create<HiddenDuplicatesState>((set) => ({
  publicId: "",
  hidden: {},
  missing: {},
  showHidden: false,
  setHidden: (publicId, hidden, missing = {}) => set({ publicId, hidden, missing, showHidden: false }),
  setShowHidden: (showHidden) => set({ showHidden }),
}));
