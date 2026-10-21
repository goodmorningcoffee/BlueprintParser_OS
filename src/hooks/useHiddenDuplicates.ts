"use client";

// Viewer: pages an admin hid as duplicates (Admin › Data tools › Duplicates). Hidden pages
// leave the sidebar page list unless "Show N hidden duplicates" is on; direct navigation still
// works and page numbers never change. The project route loads the flags once per project
// (useLoadHiddenDuplicates); PageSidebar only reads them (useHiddenDuplicates), so rendering
// the sidebar never fetches. Best-effort: any failure means "none hidden".

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useHiddenDuplicatesStore } from "@/stores/hiddenDuplicatesStore";

export interface HiddenDuplicates {
  /** hidden page → the canonical page it duplicates */
  hidden: Record<number, number>;
  count: number;
  showHidden: boolean;
  setShowHidden: (show: boolean) => void;
}

interface PageFlagsResponse {
  hidden?: { pageNumber: number; duplicateOf: number }[];
}

const NONE: Record<number, number> = {};

async function loadHiddenDuplicates(publicId: string, signal: AbortSignal): Promise<Record<number, number>> {
  const res = await fetch(`/api/projects/${encodeURIComponent(publicId)}/page-flags`, { signal });
  if (!res.ok) return {};
  const body = (await res.json()) as PageFlagsResponse;
  const out: Record<number, number> = {};
  for (const row of body.hidden ?? []) out[row.pageNumber] = row.duplicateOf;
  return out;
}

/** Project route: load the flags for an opened private project (never for demo). */
export function useLoadHiddenDuplicates(publicId: string | null | undefined): void {
  useEffect(() => {
    if (!publicId) return;
    const controller = new AbortController();
    loadHiddenDuplicates(publicId, controller.signal)
      .then((hidden) => {
        if (!controller.signal.aborted) useHiddenDuplicatesStore.getState().setHidden(publicId, hidden);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [publicId]);
}

/** PageSidebar: the current project's hidden duplicates (empty for any other project). */
export function useHiddenDuplicates(publicId: string): HiddenDuplicates {
  const state = useHiddenDuplicatesStore(
    useShallow((s) => ({ publicId: s.publicId, hidden: s.hidden, showHidden: s.showHidden, setShowHidden: s.setShowHidden })),
  );
  const hidden = publicId && state.publicId === publicId ? state.hidden : NONE;
  return { hidden, count: Object.keys(hidden).length, showHidden: state.showHidden, setShowHidden: state.setShowHidden };
}
