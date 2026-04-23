"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { useViewerStore, useNavigation, usePageData, usePanels, useProject, useDetection, useTextAnnotationDisplay } from "@/stores/viewerStore";
import { TEXT_ANNOTATION_COLORS } from "@/types";
import type { TextAnnotation, AnnotationCategory, ClientAnnotation } from "@/types";
import HelpTooltip from "./HelpTooltip";

const CATEGORY_LABELS: Record<AnnotationCategory, string> = {
  contact: "Contact Info",
  codes: "Codes & Standards",
  csi: "CSI Codes",
  dimensions: "Dimensions",
  equipment: "Equipment & Materials",
  references: "References",
  trade: "Trade Callouts",
  abbreviation: "Abbreviations",
  notes: "Notes & Instructions",
  rooms: "Rooms & Spaces",
};

/**
 * `embedded`: when true the outer panel chrome (fixed width, border, shadow)
 * is skipped so the body can be hosted inside a parent orchestrator (e.g.
 * ToolsPanel). TextPanel has no header bar, so only the wrapper is affected.
 */
export default function TextPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { pageNumber } = useNavigation();
  const { textractData, textAnnotations } = usePageData();
  const { textPanelTab: tab, setTextPanelTab: setTab } = usePanels();
  const { searchQuery, annotations: allAnnotations } = useDetection();
  const userMarkups = allAnnotations.filter((a) => a.source === "user");

  const pageData = textractData[pageNumber];
  const annotations = textAnnotations[pageNumber] || [];

  const TAB_LABELS: Record<string, string> = {
    ocr: "OCR",
    annotations: `Annotations (${annotations.length})`,
    markups: `Markups (${userMarkups.length})`,
    graph: "Graph",
    textract: "Textract",
  };

  return (
    <div className={embedded ? "flex flex-col h-full" : "w-80 border border-[var(--border)] bg-[var(--surface)] flex flex-col shrink-0 shadow-lg"}>
      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["ocr", "annotations", "markups", "graph", "textract"] as const).map((t) => (
          <HelpTooltip key={t} id={`text-tab-${t}`}>
            <button
              onClick={() => setTab(t)}
              className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                tab === t
                  ? "text-sky-400 border-b-2 border-sky-400"
                  : "text-[var(--muted)] hover:text-[var(--fg)]"
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          </HelpTooltip>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "ocr" && <OcrTab pageData={pageData} searchQuery={searchQuery} pageNumber={pageNumber} />}
        {tab === "annotations" && <AnnotationsTab annotations={annotations} pageNumber={pageNumber} />}
        {tab === "markups" && <MarkupsTab markups={userMarkups} />}
        {tab === "graph" && <GraphTab pageNumber={pageNumber} />}
        {tab === "textract" && <TextractTab pageData={pageData} pageNumber={pageNumber} />}
      </div>
    </div>
  );
}

// ─── OCR Tab ──────────────────────────────────────────────────

function OcrTab({ pageData, searchQuery, pageNumber }: { pageData: any; searchQuery: string; pageNumber: number }) {
  // Each line returns { text, highlighted, isHtml } — `isHtml === true` means
  // the `text` field is pre-escaped HTML containing <mark> tags; the render
  // path below uses `dangerouslySetInnerHTML` for those. When no search query
  // is active, we return raw text and the render path renders as a text node.
  // This closes the OCR-XSS path where an uploaded PDF's OCR text could
  // become executable markup in the viewer.
  const lines = useMemo<{ text: string; highlighted: boolean; isHtml: boolean }[]>(() => {
    if (!pageData?.lines) return [];
    const queryTerms = searchQuery.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    return pageData.lines.map((line: any) => {
      if (queryTerms.length === 0) {
        return { text: line.text, highlighted: false, isHtml: false };
      }
      let html = escapeHtml(line.text);
      for (const term of queryTerms) {
        const regex = new RegExp(`(${escapeRegex(term)})`, "gi");
        html = html.replace(regex, "<mark>$1</mark>");
      }
      return { text: html, highlighted: html !== escapeHtml(line.text), isHtml: true };
    });
  }, [pageData, searchQuery]);

  if (!pageData) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-[var(--muted)] text-sm">No text extracted</span>
      </div>
    );
  }

  return (
    <>
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-xs text-[var(--muted)]">
          Page {pageNumber} — {pageData.lines.length} lines, {pageData.words.length} words
        </span>
        <HelpTooltip id="text-ocr-copy" position="above">
          <button
            onClick={() => {
              const text = pageData.lines.map((l: any) => l.text).join("\n");
              navigator.clipboard.writeText(text).then(() => {
                const btn = document.activeElement as HTMLButtonElement;
                if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
              });
            }}
            className="px-2 py-0.5 text-[10px] rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]"
          >
            Copy
          </button>
        </HelpTooltip>
      </div>
      <div className="p-3 text-sm leading-relaxed font-mono">
        {lines.map((line, i) =>
          line.isHtml ? (
            // Search-highlight path: `text` is pre-escaped HTML with <mark>
            // tags (see useMemo above). Safe to inject.
            <p
              key={i}
              className="mb-1 break-words"
              dangerouslySetInnerHTML={{ __html: line.text }}
            />
          ) : (
            // No-search path: render raw line text as a text node so OCR
            // markup like <script> stays literal rather than executing.
            <p key={i} className="mb-1 break-words">
              {line.text}
            </p>
          ),
        )}
      </div>
    </>
  );
}

// ─── Annotations Tab ──────────────────────────────────────────

function AnnotationsTab({ annotations, pageNumber }: { annotations: TextAnnotation[]; pageNumber: number }) {
  const {
    showTextAnnotations: showAll, toggleTextAnnotations: toggleAll,
    activeTextAnnotationTypes: activeTypes, setTextAnnotationType: setType,
    setAllTextAnnotationTypes: setAllTypes,
    hiddenTextAnnotations: hiddenSet, toggleTextAnnotationVisibility: toggleIndividual,
    textAnnotationColors: customColors, setTextAnnotationColor: setColor,
    activeTextAnnotationFilter: activeFilter, setTextAnnotationFilter: setFilter,
  } = useTextAnnotationDisplay();

  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  // Group by category
  const grouped = useMemo(() => {
    const map: Record<string, { annotations: Array<TextAnnotation & { idx: number }>; category: AnnotationCategory }> = {};
    annotations.forEach((ann, idx) => {
      if (!map[ann.category]) map[ann.category] = { annotations: [], category: ann.category };
      map[ann.category].annotations.push({ ...ann, idx });
    });
    return Object.values(map).sort((a, b) => b.annotations.length - a.annotations.length);
  }, [annotations]);

  // Initialize type toggles for all types found
  useMemo(() => {
    for (const ann of annotations) {
      if (activeTypes[ann.type] === undefined) {
        setType(ann.type, true);
      }
    }
  }, [annotations]);

  if (annotations.length === 0) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-[var(--muted)] text-sm">No text annotations detected</span>
      </div>
    );
  }

  return (
    <div className="text-xs">
      {/* Global controls */}
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-[var(--muted)]">{annotations.length} annotations</span>
        <button
          onClick={toggleAll}
          className={`px-2 py-0.5 rounded border text-[11px] ${
            showAll
              ? "border-green-500/30 text-green-400 bg-green-500/10"
              : "border-red-400/30 text-red-400 bg-red-500/10"
          }`}
        >
          {showAll ? "Show Annotations: On" : "Show Annotations: Off"}
        </button>
      </div>

      {/* Category groups */}
      {grouped.map((group) => {
        const catKey = group.category;
        const expanded = expandedCategories[catKey] === true; // default collapsed
        const baseColor = TEXT_ANNOTATION_COLORS[catKey] || "#f59e0b";
        const allTypesInCategory = [...new Set(group.annotations.map((a) => a.type))];
        const allVisible = allTypesInCategory.every((t) => activeTypes[t] !== false);

        return (
          <div key={catKey} className="border-b border-[var(--border)]">
            {/* Category header */}
            <div
              className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg)]"
              onClick={() => setExpandedCategories((prev) => ({ ...prev, [catKey]: !expanded }))}
            >
              <span className="text-[var(--muted)]">{expanded ? "\u25BC" : "\u25B6"}</span>
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: baseColor }}
              />
              <span className="font-medium text-[var(--fg)] flex-1">
                {CATEGORY_LABELS[catKey] || catKey}
              </span>
              <span className="text-[var(--muted)]">{group.annotations.length}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const newState = !allVisible;
                  allTypesInCategory.forEach((t) => setType(t, newState));
                }}
                className={`px-1.5 py-0.5 rounded ${
                  allVisible ? "text-green-400" : "text-[var(--muted)]"
                }`}
                title={allVisible ? "Hide category" : "Show category"}
              >
                {allVisible ? "\u{1F441}" : "\u{1F441}\u200D\u{1F5E8}"}
              </button>
            </div>

            {/* Items */}
            {expanded && (
              <div className="pb-1">
                {group.annotations.map((ann) => {
                  const key = `${pageNumber}:${ann.idx}`;
                  const isHidden = hiddenSet.has(key) || activeTypes[ann.type] === false;
                  const color = customColors[ann.type] || baseColor;

                  return (
                    <div
                      key={ann.idx}
                      onClick={() => {
                        if (activeFilter?.type === ann.type && activeFilter?.text === ann.text) {
                          setFilter(null);
                        } else {
                          setFilter({ type: ann.type, text: ann.text });
                        }
                      }}
                      className={`flex items-center gap-2 px-4 py-1 hover:bg-[var(--bg)] cursor-pointer ${
                        isHidden ? "opacity-40" : ""
                      } ${activeFilter?.type === ann.type && activeFilter?.text === ann.text ? "bg-[var(--accent)]/10 border-l-2 border-[var(--accent)]" : ""}`}
                    >
                      {/* Individual visibility toggle */}
                      <button
                        onClick={() => toggleIndividual(pageNumber, ann.idx)}
                        className="text-[var(--muted)] hover:text-[var(--fg)] shrink-0"
                        title="Toggle visibility"
                      >
                        {isHidden ? "\u25CB" : "\u25CF"}
                      </button>
                      {/* Color indicator */}
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      {/* Type + text */}
                      <span className="text-[var(--muted)] shrink-0">{ann.type}:</span>
                      <span className="text-[var(--fg)] truncate flex-1" title={ann.text}>
                        {ann.type === "csi-code" && ann.meta?.code ? `${ann.meta.code} ${ann.text}` : ann.text}
                      </span>
                      {/* Confidence */}
                      <span className="text-[var(--muted)] shrink-0">
                        {Math.round(ann.confidence * 100)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Graph Tab ────────────────────────────────────────────────

function GraphTab({ pageNumber }: { pageNumber: number }) {
  const { textAnnotations } = usePageData();
  const { pageNames } = useProject();
  const { numPages, setPage } = useNavigation();

  // Build cross-reference data from sheet-ref annotations across all pages
  const { outgoing, incoming } = useMemo(() => {
    const out: Array<{ fromPage: number; toSheet: string; toPage: number | null }> = [];
    const inc: Array<{ fromPage: number; fromSheet: string }> = [];

    // Build sheet name → page number lookup
    const sheetToPage: Record<string, number> = {};
    for (let p = 1; p <= numPages; p++) {
      const name = (pageNames[p] || "").toUpperCase().replace(/\s+/g, "");
      if (name) sheetToPage[name] = p;
    }

    // Find outgoing refs from current page
    const pageAnns = textAnnotations[pageNumber] || [];
    for (const ann of pageAnns) {
      if (ann.type === "sheet-ref" && ann.meta?.sheetNumber) {
        const sheet = String(ann.meta.sheetNumber).toUpperCase().replace(/\s+/g, "");
        const targetPage = sheetToPage[sheet] || null;
        out.push({ fromPage: pageNumber, toSheet: String(ann.meta.sheetNumber), toPage: targetPage });
      }
    }

    // Find incoming refs to current page
    const currentSheetName = (pageNames[pageNumber] || "").toUpperCase().replace(/\s+/g, "");
    if (currentSheetName) {
      for (let p = 1; p <= numPages; p++) {
        if (p === pageNumber) continue;
        const otherAnns = textAnnotations[p] || [];
        for (const ann of otherAnns) {
          if (ann.type === "sheet-ref" && ann.meta?.sheetNumber) {
            const refSheet = String(ann.meta.sheetNumber).toUpperCase().replace(/\s+/g, "");
            if (refSheet === currentSheetName) {
              inc.push({ fromPage: p, fromSheet: pageNames[p] || `Page ${p}` });
            }
          }
        }
      }
    }

    return { outgoing: out, incoming: inc };
  }, [textAnnotations, pageNumber, pageNames, numPages]);

  // Equipment found on this page
  const equipment = useMemo(() => {
    const anns = textAnnotations[pageNumber] || [];
    return anns.filter((a) => a.type === "equipment-tag");
  }, [textAnnotations, pageNumber]);

  const hasData = outgoing.length > 0 || incoming.length > 0 || equipment.length > 0;

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-[var(--muted)] text-sm">No cross-references detected</span>
      </div>
    );
  }

  return (
    <div className="text-xs p-3 space-y-4">
      {/* Outgoing references */}
      {outgoing.length > 0 && (
        <div>
          <p className="text-[var(--muted)] font-medium mb-1">This page references:</p>
          {outgoing.map((ref, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5">
              <span className="text-purple-400">\u2192</span>
              {ref.toPage ? (
                <button
                  onClick={() => setPage(ref.toPage!)}
                  className="text-[var(--accent)] hover:underline"
                >
                  {ref.toSheet} (Page {ref.toPage})
                </button>
              ) : (
                <span className="text-[var(--muted)]">{ref.toSheet} (not found)</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Incoming references */}
      {incoming.length > 0 && (
        <div>
          <p className="text-[var(--muted)] font-medium mb-1">Referenced by:</p>
          {incoming.map((ref, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5">
              <span className="text-teal-400">\u2190</span>
              <button
                onClick={() => setPage(ref.fromPage)}
                className="text-[var(--accent)] hover:underline"
              >
                {ref.fromSheet} (Page {ref.fromPage})
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Equipment on this page */}
      {equipment.length > 0 && (
        <div>
          <p className="text-[var(--muted)] font-medium mb-1">Equipment ({equipment.length}):</p>
          <div className="flex flex-wrap gap-1">
            {equipment.map((eq, i) => (
              <span key={i} className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">
                {eq.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Markups Tab ────────────────────────────────────────────────

function MarkupsTab({ markups }: { markups: ClientAnnotation[] }) {
  const { activeAnnotationFilter, setAnnotationFilter, setSearch } = useDetection();
  const { setPage } = useNavigation();
  const { pageNames } = useProject();
  const activeMarkupId = useViewerStore((s) => s.activeMarkupId);
  const scrollRef = useRef<Record<number, HTMLDivElement | null>>({});

  // Scroll to active markup when it changes
  useEffect(() => {
    if (activeMarkupId !== null && scrollRef.current[activeMarkupId]) {
      scrollRef.current[activeMarkupId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeMarkupId]);

  // Group by page
  const byPage = useMemo(() => {
    const map: Record<number, ClientAnnotation[]> = {};
    for (const m of markups) {
      if (!map[m.pageNumber]) map[m.pageNumber] = [];
      map[m.pageNumber].push(m);
    }
    return Object.entries(map).sort(([a], [b]) => Number(a) - Number(b));
  }, [markups]);

  if (markups.length === 0) {
    return (
      <div className="p-4 text-[var(--muted)] text-xs">
        No markups yet. Use the Markup tool to draw rectangles on the blueprint and add notes.
      </div>
    );
  }

  return (
    <div className="p-2 space-y-3">
      {/* Active filter indicator */}
      {activeAnnotationFilter && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--accent)]/10 rounded text-xs">
          <span className="text-[var(--accent)] font-medium truncate flex-1">
            Filtering: {activeAnnotationFilter}
          </span>
          <button
            onClick={() => { setAnnotationFilter(null); setSearch(""); }}
            className="text-[var(--muted)] hover:text-[var(--fg)] shrink-0"
          >
            x
          </button>
        </div>
      )}

      {byPage.map(([pg, anns]) => (
        <div key={pg}>
          <div className="text-[10px] text-[var(--muted)] font-medium px-1 mb-1">
            Page {pg}{pageNames[Number(pg)] ? ` — ${pageNames[Number(pg)]}` : ""}
          </div>
          {anns.map((ann) => {
            const isActive = activeAnnotationFilter === ann.name;
            const isHighlighted = activeMarkupId === ann.id;
            return (
              <div
                key={ann.id}
                ref={(el) => { scrollRef.current[ann.id] = el; }}
                onClick={() => {
                  if (isActive) {
                    setAnnotationFilter(null);
                    setSearch("");
                  } else {
                    setAnnotationFilter(ann.name);
                    setSearch(ann.name);
                  }
                }}
                className={`px-2 py-1.5 rounded cursor-pointer transition-colors mb-1 ${
                  isHighlighted
                    ? "bg-[var(--accent)]/20 border border-[var(--accent)]/40"
                    : isActive
                    ? "bg-[var(--accent)]/10"
                    : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium truncate ${isActive ? "text-[var(--accent)]" : "text-[var(--fg)]"}`}>
                    {ann.name}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setPage(ann.pageNumber); }}
                    className="text-[10px] text-[var(--muted)] hover:text-[var(--accent)] shrink-0"
                  >
                    pg {ann.pageNumber}
                  </button>
                </div>
                {ann.note && (
                  <p className="text-[11px] text-[var(--muted)] mt-0.5 whitespace-pre-wrap break-words">
                    {ann.note}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Textract Tab ────────────────────────────────────────────────

function TextractTab({ pageData, pageNumber }: { pageData: any; pageNumber: number }) {
  const { projectId: projectDbId } = useProject();
  const setTextractData = useViewerStore((s) => s.setTextractData);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ durationMs: number; stats: { wordCount: number; lineCount: number; tableCount: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentStats = {
    words: pageData?.words?.length ?? 0,
    lines: pageData?.lines?.length ?? 0,
    tables: pageData?.tables?.length ?? 0,
  };

  const handleRerun = async () => {
    if (loading || !projectDbId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/pages/textract-rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: projectDbId, pageNumber }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResult({ durationMs: data.durationMs, stats: data.stats });
      if (data.textractData) setTextractData(pageNumber, data.textractData);
    } catch (e: any) {
      setError(e?.message || "Re-run failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-3 space-y-3 text-xs">
      <div>
        <button
          onClick={handleRerun}
          disabled={loading || !projectDbId}
          className={`w-full px-3 py-2 rounded border text-sm font-medium transition-colors ${
            loading
              ? "border-[var(--border)] text-[var(--muted)] cursor-wait"
              : !projectDbId
              ? "border-[var(--border)] text-[var(--muted)]/50 cursor-not-allowed"
              : "border-[var(--accent)]/60 text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20"
          }`}
        >
          {loading ? "Re-running Textract…" : "Re-run Textract"}
        </button>
        <p className="mt-1 text-[10px] text-[var(--muted)] leading-snug">
          Clears the cached result for page {pageNumber} and calls AnalyzeDocument fresh
          with LAYOUT + TABLES. Overwrites <code className="font-mono">pages.textractData</code>.
          Downstream CSI/text-annotation derivations stay cached — re-run reprocess separately to refresh those.
        </p>
      </div>

      <div className="border border-[var(--border)] rounded p-2 space-y-1">
        <div className="text-[var(--muted)] font-medium mb-1 uppercase tracking-wide text-[10px]">
          Current cached stats — page {pageNumber}
        </div>
        <StatRow label="Words" value={currentStats.words} />
        <StatRow label="Lines" value={currentStats.lines} />
        <StatRow
          label="Tables"
          value={currentStats.tables}
          tone={currentStats.tables > 0 ? "good" : "bad"}
          hint={currentStats.tables === 0 ? "Textract found no TABLE blocks" : undefined}
        />
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 rounded p-2 text-red-300 space-y-1">
          <div className="font-medium">Re-run failed</div>
          <div className="text-[11px] break-words">{error}</div>
        </div>
      )}

      {result && (
        <div className="border border-green-500/40 bg-green-500/10 rounded p-2 space-y-1">
          <div className="text-green-300 font-medium uppercase tracking-wide text-[10px]">Re-run complete</div>
          <StatRow label="Duration" value={`${(result.durationMs / 1000).toFixed(1)}s`} />
          <StatRow label="New word count" value={result.stats.wordCount} />
          <StatRow label="New line count" value={result.stats.lineCount} />
          <StatRow
            label="New table count"
            value={result.stats.tableCount}
            tone={result.stats.tableCount > 0 ? "good" : "bad"}
            hint={result.stats.tableCount === 0 ? "Still zero — confirms AWS-side miss on this page" : "Textract found tables this time"}
          />
        </div>
      )}

      <CsiRecomputeSection pageNumber={pageNumber} />
    </div>
  );
}

/** Per-page CSI recompute debug tool. Re-runs detectCsiCodes on cached OCR text
 *  (no S3/Textract round-trip) and overwrites pages.csiCodes. Updates the
 *  in-store CSI data so trade filter highlights refresh without a page reload. */
function CsiRecomputeSection({ pageNumber }: { pageNumber: number }) {
  const { projectId: projectDbId } = useProject();
  const setCsiCodes = useViewerStore((s) => s.setCsiCodes);
  const csiCodes = useViewerStore((s) => s.csiCodes);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ durationMs: number; stats: { codeCount: number; triggerCount: number; tradeCount: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentPageCsi = csiCodes[pageNumber] || [];
  const currentStats = {
    codes: currentPageCsi.length,
    triggers: currentPageCsi.reduce((n, c) => n + (c.triggers?.length || 0), 0),
    trades: new Set(currentPageCsi.map((c) => c.trade)).size,
  };

  const handleRecompute = async () => {
    if (loading || !projectDbId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/pages/csi-recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: projectDbId, pageNumber }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResult({ durationMs: data.durationMs, stats: data.stats });
      if (data.csiCodes && setCsiCodes) setCsiCodes(pageNumber, data.csiCodes);
    } catch (e: any) {
      setError(e?.message || "Recompute failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 pt-3 border-t border-[var(--border)]">
      <button
        onClick={handleRecompute}
        disabled={loading || !projectDbId}
        className={`w-full px-3 py-2 rounded border text-sm font-medium transition-colors ${
          loading
            ? "border-[var(--border)] text-[var(--muted)] cursor-wait"
            : !projectDbId
            ? "border-[var(--border)] text-[var(--muted)]/50 cursor-not-allowed"
            : "border-pink-400/60 text-pink-300 bg-pink-400/10 hover:bg-pink-400/20"
        }`}
      >
        {loading ? "Recomputing CSI…" : "Recompute CSI Codes"}
      </button>
      <p className="mt-1 text-[10px] text-[var(--muted)] leading-snug">
        Re-runs <code className="font-mono">detectCsiCodes()</code> on the cached OCR text for
        page {pageNumber} and overwrites <code className="font-mono">pages.csiCodes</code>.
        No S3/Textract round-trip. Uses the same code path as the Overview{" "}
        <em>Re-run All Processes</em> button. Good for testing detection logic changes on one page.
      </p>

      <div className="border border-[var(--border)] rounded p-2 space-y-1 mt-2">
        <div className="text-[var(--muted)] font-medium mb-1 uppercase tracking-wide text-[10px]">
          Current cached CSI — page {pageNumber}
        </div>
        <StatRow label="CSI codes" value={currentStats.codes} />
        <StatRow label="Trade triggers" value={currentStats.triggers} tone={currentStats.triggers > 0 ? "good" : "bad"} hint={currentStats.triggers === 0 && currentStats.codes > 0 ? "Old cached data — no trigger bboxes stored. Recompute to add them." : undefined} />
        <StatRow label="Distinct trades" value={currentStats.trades} />
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 rounded p-2 text-red-300 space-y-1 mt-2">
          <div className="font-medium">Recompute failed</div>
          <div className="text-[11px] break-words">{error}</div>
        </div>
      )}

      {result && (
        <div className="border border-green-500/40 bg-green-500/10 rounded p-2 space-y-1 mt-2">
          <div className="text-green-300 font-medium uppercase tracking-wide text-[10px]">Recompute complete</div>
          <StatRow label="Duration" value={`${result.durationMs}ms`} />
          <StatRow label="New CSI codes" value={result.stats.codeCount} />
          <StatRow label="New trade triggers" value={result.stats.triggerCount} tone={result.stats.triggerCount > 0 ? "good" : "bad"} />
          <StatRow label="New distinct trades" value={result.stats.tradeCount} />
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value, tone, hint }: { label: string; value: string | number; tone?: "good" | "bad"; hint?: string }) {
  const toneClass = tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-[var(--fg)]";
  return (
    <div>
      <div className="flex justify-between">
        <span className="text-[var(--muted)]">{label}</span>
        <span className={`font-mono ${toneClass}`}>{value}</span>
      </div>
      {hint && <div className="text-[10px] text-[var(--muted)]/70 mt-0.5">{hint}</div>}
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
