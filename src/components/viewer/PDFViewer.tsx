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
  const showKeynotes = useViewerStore((s) => s.showKeynotes);
  const toggleKeynotes = useViewerStore((s) => s.toggleKeynotes);
  const [showTips, setShowTips] = useState(true);

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

      {/* Onboarding tips banner — demo only, dismissible */}
      {isDemo && showTips && (
        <div className="h-8 bg-[#1a1a2e] border-b border-[var(--border)] flex items-center justify-end px-4 shrink-0">
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-[var(--muted)]">Buttons:</span>
            <span className="text-purple-400/80">YOLO — AI-detected objects</span>
            <span className="text-[var(--border)]">|</span>
            <span className="text-sky-400/80">Chat — Ask AI about drawings</span>
            <span className="text-[var(--border)]">|</span>
            <span className="text-emerald-400/80">QTO — Count + measure areas</span>
          </div>
          <button
            onClick={() => setShowTips(false)}
            className="text-[var(--muted)] hover:text-[var(--fg)] text-xs ml-4"
          >
            x
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <PageSidebar pdfDoc={pdfDoc!} />

        <div className="flex-1 flex flex-col min-w-0">
          <div
            ref={containerRef}
            className="flex-1 bg-[#1a1a1a] relative overflow-auto"
            style={{ cursor: mode === "move" ? "grab" : "default" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <div
              className="min-h-full p-4"
              style={{ width: "fit-content", minWidth: "100%" }}
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

          <AnnotationPanel />

          {/* Keynote visibility toggle — bottom right */}
          <button
            onClick={toggleKeynotes}
            className={`absolute bottom-3 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full flex items-center justify-center text-xs border transition-colors z-10 ${
              showKeynotes
                ? "border-amber-400/40 text-amber-400 bg-amber-400/10 hover:bg-amber-400/20"
                : "border-[var(--border)] text-[var(--muted)] bg-[var(--surface)] hover:text-[var(--fg)]"
            }`}
            title={showKeynotes ? "Hide keynote shapes" : "Show keynote shapes"}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <ellipse cx="8" cy="8" rx="7" ry="4.5" />
              <circle cx="8" cy="8" r="2" fill="currentColor" />
              {!showKeynotes && <line x1="2" y1="14" x2="14" y2="2" strokeWidth="2" />}
            </svg>
          </button>
        </div>

        {showTextPanel && <TextPanel />}
        {showChatPanel && <ChatPanel />}
        {showTakeoffPanel && <TakeoffPanel />}
      </div>
    </div>
  );
}
