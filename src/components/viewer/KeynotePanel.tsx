"use client";

import { useMemo, useState, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { mapYoloToOcrText } from "@/lib/yolo-tag-engine";

/**
 * KeynotePanel — Keynote parsing and management tool.
 *
 * 3 tabs: All Keynotes, Auto Parse, Manual Parse
 * Keynotes are 2-column key:value tables (tag + description)
 * with YOLO shape assignment for tag-to-drawing mapping.
 */
export default function KeynotePanel() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const setPage = useViewerStore((s) => s.setPage);
  const pageNames = useViewerStore((s) => s.pageNames);
  const pageIntelligence = useViewerStore((s) => s.pageIntelligence);
  const textractData = useViewerStore((s) => s.textractData);
  const annotations = useViewerStore((s) => s.annotations);
  const toggleKeynoteParsePanel = useViewerStore((s) => s.toggleKeynoteParsePanel);
  const keynoteParseTab = useViewerStore((s) => s.keynoteParseTab);
  const setKeynoteParseTab = useViewerStore((s) => s.setKeynoteParseTab);
  const keynoteParseStep = useViewerStore((s) => s.keynoteParseStep);
  const setKeynoteParseStep = useViewerStore((s) => s.setKeynoteParseStep);
  const keynoteParseRegion = useViewerStore((s) => s.keynoteParseRegion);
  const setKeynoteParseRegion = useViewerStore((s) => s.setKeynoteParseRegion);
  const keynoteColumnBBs = useViewerStore((s) => s.keynoteColumnBBs);
  const addKeynoteColumnBB = useViewerStore((s) => s.addKeynoteColumnBB);
  const keynoteRowBBs = useViewerStore((s) => s.keynoteRowBBs);
  const addKeynoteRowBB = useViewerStore((s) => s.addKeynoteRowBB);
  const keynoteYoloClass = useViewerStore((s) => s.keynoteYoloClass);
  const setKeynoteYoloClass = useViewerStore((s) => s.setKeynoteYoloClass);
  const parsedKeynoteData = useViewerStore((s) => s.parsedKeynoteData);
  const addParsedKeynote = useViewerStore((s) => s.addParsedKeynote);
  const activeKeynoteHighlight = useViewerStore((s) => s.activeKeynoteHighlight);
  const setActiveKeynoteHighlight = useViewerStore((s) => s.setActiveKeynoteHighlight);
  const resetKeynoteParse = useViewerStore((s) => s.resetKeynoteParse);
  const projectId = useViewerStore((s) => s.projectId);
  const addYoloTag = useViewerStore((s) => s.addYoloTag);

  const [autoParsing, setAutoParsing] = useState(false);

  // ─── Classified keynote regions (informational) ─────────
  const classifiedKeynotes = useMemo(() => {
    const results: { pageNum: number; table: any }[] = [];
    for (const [pn, intel] of Object.entries(pageIntelligence)) {
      const pi = intel as any;
      if (pi?.classifiedTables) {
        for (const t of pi.classifiedTables) {
          if (t.category === "keynote-table") {
            results.push({ pageNum: Number(pn), table: t });
          }
        }
      }
    }
    return results.sort((a, b) => a.pageNum - b.pageNum);
  }, [pageIntelligence]);

  // ─── YOLO annotations inside Column A (tag column) ──────
  // YOLO annotations FULLY contained within Column A (tag column)
  const yoloFullyInTagColumn = useMemo(() => {
    if (keynoteColumnBBs.length === 0) return [];
    const colA = keynoteColumnBBs[0]; // first drawn = Column A (tag column)
    const pageYolo = annotations.filter(
      (a) => a.source === "yolo" && a.pageNumber === pageNumber
    );
    // Only annotations whose ENTIRE bbox is within Column A (no edge exceeds)
    const inside = pageYolo.filter((a) => {
      const [minX, minY, maxX, maxY] = a.bbox;
      return minX >= colA[0] && maxX <= colA[2] && minY >= colA[1] && maxY <= colA[3];
    });
    return inside;
  }, [keynoteColumnBBs, annotations, pageNumber]);

  // Grouped by model + class for the panel list
  const yoloInTagColumn = useMemo(() => {
    // Group by model + class
    const groups: Record<string, { model: string; className: string; count: number }> = {};
    for (const a of yoloFullyInTagColumn) {
      const model = (a as any).data?.modelName || "unknown";
      const cls = a.name;
      const key = `${model}:${cls}`;
      if (!groups[key]) groups[key] = { model, className: cls, count: 0 };
      groups[key].count++;
    }
    return Object.values(groups).sort((a, b) => b.count - a.count);
  }, [yoloFullyInTagColumn]);

  // ─── Parse keynotes from column/row intersections ───────
  const parseKeynotes = useCallback(() => {
    const pageTextract = textractData[pageNumber];
    if (!pageTextract?.words || keynoteColumnBBs.length < 2 || keynoteRowBBs.length === 0) return;

    const cols = keynoteColumnBBs; // draw order = column order
    const rows = keynoteRowBBs;

    const keys: { key: string; description: string }[] = [];

    for (const rowBB of rows) {
      // Column A = tag key
      const tagWords = (pageTextract.words as any[]).filter((w: any) => {
        const cx = w.bbox[0] + w.bbox[2] / 2;
        const cy = w.bbox[1] + w.bbox[3] / 2;
        return cx >= cols[0][0] && cx <= cols[0][2] && cy >= rowBB[1] && cy <= rowBB[3];
      });
      const tagText = tagWords.sort((a: any, b: any) => a.bbox[0] - b.bbox[0]).map((w: any) => w.text).join(" ");

      // Column B+ = description (all other columns merged)
      let descText = "";
      for (let ci = 1; ci < cols.length; ci++) {
        const descWords = (pageTextract.words as any[]).filter((w: any) => {
          const cx = w.bbox[0] + w.bbox[2] / 2;
          const cy = w.bbox[1] + w.bbox[3] / 2;
          return cx >= cols[ci][0] && cx <= cols[ci][2] && cy >= rowBB[1] && cy <= rowBB[3];
        });
        const text = descWords.sort((a: any, b: any) => a.bbox[0] - b.bbox[0]).map((w: any) => w.text).join(" ");
        descText += (descText ? " " : "") + text;
      }

      if (tagText || descText) {
        keys.push({ key: tagText.trim(), description: descText.trim() });
      }
    }

    if (keys.length > 0) {
      addParsedKeynote({
        pageNumber,
        keys,
        yoloClass: keynoteYoloClass ? `${keynoteYoloClass.model}:${keynoteYoloClass.className}` : undefined,
        tableName: `Keynotes p.${pageNumber}`,
      });
      // Create YoloTags for each parsed keynote key
      const allAnns = useViewerStore.getState().annotations;
      for (const k of keys) {
        if (!k.key) continue;
        const instances = mapYoloToOcrText({
          tagText: k.key,
          yoloClass: keynoteYoloClass?.className,
          yoloModel: keynoteYoloClass?.model,
          scope: "page",
          pageNumber,
          annotations: allAnns,
          textractData,
        });
        addYoloTag({
          id: `keynote-${pageNumber}-${k.key}-${Date.now()}`,
          name: k.key,
          tagText: k.key,
          yoloClass: keynoteYoloClass?.className || "",
          yoloModel: keynoteYoloClass?.model || "",
          source: "keynote",
          scope: "page",
          pageNumber,
          description: k.description,
          instances,
        });
      }
      setKeynoteParseStep("review");
    }
  }, [textractData, pageNumber, keynoteColumnBBs, keynoteRowBBs, keynoteYoloClass, addParsedKeynote, addYoloTag, setKeynoteParseStep]);

  // ─── Auto parse via API ─────────────────────────────────
  const autoParseKeynote = useCallback(async (bbox: [number, number, number, number]) => {
    setAutoParsing(true);
    try {
      const resp = await fetch("/api/table-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber, regionBbox: bbox }),
      });
      if (!resp.ok) throw new Error("API error");
      const result = await resp.json();
      if (result.headers?.length >= 2 && result.rows?.length > 0) {
        // First column = key, rest = description
        const tagHeader = result.headers[0];
        const descHeaders = result.headers.slice(1);
        const keys = result.rows.map((row: any) => ({
          key: (row[tagHeader] || "").trim(),
          description: descHeaders.map((h: string) => row[h] || "").join(" ").trim(),
        })).filter((k: any) => k.key || k.description);

        if (keys.length > 0) {
          addParsedKeynote({ pageNumber, keys, tableName: `Keynotes p.${pageNumber}` });
          // Create YoloTags for auto-parsed keynotes (no YOLO class assigned in auto mode)
          const allAnns = useViewerStore.getState().annotations;
          const td = useViewerStore.getState().textractData;
          for (const k of keys) {
            if (!k.key) continue;
            const instances = mapYoloToOcrText({
              tagText: k.key,
              scope: "page",
              pageNumber,
              annotations: allAnns,
              textractData: td,
            });
            addYoloTag({
              id: `keynote-${pageNumber}-${k.key}-${Date.now()}`,
              name: k.key,
              tagText: k.key,
              yoloClass: "",
              yoloModel: "",
              source: "keynote",
              scope: "page",
              pageNumber,
              description: k.description,
              instances,
            });
          }
          setKeynoteParseStep("review");
        }
      }
    } catch (err) {
      console.error("[keynote auto-parse] Failed:", err);
    } finally {
      setAutoParsing(false);
    }
  }, [projectId, pageNumber, addParsedKeynote, addYoloTag, setKeynoteParseStep]);

  // ─── Repeat row down ───────────────────────────────────
  const repeatRowDown = useCallback((rowBB: [number, number, number, number]) => {
    if (!keynoteParseRegion) return;
    const rowH = rowBB[3] - rowBB[1];
    const bottom = keynoteParseRegion[3];
    let y = rowBB[3];
    while (y + rowH * 0.5 < bottom) {
      addKeynoteRowBB([rowBB[0], y, rowBB[2], Math.min(y + rowH, bottom)]);
      y += rowH;
    }
  }, [keynoteParseRegion, addKeynoteRowBB]);

  // ─── Render ─────────────────────────────────────────────
  return (
    <div className="w-80 flex flex-col h-full border-l border-[var(--border)] bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Keynotes</h3>
        <button onClick={toggleKeynoteParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "auto", "manual"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setKeynoteParseTab(tab)}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium ${
              keynoteParseTab === tab
                ? "text-amber-300 border-b-2 border-amber-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "all" ? "All Keynotes" : tab === "auto" ? "Auto Parse" : "Manual Parse"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {/* ════════ TAB: All Keynotes ════════ */}
        {keynoteParseTab === "all" && (
          <div className="space-y-1">
            {!parsedKeynoteData || parsedKeynoteData.length === 0 ? (
              <div className="text-[10px] text-[var(--muted)] text-center py-8 px-2">
                No parsed keynotes yet.
                <br /><span className="text-[9px]">Use Auto Parse or Manual Parse tabs.</span>
              </div>
            ) : (
              <>
                <div className="text-[10px] text-[var(--muted)] px-1">{parsedKeynoteData.length} keynote table(s)</div>
                {/* Sort current page first */}
                {[...parsedKeynoteData]
                  .sort((a, b) => (a.pageNumber === pageNumber ? -1 : b.pageNumber === pageNumber ? 1 : a.pageNumber - b.pageNumber))
                  .map((kn, i) => (
                    <KeynoteItem
                      key={i}
                      keynote={kn}
                      pageNames={pageNames}
                      isCurrentPage={kn.pageNumber === pageNumber}
                      onNavigate={() => setPage(kn.pageNumber)}
                      activeHighlight={activeKeynoteHighlight}
                      onHighlight={(key) => setActiveKeynoteHighlight(
                        activeKeynoteHighlight?.key === key && activeKeynoteHighlight?.pageNumber === kn.pageNumber
                          ? null
                          : { pageNumber: kn.pageNumber, key }
                      )}
                    />
                  ))}
              </>
            )}
          </div>
        )}

        {/* ════════ TAB: Auto Parse ════════ */}
        {keynoteParseTab === "auto" && (
          <div className="space-y-2">
            <div className="text-[11px] text-[var(--muted)] px-1">
              {keynoteParseStep === "select-region"
                ? <span className="text-amber-300">Drawing — draw a BB around the keynote table.</span>
                : "Draw a BB around a keynote table to auto-parse it."}
            </div>

            <button
              onClick={() => {
                const next = keynoteParseStep === "select-region" ? "idle" : "select-region";
                setKeynoteParseStep(next);
                if (next !== "idle") useViewerStore.getState().setMode("pointer");
              }}
              className={`w-full text-xs px-3 py-2 rounded border ${
                keynoteParseStep === "select-region"
                  ? "border-amber-500 bg-amber-500/10 text-amber-300"
                  : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              {keynoteParseStep === "select-region" ? "Cancel Drawing" : "Draw Keynote Region"}
            </button>

            {autoParsing && (
              <div className="text-[11px] text-amber-300 text-center py-2 animate-pulse">Parsing...</div>
            )}

            {keynoteParseStep === "review" && (
              <div className="text-[11px] text-green-400 px-2 py-2 border border-green-500/20 rounded bg-green-500/5">
                Keynotes parsed — see All Keynotes tab.
              </div>
            )}

            {/* Classified keynote regions — informational */}
            {classifiedKeynotes.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">
                  Detected Keynote Tables
                </div>
                {classifiedKeynotes.map((ck, i) => (
                  <div
                    key={i}
                    onDoubleClick={() => setPage(ck.pageNum)}
                    className={`text-[11px] px-2 py-1.5 rounded border cursor-pointer ${
                      ck.pageNum === pageNumber ? "border-amber-400/30 bg-amber-500/5" : "border-[var(--border)]/50"
                    }`}
                    title="Double-click to navigate"
                  >
                    <span className="font-medium text-[var(--fg)]">keynote-table</span>
                    <span className="text-[var(--muted)]"> — {pageNames[ck.pageNum] || `p.${ck.pageNum}`}</span>
                    <span className="text-[var(--muted)]"> ({Math.round(ck.table.confidence * 100)}%)</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════ TAB: Manual Parse ════════ */}
        {keynoteParseTab === "manual" && (
          <div className="space-y-2">
            {/* Step 1: Draw region */}
            <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">Step 1: Keynote Region</div>
            {!keynoteParseRegion ? (
              <button
                onClick={() => {
                const next = keynoteParseStep === "select-region" ? "idle" : "select-region";
                setKeynoteParseStep(next);
                if (next !== "idle") useViewerStore.getState().setMode("pointer");
              }}
                className={`w-full text-xs px-3 py-1.5 rounded border ${
                  keynoteParseStep === "select-region"
                    ? "border-amber-500 bg-amber-500/10 text-amber-300"
                    : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                {keynoteParseStep === "select-region" ? "Drawing..." : "Draw Keynote Region"}
              </button>
            ) : (
              <div className="text-[10px] text-green-400 px-1">Region defined</div>
            )}

            {/* Step 2: Draw Column A (tags) */}
            {keynoteParseRegion && (
              <>
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 2: Tag Column (A)</div>
                <button
                  onClick={() => setKeynoteParseStep(keynoteParseStep === "define-column" ? "idle" : "define-column")}
                  className={`w-full text-xs px-3 py-1.5 rounded border ${
                    keynoteParseStep === "define-column"
                      ? "border-amber-500 bg-amber-500/10 text-amber-300"
                      : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {keynoteParseStep === "define-column"
                    ? "Stop Drawing Columns"
                    : `Draw Columns (${keynoteColumnBBs.length} defined)`}
                </button>

                {/* YOLO class picker — appears after Column A is drawn */}
                {keynoteColumnBBs.length >= 1 && yoloInTagColumn.length > 0 && (
                  <div className="space-y-1 px-1">
                    <div className="text-[10px] text-[var(--muted)]">YOLO shapes in tag column:</div>
                    {yoloInTagColumn.map((g, i) => (
                      <button
                        key={i}
                        onClick={() => setKeynoteYoloClass({ model: g.model, className: g.className })}
                        className={`w-full text-left text-[10px] px-2 py-1 rounded border ${
                          keynoteYoloClass?.model === g.model && keynoteYoloClass?.className === g.className
                            ? "border-amber-400 bg-amber-500/10 text-amber-300"
                            : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                        }`}
                      >
                        <span className="font-medium">{g.className}</span>
                        <span className="text-[var(--muted)]"> ({g.model}) — {g.count} found</span>
                      </button>
                    ))}
                  </div>
                )}

                {keynoteColumnBBs.length >= 1 && yoloInTagColumn.length === 0 && (
                  <div className="text-[9px] text-[var(--muted)]/50 px-1 italic">
                    No YOLO shapes found in tag column. Draw Column B to continue.
                  </div>
                )}
              </>
            )}

            {/* Step 3: Draw rows */}
            {keynoteColumnBBs.length >= 2 && (
              <>
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 3: Draw Rows</div>
                <button
                  onClick={() => setKeynoteParseStep(keynoteParseStep === "define-row" ? "idle" : "define-row")}
                  className={`w-full text-xs px-3 py-1.5 rounded border ${
                    keynoteParseStep === "define-row"
                      ? "border-purple-500 bg-purple-500/10 text-purple-300"
                      : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {keynoteParseStep === "define-row" ? "Stop Drawing Rows" : `Draw Rows (${keynoteRowBBs.length} defined)`}
                </button>

                {keynoteRowBBs.length > 0 && (
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-[var(--muted)]">{keynoteRowBBs.length} rows</span>
                    <button
                      onClick={() => repeatRowDown(keynoteRowBBs[keynoteRowBBs.length - 1])}
                      className="text-[9px] text-purple-300 hover:text-purple-200"
                    >Repeat Down</button>
                  </div>
                )}
              </>
            )}

            {/* Step 4: Parse */}
            {keynoteColumnBBs.length >= 2 && keynoteRowBBs.length > 0 && (
              <>
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 4: Parse</div>
                <button
                  onClick={parseKeynotes}
                  className="w-full text-xs px-3 py-2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 font-medium"
                >
                  Parse Keynotes ({keynoteRowBBs.length} entries)
                </button>
              </>
            )}

            {keynoteParseStep === "review" && (
              <div className="text-[10px] text-green-400 px-1 py-1 border border-green-500/20 rounded bg-green-500/5">
                Keynotes parsed — see All Keynotes tab.
              </div>
            )}

            <button
              onClick={resetKeynoteParse}
              className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] mt-2"
            >
              Reset All
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible keynote item in All Keynotes list */
function KeynoteItem({
  keynote,
  pageNames,
  isCurrentPage,
  onNavigate,
  activeHighlight,
  onHighlight,
}: {
  keynote: { pageNumber: number; keys: { key: string; description: string }[]; yoloClass?: string; tableName?: string };
  pageNames: Record<number, string>;
  isCurrentPage: boolean;
  onNavigate: () => void;
  activeHighlight: { pageNumber: number; key: string } | null;
  onHighlight: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded border ${isCurrentPage ? "border-amber-400/30 bg-amber-500/5" : "border-[var(--border)]"}`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        onDoubleClick={onNavigate}
        className="w-full text-left px-2 py-1.5 flex items-center justify-between"
        title="Double-click to navigate to page"
      >
        <div>
          <span className="text-[11px] font-medium text-[var(--fg)]">{keynote.tableName || "Keynotes"}</span>
          <span className="text-[9px] text-[var(--muted)] ml-1">
            {pageNames[keynote.pageNumber] || `p.${keynote.pageNumber}`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-[var(--muted)]">{keynote.keys.length} keys</span>
          <span className="text-[10px] text-[var(--muted)]">{expanded ? "▼" : "▶"}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-0.5">
          {keynote.keys.map((k, i) => (
            <button
              key={i}
              onClick={() => onHighlight(k.key)}
              className={`w-full text-left text-[10px] px-1.5 py-0.5 rounded ${
                activeHighlight?.pageNumber === keynote.pageNumber && activeHighlight?.key === k.key
                  ? "bg-amber-500/15 text-amber-300"
                  : "hover:bg-[var(--surface-hover)] text-[var(--muted)]"
              }`}
            >
              <span className="font-mono font-medium text-[var(--fg)]">{k.key || "?"}</span>
              <span className="text-[var(--muted)]"> — {k.description || "(no description)"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
