"use client";

import { useMemo, useState, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import HelpTooltip from "./HelpTooltip";
import { mapYoloToOcrText } from "@/lib/yolo-tag-engine";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
// CSI detection runs server-side (csi-detect.ts uses fs); client components can't import it directly

/**
 * KeynotePanel — Keynote parsing and management tool.
 *
 * 3 tabs: All Keynotes, Guided Parse, Manual Parse
 * Keynotes are 2-column key:value tables (tag + description)
 * with YOLO shape assignment for tag-to-drawing mapping.
 *
 * Guided Parse: user draws region BB, system proposes a grid (rows+cols),
 * user adjusts lines on canvas, then parses via extractCellsFromGrid.
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
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);

  // Guided parse state
  const guidedParseActive = useViewerStore((s) => s.guidedParseActive);
  const guidedParseRegion = useViewerStore((s) => s.guidedParseRegion);
  const guidedParseRows = useViewerStore((s) => s.guidedParseRows);
  const guidedParseCols = useViewerStore((s) => s.guidedParseCols);
  const setGuidedParseActive = useViewerStore((s) => s.setGuidedParseActive);
  const setGuidedParseRegion = useViewerStore((s) => s.setGuidedParseRegion);
  const setGuidedParseRows = useViewerStore((s) => s.setGuidedParseRows);
  const setGuidedParseCols = useViewerStore((s) => s.setGuidedParseCols);
  const resetGuidedParse = useViewerStore((s) => s.resetGuidedParse);

  // Save parsed keynotes to pageIntelligence so All Keynotes tab persists across panel close
  const saveKeynoteToIntelligence = useCallback((keys: { key: string; description: string }[], tableName?: string, csiTags?: { code: string; description: string }[]) => {
    const currentIntel = useViewerStore.getState().pageIntelligence[pageNumber] || {};
    const existingRegions = (currentIntel as any)?.parsedRegions || [];
    const newRegion = {
      id: `parsed-kn-${Date.now()}`,
      type: "keynote" as const,
      category: "keynote-table",
      bbox: keynoteParseRegion || [0, 0, 1, 1],
      confidence: 0.9,
      csiTags: csiTags || [],
      data: {
        keynotes: keys.map(k => ({ key: k.key, description: k.description })),
        isPageSpecific: true,
      },
    };
    setPageIntelligence(pageNumber, {
      ...currentIntel,
      parsedRegions: [...existingRegions, newRegion],
    });
  }, [pageNumber, keynoteParseRegion, setPageIntelligence]);

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
      saveKeynoteToIntelligence(keys, `Keynotes p.${pageNumber}`);
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
      useViewerStore.getState().setMode("move");
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
          saveKeynoteToIntelligence(keys, `Keynotes p.${pageNumber}`, result.csiTags || []);
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
      useViewerStore.getState().setMode("move");
        }
      }
    } catch (err) {
      console.error("[keynote auto-parse] Failed:", err);
    } finally {
      setAutoParsing(false);
    }
  }, [projectId, pageNumber, addParsedKeynote, addYoloTag, setKeynoteParseStep]);

  // ─── Guided parse: propose grid ─────────────────────────
  const [guidedLoading, setGuidedLoading] = useState(false);
  const [guidedError, setGuidedError] = useState<string | null>(null);

  const proposeGrid = useCallback(async () => {
    const region = useViewerStore.getState().keynoteParseRegion;
    if (!region || !projectId) return;
    setGuidedParseRegion(region); // store for overlay
    setGuidedLoading(true);
    setGuidedError(null);
    try {
      const resp = await fetch("/api/table-parse/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          regionBbox: region,
          layoutHint: { columns: 2 },
        }),
      });
      if (!resp.ok) throw new Error("Proposal failed");
      const data = await resp.json();
      setGuidedParseRows(data.proposedRows || []);
      setGuidedParseCols(data.proposedCols || []);
      setGuidedParseActive(true);
    } catch (err: any) {
      setGuidedError(err.message || "Failed to propose grid");
    } finally {
      setGuidedLoading(false);
    }
  }, [projectId, pageNumber, setGuidedParseRegion, setGuidedParseRows, setGuidedParseCols, setGuidedParseActive]);

  // ─── Guided parse: parse from grid ─────────────────────
  const parseFromGuidedGrid = useCallback(async () => {
    const pageTextract = useViewerStore.getState().textractData[pageNumber];
    if (!pageTextract?.words || guidedParseRows.length < 2 || guidedParseCols.length < 2) return;

    const result = extractCellsFromGrid(pageTextract.words, guidedParseRows, guidedParseCols);
    if (result.rows.length === 0) return;

    // Detect CSI
    let csiTags: { code: string; description: string }[] = [];
    try {
      const csiResp = await fetch("/api/csi/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers: result.headers, rows: result.rows }),
      });
      if (csiResp.ok) {
        const csiData = await csiResp.json();
        csiTags = csiData.csiTags || [];
      }
    } catch { /* best-effort */ }

    // Save as parsed keynote
    const store = useViewerStore.getState();
    const currentIntel = store.pageIntelligence[pageNumber] || {};
    const existingRegions = (currentIntel as any)?.parsedRegions || [];
    const newRegion = {
      id: `parsed-${Date.now()}`,
      type: "keynote" as const,
      category: "keynote-table",
      bbox: guidedParseRegion || [0, 0, 1, 1],
      confidence: 0.85,
      csiTags,
      data: {
        headers: result.headers,
        rows: result.rows,
        tagColumn: result.headers[0],
        tableName: "Keynotes",
        rowCount: result.rows.length,
        columnCount: result.headers.length,
      },
    };
    store.setPageIntelligence(pageNumber, {
      ...currentIntel,
      parsedRegions: [...existingRegions, newRegion],
    });

    // Also save as parsedKeynoteData for All Keynotes tab
    const tagHeader = result.headers[0];
    const descHeaders = result.headers.slice(1);
    const keys = result.rows.map((row: any) => ({
      key: (row[tagHeader] || "").trim(),
      description: descHeaders.map((h: string) => row[h] || "").join(" ").trim(),
    })).filter((k: any) => k.key || k.description);
    if (keys.length > 0) {
      addParsedKeynote({ pageNumber, keys, tableName: `Keynotes p.${pageNumber}` });
      // Create YoloTags for guided-parsed keynotes
      const allAnns = store.annotations;
      const td = store.textractData;
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
    }

    // Refresh spatial map
    refreshPageCsiSpatialMap(pageNumber);

    // Persist to DB (fire-and-forget)
    if (projectId) {
      const updatedIntel = store.pageIntelligence[pageNumber];
      fetch("/api/pages/intelligence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber, intelligence: updatedIntel }),
      }).catch(() => {});
    }

    // Reset guided state
    resetGuidedParse();
    setKeynoteParseStep("review");
    useViewerStore.getState().setMode("move");
  }, [pageNumber, projectId, guidedParseRows, guidedParseCols, guidedParseRegion, resetGuidedParse, addParsedKeynote, addYoloTag, setKeynoteParseStep]);

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

  // ─── Repeat column right ──────────────────────────────
  const repeatColumnRight = useCallback((colBB: [number, number, number, number]) => {
    if (!keynoteParseRegion) return;
    const colW = colBB[2] - colBB[0];
    const right = keynoteParseRegion[2];
    let x = colBB[2];
    while (x + colW * 0.5 < right) {
      addKeynoteColumnBB([x, colBB[1], Math.min(x + colW, right), colBB[3]]);
      x += colW;
    }
  }, [keynoteParseRegion, addKeynoteColumnBB]);

  // ─── Render ─────────────────────────────────────────────
  return (
    <div className="w-80 flex flex-col h-full border-l border-[var(--border)] bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Keynotes</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => useViewerStore.getState().toggleParsedRegions()}
            className={`text-sm px-1 ${useViewerStore.getState().showParsedRegions ? "text-amber-300" : "text-[var(--muted)]/30"}`}
            title="Toggle region outlines on canvas"
          >
            {useViewerStore.getState().showParsedRegions ? "\u25CF" : "\u25CB"}
          </button>
          <button onClick={toggleKeynoteParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "guided", "manual"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              if (tab !== keynoteParseTab) {
                resetKeynoteParse();
                setKeynoteParseRegion(null);
                resetGuidedParse();
                useViewerStore.getState().setMode("move");
              }
              setKeynoteParseTab(tab);
            }}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium ${
              keynoteParseTab === tab
                ? "text-amber-300 border-b-2 border-amber-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "all" ? "All Keynotes" : tab === "guided" ? "Guided Parse" : "Manual Parse"}
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
                <br /><span className="text-[9px]">Use Guided Parse or Manual Parse tabs.</span>
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
                      keynoteIndex={i}
                      pageNames={pageNames}
                      isCurrentPage={kn.pageNumber === pageNumber}
                      onNavigate={() => setPage(kn.pageNumber)}
                      activeHighlight={activeKeynoteHighlight}
                      onHighlight={(key) => setActiveKeynoteHighlight(
                        activeKeynoteHighlight?.key === key && activeKeynoteHighlight?.pageNumber === kn.pageNumber
                          ? null
                          : { pageNumber: kn.pageNumber, key }
                      )}
                      onDelete={() => {
                        const store = useViewerStore.getState();
                        const all = store.parsedKeynoteData;
                        if (all) {
                          store.setParsedKeynoteData(all.filter((_, idx) => idx !== i) as any);
                        }
                      }}
                    />
                  ))}
              </>
            )}
          </div>
        )}

        {/* ════════ TAB: Guided Parse ════════ */}
        {keynoteParseTab === "guided" && (
          <div className="space-y-2">
            {/* State: review complete */}
            {keynoteParseStep === "review" && (
              <div className="space-y-1.5">
                <div className="text-[11px] text-green-400 px-2 py-2 border border-green-500/20 rounded bg-green-500/5">
                  Keynotes parsed — see All Keynotes tab.
                </div>
                <button
                  onClick={() => {
                    setKeynoteParseRegion(null);
                    resetKeynoteParse();
                    resetGuidedParse();
                  }}
                  className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Parse Another
                </button>
              </div>
            )}

            {/* State: grid proposed — adjust and parse */}
            {keynoteParseStep !== "review" && guidedParseActive && guidedParseRows.length >= 2 && guidedParseCols.length >= 2 && (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--muted)] px-1">
                  <span className="text-amber-300">Adjust row/column lines on the canvas, then click Parse.</span>
                </div>
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px] text-[var(--muted)]">
                    {guidedParseRows.length - 1} rows, {guidedParseCols.length - 1} columns
                  </span>
                </div>
                <button
                  onClick={parseFromGuidedGrid}
                  className="w-full text-xs px-3 py-2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 font-medium"
                >
                  Parse Keynotes
                </button>
                <button
                  onClick={() => {
                    resetGuidedParse();
                    setKeynoteParseRegion(null);
                    setKeynoteParseStep("idle");
                    useViewerStore.getState().setMode("move");
                  }}
                  className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Reset
                </button>
              </div>
            )}

            {/* State: region drawn but no grid proposed yet */}
            {keynoteParseStep !== "review" && !guidedParseActive && keynoteParseRegion && (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--muted)] px-1">
                  <span className="text-amber-300">Region selected. Click "Propose Grid" to auto-detect rows and columns.</span>
                </div>
                <button
                  onClick={proposeGrid}
                  disabled={guidedLoading}
                  className="w-full text-xs px-3 py-2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 font-medium disabled:opacity-50"
                >
                  {guidedLoading ? "Proposing..." : "Propose Grid (2-col Keynote)"}
                </button>
                {guidedError && <p className="text-red-400 text-[10px] px-1">{guidedError}</p>}
                <button
                  onClick={() => {
                    setKeynoteParseRegion(null);
                    setKeynoteParseStep("idle");
                    useViewerStore.getState().setMode("move");
                  }}
                  className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Clear Region
                </button>
              </div>
            )}

            {/* State: no region drawn yet */}
            {keynoteParseStep !== "review" && !guidedParseActive && !keynoteParseRegion && (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--muted)] px-1">
                  Draw a bounding box around the keynote table, then click "Propose Grid".
                  <br /><span className="text-[9px]">Exclude any title text (e.g. "KEYNOTES") that sits above the table.</span>
                </div>
                <HelpTooltip id="keynote-guided-draw"><button
                  onClick={() => {
                    const next = keynoteParseStep === "select-region" ? "idle" : "select-region";
                    setKeynoteParseStep(next);
                    useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
                  }}
                  className={`w-full text-xs px-3 py-2 rounded border ${
                    keynoteParseStep === "select-region"
                      ? "border-amber-500 bg-amber-500/10 text-amber-300"
                      : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {keynoteParseStep === "select-region" ? "Cancel Drawing" : "Draw Keynote Region"}
                </button></HelpTooltip>
              </div>
            )}

            {guidedLoading && (
              <div className="text-[11px] text-amber-300 text-center py-2 animate-pulse">Proposing grid...</div>
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
            <div className="text-[9px] text-[var(--muted)] px-1">Draw around the table grid only. Do NOT include any title text above the table.</div>
            {!keynoteParseRegion ? (
              <button
                onClick={() => {
                  const next = keynoteParseStep === "select-region" ? "idle" : "select-region";
                  setKeynoteParseStep(next);
                  useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
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
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] text-green-400">Region defined</span>
                <button
                  onClick={() => { setKeynoteParseRegion(null); resetKeynoteParse(); }}
                  className="text-[9px] text-[var(--muted)] hover:text-red-400"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Step 2: Draw Columns */}
            {keynoteParseRegion && (
              <>
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 2: Columns</div>
                <div className="text-[9px] text-[var(--muted)] px-1">
                  {keynoteColumnBBs.length === 0
                    ? "Draw the first column around the tag/key column (e.g. 01, 02...)."
                    : keynoteColumnBBs.length === 1
                      ? "Now draw the second column around the description column."
                      : `${keynoteColumnBBs.length} columns defined.`}
                </div>
                <button
                  onClick={() => {
                    const next = keynoteParseStep === "define-column" ? "idle" : "define-column";
                    setKeynoteParseStep(next);
                    useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
                  }}
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

                {keynoteColumnBBs.length > 0 && (
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-[var(--muted)]">{keynoteColumnBBs.length} col{keynoteColumnBBs.length !== 1 ? "s" : ""}</span>
                    <button
                      onClick={() => repeatColumnRight(keynoteColumnBBs[keynoteColumnBBs.length - 1])}
                      className="text-[9px] text-amber-300 hover:text-amber-200"
                    >Repeat Right →</button>
                  </div>
                )}

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
                <div className="text-[9px] text-[var(--muted)] px-1">
                  Draw a BB around each row. Use "Repeat Down" after the first to auto-fill evenly spaced rows.
                </div>
                <button
                  onClick={() => {
                    const next = keynoteParseStep === "define-row" ? "idle" : "define-row";
                    setKeynoteParseStep(next);
                    useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
                  }}
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
  keynoteIndex,
  pageNames,
  isCurrentPage,
  onNavigate,
  activeHighlight,
  onHighlight,
  onDelete,
}: {
  keynote: { pageNumber: number; keys: { key: string; description: string; csiCodes?: string[]; note?: string }[]; yoloClass?: string; tableName?: string };
  keynoteIndex: number;
  pageNames: Record<number, string>;
  isCurrentPage: boolean;
  onNavigate: () => void;
  activeHighlight: { pageNumber: number; key: string } | null;
  onHighlight: (key: string) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editCsi, setEditCsi] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(keynote.tableName || "Keynotes");

  const saveName = () => {
    const trimmed = nameValue.trim();
    if (trimmed) {
      const store = useViewerStore.getState();
      const allKeynotes = store.parsedKeynoteData;
      if (allKeynotes) {
        const updated = [...allKeynotes];
        updated[keynoteIndex] = { ...updated[keynoteIndex], tableName: trimmed };
        store.setParsedKeynoteData(updated as any);
      }
    }
    setEditingName(false);
  };

  // Find matching YoloTags for instance counts
  const yoloTags = useViewerStore((s) => s.yoloTags);
  const tagInstances = (key: string) => {
    const yt = yoloTags.find((t) => t.tagText === key && t.source === "keynote" && t.pageNumber === keynote.pageNumber);
    return yt?.instances?.length || 0;
  };

  const handleKeyClick = (key: string) => {
    const store = useViewerStore.getState();
    const existing = store.yoloTags.find((t) => t.tagText === key && t.source === "keynote" && t.pageNumber === keynote.pageNumber);
    if (existing) {
      if (store.activeYoloTagId === existing.id) {
        store.setActiveYoloTagId(null);
        store.setYoloTagFilter(null);
      } else {
        store.setActiveYoloTagId(existing.id);
        store.setYoloTagFilter(existing.id);
      }
    }
    // Also set keynote highlight for canvas
    onHighlight(key);
  };

  return (
    <div
      className={`rounded border ${isCurrentPage ? "border-amber-400/30 bg-amber-500/5" : "border-[var(--border)]"}`}
    >
      {/* Parent header */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-[var(--muted)] shrink-0">
          {expanded ? "▼" : "▶"}
        </button>
        <div className="flex-1 min-w-0" onDoubleClick={onNavigate}>
          {editingName ? (
            <input
              autoFocus
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
              className="text-[11px] font-medium bg-transparent border-b border-amber-400 outline-none w-full text-[var(--fg)]"
            />
          ) : (
            <span
              onClick={() => setEditingName(true)}
              className="text-[11px] font-medium text-[var(--fg)] truncate block cursor-pointer hover:text-amber-300"
              title="Click to rename, double-click to navigate"
            >
              {keynote.tableName || "Keynotes"}
            </span>
          )}
          <span className="text-[9px] text-[var(--muted)]">
            {pageNames[keynote.pageNumber] || `p.${keynote.pageNumber}`} · {keynote.keys.length} keys
          </span>
        </div>
        <button onClick={onDelete} className="text-[10px] text-[var(--muted)] hover:text-red-400 shrink-0" title="Delete keynote table">x</button>
      </div>

      {expanded && (
        <div className="px-2 pb-2 space-y-0.5">
          {keynote.keys.map((k, i) => (
            <div key={i}>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleKeyClick(k.key)}
                  className={`flex-1 text-left text-[10px] px-1.5 py-0.5 rounded ${
                    activeHighlight?.pageNumber === keynote.pageNumber && activeHighlight?.key === k.key
                      ? "bg-amber-500/15 text-amber-300"
                      : "hover:bg-[var(--surface-hover)] text-[var(--muted)]"
                  }`}
                >
                  <span className="font-mono font-medium text-[var(--fg)]">{k.key || "?"}</span>
                  <span className="text-[var(--muted)]"> — {k.description || "(no description)"}</span>
                  {k.csiCodes && k.csiCodes.length > 0 && (
                    <span className="text-orange-400/60 ml-1 text-[9px]">[{k.csiCodes.join(", ")}]</span>
                  )}
                  {tagInstances(k.key) > 0 && (
                    <span className="text-cyan-400/70 text-[9px] ml-1">({tagInstances(k.key)})</span>
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (editingIdx === i) { setEditingIdx(null); }
                    else { setEditingIdx(i); setEditNote(k.note || ""); setEditCsi(k.csiCodes?.join(", ") || ""); }
                  }}
                  className="text-[10px] text-[var(--muted)] hover:text-amber-300 shrink-0 px-0.5"
                  title="Edit metadata"
                >
                  {editingIdx === i ? "x" : "✏"}
                </button>
              </div>
              {editingIdx === i && (
                <div className="ml-2 mt-1 mb-1 space-y-1 p-1.5 rounded bg-[var(--surface)] border border-[var(--border)]">
                  <div>
                    <label className="text-[9px] text-[var(--muted)] block">CSI Codes</label>
                    <input
                      type="text"
                      value={editCsi}
                      onChange={(e) => setEditCsi(e.target.value)}
                      placeholder="e.g. 08 21 16, 09 91 00"
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-amber-400/50"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-[var(--muted)] block">Notes</label>
                    <textarea
                      value={editNote}
                      onChange={(e) => setEditNote(e.target.value)}
                      placeholder="Add notes..."
                      rows={2}
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-amber-400/50 resize-none"
                    />
                  </div>
                  <button
                    onClick={() => {
                      // Update the keynote key's metadata in the store
                      const store = useViewerStore.getState();
                      const allKeynotes = store.parsedKeynoteData;
                      if (allKeynotes) {
                        const updated = allKeynotes.map((kn) => {
                          if (kn.pageNumber !== keynote.pageNumber || kn.tableName !== keynote.tableName) return kn;
                          return {
                            ...kn,
                            keys: kn.keys.map((key, ki) => {
                              if (ki !== i) return key;
                              return {
                                ...key,
                                csiCodes: editCsi.split(",").map(c => c.trim()).filter(Boolean),
                                note: editNote,
                              };
                            }),
                          };
                        });
                        store.setParsedKeynoteData(updated as any);
                      }
                      setEditingIdx(null);
                    }}
                    className="text-[9px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30"
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
