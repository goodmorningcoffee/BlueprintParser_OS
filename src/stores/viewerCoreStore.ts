import { create } from "zustand";

export interface ViewerCoreData {
  pageNumber: number;
  numPages: number;
  scale: number;
  pendingCenter: boolean;
  pageDimensions: Record<number, { width: number; height: number }>;
}

interface ViewerCoreActions {
  setPage: (pageNumber: number) => void;
  setNumPages: (numPages: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  clearPendingCenter: () => void;
  setScale: (scale: number) => void;
  setPageDimensions: (pageNumber: number, width: number, height: number) => void;
  resetViewerCoreState: () => void;
}

export interface ViewerCoreState extends ViewerCoreData, ViewerCoreActions {}

function freshViewerCoreState(): ViewerCoreData {
  return {
    pageNumber: 1,
    numPages: 0,
    scale: 1,
    pendingCenter: false,
    pageDimensions: {},
  };
}

function freshViewerCoreReset(): Pick<
  ViewerCoreData,
  "pageNumber" | "numPages" | "scale" | "pageDimensions"
> {
  return {
    pageNumber: 1,
    numPages: 0,
    scale: 1,
    pageDimensions: {},
  };
}

// Mode and temporary-pan state are tool interactions, not viewer geometry. Cross-store project
// reset ordering stays in the neutral coordinator when this production-dead owner flips live.
export const useViewerCoreStore = create<ViewerCoreState>((set, get) => ({
  ...freshViewerCoreState(),
  setPage: (pageNumber) =>
    set((state) => ({
      pageNumber: Math.max(1, Math.min(pageNumber, state.numPages || 1)),
    })),
  setNumPages: (numPages) => set({ numPages }),
  zoomIn: () => set((state) => ({ scale: Math.min(state.scale * (1 / 0.95), 10) })),
  zoomOut: () => set((state) => ({ scale: Math.max(state.scale * 0.95, 0.2) })),
  zoomFit: () => set({ pendingCenter: true }),
  clearPendingCenter: () => set({ pendingCenter: false }),
  setScale: (scale) => set({ scale }),
  setPageDimensions: (pageNumber, width, height) => {
    const existing = get().pageDimensions[pageNumber];
    if (existing && existing.width === width && existing.height === height) return;
    set((state) => ({
      pageDimensions: {
        ...state.pageDimensions,
        [pageNumber]: { width, height },
      },
    }));
  },
  // Preserve the current pendingCenter omission. P2.5 owns the reset-policy decision.
  resetViewerCoreState: () => set(freshViewerCoreReset()),
}));
