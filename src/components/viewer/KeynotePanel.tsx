"use client";

import { useMemo, useState, useCallback } from "react";
import { useViewerStore, useSummaries, useProject } from "@/stores/viewerStore";
import HelpTooltip from "./HelpTooltip";
import KeynoteItem from "./KeynoteItem";
import CompareEditTab from "./CompareEditTab";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import ExportCsvModal from "./ExportCsvModal";
import type { YoloTag, QtoItemType } from "@/types";
import type { ScoredMatch } from "@/lib/tag-mapping";
// CSI detection runs server-side (csi-detect.ts uses fs); client components can't import it directly

/** Convert keynote parsedRegion data to grid format for TableCompareModal */
function keynoteDataToGrid(data: any): { headers: string[]; rows: Record<string, string>[]; tagColumn: string; tableName?: string } {
  if (data.headers && data.rows) return { headers: data.headers, rows: data.rows, tagColumn: data.tagColumn || data.headers[0], tableName: data.tableName };
  // Shape A: { keynotes: [{key, description}] } → grid
  const headers = ["Key", "Description"];
  const rows = (data.keynotes || []).map((k: any) => ({ Key: k.key || "", Description: k.description || "" }));
  return { headers, rows, tagColumn: "Key", tableName: data.tableName };
}

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
  const addYoloTagsBulk = useViewerStore((s) => s.addYoloTagsBulk);
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);
  const toggleTableCompareModal = useViewerStore((s) => s.toggleTableCompareModal);
  const showParsedRegions = useViewerStore((s) => s.showParsedRegions);
  const setTableParsedGrid = useViewerStore((s) => s.setTableParsedGrid);
  const setTableParseRegion = useViewerStore((s) => s.setTableParseRegion);
  const { publicId } = useProject();

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
  const [showExportModal, setShowExportModal] = useState(false);

  const { summaries } = useSummaries();

  // ─── Classified keynote regions (informational) ─────────
  const classifiedKeynotes = useMemo(() => {
    // Use summary catalog when available (works across all pages)
    if (summaries?.keynoteTablePages) {
      return summaries.keynoteTablePages.map((kp) => ({
        pageNum: kp.pageNum,
        table: { confidence: kp.confidence, category: "keynote-table" },
      }));
    }
    // Fallback: iterate loaded pageIntelligence
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
  }, [summaries, pageIntelligence]);

  // ─── Project-wide parsed keynotes (for All Keynotes + Compare tab) ───
  const allParsedKeynotes = useMemo(() => {
    const tables: { pageNum: number; region: any; name: string; category: string; rowCount: number; colCount: number; csiTags: any[] }[] = [];
    for (const [pn, intelEntry] of Object.entries(pageIntelligence)) {
      const pi = intelEntry as any;
      if (pi?.parsedRegions) {
        for (const pr of pi.parsedRegions) {
          if (pr.type === "keynote") {
            const grid = keynoteDataToGrid(pr.data || {});
            tables.push({
              pageNum: Number(pn),
              region: pr,
              name: pr.data?.tableName || pr.category || "Keynotes",
              category: pr.category || "keynote-table",
              rowCount: grid.rows.length,
              colCount: grid.headers.length,
              csiTags: pr.csiTags || [],
            });
          }
        }
      }
    }
    return tables.sort((a, b) => {
      if (a.pageNum === pageNumber && b.pageNum !== pageNumber) return -1;
      if (b.pageNum === pageNumber && a.pageNum !== pageNumber) return 1;
      return a.pageNum - b.pageNum;
    });
  }, [pageIntelligence, pageNumber]);

  // ─── Load existing keynote into Compare modal ───────────
  const loadExistingKeynote = useCallback((parsed: any) => {
    const grid = keynoteDataToGrid(parsed.data || {});
    setTableParseRegion(parsed.bbox ? [parsed.bbox[0], parsed.bbox[1], parsed.bbox[2], parsed.bbox[3]] : null);
    setTableParsedGrid({
      headers: grid.headers,
      rows: grid.rows,
      tagColumn: grid.tagColumn,
      tableName: grid.tableName,
    });
    useViewerStore.getState().setTableParseStep("review");
    useViewerStore.getState().setMode("move");
  }, [setTableParseRegion, setTableParsedGrid]);

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

  // ─── Map keynote keys → YoloTag[] via the server route ─────
  // Phase 4: replaces the legacy client-side mapYoloToOcrText loop with a
  // single fetch to /api/map-tags-batch per parse. Preserves scope:"page"
  // semantics by passing `selectedPages: [pageNumber]`. Results come back
  // as ScoredMatch[] which is a structural superset of YoloTagInstance.
  const mapKeynoteKeysToYoloTags = useCallback(async (params: {
    keys: { key: string; description: string }[];
    yoloClass?: string;
    yoloModel?: string;
    pageNumber: number;
  }) => {
    const { keys, yoloClass, yoloModel, pageNumber } = params;
    if (!publicId) return;
    const uniqueKeys = [...new Set(
      keys.map((k) => k.key?.trim()).filter((k): k is string => Boolean(k)),
    )];
    if (uniqueKeys.length === 0) return;
    const descByKey = new Map<string, string>();
    for (const k of keys) {
      if (k.key?.trim()) descByKey.set(k.key.trim(), k.description);
    }
    const itemType: QtoItemType = yoloClass ? "yolo-with-inner-text" : "text-only";
    try {
      const res = await fetch(`/api/projects/${publicId}/map-tags-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: uniqueKeys,
          yoloClass: yoloClass || undefined,
          yoloModel: yoloModel || undefined,
          itemType,
          selectedPages: [pageNumber],
        }),
      });
      if (!res.ok) {
        console.error(`[KeynotePanel] Map Tags failed: HTTP ${res.status}`);
        return;
      }
      const { results } = (await res.json()) as {
        results: Record<string, ScoredMatch[]>;
      };
      const newTags: YoloTag[] = uniqueKeys
        .filter((k) => results[k]?.length > 0)
        .map((k) => ({
          id: `keynote-${pageNumber}-${k}-${Date.now()}`,
          name: k,
          tagText: k,
          yoloClass: yoloClass || "",
          yoloModel: yoloModel || "",
          source: "keynote",
          scope: "page",
          pageNumber,
          description: descByKey.get(k) || "",
          instances: results[k],
        }));
      if (newTags.length > 0) addYoloTagsBulk(newTags);
    } catch (e) {
      console.error("[KeynotePanel] Map Tags error", e);
    }
  }, [publicId, addYoloTagsBulk]);

  // ─── Parse keynotes from column/row intersections ───────
  const parseKeynotes = useCallback(async () => {
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
      await mapKeynoteKeysToYoloTags({
        keys,
        yoloClass: keynoteYoloClass?.className,
        yoloModel: keynoteYoloClass?.model,
        pageNumber,
      });
      setKeynoteParseStep("review");
      useViewerStore.getState().setMode("move");
    }
  }, [textractData, pageNumber, keynoteColumnBBs, keynoteRowBBs, keynoteYoloClass, addParsedKeynote, mapKeynoteKeysToYoloTags, setKeynoteParseStep]);

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
          // Auto-parse doesn't pick a YOLO class, so we map as text-only.
          await mapKeynoteKeysToYoloTags({ keys, pageNumber });
          setKeynoteParseStep("review");
          useViewerStore.getState().setMode("move");
        }
      }
    } catch (err) {
      console.error("[keynote auto-parse] Failed:", err);
    } finally {
      setAutoParsing(false);
    }
  }, [projectId, pageNumber, addParsedKeynote, mapKeynoteKeysToYoloTags, setKeynoteParseStep]);

  // ─── Guided parse: propose grid ─────────────────────────
  const [guidedLoading, setGuidedLoading] = useState(false);
  const [guidedError, setGuidedError] = useState<string | null>(null);
  const [showGuidedTune, setShowGuidedTune] = useState(false);
  const [guidedRowTol, setGuidedRowTol] = useState(0.006);
  const [guidedColGap, setGuidedColGap] = useState(0.015);
  const [guidedColConf, setGuidedColConf] = useState(0.3);
  const [guidedExpCols, setGuidedExpCols] = useState<number | null>(2); // keynotes default 2

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
          layoutHint: guidedExpCols ? { columns: guidedExpCols } : undefined,
          gridOptions: {
            rowTolerance: guidedRowTol,
            minColGap: guidedColGap,
            minHitsRatio: guidedColConf,
          },
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
      await mapKeynoteKeysToYoloTags({ keys, pageNumber });
    }

    // Refresh spatial map
    refreshPageCsiSpatialMap(pageNumber);

    // Persist to DB (fire-and-forget) — skip for demo mode
    if (projectId && !store.isDemo) {
      const updatedIntel = store.pageIntelligence[pageNumber];
      fetch("/api/pages/intelligence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber, intelligence: updatedIntel }),
      }).then((r) => {
        if (!r.ok) r.json().then((d) => console.error("[save-keynote-intel] Failed:", r.status, d)).catch(() => {});
      }).catch((e) => console.error("[save-keynote-intel] Network error:", e));
    }

    // Reset guided state
    resetGuidedParse();
    setKeynoteParseStep("review");
    useViewerStore.getState().setMode("move");
  }, [pageNumber, projectId, guidedParseRows, guidedParseCols, guidedParseRegion, resetGuidedParse, addParsedKeynote, mapKeynoteKeysToYoloTags, setKeynoteParseStep]);

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
    <div className="w-80 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Keynotes</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => useViewerStore.getState().toggleParsedRegions()}
            className={`text-sm px-1 ${showParsedRegions ? "text-amber-300" : "text-[var(--muted)]/30"}`}
            title="Toggle region outlines on canvas"
          >
            {showParsedRegions ? "\u25CF" : "\u25CB"}
          </button>
          <button onClick={toggleKeynoteParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "auto", "guided", "manual", "compare"] as const).map((tab) => (
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
            className={`flex-1 px-1.5 py-1.5 text-[9px] font-medium ${
              keynoteParseTab === tab
                ? "text-amber-300 border-b-2 border-amber-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "all" ? "All Keynotes" : tab === "auto" ? "Auto Parse" : tab === "guided" ? "Guided" : tab === "manual" ? "Manual" : "Compare/Edit"}
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
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="text-[10px] text-[var(--muted)]">{parsedKeynoteData.length} keynote table(s)</span>
                  <button
                    onClick={() => setShowExportModal(true)}
                    className="text-[10px] px-2 py-0.5 rounded border border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/10"
                  >
                    Export CSV
                  </button>
                </div>
                {showExportModal && (
                  <ExportCsvModal
                    tables={parsedKeynoteData.map((kn) => ({
                      name: kn.tableName || "Keynotes",
                      headers: ["Key", "Description"],
                      rows: kn.keys.map((k) => ({ Key: k.key, Description: k.description })),
                      pageNumber: kn.pageNumber,
                    }))}
                    onClose={() => setShowExportModal(false)}
                    filenamePrefix="keynotes"
                  />
                )}
                {/* Sort current page first */}
                {[...parsedKeynoteData]
                  .sort((a, b) => (a.pageNumber === pageNumber ? -1 : b.pageNumber === pageNumber ? 1 : a.pageNumber - b.pageNumber))
                  .map((kn, i) => {
                    // Find matching parsedRegion for this keynote
                    const matchingRegion = allParsedKeynotes.find(
                      (pk) => pk.pageNum === kn.pageNumber && (pk.name === kn.tableName || pk.name === "Keynotes")
                    )?.region || null;
                    return (
                      <KeynoteItem
                        key={`${kn.pageNumber}-${kn.tableName || i}`}
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
                        onDelete={() => {
                          const store = useViewerStore.getState();
                          const all = store.parsedKeynoteData;
                          if (all) {
                            store.setParsedKeynoteData(all.filter((entry) =>
                              !(entry.pageNumber === kn.pageNumber && entry.tableName === kn.tableName)
                            ) as any);
                          }
                        }}
                        region={matchingRegion}
                        publicId={publicId}
                      />
                    );
                  })}
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

                {/* Tune Detection */}
                <button
                  onClick={() => setShowGuidedTune(!showGuidedTune)}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] px-1 flex items-center gap-1"
                >
                  <span className={`transition-transform ${showGuidedTune ? "rotate-90" : ""}`}>&#9656;</span>
                  Tune Detection
                </button>
                {showGuidedTune && (
                  <div className="space-y-2 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface)]">
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-[var(--muted)]">Row Sensitivity</label>
                        <span className="text-[9px] text-[var(--fg)] tabular-nums">{guidedRowTol.toFixed(3)}</span>
                      </div>
                      <input type="range" min={0.002} max={0.02} step={0.001} value={guidedRowTol}
                        onChange={(e) => { setGuidedRowTol(parseFloat(e.target.value)); proposeGrid(); }}
                        className="w-full h-1 accent-amber-400" />
                      <div className="flex justify-between text-[8px] text-[var(--muted)]"><span>Tight</span><span>Loose</span></div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-[var(--muted)]">Column Sensitivity</label>
                        <span className="text-[9px] text-[var(--fg)] tabular-nums">{guidedColGap.toFixed(3)}</span>
                      </div>
                      <input type="range" min={0.005} max={0.05} step={0.005} value={guidedColGap}
                        onChange={(e) => { setGuidedColGap(parseFloat(e.target.value)); proposeGrid(); }}
                        className="w-full h-1 accent-amber-400" />
                      <div className="flex justify-between text-[8px] text-[var(--muted)]"><span>More cols</span><span>Fewer cols</span></div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-[var(--muted)]">Column Confidence</label>
                        <span className="text-[9px] text-[var(--fg)] tabular-nums">{(guidedColConf * 100).toFixed(0)}%</span>
                      </div>
                      <input type="range" min={0.1} max={0.8} step={0.05} value={guidedColConf}
                        onChange={(e) => { setGuidedColConf(parseFloat(e.target.value)); proposeGrid(); }}
                        className="w-full h-1 accent-amber-400" />
                      <div className="flex justify-between text-[8px] text-[var(--muted)]"><span>Keep weak</span><span>Strict</span></div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-[var(--muted)]">Expected Columns</label>
                        <select value={guidedExpCols ?? "auto"}
                          onChange={(e) => { setGuidedExpCols(e.target.value === "auto" ? null : parseInt(e.target.value)); proposeGrid(); }}
                          className="text-[9px] px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]">
                          <option value="auto">Auto</option>
                          {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                )}

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

        {/* ════════ TAB: Auto Parse ════════ */}
        {keynoteParseTab === "auto" && (
          <div className="space-y-2">
            {keynoteParseStep === "review" ? (
              <div className="space-y-1.5">
                <div className="text-[11px] text-green-400 px-2 py-2 border border-green-500/20 rounded bg-green-500/5">
                  Keynotes parsed — see All Keynotes tab.
                </div>
                <button
                  onClick={() => {
                    setKeynoteParseRegion(null);
                    resetKeynoteParse();
                  }}
                  className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Parse Another
                </button>
              </div>
            ) : keynoteParseRegion ? (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--muted)] px-1">
                  <span className="text-amber-300">Region selected.</span> Click "Auto Parse" to detect rows and columns automatically.
                </div>
                <button
                  onClick={() => autoParseKeynote(keynoteParseRegion as [number, number, number, number])}
                  disabled={autoParsing}
                  className="w-full text-xs px-3 py-2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 font-medium disabled:opacity-50"
                >
                  {autoParsing ? "Parsing..." : "Auto Parse Keynotes"}
                </button>
                <button
                  onClick={() => { setKeynoteParseRegion(null); resetKeynoteParse(); }}
                  className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Clear Region
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--muted)] px-1">
                  Draw a bounding box around the keynote table, then click "Auto Parse".
                  <br /><span className="text-[9px]">Exclude any title text above the table.</span>
                </div>
                <button
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
                </button>
              </div>
            )}
            {autoParsing && (
              <div className="text-[11px] text-amber-300 text-center py-2 animate-pulse">Auto-parsing keynotes...</div>
            )}
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

        {/* ════════ TAB: Compare/Edit Cells ════════ */}
        {keynoteParseTab === "compare" && (
          <CompareEditTab
            allParsedTables={allParsedKeynotes}
            loadExistingParsed={loadExistingKeynote}
            toggleTableCompareModal={toggleTableCompareModal}
          />
        )}
      </div>
    </div>
  );
}
