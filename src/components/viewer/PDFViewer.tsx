"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useSymbolSearch, useToolStore } from "@/stores/toolStore";
import { useNavigation, useViewerCoreStore } from "@/stores/viewerCoreStore";
import { navigateViewerPage } from "@/stores/viewerCommands";
import {
  useUiStore,
  useLayoutUi,
  useLayoutUiActions,
  usePanelVisibility,
} from "@/stores/uiStore";
import { useProject, useSessionStore } from "@/stores/sessionStore";
import { useShallow } from "zustand/react/shallow";
import PDFPage from "./PDFPage";
import ViewerToolbar from "./ViewerToolbar";
import PageSidebar from "./PageSidebar";
import TextPanel from "./TextPanel";
import ChatPanel from "./ChatPanel";
import AnnotationPanel from "./AnnotationPanel";
import TakeoffPanel from "./TakeoffPanel";
import DetectionPanel from "./DetectionPanel";
import GroupActionsBar from "./GroupActionsBar";
import CsiPanel from "./CsiPanel";
import PageIntelligencePanel from "./PageIntelligencePanel";
import TableParsePanel from "./TableParsePanel";
import TableCompareModal from "./TableCompareModal";
import TagBrowseBar from "./TagBrowseBar";
import KeynotePanel from "./KeynotePanel";
import SpecsNotesPanel from "./SpecsNotesPanel";
import TablesWorkspaceHost from "./workspace/TablesWorkspaceHost";
import ParsePanel from "./ParsePanel";
import ToolsPanel from "./ToolsPanel";
import SymbolSearchPanel from "./SymbolSearchPanel";
import ViewAllPanel from "./ViewAllPanel";
import PageWindowLoaderController from "./PageWindowLoaderController";
import TextractLoaderController from "./TextractLoaderController";
import VectorGeometryPrefetchController from "./VectorGeometryPrefetchController";
import { useHighlightViewportFocus, useZoomAnchorReapply } from "./useViewerViewport";
import { anchoredScroll, nextWheelScale, zoomAnchorAt } from "./viewerZoomAnchor";
import {
  loadViewport,
  saveViewport,
  type ViewerViewport,
} from "@/lib/viewer-state";
import {
  PDF_RANGE_PROBE_HEADER,
  PDF_RANGE_PROBE_VALUE,
} from "@/lib/project-asset-transport";

interface PDFViewerProps {
  pdfUrl: string;
  projectName: string;
  backHref?: string;
  onRename?: (newName: string) => void;
}

export default function PDFViewer({
  pdfUrl,
  projectName,
  backHref,
  onRename,
}: PDFViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [containerWidth, setContainerWidth] = useState(1200);

  // Slice selectors — grouped subscriptions prevent cascading re-renders
  const { pageNumber, numPages, setNumPages } = useNavigation();
  const mode = useToolStore((s) => s.mode);
  const setMode = useToolStore((s) => s.setMode);
  const { scale, setScale } = useViewerCoreStore(
    useShallow((s) => ({ scale: s.scale, setScale: s.setScale })),
  );
  const tempPanMode = useToolStore((s) => s.tempPanMode);
  const { publicId, assetBaseUrl } = useProject();
  const {
    symbolSearchActive,
    symbolSearchResults,
    symbolSearchLoading,
    symbolSearchTemplateBbox,
    symbolSearchError,
  } = useSymbolSearch();
  // Gate the floating Symbol Search popup when Parse panel's Template Parse tab
  // is open — the embedded SymbolSearchPanel in ParsePanel is the canonical
  // surface in that case, avoids double-render.
  const templateTabOpen = useUiStore(
    (s) => s.showParsePanel && s.parsePanelTab === "template",
  );

  // Preload current page PNG via <link> — starts fetch before React commits the img element
  useEffect(() => {
    if (!assetBaseUrl) return;
    const key = String(pageNumber).padStart(4, "0");
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = `${assetBaseUrl}/pages/page_${key}.png`;
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, [pageNumber, assetBaseUrl]);

  // Prefetch adjacent page PNGs into browser cache for instant navigation
  useEffect(() => {
    if (!assetBaseUrl) return;
    for (let i = pageNumber + 1; i <= Math.min(pageNumber + 3, numPages); i++) {
      const img = new Image();
      img.src = `${assetBaseUrl}/pages/page_${String(i).padStart(4, "0")}.png`;
    }
  }, [pageNumber, numPages, assetBaseUrl]);

  // Centre (and for fit requests, zoom to) highlighted regions: tag browse, LLM, View All rows.
  const llmHighlight = useUiStore((s) => s.llmHighlight);
  const pageDimensions = useViewerCoreStore((s) => s.pageDimensions);
  useHighlightViewportFocus(containerRef, pageWrapRef, llmHighlight);
  const armZoomAnchor = useZoomAnchorReapply(containerRef, pageWrapRef, scale);

  // Keyboard shortcuts: a = pointer/select, v = pan/zoom (hold V = temp pan in tools)
  const isPanningRef = useRef(false);
  const vReleasedDuringPanRef = useRef(false);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement).isContentEditable
      )
        return;
      if (e.key === "a") setMode("pointer");
      else if (e.key === "v") {
        if (e.repeat) return;
        const s = useToolStore.getState();
        const toolActive = s.activeTool !== null;
        if (toolActive) {
          s.setTempPanMode(true);
        } else {
          setMode("move");
        }
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      if (e.key !== "v") return;
      const s = useToolStore.getState();
      if (!s.tempPanMode) return;
      if (isPanningRef.current) {
        vReleasedDuringPanRef.current = true;
      } else {
        s.setTempPanMode(false);
      }
    }
    function handleBlur() {
      useToolStore.getState().setTempPanMode(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [setMode]);

  // Measure container width for fit-to-width rendering
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  // Load pdf.js and the document
  useEffect(() => {
    let cancelled = false;
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;

    async function loadPdf() {
      try {
        setLoading(true);
        setError(null);
        setPdfDoc(null);

        // Dynamic import to avoid SSR issues
        const pdfjsLib = await import("pdfjs-dist");
        if (cancelled) return;

        // Set up worker — use static copy in public/ for standalone build compatibility
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          // Mark pdf.js' initial un-ranged capability request so the private
          // gateway can learn the S3 object length with a one-byte upstream
          // range instead of racing a buffered full-object GET cancellation.
          httpHeaders: {
            [PDF_RANGE_PROBE_HEADER]: PDF_RANGE_PROBE_VALUE,
          },
          cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/",
          cMapPacked: true,
          // pdf.js keeps a full-document GET alive unless streaming is also disabled. Bounded 1MiB
          // ranges amortize the access-checked application gateway without weakening its pre/post
          // lifecycle fences, and stop withdrawn documents before the next chunk is admitted.
          disableStream: true,
          disableAutoFetch: true,
          rangeChunkSize: 1024 * 1024,
        });
        const doc = await loadingTask.promise;

        if (cancelled) return;

        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load PDF:", err);
        setError("Failed to load PDF");
        setLoading(false);
      }
    }

    loadPdf();
    return () => {
      cancelled = true;
      // Cancel in-flight ranges and release the worker/document when the project changes or the
      // viewer unmounts. destroy() is idempotent at this loading-task boundary.
      if (loadingTask) void loadingTask.destroy().catch(() => undefined);
    };
  }, [pdfUrl, setNumPages]);

  // Per-project viewport restore-or-center. Two effects cooperate:
  // intent reads localStorage and stashes the target; apply waits for
  // pageDimensions[targetPage] (populated by PDFPage once the inner padded
  // div has grown past the container) before placing the scroll. This is
  // why the earlier single-effect fix clamped to 0 — the inner div was
  // still at minimum width when the scroll assignment fired.
  const pendingRestoreRef = useRef<ViewerViewport | "center" | null>(null);
  const hasAppliedRef = useRef(false);

  useEffect(() => {
    if (!publicId) return;
    pendingRestoreRef.current = null;
    hasAppliedRef.current = false;

    const saved = loadViewport(publicId);
    if (saved) {
      const clampedPage = Math.max(
        1,
        Math.min(saved.pageNumber, numPages || saved.pageNumber),
      );
      pendingRestoreRef.current = { ...saved, pageNumber: clampedPage };
      setScale(saved.scale);
      navigateViewerPage(clampedPage);
    } else {
      pendingRestoreRef.current = "center";
    }
  }, [publicId, numPages, setScale]);

  const restorePageDimensions = useViewerCoreStore((s) => s.pageDimensions);
  useEffect(() => {
    if (hasAppliedRef.current) return;
    if (!pdfDoc) return;
    const intent = pendingRestoreRef.current;
    if (!intent) return;
    const container = containerRef.current;
    if (!container) return;

    const targetPage = intent === "center" ? 1 : intent.pageNumber;
    const dim = restorePageDimensions[targetPage];
    if (!dim) return;

    if (intent === "center") {
      // The inner scroll content has paddingLeft: 25vw and paddingTop: 50vh
      // (inline style at PDFViewer.tsx:577-578, which overrides the p-4 class).
      // Scrolling to those offsets lands the page at the top-left of the viewport.
      // For horizontal: at scale=1 the page width ≈ containerWidth-32, so
      // scrollLeft = 25vw approximately centers it (off by up to 16px of slack).
      // For vertical: we additionally center the page within the container when
      // it fits, and clamp to the page top when it overflows.
      container.scrollLeft = window.innerWidth * 0.25;
      const pageTopY = window.innerHeight * 0.5;
      const gap = dim.height - container.clientHeight;
      container.scrollTop = gap <= 0 ? pageTopY + gap / 2 : pageTopY;
    } else {
      container.scrollLeft = intent.scrollLeft;
      container.scrollTop = intent.scrollTop;
    }
    hasAppliedRef.current = true;
    pendingRestoreRef.current = null;
  }, [pdfDoc, restorePageDimensions]);

  // Persist viewport to the in-memory session map on scroll / scale / page
  // changes (see viewer-state.ts — storage is per-tab and resets on refresh).
  // The flush-on-cleanup is gated on "store still has this project's publicId"
  // so that the A→B re-use path (where PDFViewer stays mounted and
  // resetProjectData() has already zeroed the store) skips the flush and
  // doesn't overwrite A's saved entry with the reset values. The A→/home
  // unmount path still has the store at this project's state, so flush fires.
  useEffect(() => {
    if (!publicId) return;
    const container = containerRef.current;
    if (!container) return;

    const doSave = () => {
      if (!hasAppliedRef.current) return;
      const current = useViewerCoreStore.getState();
      const session = useSessionStore.getState();
      if (session.publicId !== publicId) return;
      saveViewport(publicId, {
        scale: current.scale,
        pageNumber: current.pageNumber,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
        savedAt: Date.now(),
      });
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(doSave, 500);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
      doSave();
    };
  }, [publicId]);

  useEffect(() => {
    if (!publicId || !hasAppliedRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const timer = setTimeout(() => {
      if (useSessionStore.getState().publicId !== publicId) return;
      saveViewport(publicId, {
        scale,
        pageNumber,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
        savedAt: Date.now(),
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [publicId, scale, pageNumber]);

  // Center when zoomFit is triggered (via store flag)
  const { pendingCenter, clearPendingCenter } = useViewerCoreStore(
    useShallow((s) => ({
      pendingCenter: s.pendingCenter,
      clearPendingCenter: s.clearPendingCenter,
    })),
  );
  useEffect(() => {
    if (!pendingCenter) return;
    clearPendingCenter();

    const container = containerRef.current;
    if (!container) return;

    // Compute fit scale from current container + page natural size. containerRef.clientWidth
    // already reflects the current available width (shrinks when side panels open), so fit
    // adapts to panel state. 0.95 leaves a tiny margin so the page doesn't kiss the edges.
    const dim = pageDimensions[pageNumber];
    if (dim && dim.width > 0 && dim.height > 0) {
      const fitScale =
        Math.min(
          container.clientWidth / dim.width,
          container.clientHeight / dim.height,
        ) * 0.95;
      if (fitScale > 0 && isFinite(fitScale)) {
        setScale(fitScale);
        scaleRef.current = fitScale;
      }
    } else {
      // Dimensions not yet known (first render); fall back to scale=1 like the old behavior.
      setScale(1);
      scaleRef.current = 1;
    }

    // Center using hardcoded padding offsets. scrollWidth is unreliable during the CSS
    // scale transition, so we compute from known layout: inner div has paddingLeft=25vw,
    // paddingRight=25vw, top-bottom padding p-4 + 50vh offset. These values hold regardless
    // of the current transform state.
    const targetLeft = window.innerWidth * 0.25;
    const targetTop = window.innerHeight * 0.5;
    container.scrollLeft = targetLeft;
    container.scrollTop = targetTop;
  }, [pendingCenter, clearPendingCenter, pageDimensions, pageNumber, setScale]);

  // Zoom via wheel — document-level capture phase listener
  // Guarantees we intercept events before browser native scroll or child elements
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    function handleWheel(e: WheelEvent) {
      const container = containerRef.current;
      if (!container) return;

      // Only handle events targeting the viewer container
      if (!container.contains(e.target as Node)) return;

      // Determine if we should zoom:
      // - Ctrl/Meta+wheel: zoom in ANY mode (universal shortcut)
      // - Plain wheel in Pan mode: zoom (trackpad two-finger)
      const isCtrlZoom = e.ctrlKey || e.metaKey;
      const isPanZoom = modeRef.current === "move" && !isCtrlZoom;

      if (!isCtrlZoom && !isPanZoom) return; // Let native scroll happen

      e.preventDefault();
      e.stopPropagation();

      const rect = container.getBoundingClientRect();
      const pageRect = pageWrapRef.current?.getBoundingClientRect() ?? null;
      const oldScale = scaleRef.current;
      const newScale = nextWheelScale(oldScale, e.deltaY, e.deltaMode);
      scaleRef.current = newScale;

      // Keep the PAGE point under the cursor (the padding around the page does not scale): scroll now, and
      // re-apply once the page has resized, since this assignment is clamped to the old scroll size.
      const ratio = newScale / oldScale;
      const anchor = zoomAnchorAt(e.clientX, e.clientY, pageRect, rect);
      const scroll = { left: container.scrollLeft, top: container.scrollTop };
      const next = anchoredScroll(anchor, pageRect, rect, scroll, ratio, e);
      container.scrollLeft = next.left;
      container.scrollTop = next.top;
      armZoomAnchor(anchor, (pageRect?.width ?? 0) * ratio);

      // Immediate scale update for CSS transform feedback
      // PDFPage debounces the expensive re-rasterization separately (300ms)
      setScale(newScale);
    }

    // Capture phase on document — fires before any child element or native scroll
    document.addEventListener("wheel", handleWheel, {
      passive: false,
      capture: true,
    });
    return () =>
      document.removeEventListener("wheel", handleWheel, { capture: true });
  }, [setScale, armZoomAnchor]);

  // Click-drag pan
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const tool = useToolStore.getState();
    const shouldPan =
      tool.tempPanMode || (tool.activeTool === null && tool.mode === "move");
    if (!shouldPan) return;
    if (e.button !== 0) return;

    const container = containerRef.current;
    if (!container) return;

    setIsPanning(true);
    isPanningRef.current = true;
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    };
    container.style.cursor = "grabbing";
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;

      const container = containerRef.current;
      if (!container) return;

      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      container.scrollLeft = panStart.current.scrollLeft - dx;
      container.scrollTop = panStart.current.scrollTop - dy;
    },
    [isPanning],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    isPanningRef.current = false;
    const container = containerRef.current;
    const tool = useToolStore.getState();
    const tempPan = tool.tempPanMode;
    const basePan = tool.activeTool === null && tool.mode === "move";
    if (container)
      container.style.cursor = basePan || tempPan ? "grab" : "default";
    if (vReleasedDuringPanRef.current) {
      vReleasedDuringPanRef.current = false;
      useToolStore.getState().setTempPanMode(false);
      if (container) container.style.cursor = "default";
    }
  }, []);

  // Hooks must be before early returns (Rules of Hooks)
  const { isDemo } = useProject();
  const { sidebarCollapsed, annotationPanelCollapsed, showTips, helpMode } =
    useLayoutUi();
  const { toggleSidebar, toggleAnnotationPanel, toggleTips, toggleHelpMode } =
    useLayoutUiActions();
  const showTableCompareModal = useUiStore((s) => s.showTableCompareModal);

  // Demo page sets helpMode: false, showTips: false directly — no auto-override needed

  return (
    <>
      {/* Keep loader rerenders and request lifetime out of this heavyweight component. */}
      <PageWindowLoaderController />
      <TextractLoaderController />
      <VectorGeometryPrefetchController pdfDoc={pdfDoc} pageNumber={pageNumber} />
      {error ? (
        <div className="flex-1 flex items-center justify-center text-red-400">
          {error}
        </div>
      ) : (
        <div className="flex-1 flex flex-col h-screen">
          <ViewerToolbar
            projectName={projectName}
            backHref={backHref}
            onRename={onRename}
          />
          <GroupActionsBar />

          {/* Help tips banner — dismissible, toggleable from Menu → Help */}
          {showTips && (
            <div className="h-8 bg-[var(--surface)] border-b border-[var(--border)] flex items-center justify-center px-4 shrink-0">
              <div className="flex items-center gap-3 text-[11px] -ml-16">
                <span className="text-[var(--fg)]/50 font-medium">
                  BUTTONS:
                </span>
                <span className="text-[var(--fg)]/60">
                  Menu — Data labeling & more
                </span>
                <span className="text-[var(--border)]">|</span>
                <span className="text-purple-400/80">
                  YOLO — Toggle AI detections on/off
                </span>
                <span className="text-[var(--border)]">|</span>
                <span className="text-sky-400/80">
                  Text — Phone, abbreviations & more
                </span>
                <span className="text-[var(--border)]">|</span>
                <span className="text-blue-400/80">
                  Chat — Talk with LLM about blueprints
                </span>
                <span className="text-[var(--border)]">|</span>
                <span className="text-emerald-400/80">QTO — Count + area</span>
                <span className="text-[var(--border)]">|</span>
                <span className="text-amber-400/80 inline-flex items-center gap-1">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="inline-block"
                  >
                    <ellipse cx="8" cy="8" rx="7" ry="4.5" />
                    <circle cx="8" cy="8" r="2" fill="currentColor" />
                  </svg>
                  — Toggle simple_parse on/off
                </span>
              </div>
              <button
                onClick={toggleHelpMode}
                className={`text-[11px] ml-4 px-2 py-0.5 rounded border transition-colors ${
                  helpMode
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10 animate-pulse"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]/50"
                }`}
              >
                {helpMode ? "Help ON" : "Help Mode Off"}
              </button>
              <button
                onClick={toggleTips}
                className="text-[var(--muted)] hover:text-[var(--fg)] text-sm ml-2 w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--surface)]"
              >
                x
              </button>
            </div>
          )}

          <div className="flex flex-1 min-h-0">
            {!sidebarCollapsed && <PageSidebar pdfDoc={pdfDoc} />}

            <div className="flex-1 flex flex-col min-w-0 relative">
              {/* Sidebar collapse toggle — outside scroll container so it doesn't scroll away */}
              <button
                onClick={toggleSidebar}
                className="absolute top-2 left-2 z-20 w-6 h-6 rounded flex items-center justify-center text-xs bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--fg)]/40"
                title={sidebarCollapsed ? "Show pages" : "Hide pages"}
              >
                {sidebarCollapsed ? ">" : "<"}
              </button>

              {/* Symbol Search floating panel — suppressed when ParsePanel's Template
              Parse tab is active (the embedded SymbolSearchPanel there is the
              canonical surface in that case). */}
              {(symbolSearchActive ||
                symbolSearchResults ||
                symbolSearchLoading ||
                symbolSearchTemplateBbox ||
                symbolSearchError) &&
                !templateTabOpen && (
                  <div className="absolute top-12 left-10 z-50">
                    <SymbolSearchPanel pdfDoc={pdfDoc} />
                  </div>
                )}

              <div
                ref={containerRef}
                className="flex-1 bg-[var(--bg)] overflow-auto relative"
                style={{
                  cursor: mode === "move" || tempPanMode ? "grab" : "default",
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                <div
                  className="p-4"
                  style={{
                    width: "fit-content",
                    paddingTop: "50vh",
                    paddingBottom: "50vh",
                    paddingLeft: "25vw",
                    paddingRight: "25vw",
                  }}
                >
                  <div ref={pageWrapRef} style={{ width: "fit-content", margin: "0 auto" }}>
                    <PDFPage
                      pdfDoc={pdfDoc}
                      pageNumber={pageNumber}
                      scale={scale}
                      containerWidth={containerWidth}
                    />
                  </div>
                </div>
              </div>

              {/* Annotation panel — collapsible */}
              {annotationPanelCollapsed ? (
                <button
                  onClick={toggleAnnotationPanel}
                  className="border-t border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)] hover:text-[var(--fg)] text-left shrink-0"
                  style={{ backgroundColor: "var(--surface)" }}
                >
                  View Annotations
                </button>
              ) : (
                <>
                  <AnnotationPanel />
                  <button
                    onClick={toggleAnnotationPanel}
                    className="border-t border-[var(--border)] px-3 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--fg)] text-center shrink-0"
                    style={{ backgroundColor: "var(--surface)" }}
                  >
                    Collapse
                  </button>
                </>
              )}
            </div>

            {/* Right-side panels — subscribes independently to avoid re-rendering PDF area */}
            <ViewerPanels pdfDoc={pdfDoc} />
          </div>

          {/* Fullscreen modal overlays */}
          {showTableCompareModal && pdfDoc && (
            <TableCompareModal pdfDoc={pdfDoc} />
          )}

          {/* Tag instance browser bar */}
          <TagBrowseBar />
        </div>
      )}
    </>
  );
}

/** Panels subscribe to their own visibility — toggles don't re-render PDFPage/overlays */
function ViewerPanels({ pdfDoc }: { pdfDoc: PDFDocumentProxy | null }) {
  const {
    showTextPanel,
    showChatPanel,
    showTakeoffPanel,
    showDetectionPanel,
    showCsiPanel,
    showPageIntelPanel,
    showTableParsePanel,
    showKeynoteParsePanel,
    showSpecsNotesPanel,
    showParsePanel,
    showToolsPanel,
    showViewAllPanel,
  } = usePanelVisibility();

  return (
    <div className="viewer-scalable flex shrink-0">
      {showTextPanel && <TextPanel />}
      {showChatPanel && <ChatPanel />}
      {showTakeoffPanel && <TakeoffPanel />}
      {showDetectionPanel && <DetectionPanel />}
      {showCsiPanel && <CsiPanel />}
      {showPageIntelPanel && <PageIntelligencePanel />}
      {showTableParsePanel && <TableParsePanel />}
      {showKeynoteParsePanel && <KeynotePanel />}
      {showSpecsNotesPanel && <SpecsNotesPanel />}
      <TablesWorkspaceHost />
      {showParsePanel && <ParsePanel pdfDoc={pdfDoc} />}
      {showToolsPanel && <ToolsPanel />}
      {showViewAllPanel && <ViewAllPanel />}
    </div>
  );
}
