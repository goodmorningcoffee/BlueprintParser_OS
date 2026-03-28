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
  const showTextPanel = useViewerStore((s) => s.showTextPanel);
  const showChatPanel = useViewerStore((s) => s.showChatPanel);
  const showTakeoffPanel = useViewerStore((s) => s.showTakeoffPanel);
  const setMode = useViewerStore((s) => s.setMode);

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
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      // Debounced sync to React state — avoids jittery re-renders during gesture
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
      zoomDebounceRef.current = setTimeout(() => {
        setScale(scaleRef.current);
      }, 60);

      // Immediate visual: sync scale to store for CSS transform feedback
      setScale(newScale);

      requestAnimationFrame(() => {
        container.scrollLeft = newScrollLeft;
        container.scrollTop = newScrollTop;
      });
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
        <div className="h-8 bg-[#1a1a2e] border-b border-[var(--border)] flex items-center justify-center px-4 shrink-0">
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

          <div
            ref={containerRef}
            className="flex-1 bg-[#1a1a1a] overflow-auto"
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
              style={{ backgroundColor: "#1e1e22" }}
            >
              View Annotations
            </button>
          ) : (
            <>
              <AnnotationPanel />
              <button
                onClick={toggleAnnotationPanel}
                className="border-t border-[var(--border)] px-3 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--fg)] text-center shrink-0"
                style={{ backgroundColor: "#1e1e22" }}
              >
                Collapse
              </button>
            </>
          )}

        </div>

        {showTextPanel && <TextPanel />}
        {showChatPanel && <ChatPanel />}
        {showTakeoffPanel && <TakeoffPanel />}
      </div>
    </div>
  );
}
