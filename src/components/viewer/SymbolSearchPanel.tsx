"use client";

import { useMemo } from "react";
import { useViewerStore } from "@/stores/viewerStore";

export default function SymbolSearchPanel() {
  const symbolSearchResults = useViewerStore((s) => s.symbolSearchResults);
  const symbolSearchLoading = useViewerStore((s) => s.symbolSearchLoading);
  const symbolSearchProgress = useViewerStore((s) => s.symbolSearchProgress);
  const symbolSearchConfidence = useViewerStore((s) => s.symbolSearchConfidence);
  const setSymbolSearchConfidence = useViewerStore((s) => s.setSymbolSearchConfidence);
  const dismissedSymbolMatches = useViewerStore((s) => s.dismissedSymbolMatches);
  const dismissSymbolMatch = useViewerStore((s) => s.dismissSymbolMatch);
  const clearSymbolSearch = useViewerStore((s) => s.clearSymbolSearch);
  const setPage = useViewerStore((s) => s.setPage);
  const pageNames = useViewerStore((s) => s.pageNames);
  const pageNumber = useViewerStore((s) => s.pageNumber);

  // Filter matches by confidence and dismissed state
  const visibleMatches = useMemo(() => {
    if (!symbolSearchResults) return [];
    return symbolSearchResults.matches.filter(
      (m) => m.confidence >= symbolSearchConfidence && !dismissedSymbolMatches.has(m.id)
    );
  }, [symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches]);

  // Group by page
  const pageGroups = useMemo(() => {
    const groups: Record<number, typeof visibleMatches> = {};
    for (const m of visibleMatches) {
      if (!groups[m.pageNumber]) groups[m.pageNumber] = [];
      groups[m.pageNumber].push(m);
    }
    return Object.entries(groups)
      .map(([page, matches]) => ({ pageNumber: Number(page), matches }))
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }, [visibleMatches]);

  if (!symbolSearchLoading && !symbolSearchResults) return null;

  return (
    <div className="flex flex-col w-72 max-h-[60vh] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-cyan-900/20">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#22d3ee" strokeWidth="1.5">
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10" y1="10" x2="14" y2="14" />
          </svg>
          <span className="text-xs font-medium text-cyan-400">Symbol Search</span>
        </div>
        <button
          onClick={clearSymbolSearch}
          className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none"
          title="Clear search"
        >
          &times;
        </button>
      </div>

      {/* Loading state */}
      {symbolSearchLoading && (
        <div className="px-3 py-4 text-center">
          <div className="text-xs text-cyan-400 animate-pulse mb-2">
            Searching for matches...
          </div>
          {symbolSearchProgress && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--muted)]">
                Page {symbolSearchProgress.pageIndex} of {symbolSearchProgress.totalPages}
              </div>
              <div className="w-full h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-400 rounded-full transition-all duration-300"
                  style={{ width: `${(symbolSearchProgress.pageIndex / symbolSearchProgress.totalPages) * 100}%` }}
                />
              </div>
              <div className="text-[10px] text-cyan-400/70">
                {symbolSearchProgress.matches} match{symbolSearchProgress.matches !== 1 ? "es" : ""} so far
              </div>
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {symbolSearchResults && !symbolSearchLoading && (
        <>
          {/* Summary */}
          <div className="px-3 py-2 border-b border-[var(--border)]">
            <div className="text-xs text-[var(--fg)]">
              <span className="text-cyan-400 font-medium">{visibleMatches.length}</span>
              {" "}match{visibleMatches.length !== 1 ? "es" : ""} across{" "}
              <span className="text-cyan-400 font-medium">{pageGroups.length}</span>
              {" "}page{pageGroups.length !== 1 ? "s" : ""}
            </div>
            {dismissedSymbolMatches.size > 0 && (
              <div className="text-[10px] text-[var(--muted)]">
                ({dismissedSymbolMatches.size} dismissed)
              </div>
            )}
          </div>

          {/* Confidence slider */}
          <div className="px-3 py-2 border-b border-[var(--border)] space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--muted)]">Min Confidence</span>
              <span className="text-[10px] text-cyan-400 font-medium">
                {Math.round(symbolSearchConfidence * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={symbolSearchConfidence * 100}
              onChange={(e) => setSymbolSearchConfidence(Number(e.target.value) / 100)}
              className="w-full h-1 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
          </div>

          {/* Per-page groups */}
          <div className="flex-1 overflow-y-auto">
            {pageGroups.map(({ pageNumber: pn, matches }) => (
              <div key={pn} className="border-b border-[var(--border)] last:border-b-0">
                <button
                  onClick={() => setPage(pn)}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] ${
                    pn === pageNumber ? "bg-cyan-400/5" : ""
                  }`}
                >
                  <span className={`text-[11px] ${pn === pageNumber ? "text-cyan-400" : "text-[var(--fg)]"}`}>
                    {pageNames[pn] || `Page ${pn}`}
                  </span>
                  <span className="text-[10px] text-cyan-400/70 bg-cyan-400/10 px-1.5 rounded">
                    {matches.length}
                  </span>
                </button>
                {/* Individual matches for current page */}
                {pn === pageNumber && (
                  <div className="px-3 pb-1.5">
                    {matches.map((m) => (
                      <div key={m.id} className="flex items-center justify-between py-0.5">
                        <span className="text-[10px] text-[var(--muted)]">
                          {Math.round(m.confidence * 100)}% ({m.method})
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); dismissSymbolMatch(m.id); }}
                          className="text-[10px] text-red-400/50 hover:text-red-400"
                          title="Dismiss match"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {pageGroups.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-[var(--muted)]">
                No matches found. Try lowering the confidence threshold.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
