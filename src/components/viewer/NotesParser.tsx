"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import { unionBboxes } from "@/lib/specnote-parser";
import type { BboxLTWH, NotesData, PageIntelligence, ParsedRegion } from "@/types";

type NotesSubMode = "auto" | "guided" | "paragraph" | "fast-manual" | "manual";

interface PreviewGrid {
  headers: string[];
  rows: Record<string, string>[];
  rowBoundaries?: number[];
  colBoundaries?: number[];
  csiTags?: { code: string; description: string }[];
}

/**
 * NotesParser — Stage 4 commit tool with 4 sub-modes.
 *
 * Each sub-mode converges on the same "Save Notes" path which POSTs to
 * `/api/regions/promote` with an `overrides: {bbox, data}` payload. The
 * server writes a ParsedRegion{type:"notes"} and merges CSI tags.
 *
 * Sub-modes:
 *   - Auto: POST /api/notes-parse → preview → Save
 *   - Guided: POST /api/notes-parse/propose → user adjusts boundaries on
 *     the GuidedParseOverlay (shared with keynote; PDFPage's
 *     NotesGuidedOverlaySlot renders it) → client-side extractCellsFromGrid
 *   - Fast-manual: PDFPage renders FastManualParseOverlay; user double-
 *     clicks paragraphs to build grid incrementally
 *   - Manual: user draws column + row BBs via AnnotationOverlay's
 *     existing draw-rect gate, extractGridFromBBs builds the grid
 */
export default function NotesParser() {
  const projectId = useViewerStore((s) => s.projectId);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);
  const textractData = useViewerStore((s) => s.textractData[pageNumber]);

  const notesParseRegion = useViewerStore((s) => s.notesParseRegion);
  const setNotesParseRegion = useViewerStore((s) => s.setNotesParseRegion);
  const setNotesParseStep = useViewerStore((s) => s.setNotesParseStep);

  const guidedNotesRows = useViewerStore((s) => s.guidedNotesRows);
  const guidedNotesCols = useViewerStore((s) => s.guidedNotesCols);
  const resetNotesParse = useViewerStore((s) => s.resetNotesParse);

  const setParseDraftRegion = useViewerStore((s) => s.setParseDraftRegion);

  const paragraphBatch = useViewerStore((s) => s.paragraphBatch);
  const setParagraphBatch = useViewerStore((s) => s.setParagraphBatch);
  const removePendingParagraph = useViewerStore((s) => s.removePendingParagraph);
  const upsertPendingParagraph = useViewerStore((s) => s.upsertPendingParagraph);
  const setParagraphOverlayActive = useViewerStore((s) => s.setParagraphOverlayActive);

  const [mode, setMode] = useState<NotesSubMode>("auto");
  const [preview, setPreview] = useState<PreviewGrid | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSavingRef = useRef(false);

  // Derive the draft ParsedRegion via useMemo so its identity is stable while
  // inputs are stable. Without this, every effect fire (and downstream
  // ParseRegionLayer canvas redraw) triggers even when the payload is
  // structurally unchanged across re-renders.
  const draft = useMemo<ParsedRegion | null>(() => {
    if (!preview || !notesParseRegion) return null;
    const [x0, y0, x1, y1] = notesParseRegion;
    return {
      id: "draft-notes",
      type: "notes",
      category: "notes-preview",
      bbox: [x0, y0, x1, y1],
      confidence: 0.85,
      source: "user",
      data: {
        headers: preview.headers,
        rows: preview.rows,
        tagColumn: preview.headers[0],
        tableName: "(preview)",
        rowCount: preview.rows.length,
        columnCount: preview.headers.length,
        rowBoundaries: preview.rowBoundaries,
        colBoundaries: preview.colBoundaries,
      },
    };
  }, [preview, notesParseRegion]);

  useEffect(() => {
    setParseDraftRegion(draft);
  }, [draft, setParseDraftRegion]);

  // Clear draft on unmount
  useEffect(() => {
    return () => setParseDraftRegion(null);
  }, [setParseDraftRegion]);

  // Toggle the shared guidedParseActive flag when entering/leaving Guided mode
  // so PDFPage's KeynoteGuidedOverlaySlot renders the drag-adjust overlay.
  // Only one parser is active at a time so sharing the flag is safe.
  useEffect(() => {
    const store = useViewerStore.getState();
    if (mode === "guided" && notesParseRegion) {
      store.setGuidedParseActive(true);
      if (!store.guidedParseRegion) {
        store.setGuidedParseRegion(notesParseRegion);
      }
    } else {
      store.setGuidedParseActive(false);
    }
    return () => {
      useViewerStore.getState().setGuidedParseActive(false);
    };
  }, [mode, notesParseRegion]);

  // Toggle the Fast-manual overlay slot when entering/leaving that sub-mode.
  useEffect(() => {
    const store = useViewerStore.getState();
    store.setNotesFastManualActive(mode === "fast-manual" && !!notesParseRegion);
    if (mode !== "fast-manual") {
      store.setNotesFastManualGrid(null);
    }
    return () => {
      const s = useViewerStore.getState();
      s.setNotesFastManualActive(false);
      s.setNotesFastManualGrid(null);
    };
  }, [mode, notesParseRegion]);

  // Toggle ParagraphOverlay activation on paragraph sub-mode entry/exit.
  useEffect(() => {
    setParagraphOverlayActive(mode === "paragraph" && !!notesParseRegion);
    return () => setParagraphOverlayActive(false);
  }, [mode, notesParseRegion, setParagraphOverlayActive]);

  // Mirror the Fast-manual overlay's grid into local preview so the standard
  // preview panel + Save path work identically across all four sub-modes.
  const notesFastManualGrid = useViewerStore((s) => s.notesFastManualGrid);
  useEffect(() => {
    if (mode !== "fast-manual") return;
    if (!notesFastManualGrid) {
      setPreview(null);
      return;
    }
    setPreview({
      headers: notesFastManualGrid.headers,
      rows: notesFastManualGrid.rows,
      rowBoundaries: notesFastManualGrid.rowBoundaries,
      colBoundaries: notesFastManualGrid.colBoundaries,
    });
  }, [mode, notesFastManualGrid]);

  const regionReady = !!notesParseRegion;

  const runAuto = async () => {
    if (!projectId || !notesParseRegion) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/notes-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          regionBbox: notesParseRegion,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Parse failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as PreviewGrid & { note?: string };
      if (!payload.headers?.length || !payload.rows?.length) {
        setError(payload.note ?? "No numbered items found in region");
        setPreview(null);
      } else {
        setPreview(payload);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parse failed");
    } finally {
      setLoading(false);
    }
  };

  const runProposeGuided = async () => {
    if (!projectId || !notesParseRegion) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/notes-parse/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          regionBbox: notesParseRegion,
        }),
      });
      if (!res.ok) throw new Error("Propose failed");
      const payload = (await res.json()) as { proposedRows: number[]; proposedCols: number[] };
      // Populate the shared guided slice (keynote uses the same) so
      // GuidedParseOverlay can render via PDFPage's notes slot.
      useViewerStore.getState().setGuidedParseRows(payload.proposedRows);
      useViewerStore.getState().setGuidedParseCols(payload.proposedCols);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Propose failed");
    } finally {
      setLoading(false);
    }
  };

  const buildGridFromGuided = (): PreviewGrid | null => {
    if (!textractData) return null;
    const store = useViewerStore.getState();
    const rows = store.guidedParseRows;
    const cols = store.guidedParseCols;
    if (rows.length < 2 || cols.length < 2) return null;
    const { headers, rows: dataRows } = extractCellsFromGrid(textractData.words, rows, cols);
    return {
      headers,
      rows: dataRows,
      rowBoundaries: rows,
      colBoundaries: cols,
    };
  };

  const buildGridFromManualBBs = (): PreviewGrid | null => {
    if (!textractData || guidedNotesCols.length < 2 || guidedNotesRows.length < 1) return null;
    const columns = guidedNotesCols;
    const rowBbs = guidedNotesRows;
    const headers = columns.map((_, i) => (i === 0 ? "Key" : i === 1 ? "Note" : `Col${i + 1}`));
    const builtRows: Record<string, string>[] = [];
    for (const [, yT, , yB] of rowBbs) {
      const row: Record<string, string> = {};
      for (let c = 0; c < columns.length; c++) {
        const [xL, , xR] = columns[c];
        const cellWords = textractData.words.filter((w) => {
          const [wL, wT, wW, wH] = w.bbox;
          const cx = wL + wW / 2;
          const cy = wT + wH / 2;
          return cx >= xL && cx <= xR && cy >= yT && cy <= yB;
        });
        cellWords.sort((a, b) => a.bbox[0] - b.bbox[0]);
        row[headers[c]] = cellWords.map((w) => w.text).join(" ").trim();
      }
      builtRows.push(row);
    }
    if (builtRows.every((r) => Object.values(r).every((v) => !v))) return null;

    const xs = [...columns.map((c) => c[0]), columns[columns.length - 1][2]];
    const ys = [...rowBbs.map((r) => r[1]), rowBbs[rowBbs.length - 1][3]];
    return {
      headers,
      rows: builtRows,
      colBoundaries: xs,
      rowBoundaries: ys,
    };
  };

  const handleRepeatPlusOne = () => {
    if (paragraphBatch.length === 0) return;
    const last = paragraphBatch[paragraphBatch.length - 1];
    const [x0, y0, x1, y1] = last.bbox;
    const h = y1 - y0;
    upsertPendingParagraph({
      id: `para-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bbox: [x0, y1, x1, y1 + h],
      lines: [],
      rowText: { Key: "", Note: "" },
    });
  };

  const saveFromParagraphBatch = async () => {
    if (!projectId || !notesParseRegion || paragraphBatch.length === 0 || isSavingRef.current) return;
    isSavingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const unionBbox = unionBboxes(paragraphBatch.map((p) => p.bbox));
      const headers = ["Key", "Note"];
      const rows = paragraphBatch.map((p) => ({
        Key: p.rowText.Key ?? "",
        Note: p.rowText.Note ?? p.rowText.Value ?? "",
      }));
      const rowBoundaries = paragraphBatch.map((p) => p.bbox[1]);
      rowBoundaries.push(paragraphBatch[paragraphBatch.length - 1].bbox[3]);
      const data: NotesData = {
        headers,
        rows,
        tagColumn: headers[0],
        tableName: `Notes p.${pageNumber} — ${paragraphBatch.length} paragraph${paragraphBatch.length === 1 ? "" : "s"}`,
        rowCount: rows.length,
        columnCount: headers.length,
        rowBoundaries,
      };
      const res = await fetch("/api/regions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          type: "notes",
          overrides: {
            bbox: unionBbox,
            data,
            category: "notes",
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { updatedIntelligence: PageIntelligence };
      setPageIntelligence(pageNumber, payload.updatedIntelligence);
      refreshPageCsiSpatialMap(pageNumber);
      setParagraphBatch([]);
      resetNotesParse();
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      isSavingRef.current = false;
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (mode === "paragraph") return saveFromParagraphBatch();
    if (!projectId || !notesParseRegion || !preview || isSavingRef.current) return;
    isSavingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const data: NotesData = {
        headers: preview.headers,
        rows: preview.rows,
        tagColumn: preview.headers[0],
        tableName: `Notes p.${pageNumber}`,
        rowCount: preview.rows.length,
        columnCount: preview.headers.length,
        rowBoundaries: preview.rowBoundaries,
        colBoundaries: preview.colBoundaries,
      };
      const res = await fetch("/api/regions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          type: "notes",
          overrides: {
            bbox: notesParseRegion,
            data,
            category: "notes",
            csiTags: preview.csiTags ?? [],
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { updatedIntelligence: PageIntelligence };
      setPageIntelligence(pageNumber, payload.updatedIntelligence);
      refreshPageCsiSpatialMap(pageNumber);
      resetNotesParse();
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      isSavingRef.current = false;
      setSaving(false);
    }
  };

  const handleClear = () => {
    setPreview(null);
    setError(null);
    setNotesParseRegion(null);
    setNotesParseStep("idle");
    resetNotesParse();
  };

  const regionLabel = useMemo(() => {
    if (!notesParseRegion) return "Draw a region to begin";
    const [x0, y0, x1, y1] = notesParseRegion;
    return `Region: ${(x0 * 100).toFixed(1)},${(y0 * 100).toFixed(1)} → ${(x1 * 100).toFixed(1)},${(y1 * 100).toFixed(1)} (%)`;
  }, [notesParseRegion]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Sub-mode tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["auto", "guided", "paragraph", "fast-manual", "manual"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setPreview(null);
              setError(null);
            }}
            className={`flex-1 px-1 py-1.5 text-[9px] font-medium ${
              mode === m
                ? "text-blue-300 border-b-2 border-blue-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {m === "auto" ? "Auto" : m === "guided" ? "Guided" : m === "paragraph" ? "Paragraph" : m === "fast-manual" ? "Fast-manual" : "Manual"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {/* Region status + draw controls */}
        <div className="flex items-center gap-1.5">
          <div className="text-[10px] text-[var(--muted)] flex-1 truncate">{regionLabel}</div>
          {!regionReady ? (
            <button
              onClick={() => {
                setNotesParseStep("select-region");
                useViewerStore.getState().setMode("pointer");
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10"
            >
              Draw region
            </button>
          ) : (
            <button
              onClick={() => {
                resetNotesParse();
                setNotesParseStep("select-region");
                useViewerStore.getState().setMode("pointer");
              }}
              className="text-[9px] px-1.5 py-0.5 rounded text-[var(--muted)] hover:text-red-400"
            >
              Redraw
            </button>
          )}
        </div>

        {/* Sub-mode body */}
        {mode === "auto" && (
          <div className="space-y-1.5">
            <button
              onClick={runAuto}
              disabled={!regionReady || loading}
              className="w-full text-[10px] px-2 py-1 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 disabled:opacity-40"
            >
              {loading ? "Parsing…" : "Run Auto-Parse"}
            </button>
            {!regionReady && (
              <div className="text-[9px] text-[var(--muted)]/70 italic">
                Draw a bbox around the notes region (click &ldquo;Draw region&rdquo; on the canvas toolbar, or hand-off from Classifier &ldquo;Edit&rdquo;).
              </div>
            )}
          </div>
        )}

        {mode === "guided" && (
          <div className="space-y-1.5">
            <button
              onClick={runProposeGuided}
              disabled={!regionReady || loading}
              className="w-full text-[10px] px-2 py-1 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 disabled:opacity-40"
            >
              {loading ? "Proposing…" : "Propose Grid"}
            </button>
            <button
              onClick={() => {
                const grid = buildGridFromGuided();
                if (!grid) setError("Need at least 2 rows and 2 columns to build grid");
                else setPreview(grid);
              }}
              disabled={!regionReady}
              className="w-full text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
            >
              Extract Grid
            </button>
            <div className="text-[9px] text-[var(--muted)]/70 italic">
              After propose, drag/double-click the overlay lines to adjust, then extract.
            </div>
          </div>
        )}

        {mode === "paragraph" && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-[var(--muted)]/70 italic leading-snug">
              Hover a paragraph to preview, double-click to commit. First-word
              numeric becomes the Key (numbered lists) or largest-gap split
              becomes Key/Value (legends). Drag edge handles to adjust. Cmd+C
              / Cmd+V copies column boundaries across paragraphs. Press Delete
              to remove a focused paragraph.
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleRepeatPlusOne}
                disabled={paragraphBatch.length === 0}
                title="Clone the last paragraph's bbox one row down"
                className="flex-1 text-[10px] px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
              >
                Repeat +1 single
              </button>
              <button
                onClick={() => setParagraphBatch([])}
                disabled={paragraphBatch.length === 0}
                className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-red-400 disabled:opacity-40"
              >
                Discard
              </button>
            </div>
            <div className="text-[9.5px] text-[var(--muted)]">
              {paragraphBatch.length} paragraph{paragraphBatch.length === 1 ? "" : "s"} in batch
            </div>
            {paragraphBatch.length > 0 && (
              <ul className="space-y-1 max-h-32 overflow-y-auto text-[9px] font-mono">
                {paragraphBatch.map((p, i) => (
                  <li key={p.id} className="flex items-start gap-1 px-1 py-0.5 rounded bg-[var(--surface-2)]/50">
                    <span className="text-blue-300 font-semibold shrink-0">#{i + 1}</span>
                    <span className="flex-1 truncate text-[var(--fg)]/80">
                      {p.rowText.Key || "(no key)"}
                      {p.rowText.Note ? ` · ${p.rowText.Note.slice(0, 48)}${p.rowText.Note.length > 48 ? "…" : ""}` : ""}
                      {p.rowText.Value ? ` · ${p.rowText.Value.slice(0, 48)}${p.rowText.Value.length > 48 ? "…" : ""}` : ""}
                    </span>
                    <button
                      onClick={() => removePendingParagraph(p.id)}
                      className="text-red-400/70 hover:text-red-400 shrink-0"
                      title="Remove"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === "fast-manual" && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-[var(--muted)]/70 italic">
              Fast-manual mode: double-click paragraphs on the canvas to snap
              Textract LINE bboxes and build the grid incrementally. Columns
              auto-snap to established boundaries after the first selection.
            </div>
            <div className="text-[9px] text-amber-400/70">
              Overlay available on the page canvas once the region is drawn.
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-[var(--muted)]/70 leading-snug">
              Manual: draw column BBs (left &rarr; right) and row BBs, then click Parse.
              Columns become &ldquo;Key&rdquo; / &ldquo;Note&rdquo; by convention.
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => {
                  setNotesParseStep("define-column");
                  useViewerStore.getState().setMode("pointer");
                }}
                disabled={!regionReady}
                className="flex-1 text-[10px] px-2 py-1 rounded border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
              >
                + Column BB
              </button>
              <button
                onClick={() => {
                  setNotesParseStep("define-row");
                  useViewerStore.getState().setMode("pointer");
                }}
                disabled={!regionReady}
                className="flex-1 text-[10px] px-2 py-1 rounded border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 disabled:opacity-40"
              >
                + Row BB
              </button>
            </div>
            <div className="text-[9px] text-[var(--muted)]">
              Drawn: {guidedNotesCols.length} col&nbsp;BB{guidedNotesCols.length === 1 ? "" : "s"},{" "}
              {guidedNotesRows.length} row&nbsp;BB{guidedNotesRows.length === 1 ? "" : "s"}
            </div>
            <button
              onClick={() => {
                const grid = buildGridFromManualBBs();
                if (!grid) setError("Need at least 2 columns and 1 row drawn");
                else setPreview(grid);
              }}
              disabled={!regionReady}
              className="w-full text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
            >
              Parse from BBs
            </button>
          </div>
        )}

        {error && (
          <div className="text-[9.5px] text-red-400 px-1">{error}</div>
        )}

        {/* Preview */}
        {preview && (
          <div className="rounded border border-[var(--border)] bg-[var(--surface-2)]/50 p-2 space-y-1">
            <div className="text-[10px] font-semibold text-blue-300">
              Preview: {preview.rows.length} rows &times; {preview.headers.length} cols
            </div>
            {preview.csiTags && preview.csiTags.length > 0 && (
              <div className="text-[9px] text-[var(--muted)]">
                {preview.csiTags.length} CSI tag{preview.csiTags.length === 1 ? "" : "s"} detected
              </div>
            )}
            <div className="max-h-32 overflow-y-auto text-[9px] font-mono text-[var(--fg)]/80 leading-tight">
              {preview.rows.slice(0, 10).map((row, ri) => (
                <div key={ri} className="flex gap-1">
                  <span className="text-blue-300 w-6 shrink-0">{row[preview.headers[0]]}</span>
                  <span className="flex-1 truncate">
                    {preview.headers.slice(1).map((h) => row[h]).filter(Boolean).join(" | ")}
                  </span>
                </div>
              ))}
              {preview.rows.length > 10 && (
                <div className="text-[var(--muted)]/70 italic">
                  … and {preview.rows.length - 10} more
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="border-t border-[var(--border)] px-2 py-1.5 flex gap-1">
        <button
          onClick={handleClear}
          className="flex-1 text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
        >
          Clear
        </button>
        <button
          onClick={handleSave}
          disabled={saving || (mode === "paragraph" ? paragraphBatch.length === 0 : !preview)}
          className="flex-1 text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save Notes"}
        </button>
      </div>
    </div>
  );
}

