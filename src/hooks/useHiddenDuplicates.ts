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
  /** page numbers with no page row (permanently deleted duplicates): always skipped */
  missing: Record<number, true>;
  count: number;
  showHidden: boolean;
  setShowHidden: (show: boolean) => void;
}

interface PageFlagsResponse {
  hidden?: { pageNumber: number; duplicateOf: number }[];
  missing?: number[];
}
interface Flags { hidden: Record<number, number>; missing: Record<number, true> }

const NONE: Record<number, number> = {};
const NO_MISSING: Record<number, true> = {};

async function loadHiddenDuplicates(publicId: string, signal: AbortSignal): Promise<Flags> {
  const res = await fetch(`/api/projects/${encodeURIComponent(publicId)}/page-flags`, { signal });
  if (!res.ok) return { hidden: {}, missing: {} };
  const body = (await res.json()) as PageFlagsResponse;
  const out: Flags = { hidden: {}, missing: {} };
  for (const row of body.hidden ?? []) out.hidden[row.pageNumber] = row.duplicateOf;
  for (const n of body.missing ?? []) out.missing[n] = true;
  return out;
}

/** Project route: load the flags for an opened private project (never for demo). */
export function useLoadHiddenDuplicates(publicId: string | null | undefined): void {
  useEffect(() => {
    if (!publicId) return;
    const controller = new AbortController();
    loadHiddenDuplicates(publicId, controller.signal)
      .then((flags) => {
        if (!controller.signal.aborted) useHiddenDuplicatesStore.getState().setHidden(publicId, flags.hidden, flags.missing);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [publicId]);
}

/** PageSidebar: the current project's hidden duplicates (empty for any other project). */
export function useHiddenDuplicates(publicId: string): HiddenDuplicates {
  const state = useHiddenDuplicatesStore(
    useShallow((s) => ({ publicId: s.publicId, hidden: s.hidden, missing: s.missing, showHidden: s.showHidden, setShowHidden: s.setShowHidden })),
  );
  const current = Boolean(publicId) && state.publicId === publicId;
  const hidden = current ? state.hidden : NONE;
  const missing = current ? state.missing : NO_MISSING;
  return { hidden, missing, count: Object.keys(hidden).length, showHidden: state.showHidden, setShowHidden: state.setShowHidden };
}
