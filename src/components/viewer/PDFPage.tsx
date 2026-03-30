"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore } from "@/stores/viewerStore";
import SearchHighlightOverlay from "./SearchHighlightOverlay";
import TextAnnotationOverlay from "./TextAnnotationOverlay";
import KeynoteOverlay from "./KeynoteOverlay";
import AnnotationOverlay from "./AnnotationOverlay";
import GuidedParseOverlay from "./GuidedParseOverlay";
import DrawingPreviewLayer from "./DrawingPreviewLayer";
import ParseRegionLayer from "./ParseRegionLayer";

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

  // Pre-rendered PNG fallback for instant page display while pdf.js renders
  const dataUrl = useViewerStore((s) => s.dataUrl);
  const pageKey = String(pageNumber).padStart(4, "0");
  const cdnDomain = typeof window !== "undefined" ? undefined : undefined; // client-side only
  const s3Bucket = process.env.NEXT_PUBLIC_S3_BUCKET || "beaver-app-uploads";
  const cloudfront = process.env.NEXT_PUBLIC_CLOUDFRONT_DOMAIN;
  const fallbackSrc = dataUrl
    ? cloudfront
      ? `https://${cloudfront}/${dataUrl}/pages/page_${pageKey}.png`
      : `https://${s3Bucket}.s3.amazonaws.com/${dataUrl}/pages/page_${pageKey}.png`
    : null;
  const [canvasReady, setCanvasReady] = useState(false);
  const [fallbackError, setFallbackError] = useState(false);

  // Reset states when page changes
  useEffect(() => { setCanvasReady(false); setFallbackError(false); }, [pageNumber]);

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

        // Render at device pixel ratio for crisp output, capped at 2 to prevent
        // excessive pixel volume on high-DPI displays (3x DPR = 9x pixels = freeze)
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
        setCanvasReady(true);
      } catch (err: any) {
        if (err?.name !== "RenderingCancelledException") {
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
    }, 300);

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
      {/* Pre-rendered PNG fallback — shows instantly while pdf.js canvas renders */}
      {fallbackSrc && !canvasReady && !fallbackError && (
        <img
          src={fallbackSrc}
          alt=""
          onError={() => setFallbackError(true)}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: displayWidth || "100%",
            height: displayHeight || "auto",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}
      <canvas
        ref={canvasRef}
        style={{
          transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
          transformOrigin: "top left",
          willChange: "transform",
          opacity: canvasReady ? 1 : 0,
          transition: "opacity 150ms ease-in",
        }}
      />
      <SearchHighlightOverlay
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
      <TextAnnotationOverlay
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
      <GuidedParseOverlay
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
      <ParseRegionLayer
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
      <AnnotationOverlay
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
    </div>
  );
}
