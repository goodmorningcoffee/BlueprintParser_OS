"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore } from "@/stores/viewerStore";
import PDFPage from "./PDFPage";
import ViewerToolbar from "./ViewerToolbar";
import PageSidebar from "./PageSidebar";
import TextPanel from "./TextPanel";
import ChatPanel from "./ChatPanel";
import AnnotationPanel from "./AnnotationPanel";
import TakeoffPanel from "./TakeoffPanel";
import DetectionPanel from "./DetectionPanel";
import CsiPanel from "./CsiPanel";
import PageIntelligencePanel from "./PageIntelligencePanel";
import TableParsePanel from "./TableParsePanel";
import TableCompareModal from "./TableCompareModal";
import KeynotePanel from "./KeynotePanel";
import SymbolSearchPanel from "./SymbolSearchPanel";
import { useChunkLoader } from "@/hooks/useChunkLoader";

interface PDFViewerProps {
  pdfUrl: string;
  projectName: string;
  backHref?: string;
  onRename?: (newName: string) => void;
}

export default function PDFViewer({ pdfUrl, projectName, backHref, onRename }: PDFViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [containerWidth, setContainerWidth] = useState(1200);

  const { pageNumber, numPages, setNumPages, scale, setScale } =
    useViewerStore();

  // Chunk loader: fetches page data when navigating beyond loaded range
  useChunkLoader();
  const showTextPanel = useViewerStore((s) => s.showTextPanel);
  const showChatPanel = useViewerStore((s) => s.showChatPanel);
  const showTakeoffPanel = useViewerStore((s) => s.showTakeoffPanel);
  const showDetectionPanel = useViewerStore((s) => s.showDetectionPanel);
  const showCsiPanel = useViewerStore((s) => s.showCsiPanel);
  const showPageIntelPanel = useViewerStore((s) => s.showPageIntelPanel);
  const showTableParsePanel = useViewerStore((s) => s.showTableParsePanel);
  const showTableCompareModal = useViewerStore((s) => s.showTableCompareModal);
  const showKeynoteParsePanel = useViewerStore((s) => s.showKeynoteParsePanel);
  const symbolSearchActive = useViewerStore((s) => s.symbolSearchActive);
  const symbolSearchResults = useViewerStore((s) => s.symbolSearchResults);
  const symbolSearchLoading = useViewerStore((s) => s.symbolSearchLoading);
  const symbolSearchTemplateBbox = useViewerStore((s) => s.symbolSearchTemplateBbox);
  const symbolSearchError = useViewerStore((s) => s.symbolSearchError);
  const setMode = useViewerStore((s) => s.setMode);
  const projectId = useViewerStore((s) => s.projectId);

  // Lazy-load textractData per page (not loaded in initial project response)
  // Also prefetch textractData for adjacent pages
  useEffect(() => {
    if (!projectId) return;
    const pagesToLoad = [pageNumber, pageNumber + 1, pageNumber - 1].filter((p) => p >= 1 && p <= numPages);

    for (const p of pagesToLoad) {
      const store = useViewerStore.getState();
      if (store.textractData[p]) continue;
      fetch(`/api/pages/textract?projectId=${projectId}&pageNumber=${p}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.textractData) {
            useViewerStore.getState().setTextractData(p, data.textractData);
          }
        })
        .catch(() => {});
    }
  }, [pageNumber, projectId, numPages]);

  // Keyboard shortcuts: a = pointer/select, v = pan/zoom
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;
      if (e.key === "a") setMode("pointer");
      else if (e.key === "v") setMode("move");
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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

    async function loadPdf() {
      try {
        setLoading(true);
        setError(null);

        // Dynamic import to avoid SSR issues
        const pdfjsLib = await import("pdfjs-dist");

        // Set up worker — use static copy in public/ for standalone build compatibility
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        const doc = await pdfjsLib.getDocument({
          url: pdfUrl,
          cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/",
          cMapPacked: true,
        }).promise;

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
    };
  }, [pdfUrl, setNumPages]);

  // Auto-center blueprint on load (free panning padding pushes content off-screen)
  // Center content once on initial PDF load only (not on tab switch)
  const centeredRef = useRef(false);
  useEffect(() => {
    if (!pdfDoc || centeredRef.current) return;
    centeredRef.current = true;
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container || container.scrollWidth <= container.clientWidth) return;
      container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
      container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
    }, 200);
    return () => clearTimeout(timer);
  }, [pdfDoc]);

  // Center when zoomFit is triggered (via store flag)
  const pendingCenter = useViewerStore((s) => s.pendingCenter);
  const clearPendingCenter = useViewerStore((s) => s.clearPendingCenter);
  useEffect(() => {
    if (!pendingCenter) return;
    clearPendingCenter();
    scaleRef.current = 1;

    // Calculate scroll positions directly from known padding values.
    // We can't rely on scrollWidth during the CSS transition — the wrapper div
    // shrinks to pageSize * (1/renderedScale) before the canvas re-renders,
    // making scrollWidth temporarily wrong.
    //
    // The inner div has: paddingLeft=25vw, paddingRight=25vw, p-4 (16px).
    // At scale=1, the page fills containerWidth-32. To center it:
    //   scrollLeft = 25vw (the left padding offset)
    //   scrollTop  = 50vh (the top padding offset, centers page vertically)
    const container = containerRef.current;
    if (!container) return;
    const targetLeft = window.innerWidth * 0.25;
    const targetTop = window.innerHeight * 0.5;
    // Apply immediately — these values are correct regardless of CSS transform state
    container.scrollLeft = targetLeft;
    container.scrollTop = targetTop;
  }, [pendingCenter, clearPendingCenter]);

  // Mode ref for use in native event listeners
  const mode = useViewerStore((s) => s.mode);

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
      const mouseX = e.clientX - rect.left + container.scrollLeft;
      const mouseY = e.clientY - rect.top + container.scrollTop;

      const oldScale = scaleRef.current;
      // Smaller factor for Ctrl (pinch-zoom sends smaller deltas) vs trackpad scroll
      const factor = e.deltaY < 0 ? 1 / 0.97 : 0.97;
      const newScale = Math.max(0.2, Math.min(oldScale * factor, 10));
      scaleRef.current = newScale;

      // Adjust scroll to keep cursor position stable
      const ratio = newScale / oldScale;
      const newScrollLeft = mouseX * ratio - (e.clientX - rect.left);
      const newScrollTop = mouseY * ratio - (e.clientY - rect.top);

      // Set scroll BEFORE scale update so they apply in the same frame
      // This eliminates the 1-frame position jump
      container.scrollLeft = newScrollLeft;
      container.scrollTop = newScrollTop;

      // Immediate scale update for CSS transform feedback
      // PDFPage debounces the expensive re-rasterization separately (300ms)
      setScale(newScale);
    }

    // Capture phase on document — fires before any child element or native scroll
    document.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => document.removeEventListener("wheel", handleWheel, { capture: true });
  }, [setScale]);

  // Click-drag pan
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "move") return;
      if (e.button !== 0) return;

      const container = containerRef.current;
      if (!container) return;

      setIsPanning(true);
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
      container.style.cursor = "grabbing";
    },
    [mode]
  );

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
    [isPanning]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    const container = containerRef.current;
    if (container) container.style.cursor = mode === "move" ? "grab" : "default";
  }, [mode]);

  // Hooks must be before early returns (Rules of Hooks)
  const isDemo = useViewerStore((s) => s.isDemo);
  const sidebarCollapsed = useViewerStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useViewerStore((s) => s.toggleSidebar);
  const annotationPanelCollapsed = useViewerStore((s) => s.annotationPanelCollapsed);
  const toggleAnnotationPanel = useViewerStore((s) => s.toggleAnnotationPanel);
  const showTips = useViewerStore((s) => s.showTips);
  const toggleTips = useViewerStore((s) => s.toggleTips);
  const helpMode = useViewerStore((s) => s.helpMode);
  const toggleHelpMode = useViewerStore((s) => s.toggleHelpMode);

  // Auto-enable help mode in demo so new users see tooltips
  useEffect(() => {
    if (isDemo && !helpMode) {
      useViewerStore.getState().toggleHelpMode();
    }
  }, [isDemo]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
        Loading PDF...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-screen">
      <ViewerToolbar projectName={projectName} backHref={backHref} onRename={onRename} />

      {/* Help tips banner — dismissible, toggleable from Menu → Help */}
      {showTips && (
        <div className="h-8 bg-[var(--surface)] border-b border-[var(--border)] flex items-center justify-center px-4 shrink-0">
          <div className="flex items-center gap-3 text-[11px] -ml-16">
            <span className="text-[var(--fg)]/50 font-medium">BUTTONS:</span>
            <span className="text-[var(--fg)]/60">Menu — Data labeling & more</span>
            <span className="text-[var(--border)]">|</span>
            <span className="text-purple-400/80">YOLO — Toggle AI detections on/off</span>
            <span className="text-[var(--border)]">|</span>
            <span className="text-sky-400/80">Text — Phone, abbreviations & more</span>
            <span className="text-[var(--border)]">|</span>
            <span className="text-blue-400/80">Chat — Talk with LLM about blueprints</span>
            <span className="text-[var(--border)]">|</span>
            <span className="text-emerald-400/80">QTO — Count + area</span>
            <span className="text-[var(--border)]">|</span>
            <span className="text-amber-400/80 inline-flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="inline-block"><ellipse cx="8" cy="8" rx="7" ry="4.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>
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
        {!sidebarCollapsed && <PageSidebar pdfDoc={pdfDoc!} />}

        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* Sidebar collapse toggle — outside scroll container so it doesn't scroll away */}
          <button
            onClick={toggleSidebar}
            className="absolute top-2 left-2 z-20 w-6 h-6 rounded flex items-center justify-center text-xs bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--fg)]/40"
            title={sidebarCollapsed ? "Show pages" : "Hide pages"}
          >
            {sidebarCollapsed ? ">" : "<"}
          </button>

          {/* Symbol Search floating panel — outside scroll container to avoid stacking context issues */}
          {(symbolSearchActive || symbolSearchResults || symbolSearchLoading || symbolSearchTemplateBbox || symbolSearchError) && (
            <div className="absolute top-12 left-10 z-50">
              <SymbolSearchPanel pdfDoc={pdfDoc} />
            </div>
          )}

          <div
            ref={containerRef}
            className="flex-1 bg-[var(--bg)] overflow-auto relative"
            style={{ cursor: mode === "move" ? "grab" : "default" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <div
              className="p-4"
              style={{ width: "fit-content", paddingTop: "50vh", paddingBottom: "50vh", paddingLeft: "25vw", paddingRight: "25vw" }}
            >
              <div style={{ width: "fit-content", margin: "0 auto" }}>
                {pdfDoc && (
                  <PDFPage
                    pdfDoc={pdfDoc}
                    pageNumber={pageNumber}
                    scale={scale}
                    containerWidth={containerWidth}
                  />
                )}
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

        {/* Right-side panels — wrapped for UI scale */}
        <div className="viewer-scalable flex shrink-0">
          {showTextPanel && <TextPanel />}
          {showChatPanel && <ChatPanel />}
          {showTakeoffPanel && <TakeoffPanel />}
          {showDetectionPanel && <DetectionPanel />}
          {showCsiPanel && <CsiPanel />}
          {showPageIntelPanel && <PageIntelligencePanel />}
          {showTableParsePanel && <TableParsePanel />}
          {showKeynoteParsePanel && <KeynotePanel />}
        </div>
      </div>

      {/* Fullscreen modal overlays */}
      {showTableCompareModal && pdfDoc && <TableCompareModal pdfDoc={pdfDoc} />}
    </div>
  );
}
