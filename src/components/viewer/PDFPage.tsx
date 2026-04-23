"use client";

import { useEffect, useRef, useState, useCallback, memo } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore, useKeynoteParse } from "@/stores/viewerStore";
import SearchHighlightOverlay from "./SearchHighlightOverlay";
import TextAnnotationOverlay from "./TextAnnotationOverlay";
import KeynoteOverlay from "./KeynoteOverlay";
import AnnotationOverlay from "./AnnotationOverlay";
import GuidedParseOverlay from "./GuidedParseOverlay";
import FastManualParseOverlay from "./FastManualParseOverlay";
import ParagraphOverlay, { type ParagraphRegionKind } from "./ParagraphOverlay";
import { CLUSTER_Y_TOLERANCE_FACTOR } from "@/lib/spatial-constants";
import DrawingPreviewLayer from "./DrawingPreviewLayer";
import ParseRegionLayer from "./ParseRegionLayer";
import ParsedTableCellOverlay from "./ParsedTableCellOverlay";

interface CacheEntry {
  bitmap: ImageBitmap;
  cssWidth: number;
  cssHeight: number;
  scale: number;
  pxWidth: number;
  pxHeight: number;
}

const MAX_CACHED_PAGES = 8;

const KeynoteGuidedOverlaySlot = memo(function KeynoteGuidedOverlaySlot(props: {
  width: number;
  height: number;
  cssScale: number;
}) {
  const {
    guidedParseActive,
    guidedParseRegion,
    guidedParseRows,
    guidedParseCols,
    setGuidedParseRows,
    setGuidedParseCols,
  } = useKeynoteParse();
  return (
    <GuidedParseOverlay
      active={guidedParseActive}
      region={guidedParseRegion}
      rows={guidedParseRows}
      cols={guidedParseCols}
      setRows={setGuidedParseRows}
      setCols={setGuidedParseCols}
      width={props.width}
      height={props.height}
      cssScale={props.cssScale}
    />
  );
});

const NotesFastManualOverlaySlot = memo(function NotesFastManualOverlaySlot(props: {
  pageNumber: number;
  width: number;
  height: number;
  cssScale: number;
}) {
  const active = useViewerStore((s) => s.notesFastManualActive);
  const notesParseRegion = useViewerStore((s) => s.notesParseRegion);
  const textractData = useViewerStore((s) => s.textractData[props.pageNumber]);
  const setNotesFastManualGrid = useViewerStore((s) => s.setNotesFastManualGrid);
  const lines = textractData?.lines ?? [];
  return (
    <FastManualParseOverlay
      active={active}
      textractLines={lines}
      regionBbox={notesParseRegion}
      onGridChange={setNotesFastManualGrid}
      width={props.width}
      height={props.height}
      cssScale={props.cssScale}
    />
  );
});

const ParagraphOverlaySlot = memo(function ParagraphOverlaySlot(props: {
  pageNumber: number;
  width: number;
  height: number;
  cssScale: number;
}) {
  const active = useViewerStore((s) => s.paragraphOverlayActive);
  const specParseRegion = useViewerStore((s) => s.specParseRegion);
  const notesParseRegion = useViewerStore((s) => s.notesParseRegion);
  const textractData = useViewerStore((s) => s.textractData[props.pageNumber]);
  const pageIntel = useViewerStore((s) => s.pageIntelligence[props.pageNumber]);
  const paragraphBatch = useViewerStore((s) => s.paragraphBatch);
  const paragraphClipboard = useViewerStore((s) => s.paragraphClipboard);
  const upsertPendingParagraph = useViewerStore((s) => s.upsertPendingParagraph);
  const removePendingParagraph = useViewerStore((s) => s.removePendingParagraph);
  const setParagraphClipboard = useViewerStore((s) => s.setParagraphClipboard);
  const resetNotesParse = useViewerStore((s) => s.resetNotesParse);
  const resetSpecParse = useViewerStore((s) => s.resetSpecParse);

  // Phase 2.5 temporary: prefer spec region when present, else notes region.
  // Phase 2.6 will unify into a single `parseRegion` slot.
  const outerBbox = specParseRegion ?? notesParseRegion;
  const isSpec = !!specParseRegion;
  // Notes default to the numbered binder since it's the most common shape on
  // arch drawings. Per-paragraph rowText is still editable in ParagraphOverlay,
  // and Step 5 (parallel MethodResult refactor) will re-introduce an
  // algorithmic regionKind selector driven by the winning method.
  const regionKind: ParagraphRegionKind = isSpec ? "spec-dense-columns" : "notes-numbered";

  const allLines = textractData?.lines ?? [];
  const textRegions = (pageIntel as { textRegions?: import("@/types").TextRegion[] } | undefined)?.textRegions ?? [];

  // Loose y-gap tolerance for specs (dense paragraph blocks); tighter for notes (short items).
  // Matches the classifier's line-height-factor default scaled for each family.
  const yGapTolerance = isSpec ? CLUSTER_Y_TOLERANCE_FACTOR * 0.035 * 8 : CLUSTER_Y_TOLERANCE_FACTOR * 0.025 * 4;

  const onExit = useCallback(() => {
    if (isSpec) resetSpecParse();
    else resetNotesParse();
  }, [isSpec, resetSpecParse, resetNotesParse]);

  return (
    <ParagraphOverlay
      active={active}
      outerBbox={outerBbox}
      textRegions={textRegions}
      allLines={allLines}
      yGapTolerance={yGapTolerance}
      regionKind={regionKind}
      paragraphBatch={paragraphBatch}
      paragraphClipboard={paragraphClipboard}
      onParagraphUpsert={upsertPendingParagraph}
      onParagraphRemove={removePendingParagraph}
      onClipboardCapture={setParagraphClipboard}
      onExit={onExit}
      width={props.width}
      height={props.height}
      cssScale={props.cssScale}
    />
  );
});

interface PDFPageProps {
  pdfDoc: PDFDocumentProxy | null;
  pageNumber: number;
  scale: number;
  containerWidth: number;
}

export default memo(function PDFPage({
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
  const initialRenderDoneRef = useRef(false);
  const pdfRenderedForPageRef = useRef(0); // tracks which page pdf.js has rendered
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // LRU page render cache — stores last N rendered pages as ImageBitmaps
  // Keyed by page number; each entry stores the scale it was rendered at
  const pageCacheRef = useRef<Map<number, CacheEntry>>(new Map());
  const preRenderTasksRef = useRef<Map<number, { cancel: () => void }>>(new Map());

  // Clean up cached bitmaps on unmount
  useEffect(() => {
    const cache = pageCacheRef.current;
    const tasks = preRenderTasksRef.current;
    return () => {
      for (const entry of cache.values()) entry.bitmap.close();
      cache.clear();
      for (const task of tasks.values()) task.cancel();
      tasks.clear();
    };
  }, []);

  // Pre-rendered PNG fallback for instant page display while pdf.js renders
  const dataUrl = useViewerStore((s) => s.dataUrl);
  const pageKey = String(pageNumber).padStart(4, "0");
  const cdnDomain = typeof window !== "undefined" ? undefined : undefined; // client-side only
  const s3Bucket = process.env.NEXT_PUBLIC_S3_BUCKET || "";
  const cloudfront = process.env.NEXT_PUBLIC_CLOUDFRONT_DOMAIN;
  const fallbackSrc = dataUrl
    ? cloudfront
      ? `https://${cloudfront}/${dataUrl}/pages/page_${pageKey}.png`
      : `https://${s3Bucket}.s3.amazonaws.com/${dataUrl}/pages/page_${pageKey}.png`
    : null;
  const [canvasReady, setCanvasReady] = useState(false);
  const [fallbackError, setFallbackError] = useState(false);

  // Reset states when page changes — don't hide canvas yet (old content stays visible
  // until new PNG or canvas is ready, preventing white flash)
  useEffect(() => { setFallbackError(false); initialRenderDoneRef.current = false; pdfRenderedForPageRef.current = 0; }, [pageNumber]);

  // Base width = container width minus padding, so page fills the viewport
  const baseWidth = Math.max(containerWidth - 32, 400);

  // Store a rendered page in the LRU cache
  const cacheRenderedPage = useCallback((page: number, tmpCanvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, targetScale: number, pxW: number, pxH: number) => {
    createImageBitmap(tmpCanvas).then((bitmap) => {
      const cache = pageCacheRef.current;
      // Close old bitmap for this page if exists
      cache.get(page)?.bitmap.close();
      cache.delete(page); // delete + re-insert = LRU move-to-end
      cache.set(page, { bitmap, cssWidth, cssHeight, scale: targetScale, pxWidth: pxW, pxHeight: pxH });
      // Evict oldest if over limit
      if (cache.size > MAX_CACHED_PAGES) {
        const oldestKey = cache.keys().next().value!;
        cache.get(oldestKey)?.bitmap.close();
        cache.delete(oldestKey);
      }
    }).catch(() => {}); // createImageBitmap may fail in some contexts
  }, []);

  // PNG loaded — derive dimensions and signal that new content is ready
  const handleFallbackLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    // Set dimensions from PNG when pdf.js hasn't rendered THIS page yet
    // (pdfRenderedForPageRef resets on page change, so PNG always sets dims for new pages)
    if (img.naturalWidth > 0 && pdfRenderedForPageRef.current !== pageNumber) {
      const fitScale = baseWidth / img.naturalWidth;
      setPageSize({ width: baseWidth, height: img.naturalHeight * fitScale });
    }
    // PNG is ready — now safe to hide canvas (old page → new PNG, no white gap)
    setCanvasReady(false);
  }, [baseWidth, pageNumber]);

  const renderPage = useCallback(
    async (targetScale: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !pdfDoc) return;

      // Check LRU cache — instant draw if page was previously rendered at this scale
      const cached = pageCacheRef.current.get(pageNumber);
      if (cached && cached.scale === targetScale) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          canvas.width = cached.pxWidth;
          canvas.height = cached.pxHeight;
          canvas.style.width = `${cached.cssWidth}px`;
          canvas.style.height = `${cached.cssHeight}px`;
          ctx.drawImage(cached.bitmap, 0, 0);
        }
        setPageSize({ width: cached.cssWidth, height: cached.cssHeight });
        setRenderedScale(targetScale);
        setCanvasReady(true);
        initialRenderDoneRef.current = true;
        pdfRenderedForPageRef.current = pageNumber;
        // LRU touch: move to end
        pageCacheRef.current.delete(pageNumber);
        pageCacheRef.current.set(pageNumber, cached);
        return;
      }

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
        const pxWidth = Math.floor(viewport.width * dpr);
        const pxHeight = Math.floor(viewport.height * dpr);

        // Render to OFFSCREEN canvas — visible canvas keeps old content during render
        // This eliminates the white flash that occurs when canvas.width clears the buffer
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = pxWidth;
        tmpCanvas.height = pxHeight;
        const tmpCtx = tmpCanvas.getContext("2d");
        if (!tmpCtx) return;

        tmpCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderTask = page.render({
          canvasContext: tmpCtx,
          viewport,
        });

        renderTaskRef.current = renderTask;

        await renderTask.promise;
        renderTaskRef.current = null;

        // ATOMIC SWAP: clear + copy in same synchronous block = no visible flash
        // Browser doesn't paint between synchronous DOM operations
        canvas.width = pxWidth;
        canvas.height = pxHeight;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(tmpCanvas, 0, 0);

        // Store in LRU cache for instant revisit
        cacheRenderedPage(pageNumber, tmpCanvas, viewport.width, viewport.height, targetScale, pxWidth, pxHeight);

        setPageSize({ width: viewport.width, height: viewport.height });
        setRenderedScale(targetScale);
        setCanvasReady(true);
        initialRenderDoneRef.current = true;
        pdfRenderedForPageRef.current = pageNumber;
      } catch (err: any) {
        if (err?.name !== "RenderingCancelledException") {
          console.error("Render error:", err);
        }
      }
    },
    [pdfDoc, pageNumber, baseWidth, cacheRenderedPage]
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

  // Background pre-render adjacent pages during idle time
  // After current page renders, pre-render N+1 and N-1 into the LRU cache
  const numPages = useViewerStore((s) => s.numPages);
  useEffect(() => {
    if (!pdfDoc || renderedScale === 0) return;
    const currentScale = scaleRef.current;
    const pagesToPreRender = [pageNumber + 1, pageNumber - 1].filter(
      (p) => p >= 1 && p <= numPages
    );

    const idleIds: number[] = [];
    for (const p of pagesToPreRender) {
      // Skip if already cached at this scale
      const existing = pageCacheRef.current.get(p);
      if (existing && existing.scale === currentScale) continue;

      const id = (typeof requestIdleCallback !== "undefined" ? requestIdleCallback : setTimeout)(async () => {
        // Cancel any existing pre-render for this page
        preRenderTasksRef.current.get(p)?.cancel();

        try {
          const page = await pdfDoc.getPage(p);
          const uv = page.getViewport({ scale: 1 });
          const bScale = baseWidth / uv.width;
          const fScale = bScale * currentScale;
          const vp = page.getViewport({ scale: fScale });
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const pw = Math.floor(vp.width * dpr);
          const ph = Math.floor(vp.height * dpr);

          const tmp = document.createElement("canvas");
          tmp.width = pw;
          tmp.height = ph;
          const ctx = tmp.getContext("2d");
          if (!ctx) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          const task = page.render({ canvasContext: ctx, viewport: vp });
          preRenderTasksRef.current.set(p, task);

          await task.promise;
          preRenderTasksRef.current.delete(p);

          // Store in cache (no React state updates — purely background)
          cacheRenderedPage(p, tmp, vp.width, vp.height, currentScale, pw, ph);
        } catch (err: any) {
          if (err?.name !== "RenderingCancelledException") {
            // Pre-render failures are non-critical
          }
          preRenderTasksRef.current.delete(p);
        }
      }) as number;
      idleIds.push(id);
    }

    return () => {
      const cancelFn = typeof cancelIdleCallback !== "undefined" ? cancelIdleCallback : clearTimeout;
      for (const id of idleIds) cancelFn(id);
      // Cancel any in-flight pre-render tasks
      for (const task of preRenderTasksRef.current.values()) task.cancel();
      preRenderTasksRef.current.clear();
    };
  }, [pdfDoc, pageNumber, renderedScale, numPages, baseWidth, cacheRenderedPage]);

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
        contain: "layout",
      }}
    >
      {/* PNG background — ALWAYS in DOM behind canvas. Shows through when canvas is hidden.
           Old page stays visible until new PNG loads (no white flash on page switch). */}
      {fallbackSrc && !fallbackError && (
        <img
          src={fallbackSrc}
          alt=""
          decoding="async"
          onLoad={handleFallbackLoad}
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
        data-page-canvas="true"
        style={{
          transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
          transformOrigin: "top left",
          willChange: "transform",
          opacity: canvasReady ? 1 : 0,
          transition: !initialRenderDoneRef.current ? "opacity 150ms ease-in" : undefined,
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
      <KeynoteGuidedOverlaySlot
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
      <NotesFastManualOverlaySlot
        pageNumber={pageNumber}
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
      <ParagraphOverlaySlot
        pageNumber={pageNumber}
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
      <ParsedTableCellOverlay
        width={pageSize.width}
        height={pageSize.height}
        cssScale={cssScale}
      />
    </div>
  );
})
