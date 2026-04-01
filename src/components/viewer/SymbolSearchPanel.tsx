"use client";

import { useMemo, useEffect, useState, useRef, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore, useSymbolSearch, useProject, useNavigation } from "@/stores/viewerStore";

interface SymbolSearchPanelProps {
  pdfDoc: PDFDocumentProxy | null;
}

export default function SymbolSearchPanel({ pdfDoc }: SymbolSearchPanelProps) {
  const {
    symbolSearchActive,
    symbolSearchResults,
    symbolSearchLoading,
    symbolSearchProgress,
    symbolSearchConfidence,
    setSymbolSearchConfidence,
    dismissedSymbolMatches,
    dismissSymbolMatch,
    clearSymbolSearch,
    symbolSearchError,
    symbolSearchTemplateBbox,
    symbolSearchSourcePage,
    setSymbolSearchActive,
    symbolSearchConfig,
    setSymbolSearchConfig,
  } = useSymbolSearch();
  const { pageNames } = useProject();
  const { pageNumber, setPage } = useNavigation();

  // Template preview image
  const [templateImageUrl, setTemplateImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pdfDoc || !symbolSearchTemplateBbox || !symbolSearchSourcePage) {
      setTemplateImageUrl(null);
      return;
    }
    let cancelled = false;

    async function renderCrop() {
      try {
        const page = await pdfDoc!.getPage(symbolSearchSourcePage!);
        const scale = 2;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;

        const [minX, minY, maxX, maxY] = symbolSearchTemplateBbox!;
        const sx = minX * viewport.width;
        const sy = minY * viewport.height;
        const sw = (maxX - minX) * viewport.width;
        const sh = (maxY - minY) * viewport.height;

        const crop = document.createElement("canvas");
        crop.width = Math.round(sw);
        crop.height = Math.round(sh);
        const cctx = crop.getContext("2d")!;
        cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
        if (!cancelled) setTemplateImageUrl(crop.toDataURL("image/png"));
      } catch {
        if (!cancelled) setTemplateImageUrl(null);
      }
    }
    renderCrop();
    return () => { cancelled = true; };
  }, [pdfDoc, symbolSearchTemplateBbox, symbolSearchSourcePage]);

  // Filter matches
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

  // Run search — fires the API with current config
  const abortRef = useRef<AbortController | null>(null);
  const runSearch = useCallback(async () => {
    const store = useViewerStore.getState();
    if (!store.symbolSearchTemplateBbox || !store.symbolSearchSourcePage) return;

    // Abort any in-flight search
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    // Auto-timeout after 120s
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 120000);

    const bbox = store.symbolSearchTemplateBbox;
    store.setSymbolSearchLoading(true);
    store.setSymbolSearchError(null);
    store.setSymbolSearchResults(null);
    store.setSymbolSearchProgress(null);

    try {
      const resp = await fetch("/api/symbol-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          projectId: store.projectId,
          sourcePageNumber: store.symbolSearchSourcePage,
          templateBbox: { x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1] },
          confidenceThreshold: store.symbolSearchConfidence,
          multiScale: store.symbolSearchConfig.multiScale,
          useSiftFallback: store.symbolSearchConfig.useSiftFallback,
          searchPages: store.symbolSearchConfig.searchPages,
        }),
      });

      if (!resp.ok || !resp.body) {
        const errorText = resp.ok ? "No response body" : await resp.text().catch(() => `HTTP ${resp.status}`);
        throw new Error(errorText);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // skip malformed JSON lines
          }
          if (msg.type === "progress") {
            useViewerStore.getState().setSymbolSearchProgress({
              page: msg.page as number,
              pageIndex: msg.pageIndex as number,
              totalPages: msg.totalPages as number,
              matches: msg.matches as number,
            });
          } else if (msg.type === "done") {
            useViewerStore.getState().setSymbolSearchResults({
              templateBbox: msg.templateBbox as [number, number, number, number],
              sourcePageNumber: msg.sourcePageNumber as number,
              totalMatches: msg.totalMatches as number,
              pagesWithMatches: msg.pagesWithMatches as number[],
              matches: msg.matches as any[],
              searchedAt: msg.searchedAt as string,
            });
          } else if (msg.type === "error") {
            throw new Error((msg.message as string) || "Engine error");
          }
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === "AbortError") {
        if (timedOut) {
          useViewerStore.getState().setSymbolSearchError("Search timed out — try searching fewer pages");
        }
        return;
      }
      console.error("[SYMBOL_SEARCH] Failed:", err);
      useViewerStore.getState().setSymbolSearchError(
        err instanceof Error ? err.message : "Symbol search failed"
      );
    } finally {
      clearTimeout(timeout);
      useViewerStore.getState().setSymbolSearchLoading(false);
      useViewerStore.getState().setSymbolSearchProgress(null);
    }
  }, []);

  // Determine UI state
  const hasTemplate = !!symbolSearchTemplateBbox && !!symbolSearchSourcePage;
  const state: "idle" | "configure" | "processing" | "results" | "error" =
    symbolSearchError ? "error" :
    symbolSearchLoading ? "processing" :
    symbolSearchResults ? "results" :
    hasTemplate ? "configure" :
    "idle";

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
          onClick={() => { abortRef.current?.abort(); clearSymbolSearch(); }}
          className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none"
          title="Close"
        >
          &times;
        </button>
      </div>

      {/* Template preview */}
      {templateImageUrl && (
        <div className="px-3 pt-2 flex items-start gap-2">
          <img
            src={templateImageUrl}
            alt="Search template"
            className="w-16 h-16 object-contain border border-cyan-500/30 rounded bg-neutral-900"
          />
          <div className="flex-1 text-[10px]">
            {state === "processing" && (
              <div className="space-y-1">
                <div className="text-cyan-400 animate-pulse">
                  {symbolSearchProgress
                    ? `Page ${symbolSearchProgress.pageIndex + 1} of ${symbolSearchProgress.totalPages}...`
                    : "Loading pages..."}
                </div>
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="text-[9px] text-[var(--muted)] hover:text-red-400"
                >
                  Cancel
                </button>
              </div>
            )}
            {state === "configure" && (
              <div className="text-[var(--muted)]">Template captured. Configure options below.</div>
            )}
            {state === "results" && (
              <div className="text-[var(--fg)]">
                <span className="text-cyan-400 font-medium">{visibleMatches.length}</span>
                {" "}match{visibleMatches.length !== 1 ? "es" : ""} across{" "}
                <span className="text-cyan-400 font-medium">{pageGroups.length}</span>
                {" "}page{pageGroups.length !== 1 ? "s" : ""}
              </div>
            )}
            {state === "error" && (
              <div className="text-red-400 text-[10px]">{symbolSearchError || "Search failed"}</div>
            )}
          </div>
        </div>
      )}

      {/* State: IDLE — prompt to draw */}
      {state === "idle" && (
        <div className="px-3 py-6 text-center">
          <div className="text-xs text-[var(--muted)] mb-1">
            Draw a bounding box around the
          </div>
          <div className="text-xs text-cyan-400 font-medium">
            symbol you want to find.
          </div>
          <div className="text-[10px] text-[var(--muted)] mt-3">
            Click and drag on the blueprint to select.
          </div>
        </div>
      )}

      {/* State: CONFIGURE — show options before running */}
      {state === "configure" && (
        <div className="px-3 py-2 space-y-2 border-t border-[var(--border)]">
          {/* Confidence threshold */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--muted)]">Min Confidence</span>
              <span className="text-[10px] text-cyan-400 font-medium">
                {Math.round(symbolSearchConfidence * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="10"
              max="100"
              value={symbolSearchConfidence * 100}
              onChange={(e) => setSymbolSearchConfidence(Number(e.target.value) / 100)}
              className="w-full h-1 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
          </div>

          {/* Multi-scale toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={symbolSearchConfig.multiScale}
              onChange={(e) => setSymbolSearchConfig({ multiScale: e.target.checked })}
              className="accent-cyan-400"
            />
            <span className="text-[10px] text-[var(--fg)]">Multi-scale matching</span>
            <span className="text-[9px] text-[var(--muted)]">— try different sizes</span>
          </label>

          {/* SIFT fallback toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={symbolSearchConfig.useSiftFallback}
              onChange={(e) => setSymbolSearchConfig({ useSiftFallback: e.target.checked })}
              className="accent-cyan-400"
            />
            <span className="text-[10px] text-[var(--fg)]">SIFT fallback</span>
            <span className="text-[9px] text-[var(--muted)]">— rotation-invariant</span>
          </label>

          {/* Page scope */}
          <div className="space-y-1">
            <span className="text-[10px] text-[var(--muted)]">Search scope</span>
            <div className="flex gap-1">
              <button
                onClick={() => setSymbolSearchConfig({ searchPages: null })}
                className={`flex-1 text-[9px] px-2 py-1 rounded border transition-colors ${
                  !symbolSearchConfig.searchPages
                    ? "border-cyan-500 text-cyan-400 bg-cyan-500/10"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                }`}
              >
                All pages
              </button>
              <button
                onClick={() => setSymbolSearchConfig({ searchPages: [pageNumber] })}
                className={`flex-1 text-[9px] px-2 py-1 rounded border transition-colors ${
                  symbolSearchConfig.searchPages?.length === 1 && symbolSearchConfig.searchPages[0] === pageNumber
                    ? "border-cyan-500 text-cyan-400 bg-cyan-500/10"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                }`}
              >
                This page only
              </button>
            </div>
          </div>

          {/* Run button */}
          <button
            onClick={runSearch}
            className="w-full text-xs px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors"
          >
            Run Search
          </button>

          {/* Redraw button */}
          <button
            onClick={() => {
              useViewerStore.getState().setSymbolSearchResults(null);
              useViewerStore.getState().setSymbolSearchTemplateBbox(null);
              useViewerStore.getState().setSymbolSearchActive(true);
            }}
            className="w-full text-[9px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--fg)]/40"
          >
            Redraw Template
          </button>
        </div>
      )}

      {/* State: PROCESSING — progress bar */}
      {state === "processing" && (
        <div className="px-3 py-2">
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
          {!symbolSearchProgress && (
            <div className="text-xs text-cyan-400 animate-pulse text-center py-2">
              Preparing search...
            </div>
          )}
        </div>
      )}

      {/* State: ERROR — show error + retry */}
      {state === "error" && (
        <div className="px-3 py-3 space-y-2">
          <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
            {symbolSearchError}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => {
                useViewerStore.getState().setSymbolSearchError(null);
              }}
              className="flex-1 text-[9px] px-2 py-1 rounded border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
            >
              Back to Config
            </button>
            <button
              onClick={() => {
                useViewerStore.getState().setSymbolSearchError(null);
                useViewerStore.getState().setSymbolSearchTemplateBbox(null);
                useViewerStore.getState().setSymbolSearchActive(true);
              }}
              className="flex-1 text-[9px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Redraw
            </button>
          </div>
        </div>
      )}

      {/* State: RESULTS — confidence slider + page list */}
      {state === "results" && (
        <>
          {/* Confidence slider */}
          <div className="px-3 py-2 border-t border-[var(--border)] space-y-1">
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
          <div className="flex-1 overflow-y-auto border-t border-[var(--border)]">
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
                No matches at {Math.round(symbolSearchConfidence * 100)}% confidence. Try lowering the threshold.
              </div>
            )}
          </div>

          {/* Bottom actions */}
          <div className="px-3 py-2 border-t border-[var(--border)] space-y-1">
            <button
              onClick={runSearch}
              className="w-full text-[9px] px-2 py-1 rounded border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
            >
              Re-run with Current Settings
            </button>
            <button
              onClick={() => {
                useViewerStore.getState().setSymbolSearchResults(null);
                useViewerStore.getState().setSymbolSearchTemplateBbox(null);
                useViewerStore.getState().setSymbolSearchActive(true);
              }}
              className="w-full text-[9px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Search New Symbol
            </button>
          </div>
        </>
      )}
    </div>
  );
}
