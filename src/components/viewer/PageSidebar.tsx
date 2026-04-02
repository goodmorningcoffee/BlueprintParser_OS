"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore, useNavigation, useProject, usePageData, useDetection, useTextAnnotationDisplay, useYoloTags, useSymbolSearch, useSummaries } from "@/stores/viewerStore";
import { findPhraseMatches } from "./SearchHighlightOverlay";
import { extractDisciplinePrefix, disciplineOrder } from "@/lib/page-utils";

interface PageSidebarProps {
  pdfDoc: PDFDocumentProxy;
}

interface ThumbnailCache {
  [pageNum: number]: string; // data URL
}

const BATCH_SIZE = 5;
const THUMB_WIDTH = 150;

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

  // Try pre-generated S3 thumbnails first, fall back to pdf.js rendering
  const dataUrl = useViewerStore((s) => s.dataUrl);
  const s3ThumbsAvailableRef = useRef<boolean | null>(null); // null = unknown, true/false = probed
  useEffect(() => {
    if (!dataUrl || !pdfDoc) return;
    const s3Bucket = process.env.NEXT_PUBLIC_S3_BUCKET || "";
    const cf = process.env.NEXT_PUBLIC_CLOUDFRONT_DOMAIN;
    if (!s3Bucket && !cf) return; // No S3 configured, skip entirely
    const baseUrl = cf ? `https://${cf}/${dataUrl}` : `https://${s3Bucket}.s3.amazonaws.com/${dataUrl}`;

    // Probe page 1 thumbnail first — if it 404s, skip all S3 attempts (no thumbnails for this project)
    const probe = new Image();
    probe.onload = () => {
      s3ThumbsAvailableRef.current = true;
      renderedPagesRef.current.add(1);
      setThumbnails((prev) => ({ ...prev, [1]: probe.src }));

      // Page 1 exists, try the rest
      const allPages = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
      for (const pg of allPages) {
        if (renderedPagesRef.current.has(pg)) continue;
        const key = String(pg).padStart(4, "0");
        const img = new Image();
        img.onload = () => {
          renderedPagesRef.current.add(pg);
          setThumbnails((prev) => ({ ...prev, [pg]: img.src }));
        };
        img.onerror = () => {}; // Individual misses are fine, pdf.js will fill gaps
        img.src = `${baseUrl}/thumbnails/page_${key}.png`;
      }
    };
    probe.onerror = () => {
      s3ThumbsAvailableRef.current = false; // No S3 thumbnails — pdf.js will handle all pages
    };
    probe.src = `${baseUrl}/thumbnails/page_0001.png`;
  }, [dataUrl, pdfDoc]);

  // Generate thumbnails via pdf.js for pages that don't have S3 thumbnails
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
          // ─── Flat view ──────────────────────────────────────
          Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
            if (isPageHidden(n)) return null;
            return renderPageButton(n);
          })
        )}
      </div>
    </div>
  );
}
