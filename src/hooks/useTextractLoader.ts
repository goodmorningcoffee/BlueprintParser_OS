"use client";

import { useEffect, useRef } from "react";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * Own the legacy per-page Textract transport while its payloads are still Zustand-backed.
 *
 * [refactor jul11 P2.2⑧ C1] This is a literal extraction from PDFViewer: the 200 ms trailing
 * debounce, numeric project-id URL, current/+1/-1 order, live cache-hit check, shared batch abort,
 * and silent failure policy are intentionally unchanged. C2/C3 replace the backing and identity;
 * keeping scheduling behind one null controller gives that migration one transport owner.
 */
export function useTextractLoader(): void {
  const pageNumber = useViewerStore((state) => state.pageNumber);
  const numPages = useViewerStore((state) => state.numPages);
  const projectId = useViewerStore((state) => state.projectId);
  const textractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textractAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!projectId) return;

    if (textractTimerRef.current) clearTimeout(textractTimerRef.current);
    if (textractAbortRef.current) textractAbortRef.current.abort();

    textractTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      textractAbortRef.current = controller;
      const pagesToLoad = [pageNumber, pageNumber + 1, pageNumber - 1].filter(
        (page) => page >= 1 && page <= numPages,
      );

      for (const page of pagesToLoad) {
        const store = useViewerStore.getState();
        if (store.textractData[page]) continue;
        fetch(`/api/pages/textract?projectId=${projectId}&pageNumber=${page}`, {
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (data?.textractData) {
              useViewerStore.getState().setTextractData(page, data.textractData);
            }
          })
          .catch(() => {});
      }
    }, 200);

    return () => {
      if (textractTimerRef.current) clearTimeout(textractTimerRef.current);
      if (textractAbortRef.current) textractAbortRef.current.abort();
    };
  }, [pageNumber, projectId, numPages]);
}
