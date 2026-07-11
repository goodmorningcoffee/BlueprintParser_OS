"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  cancelTextractPage,
  clearTextractProject,
  ensureTextractPage,
  setTextractProtectedPages,
} from "@/queries/textractCache";
import { useSessionStore } from "@/stores/sessionStore";
import { useViewerStore } from "@/stores/viewerStore";

interface TextractBatch {
  generation: number;
  publicId: string;
  pages: number[];
}

function pagesAround(pageNumber: number, numPages: number): number[] {
  return [pageNumber, pageNumber + 1, pageNumber - 1].filter(
    (page) => page >= 1 && page <= numPages,
  );
}

function cancelBatch(qc: QueryClient, batch: TextractBatch | null): void {
  if (!batch) return;
  for (const pageNumber of batch.pages) {
    // Each page owns its own Query/fetch signal; cancellation must stay exact so a sibling that a
    // newer batch still needs is deduped or restarted by that batch rather than broadly invalidated.
    void cancelTextractPage(qc, batch.publicId, pageNumber);
  }
}

/**
 * The one automatic Textract transport owner.
 *
 * Component hooks are disabled data observers. This headless state machine preserves the legacy
 * trailing 200 ms and current/+1/-1 cadence while Query owns publicId provenance, dedupe,
 * cancellation, null/error cleanup, and bounded retention.
 */
export function useTextractLoader(): void {
  const qc = useQueryClient();
  const pageNumber = useViewerStore((state) => state.pageNumber);
  const numPages = useViewerStore((state) => state.numPages);
  const publicId = useSessionStore((state) => state.publicId);
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeBatchRef = useRef<TextractBatch | null>(null);

  // Project identity/unmount is the ownership boundary for this heavy domain. Clear only the exact
  // Textract prefix; broader project removal would destroy sibling cache semantics established by
  // earlier P2.2 migrations.
  useEffect(() => {
    const capturedPublicId = publicId;
    return () => {
      generationRef.current += 1;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const activeBatch = activeBatchRef.current;
      activeBatchRef.current = null;
      cancelBatch(qc, activeBatch);
      if (capturedPublicId) void clearTextractProject(qc, capturedPublicId);
    };
  }, [publicId, qc]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Install the new intent before cancellation. Abort-aware old attempts may settle immediately;
    // they must already be obsolete when their cancellation path runs.
    const previousBatch = activeBatchRef.current;
    const batch: TextractBatch | null =
      publicId && numPages !== 0 ? { generation, publicId, pages: [] } : null;
    activeBatchRef.current = batch;
    cancelBatch(qc, previousBatch);

    if (!batch) {
      if (publicId) setTextractProtectedPages(qc, publicId, []);
      return;
    }

    // Publish protection at intent time so a late old settlement during the real debounce prunes
    // against the newly navigated working set. Dispatch re-reads and republishes the live bounds.
    setTextractProtectedPages(qc, publicId, pagesAround(pageNumber, numPages));

    const timer = setTimeout(() => {
      if (
        activeBatchRef.current !== batch ||
        generationRef.current !== batch.generation
      ) {
        return;
      }

      // Preserve the legacy timer-time snapshot boundary across the session/viewer carve. These
      // reads stay adjacent and synchronous so identity guards describe the same navigation turn.
      const liveSession = useSessionStore.getState();
      const liveViewer = useViewerStore.getState();
      if (
        liveSession.publicId !== batch.publicId ||
        liveViewer.numPages === 0 ||
        generationRef.current !== batch.generation
      ) {
        return;
      }

      const livePages = pagesAround(liveViewer.pageNumber, liveViewer.numPages);
      batch.pages = livePages;
      setTextractProtectedPages(qc, batch.publicId, livePages);

      for (const livePage of livePages) {
        // A synchronous transport/test double can change project identity during an earlier sibling
        // dispatch. Recheck before every ensure so no later old-project sibling can start afterward.
        if (
          activeBatchRef.current !== batch ||
          generationRef.current !== batch.generation ||
          useSessionStore.getState().publicId !== batch.publicId
        ) {
          break;
        }

        void ensureTextractPage(qc, {
          publicId: batch.publicId,
          pageNumber: livePage,
          protectedPages: livePages,
        });
      }
    }, 200);
    timerRef.current = timer;

    return () => {
      clearTimeout(timer);
      if (timerRef.current === timer) timerRef.current = null;
    };
  }, [pageNumber, numPages, publicId, qc]);
}
