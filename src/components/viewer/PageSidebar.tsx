"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore } from "@/stores/viewerStore";
import { findPhraseMatches } from "./SearchHighlightOverlay";

interface PageSidebarProps {
  pdfDoc: PDFDocumentProxy;
}

interface ThumbnailCache {
  [pageNum: number]: string; // data URL
}

const BATCH_SIZE = 5;
const THUMB_WIDTH = 150;

/** Extract discipline prefix from a drawing number like "A-101.00" → "A", "ES-201" → "ES" */
function extractDisciplinePrefix(name: string): string {
  const match = name.match(/^([A-Za-z]+)[\s\-\.0-9]/);
  if (match) return match[1].toUpperCase();
  // "Page 5" or similar → no discipline
  if (/^page\s/i.test(name)) return "OTHER";
  // Pure letters → use as prefix
  const letters = name.match(/^([A-Za-z]+)/);
  return letters ? letters[1].toUpperCase() : "OTHER";
}

/** Standard construction discipline sort order */
function disciplineOrder(prefix: string): number {
  const order: Record<string, number> = {
    G: 0, A: 1, S: 2, M: 3, E: 4, P: 5, FP: 6, L: 7, C: 8, T: 9, D: 10,
  };
  return order[prefix] ?? 50;
}

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
    textractData,
    textAnnotations,
    activeTextAnnotationFilter,
    setTextAnnotationFilter,
    activeTakeoffFilter,
    setTakeoffFilter,
    yoloTags,
    activeYoloTagFilter,
    setYoloTagFilter,
    setActiveYoloTagId,
  } = useViewerStore();

  const [thumbnails, setThumbnails] = useState<ThumbnailCache>({});
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());

  // Group-by-sheet state
  const [groupBySheet, setGroupBySheet] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  function toggleGroup(prefix: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  }

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
  }, [numPages, groupBySheet, expandedGroups]);

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

  // Compute annotation-filtered pages + per-page counts
  const annotationFilteredPages = activeAnnotationFilter
    ? [...new Set(annotations.filter((a) => a.name === activeAnnotationFilter).map((a) => a.pageNumber))]
    : [];
  const isAnnotationFiltered = activeAnnotationFilter !== null && annotationFilteredPages.length > 0;
  const annotationPageCounts: Record<number, number> = {};
  if (activeAnnotationFilter) {
    for (const a of annotations) {
      if (a.name === activeAnnotationFilter) {
        annotationPageCounts[a.pageNumber] = (annotationPageCounts[a.pageNumber] || 0) + 1;
      }
    }
  }

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

  // Compute per-page word match counts for trade/CSI filters
  const tradeWordCounts = useMemo(() => {
    if (!activeTradeFilter) return {};
    const counts: Record<number, number> = {};
    for (const pageNum of tradeFilteredPages) {
      const pageWords = textractData[pageNum]?.words;
      if (!pageWords?.length) continue;
      const pageCsi = csiCodes[pageNum] || [];
      const matchingCodes = pageCsi.filter((c) => c.trade === activeTradeFilter);
      let total = 0;
      for (const code of matchingCodes) {
        total += findPhraseMatches(pageWords, code.description).length;
      }
      // Also count trade name word matches
      const tradeWords = activeTradeFilter.toLowerCase().split(/\s+/);
      for (const word of pageWords) {
        if (tradeWords.includes(word.text.toLowerCase())) total++;
      }
      if (total > 0) counts[pageNum] = total;
    }
    return counts;
  }, [activeTradeFilter, tradeFilteredPages, csiCodes, textractData]);

  const csiWordCounts = useMemo(() => {
    if (!activeCsiFilter) return {};
    const counts: Record<number, number> = {};
    for (const pageNum of csiFilteredPages) {
      const pageWords = textractData[pageNum]?.words;
      if (!pageWords?.length) continue;
      const pageCsi = csiCodes[pageNum] || [];
      const matchingCode = pageCsi.find((c) => c.code === activeCsiFilter);
      if (!matchingCode) continue;
      const total = findPhraseMatches(pageWords, matchingCode.description).length;
      if (total > 0) counts[pageNum] = total;
    }
    return counts;
  }, [activeCsiFilter, csiFilteredPages, csiCodes, textractData]);

  // Compute text annotation-filtered pages
  const textAnnotationFilteredPages = activeTextAnnotationFilter
    ? Object.entries(textAnnotations)
        .filter(([, anns]) =>
          anns.some((a) => a.type === activeTextAnnotationFilter!.type && a.text === activeTextAnnotationFilter!.text)
        )
        .map(([pageNum]) => Number(pageNum))
    : [];
  const isTextAnnotationFiltered = activeTextAnnotationFilter !== null && textAnnotationFilteredPages.length > 0;

  const textAnnotationCounts = useMemo(() => {
    if (!activeTextAnnotationFilter) return {};
    const counts: Record<number, number> = {};
    for (const pageNum of textAnnotationFilteredPages) {
      const anns = textAnnotations[pageNum] || [];
      const count = anns.filter(
        (a) => a.type === activeTextAnnotationFilter!.type && a.text === activeTextAnnotationFilter!.text
      ).length;
      if (count > 0) counts[pageNum] = count;
    }
    return counts;
  }, [activeTextAnnotationFilter, textAnnotationFilteredPages, textAnnotations]);

  // Compute QTO takeoff-filtered pages
  const takeoffFilteredPages = useMemo(() => {
    if (activeTakeoffFilter === null) return [];
    const pages: number[] = [];
    const seen = new Set<number>();
    for (const ann of annotations) {
      if (ann.source !== "takeoff") continue;
      const itemId = (ann.data as any)?.takeoffItemId;
      if (String(itemId) === String(activeTakeoffFilter) && !seen.has(ann.pageNumber)) {
        seen.add(ann.pageNumber);
        pages.push(ann.pageNumber);
      }
    }
    return pages;
  }, [activeTakeoffFilter, annotations]);
  const isTakeoffFiltered = activeTakeoffFilter !== null && takeoffFilteredPages.length > 0;

  const takeoffCounts = useMemo(() => {
    if (activeTakeoffFilter === null) return {};
    const counts: Record<number, number> = {};
    for (const ann of annotations) {
      if (ann.source !== "takeoff") continue;
      const itemId = (ann.data as any)?.takeoffItemId;
      if (String(itemId) === String(activeTakeoffFilter)) {
        counts[ann.pageNumber] = (counts[ann.pageNumber] || 0) + 1;
      }
    }
    return counts;
  }, [activeTakeoffFilter, annotations]);

  // YOLO Tag filter
  const activeYoloTag = useMemo(() => {
    if (!activeYoloTagFilter) return null;
    return yoloTags.find((t) => t.id === activeYoloTagFilter) || null;
  }, [activeYoloTagFilter, yoloTags]);
  const yoloTagFilteredPages = useMemo(() => {
    if (!activeYoloTag) return [];
    const pages = new Set<number>();
    for (const inst of activeYoloTag.instances) pages.add(inst.pageNumber);
    return [...pages].sort((a, b) => a - b);
  }, [activeYoloTag]);
  const isYoloTagFiltered = activeYoloTagFilter !== null && yoloTagFilteredPages.length > 0;
  const yoloTagPageCounts = useMemo(() => {
    if (!activeYoloTag) return {};
    const counts: Record<number, number> = {};
    for (const inst of activeYoloTag.instances) {
      counts[inst.pageNumber] = (counts[inst.pageNumber] || 0) + 1;
    }
    return counts;
  }, [activeYoloTag]);

  const isFiltered = isSearchFiltered || isKeynoteFiltered || isAnnotationFiltered || isTradeFiltered || isCsiFiltered || isTextAnnotationFiltered || isTakeoffFiltered || isYoloTagFiltered;

  // Check if a page is hidden by active filters
  function isPageHidden(n: number): boolean {
    return (
      (isSearchFiltered && !searchResults.includes(n)) ||
      (isKeynoteFiltered && !keynoteFilteredPages.includes(n)) ||
      (isAnnotationFiltered && !annotationFilteredPages.includes(n)) ||
      (isTradeFiltered && !tradeFilteredPages.includes(n)) ||
      (isTextAnnotationFiltered && !textAnnotationFilteredPages.includes(n)) ||
      (isTakeoffFiltered && !takeoffFilteredPages.includes(n)) ||
      (isCsiFiltered && !csiFilteredPages.includes(n)) ||
      (isYoloTagFiltered && !yoloTagFilteredPages.includes(n))
    );
  }

  // Group pages by discipline prefix
  const sheetGroups = useMemo(() => {
    if (!groupBySheet) return null;

    const groups: Record<string, number[]> = {};
    for (let n = 1; n <= numPages; n++) {
      const name = pageNames[n] || `Page ${n}`;
      const prefix = extractDisciplinePrefix(name);
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(n);
    }

    return Object.entries(groups).sort(
      ([a], [b]) => disciplineOrder(a) - disciplineOrder(b)
    );
  }, [groupBySheet, numPages, pageNames]);

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

  // Render a single page button (shared between flat and grouped modes)
  function renderPageButton(n: number) {
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
          {isAnnotationFiltered && annotationPageCounts[n] > 0 && (
            <span className="bg-purple-500/20 text-purple-300 text-[10px] px-1.5 rounded-full shrink-0">
              {annotationPageCounts[n]}
            </span>
          )}
          {isTradeFiltered && tradeWordCounts[n] > 0 && (
            <span className="bg-pink-500/20 text-pink-300 text-[10px] px-1.5 rounded-full shrink-0">
              {tradeWordCounts[n]}
            </span>
          )}
          {isCsiFiltered && csiWordCounts[n] > 0 && (
            <span className="bg-pink-500/20 text-pink-300 text-[10px] px-1.5 rounded-full shrink-0">
              {csiWordCounts[n]}
            </span>
          )}
          {isTextAnnotationFiltered && textAnnotationCounts[n] > 0 && (
            <span className="bg-sky-500/20 text-sky-300 text-[10px] px-1.5 rounded-full shrink-0">
              {textAnnotationCounts[n]}
            </span>
          )}
          {isTakeoffFiltered && takeoffCounts[n] > 0 && (
            <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-1.5 rounded-full shrink-0">
              {takeoffCounts[n]}
            </span>
          )}
          {isYoloTagFiltered && yoloTagPageCounts[n] > 0 && (
            <span className="bg-cyan-500/20 text-cyan-300 text-[10px] px-1.5 rounded-full shrink-0">
              {yoloTagPageCounts[n]}
            </span>
          )}
        </div>
      </button>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-48 border-r border-[var(--border)] bg-[var(--surface)] overflow-y-auto shrink-0"
    >
      <div className="p-2">
        {/* Group by sheet type toggle */}
        <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-[var(--border)]">
          <span className="text-[10px] text-[var(--muted)]">{numPages} sheets</span>
          <button
            onClick={() => {
              setGroupBySheet(!groupBySheet);
              setExpandedGroups(new Set());
            }}
            className={`text-[10px] px-1.5 py-0.5 rounded border ${
              groupBySheet
                ? "border-[var(--accent)]/40 text-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]/30"
            }`}
          >
            {groupBySheet ? "Grouped" : "Group"}
          </button>
        </div>

        {/* Filter badges */}
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
        {isTextAnnotationFiltered && (
          <div className="text-xs text-sky-400 px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              Text: {activeTextAnnotationFilter!.text} ({textAnnotationFilteredPages.length} pg)
            </span>
            <button
              onClick={() => setTextAnnotationFilter(null)}
              className="text-[var(--muted)] hover:text-[var(--fg)] ml-1"
            >
              x
            </button>
          </div>
        )}
        {isTakeoffFiltered && (
          <div className="text-xs text-emerald-400 px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              QTO: {annotations.find((a) => a.source === "takeoff" && String((a.data as any)?.takeoffItemId) === String(activeTakeoffFilter))?.name || "Item"} ({takeoffFilteredPages.length} pg)
            </span>
            <button
              onClick={() => setTakeoffFilter(null)}
              className="text-[var(--muted)] hover:text-[var(--fg)] ml-1"
            >
              x
            </button>
          </div>
        )}
        {isYoloTagFiltered && activeYoloTag && (
          <div className="text-xs text-cyan-400 px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              Tag: {activeYoloTag.tagText} ({yoloTagFilteredPages.length} pg, {activeYoloTag.instances.length} inst)
            </span>
            <button
              onClick={() => { setYoloTagFilter(null); setActiveYoloTagId(null); }}
              className="text-[var(--muted)] hover:text-[var(--fg)] ml-1"
            >
              x
            </button>
          </div>
        )}

        {/* Page list: grouped or flat */}
        {groupBySheet && sheetGroups ? (
          // ─── Grouped view ──────────────────────────────────────
          sheetGroups.map(([prefix, pageNums]) => {
            const visibleInGroup = pageNums.filter((n) => !isPageHidden(n));
            if (visibleInGroup.length === 0) return null;

            const isExpanded = expandedGroups.has(prefix);
            const firstPage = visibleInGroup[0];
            const hasActivePage = visibleInGroup.includes(pageNumber);

            return (
              <div key={prefix} className="mb-1">
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(prefix)}
                  className={`w-full flex items-center gap-2 p-1.5 rounded transition-colors ${
                    hasActivePage && !isExpanded
                      ? "bg-[var(--accent)]/10 border border-[var(--accent)]/20"
                      : "hover:bg-[var(--surface-hover)] border border-transparent"
                  }`}
                >
                  <span className="text-[10px] text-[var(--muted)] w-3 shrink-0">
                    {isExpanded ? "\u25BC" : "\u25B6"}
                  </span>
                  <div className="w-10 h-7 bg-[var(--bg)] rounded overflow-hidden shrink-0">
                    {thumbnails[firstPage] ? (
                      <img
                        src={thumbnails[firstPage]}
                        alt={prefix}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[var(--muted)] text-[8px]">
                        {firstPage}
                      </div>
                    )}
                  </div>
                  <span className="text-xs font-medium flex-1 text-left">{prefix}</span>
                  <span className="text-[10px] text-[var(--muted)] shrink-0">
                    {visibleInGroup.length}
                  </span>
                </button>

                {/* Expanded pages */}
                {isExpanded && (
                  <div className="ml-2 border-l border-[var(--border)] pl-1">
                    {visibleInGroup.map((n) => renderPageButton(n))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          // ─── Flat view (original) ──────────────────────────────
          Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
            if (isPageHidden(n)) return null;
            return renderPageButton(n);
          })
        )}
      </div>
    </div>
  );
}
