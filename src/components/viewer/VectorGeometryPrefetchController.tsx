"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useToolStore } from "@/stores/toolStore";
import { selectActiveToolKey } from "@/lib/active-tool-state";
import { useProjectIdentity } from "@/stores/sessionStore";
import { useVectorGeometryPrefetch } from "@/hooks/useVectorGeometryPrefetch";
import type { OpsTable } from "@/lib/oneclick/oneclick";

/**
 * Keep vector-geometry prefetch lifetime out of the heavyweight PDF viewer render tree.
 *
 * Same shape as `TextractLoaderController` and `PageWindowLoaderController`, which is the
 * established precedent for a headless controller mounted from `PDFViewer`: it renders nothing and
 * exists so its subscriptions re-render *it* rather than the viewer.
 *
 * ── WHY THE SUBSCRIPTIONS LIVE HERE AND NOT IN THE HOOK ─────────────────────────────────
 * `useVectorGeometryPrefetch` takes every dependency as an argument and reads no store, so it can
 * be tested exhaustively without a provider tree. This file is the one place that knows where
 * those values come from — which keeps `PDFViewer`'s own diff to a single import and a single JSX
 * line, and leaves its seven freeze pins untouched.
 *
 * `pdfDoc` and `pageNumber` arrive as PROPS because `PDFViewer` owns them (the document is local
 * state, and subscribing to navigation here would add this file to a pinned navigation-topology
 * record for no benefit).
 *
 * ⚠ The active-tool read uses `selectActiveToolKey` rather than touching `activeTool` directly —
 * the same line `AreaTab.tsx` already uses. A whole-`activeTool` selector re-renders on every
 * tool-state change, and the canvas-topology freeze suite rejects that pattern outright in the
 * files it guards.
 */

interface VectorGeometryPrefetchControllerProps {
  pdfDoc: PDFDocumentProxy | null;
  pageNumber: number;
}

export default function VectorGeometryPrefetchController({
  pdfDoc,
  pageNumber,
}: VectorGeometryPrefetchControllerProps) {
  const queryClient = useQueryClient();
  const { publicId } = useProjectIdentity();
  const toolArmed = useToolStore((s) => selectActiveToolKey(s) === "bucketFill");

  // pdf.js's opcode table, injected downward so neither the cache nor the engine imports pdfjs.
  // `PDFViewer` has already resolved this module by the time a document exists, so this is a
  // cache hit rather than a second load — it costs a microtask, not a fetch.
  const [ops, setOps] = useState<OpsTable | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("pdfjs-dist")
      .then((pdfjs) => {
        if (!cancelled) setOps(pdfjs.OPS as unknown as OpsTable);
      })
      .catch(() => {
        // Without OPS the prefetcher simply never fires and every click routes to raster. That is
        // the correct degradation and it is silent by design; PDFViewer surfaces a real load
        // failure already, and a second error here would only duplicate it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useVectorGeometryPrefetch({
    queryClient,
    publicId,
    pageNumber,
    pdfDoc,
    toolArmed,
    ops,
  });

  return null;
}
