"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore } from "@/stores/viewerStore";

interface PageSidebarProps {
  pdfDoc: PDFDocumentProxy;
}

interface ThumbnailCache {
  [pageNum: number]: string; // data URL
}

const BATCH_SIZE = 5;
const THUMB_WIDTH = 150;

export default function PageSidebar({ pdfDoc }: PageSidebarProps) {
  const {
    pageNumber,
    numPages,
    setPage,
    pageNames,
    setPageName,
    publicId,
    searchResults,
    searchQuery,
    searchMatches,
    keynotes,
    activeKeynoteFilter,
    setKeynoteFilter,
    annotations,
    activeAnnotationFilter,
    setAnnotationFilter,
    csiCodes,
    activeTradeFilter,
    setTradeFilter,
    activeCsiFilter,
    setCsiFilter,
  } = useViewerStore();

  const [thumbnails, setThumbnails] = useState<ThumbnailCache>({});
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());

  // Track which sidebar entries are visible for lazy thumbnail generation
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const pageNum = Number(
              (entry.target as HTMLElement).dataset.pageNum
            );
            if (entry.isIntersecting) {
              next.add(pageNum);
            }
          }
          return next;
        });
      },
      { root: container, rootMargin: "200px" }
    );

    const buttons = container.querySelectorAll("[data-page-num]");
    buttons.forEach((btn) => observer.observe(btn));

    return () => observer.disconnect();
  }, [numPages]);

  // Reset rendered tracking when PDF changes
  useEffect(() => {
    renderedPagesRef.current = new Set();
    setThumbnails({});
  }, [pdfDoc]);

  // Generate thumbnails in batches, prioritizing visible + current page
  useEffect(() => {
    if (!pdfDoc) return;

    let cancelled = false;

    async function renderThumbnail(
      pageNum: number,
      canvas: HTMLCanvasElement,
      ctx: CanvasRenderingContext2D
    ) {
      if (cancelled) return;
      try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const thumbScale = THUMB_WIDTH / viewport.width;
        const thumbViewport = page.getViewport({ scale: thumbScale });

        canvas.width = thumbViewport.width;
        canvas.height = thumbViewport.height;

        await page.render({
          canvasContext: ctx,
          viewport: thumbViewport,
        }).promise;

        if (!cancelled) {
          renderedPagesRef.current.add(pageNum);
          const dataUrl = canvas.toDataURL("image/png");
          setThumbnails((prev) => ({ ...prev, [pageNum]: dataUrl }));
        }
      } catch (err) {
        console.error(`Thumbnail error page ${pageNum}:`, err);
        renderedPagesRef.current.add(pageNum); // Don't retry failed pages
      }
    }

    async function generateAll() {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Build priority queue: current page first, then visible, then rest
      const allPages = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
      const prioritized: number[] = [];

      // Current page first
      prioritized.push(pageNumber);

      // Nearby pages (for quick navigation)
      for (
        let i = Math.max(1, pageNumber - 2);
        i <= Math.min(pdfDoc.numPages, pageNumber + 2);
        i++
      ) {
        if (!prioritized.includes(i)) prioritized.push(i);
      }

      // Visible pages
      for (const p of visiblePages) {
        if (!prioritized.includes(p)) prioritized.push(p);
      }

      // Remaining pages
      for (const p of allPages) {
        if (!prioritized.includes(p)) prioritized.push(p);
      }

      // Render in batches with yielding
      for (let i = 0; i < prioritized.length; i++) {
        if (cancelled) break;

        const pg = prioritized[i];
        // Skip if already rendered (use ref to avoid re-triggering effect)
        if (renderedPagesRef.current.has(pg)) continue;

        await renderThumbnail(pg, canvas, ctx);

        // Yield to main thread every BATCH_SIZE pages
        if ((i + 1) % BATCH_SIZE === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    generateAll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageNumber, visiblePages]);

  // Filter pages based on search or keynote filter
  const isSearchFiltered = searchQuery.length > 0 && searchResults.length > 0;

  // Compute keynote-filtered pages
  const keynoteFilteredPages = activeKeynoteFilter
    ? Object.entries(keynotes)
        .filter(([, pageKeynotes]) =>
          pageKeynotes.some(
            (k) =>
              k.shape === activeKeynoteFilter.shape &&
              k.text === activeKeynoteFilter.text
          )
        )
        .map(([pageNum]) => Number(pageNum))
    : [];
  const isKeynoteFiltered = activeKeynoteFilter !== null && keynoteFilteredPages.length > 0;

  // Compute annotation-filtered pages
  const annotationFilteredPages = activeAnnotationFilter
    ? [...new Set(annotations.filter((a) => a.name === activeAnnotationFilter).map((a) => a.pageNumber))]
    : [];
  const isAnnotationFiltered = activeAnnotationFilter !== null && annotationFilteredPages.length > 0;

  // Compute trade-filtered pages
  const tradeFilteredPages = activeTradeFilter
    ? Object.entries(csiCodes)
        .filter(([, codes]) =>
          codes.some((c) => c.trade === activeTradeFilter)
        )
        .map(([pageNum]) => Number(pageNum))
    : [];
  const isTradeFiltered = activeTradeFilter !== null && tradeFilteredPages.length > 0;

  // Compute CSI code-filtered pages
  const csiFilteredPages = activeCsiFilter
    ? Object.entries(csiCodes)
        .filter(([, codes]) =>
          codes.some((c) => c.code === activeCsiFilter)
        )
        .map(([pageNum]) => Number(pageNum))
    : [];
  const isCsiFiltered = activeCsiFilter !== null && csiFilteredPages.length > 0;

  const isFiltered = isSearchFiltered || isKeynoteFiltered || isAnnotationFiltered || isTradeFiltered || isCsiFiltered;

  // Persist page name edits to the server (debounced)
  const handleNameEdit = useCallback(
    (pageNum: number, newName: string) => {
      setPageName(pageNum, newName);

      // Debounce the API call
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          await fetch("/api/pages/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: publicId,
              pageNumber: pageNum,
              name: newName,
            }),
          });
        } catch (err) {
          console.error("Failed to save page name:", err);
        }
      }, 500);
    },
    [setPageName, publicId]
  );

  return (
    <div
      ref={containerRef}
      className="w-48 border-r border-[var(--border)] bg-[var(--surface)] overflow-y-auto shrink-0"
    >
      <div className="p-2">
        {isSearchFiltered && (
          <div className="text-xs text-[var(--accent)] px-1.5 pb-2 border-b border-[var(--border)] mb-2">
            Found on {searchResults.length} page{searchResults.length !== 1 ? "s" : ""}
          </div>
        )}
        {isKeynoteFiltered && (
          <div className="text-xs text-[var(--accent)] px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              Keynote: {activeKeynoteFilter!.text || activeKeynoteFilter!.shape} ({keynoteFilteredPages.length} pg)
            </span>
            <button
              onClick={() => setKeynoteFilter(null)}
              className="text-[var(--muted)] hover:text-[var(--fg)] ml-1"
            >
              x
            </button>
          </div>
        )}
        {isAnnotationFiltered && (
          <div className="text-xs text-[var(--accent)] px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              Annotation: {activeAnnotationFilter} ({annotationFilteredPages.length} pg)
            </span>
            <button
              onClick={() => setAnnotationFilter(null)}
              className="text-[var(--muted)] hover:text-[var(--fg)] ml-1"
            >
              x
            </button>
          </div>
        )}
        {isTradeFiltered && (
          <div className="text-xs text-[var(--accent)] px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              Trade: {activeTradeFilter} ({tradeFilteredPages.length} pg)
            </span>
            <button
              onClick={() => setTradeFilter(null)}
              className="text-[var(--muted)] hover:text-[var(--fg)] ml-1"
            >
              x
            </button>
          </div>
        )}
        {isCsiFiltered && (
          <div className="text-xs text-[var(--accent)] px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              CSI: {activeCsiFilter} ({csiFilteredPages.length} pg)
            </span>
            <button
              onClick={() => setCsiFilter(null)}
              className="text-[var(--muted)] hover:text-[var(--fg)] ml-1"
            >
              x
            </button>
          </div>
        )}
        {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
          const isHidden =
            (isSearchFiltered && !searchResults.includes(n)) ||
            (isKeynoteFiltered && !keynoteFilteredPages.includes(n)) ||
            (isAnnotationFiltered && !annotationFilteredPages.includes(n)) ||
            (isTradeFiltered && !tradeFilteredPages.includes(n)) ||
            (isCsiFiltered && !csiFilteredPages.includes(n));
          if (isHidden) return null;

          const isActive = n === pageNumber;
          const name = pageNames[n] || `Page ${n}`;

          return (
            <button
              key={n}
              data-page-num={n}
              onClick={() => setPage(n)}
              className={`w-full text-left p-1.5 rounded mb-1 transition-colors ${
                isActive
                  ? "bg-[var(--accent)]/20 border border-[var(--accent)]/40"
                  : "hover:bg-[var(--surface-hover)] border border-transparent"
              }`}
            >
              {/* Thumbnail */}
              <div className="aspect-[4/3] bg-[var(--bg)] rounded overflow-hidden mb-1">
                {thumbnails[n] ? (
                  <img
                    src={thumbnails[n]}
                    alt={`Page ${n}`}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[var(--muted)] text-xs">
                    {n}
                  </div>
                )}
              </div>

              {/* Page name + match count */}
              <div className="flex items-center gap-1">
                <div
                  className="text-xs truncate text-[var(--muted)] px-0.5 flex-1"
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(e) =>
                    handleNameEdit(n, e.currentTarget.textContent || `Page ${n}`)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                >
                  {name}
                </div>
                {searchMatches[n] && searchMatches[n].length > 0 && (
                  <span className="bg-yellow-500/20 text-yellow-300 text-[10px] px-1.5 rounded-full shrink-0">
                    {searchMatches[n].length}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
