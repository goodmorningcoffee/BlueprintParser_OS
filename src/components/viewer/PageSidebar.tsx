"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore, useNavigation, useProject, usePageData, useDetection, useTextAnnotationDisplay, useYoloTags, useSymbolSearch, useSummaries } from "@/stores/viewerStore";
import { findPhraseMatches } from "./SearchHighlightOverlay";
import { extractDisciplinePrefix, disciplineOrder } from "@/lib/page-utils";

interface PageSidebarProps {
  pdfDoc: PDFDocumentProxy | null;
}

const ITEM_HEIGHT = 164; // Thumbnail (aspect-[4/3] ~123px) + name row (~20px) + padding/margin (~21px)
const VIRTUAL_BUFFER = 5; // Extra items above/below viewport

export default function PageSidebar({ pdfDoc }: PageSidebarProps) {
  // Slice selectors (only re-render when relevant slice changes)
  const { pageNumber, numPages, setPage } = useNavigation();
  const { pageNames, publicId } = useProject();
  const { keynotes, csiCodes, textractData, textAnnotations, activeCsiFilter, setCsiFilter } = usePageData();
  const { annotations, activeAnnotationFilter, setAnnotationFilter, searchQuery } = useDetection();
  const { activeTextAnnotationFilter, setTextAnnotationFilter } = useTextAnnotationDisplay();
  const { yoloTags, setActiveYoloTagId, setYoloTagFilter } = useYoloTags();
  const { symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches } = useSymbolSearch();
  const { summaries } = useSummaries();

  // Fields not in any slice selector — individual selectors
  const setPageName = useViewerStore((s) => s.setPageName);
  const searchResults = useViewerStore((s) => s.searchResults);
  const searchMatches = useViewerStore((s) => s.searchMatches);
  const activeKeynoteFilter = useViewerStore((s) => s.activeKeynoteFilter);
  const setKeynoteFilter = useViewerStore((s) => s.setKeynoteFilter);
  const activeTradeFilter = useViewerStore((s) => s.activeTradeFilter);
  const setTradeFilter = useViewerStore((s) => s.setTradeFilter);
  const activeTakeoffFilter = useViewerStore((s) => s.activeTakeoffFilter);
  const setTakeoffFilter = useViewerStore((s) => s.setTakeoffFilter);
  const activeYoloTagFilter = useViewerStore((s) => s.activeYoloTagFilter);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const visiblePagesRef = useRef<Set<number>>(visiblePages);
  visiblePagesRef.current = visiblePages;
  const pageNumRef = useRef(pageNumber);
  pageNumRef.current = pageNumber;

  // Virtual scroll state — only render ~20 buttons regardless of numPages
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const scrollRafRef = useRef(0);
  const sidebarClickRef = useRef(false); // Prevents auto-scroll on sidebar clicks

  // Thumbnail URL via server proxy (avoids requiring public S3 access from browser)
  const thumbUrl = useCallback(
    (page: number) => publicId ? `/api/projects/${publicId}/thumbnail/${page}` : null,
    [publicId],
  );

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

  // Filter pages based on search or keynote filter
  const isSearchFiltered = searchQuery.length > 0 && searchResults.length > 0;

  // Compute keynote-filtered pages (use summary index when available)
  const keynoteFilteredPages = useMemo(() => {
    if (!activeKeynoteFilter) return [];
    return summaries?.keynotePageIndex?.[`${activeKeynoteFilter.shape}:${activeKeynoteFilter.text}`] ||
      // Fallback: iterate loaded keynotes (for old projects without summaries)
      Object.entries(keynotes)
        .filter(([, pageKeynotes]) =>
          pageKeynotes.some(
            (k) => k.shape === activeKeynoteFilter.shape && k.text === activeKeynoteFilter.text
          )
        )
        .map(([pageNum]) => Number(pageNum));
  }, [activeKeynoteFilter, summaries, keynotes]);
  const isKeynoteFiltered = activeKeynoteFilter !== null && keynoteFilteredPages.length > 0;

  // Compute annotation-filtered pages + per-page counts (use summary when available)
  const annotationFilteredPages = useMemo(() => {
    if (!activeAnnotationFilter) return [];
    return summaries?.annotationSummary?.categoryCounts?.[activeAnnotationFilter]?.pages ||
      [...new Set(annotations.filter((a) => a.name === activeAnnotationFilter).map((a) => a.pageNumber))];
  }, [activeAnnotationFilter, summaries, annotations]);
  const isAnnotationFiltered = activeAnnotationFilter !== null && annotationFilteredPages.length > 0;
  const annotationPageCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    if (activeAnnotationFilter && summaries?.annotationSummary?.pageAnnotationCounts) {
      for (const pn of annotationFilteredPages) {
        counts[pn] = 1;
      }
    } else if (activeAnnotationFilter) {
      for (const a of annotations) {
        if (a.name === activeAnnotationFilter) {
          counts[a.pageNumber] = (counts[a.pageNumber] || 0) + 1;
        }
      }
    }
    return counts;
  }, [activeAnnotationFilter, annotationFilteredPages, summaries, annotations]);

  // Compute trade-filtered pages (use summary index when available)
  const tradeFilteredPages = useMemo(() => {
    if (!activeTradeFilter) return [];
    return summaries?.tradePageIndex?.[activeTradeFilter] ||
      Object.entries(csiCodes)
        .filter(([, codes]) => codes.some((c) => c.trade === activeTradeFilter))
        .map(([pageNum]) => Number(pageNum));
  }, [activeTradeFilter, summaries, csiCodes]);
  const isTradeFiltered = activeTradeFilter !== null && tradeFilteredPages.length > 0;

  // Compute CSI code-filtered pages (use summary index when available)
  const csiFilteredPages = useMemo(() => {
    if (!activeCsiFilter) return [];
    return summaries?.csiPageIndex?.[activeCsiFilter] ||
      Object.entries(csiCodes)
        .filter(([, codes]) => codes.some((c) => c.code === activeCsiFilter))
        .map(([pageNum]) => Number(pageNum));
  }, [activeCsiFilter, summaries, csiCodes]);
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

  // Compute text annotation-filtered pages (use summary index when available)
  const textAnnotationFilteredPages = useMemo(() => {
    if (!activeTextAnnotationFilter) return [];
    return summaries?.textAnnotationPageIndex?.[`${activeTextAnnotationFilter.type}:${activeTextAnnotationFilter.text}`] ||
      Object.entries(textAnnotations)
        .filter(([, anns]) =>
          anns.some((a) => a.type === activeTextAnnotationFilter!.type && a.text === activeTextAnnotationFilter!.text)
        )
        .map(([pageNum]) => Number(pageNum));
  }, [activeTextAnnotationFilter, summaries, textAnnotations]);
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

  // Compute QTO takeoff-filtered pages (use summary when available)
  const takeoffFilteredPages = useMemo(() => {
    if (activeTakeoffFilter === null) return [];
    // Use summary if available
    if (summaries?.takeoffTotals?.[activeTakeoffFilter]) {
      return summaries.takeoffTotals[activeTakeoffFilter].pages;
    }
    // Fallback: iterate loaded annotations
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
  }, [activeTakeoffFilter, annotations, summaries]);
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

  // Symbol Search filter
  const symbolSearchFilteredPages = useMemo(() => {
    if (!symbolSearchResults) return [];
    const visibleMatches = symbolSearchResults.matches.filter(
      (m) => m.confidence >= symbolSearchConfidence && !dismissedSymbolMatches.has(m.id)
    );
    return [...new Set(visibleMatches.map((m) => m.pageNumber))].sort((a, b) => a - b);
  }, [symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches]);
  const isSymbolSearchFiltered = symbolSearchResults !== null && symbolSearchFilteredPages.length > 0;
  const symbolSearchPageCounts = useMemo(() => {
    if (!symbolSearchResults) return {};
    const counts: Record<number, number> = {};
    const visibleMatches = symbolSearchResults.matches.filter(
      (m) => m.confidence >= symbolSearchConfidence && !dismissedSymbolMatches.has(m.id)
    );
    for (const m of visibleMatches) {
      counts[m.pageNumber] = (counts[m.pageNumber] || 0) + 1;
    }
    return counts;
  }, [symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches]);

  const isFiltered = isSearchFiltered || isKeynoteFiltered || isAnnotationFiltered || isTradeFiltered || isCsiFiltered || isTextAnnotationFiltered || isTakeoffFiltered || isYoloTagFiltered || isSymbolSearchFiltered;

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
      (isYoloTagFiltered && !yoloTagFilteredPages.includes(n)) ||
      (isSymbolSearchFiltered && !symbolSearchFilteredPages.includes(n))
    );
  }

  // Measure container height for virtual scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerHeight(entry.contentRect.height);
    });
    ro.observe(container);
    setContainerHeight(container.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Flat list of displayable page numbers (filter-aware, computed once)
  const displayPages = useMemo(() => {
    const pages: number[] = [];
    for (let n = 1; n <= numPages; n++) {
      if (!isPageHidden(n)) pages.push(n);
    }
    return pages;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, isSearchFiltered, searchResults, isKeynoteFiltered, keynoteFilteredPages,
      isAnnotationFiltered, annotationFilteredPages, isTradeFiltered, tradeFilteredPages,
      isTextAnnotationFiltered, textAnnotationFilteredPages, isTakeoffFiltered, takeoffFilteredPages,
      isCsiFiltered, csiFilteredPages, isYoloTagFiltered, yoloTagFilteredPages,
      isSymbolSearchFiltered, symbolSearchFilteredPages]);

  // Virtual scroll: compute which page buttons to render (~20 instead of all)
  const visibleStartIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - VIRTUAL_BUFFER);
  const visibleEndIdx = Math.min(displayPages.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + VIRTUAL_BUFFER);
  const visibleSlice = displayPages.slice(visibleStartIdx, visibleEndIdx);

  // Update visiblePages for thumbnail loading (derived from virtual scroll range)
  useEffect(() => {
    const newVisible = new Set(visibleSlice);
    setVisiblePages((prev) => {
      // Merge new visible pages into existing set (accumulate for thumbnail caching)
      let changed = false;
      for (const pg of newVisible) {
        if (!prev.has(pg)) changed = true;
      }
      if (!changed) return prev;
      const merged = new Set(prev);
      for (const pg of newVisible) merged.add(pg);
      return merged;
    });
  }, [visibleSlice.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll sidebar to active page (keyboard/viewer navigation only, not sidebar clicks)
  useEffect(() => {
    if (sidebarClickRef.current) {
      sidebarClickRef.current = false;
      return;
    }
    const idx = displayPages.indexOf(pageNumber);
    if (idx < 0) return;
    const targetTop = idx * ITEM_HEIGHT;
    const container = containerRef.current;
    if (!container) return;
    const currentScroll = container.scrollTop;
    const viewHeight = container.clientHeight;
    // Only scroll if active page is outside visible area
    if (targetTop < currentScroll || targetTop > currentScroll + viewHeight - ITEM_HEIGHT) {
      container.scrollTop = Math.max(0, targetTop - viewHeight / 3);
    }
  }, [pageNumber, displayPages]);

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
        onClick={() => { sidebarClickRef.current = true; setPage(n); }}
        className={`w-full text-left p-1.5 rounded mb-1 transition-colors ${
          isActive
            ? "bg-[var(--accent)]/20 border border-[var(--accent)]/40"
            : "hover:bg-[var(--surface-hover)] border border-transparent"
        }`}
      >
        {/* Thumbnail */}
        <div className="aspect-[4/3] bg-[var(--bg)] rounded overflow-hidden mb-1 relative">
          {thumbUrl(n) ? (
            <img
              src={thumbUrl(n)!}
              alt={`Page ${n}`}
              className="w-full h-full object-contain relative z-[1]"
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : null}
          <div className="w-full h-full flex items-center justify-center text-[var(--muted)] text-xs absolute inset-0">
            {n}
          </div>
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
          {isSymbolSearchFiltered && symbolSearchPageCounts[n] > 0 && (
            <span className="bg-cyan-500/20 text-cyan-300 text-[10px] px-1.5 rounded-full shrink-0" title="Symbol matches">
              {symbolSearchPageCounts[n]}
            </span>
          )}
        </div>
      </button>
    );
  }

  return (
    <div
      ref={containerRef}
      className="viewer-scalable w-48 border-r border-[var(--border)] bg-[var(--surface)] overflow-y-auto shrink-0"
      onScroll={(e) => {
        const st = e.currentTarget.scrollTop;
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = requestAnimationFrame(() => setScrollTop(st));
      }}
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
        {isSymbolSearchFiltered && (
          <div className="text-xs text-cyan-400 px-1.5 pb-2 border-b border-[var(--border)] mb-2 flex items-center justify-between">
            <span>
              Symbol: {symbolSearchResults!.totalMatches} match{symbolSearchResults!.totalMatches !== 1 ? "es" : ""} ({symbolSearchFilteredPages.length} pg)
            </span>
            <button
              onClick={() => useViewerStore.getState().clearSymbolSearch()}
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
                  <div className="w-10 h-7 bg-[var(--bg)] rounded overflow-hidden shrink-0 relative">
                    {thumbUrl(firstPage) ? (
                      <img
                        src={thumbUrl(firstPage)!}
                        alt={prefix}
                        className="w-full h-full object-contain relative z-[1]"
                        loading="lazy"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : null}
                    <div className="w-full h-full flex items-center justify-center text-[var(--muted)] text-[8px] absolute inset-0">
                      {firstPage}
                    </div>
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
          // ─── Flat view (virtualized — only ~20 buttons in DOM) ──────────
          <div style={{ height: displayPages.length * ITEM_HEIGHT, position: "relative" }}>
            {visibleSlice.map((n, i) => (
              <div
                key={n}
                style={{ position: "absolute", top: (visibleStartIdx + i) * ITEM_HEIGHT, left: 0, right: 0 }}
              >
                {renderPageButton(n)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
