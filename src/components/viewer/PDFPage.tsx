"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore } from "@/stores/viewerStore";
import SearchHighlightOverlay from "./SearchHighlightOverlay";
import KeynoteOverlay from "./KeynoteOverlay";
import AnnotationOverlay from "./AnnotationOverlay";

interface PDFPageProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  containerWidth: number;
}

export default function PDFPage({
  pdfDoc,
  pageNumber,
  scale,
  containerWidth,
}: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<void> } | null>(null);
  const [renderedScale, setRenderedScale] = useState(0);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Base width = container width minus padding, so page fills the viewport
  const baseWidth = Math.max(containerWidth - 32, 400);

  const renderPage = useCallback(
    async (targetScale: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !pdfDoc) return;

      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }

        const page = await pdfDoc.getPage(pageNumber);
        const unscaledViewport = page.getViewport({ scale: 1 });

        // Fit page to container width, then apply user zoom
        const baseScale = baseWidth / unscaledViewport.width;
        const finalScale = baseScale * targetScale;

        const viewport = page.getViewport({ scale: finalScale });

        // Render at device pixel ratio for crisp output on Retina displays
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);

        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        setPageSize({ width: viewport.width, height: viewport.height });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
        });

        renderTaskRef.current = renderTask;

        await renderTask.promise;
        renderTaskRef.current = null;
        setRenderedScale(targetScale);
      } catch (err: any) {
        if (err?.name !== "RenderingCancelled") {
          console.error("Render error:", err);
        }
      }
    },
    [pdfDoc, pageNumber, baseWidth]
  );

  // Render on page change or container resize (uses ref for scale to avoid re-triggering on zoom)
  useEffect(() => {
    renderPage(scaleRef.current);
  }, [pageNumber, pdfDoc, baseWidth, renderPage]);

  // Debounced re-render on zoom change
  useEffect(() => {
    if (renderedScale === 0) return;

    if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);

    renderTimerRef.current = setTimeout(() => {
      renderPage(scale);
    }, 80);

    return () => {
      if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
    };
  }, [scale, renderPage, renderedScale]);

  // Push page dimensions to store for scale calibration math
  const setPageDimensions = useViewerStore((s) => s.setPageDimensions);
  useEffect(() => {
    if (pageSize.width > 0 && pageSize.height > 0) {
      setPageDimensions(pageNumber, pageSize.width, pageSize.height);
    }
  }, [pageNumber, pageSize.width, pageSize.height, setPageDimensions]);

  // CSS transform for instant zoom feedback while debounced render catches up
  const cssScale = renderedScale > 0 ? scale / renderedScale : 1;

  // Wrapper tracks the visual size (including CSS transform) to prevent clipping
  const displayWidth = pageSize.width ? pageSize.width * cssScale : undefined;
  const displayHeight = pageSize.height ? pageSize.height * cssScale : undefined;

  return (
    <div
      className="relative shadow-2xl"
      style={{
        width: displayWidth,
        height: displayHeight,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
          transformOrigin: "top left",
        }}
      />
      <SearchHighlightOverlay
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
      {useViewerStore((s) => s.showKeynotes) && (
        <KeynoteOverlay
          width={pageSize.width}
          height={pageSize.height}
          cssScale={cssScale}
        />
      )}
      <AnnotationOverlay
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
    </div>
  );
}
