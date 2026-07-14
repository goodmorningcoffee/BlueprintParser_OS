"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParseFlow } from "@/hooks/useParseFlow";
import { useProjectLifecycleGuard } from "@/hooks/useProjectLifecycleGuard";
import {
  commitParseOperation,
  useParseOperation,
  type ParseOperationToken,
} from "@/hooks/useParseOperation";
import {
  useNotesParseExtensions,
  useParagraphWorkspaceExtensions,
  useParseFlowStore,
} from "@/stores/parseFlowStore";
import {
  claimGuidedParseWorkspaceForOperation,
  claimParagraphWorkspaceForOperation,
  completeNotesParseOperation,
  invalidateNotesWorkspaceOperationsForOperation,
  invalidateParagraphParseOperationsForOperation,
  leaveNotesParserWorkspace,
  publishGuidedProposalForOperation,
  removeParagraphForUser,
  resetNotesParseWorkspace,
  setNotesParseStepWithTool,
  setParagraphBatchForUser,
  transitionNotesParserMode,
  upsertParagraphForUser,
  type ParseWorkspaceLease,
} from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useTextractForPage } from "@/queries/useTextract";
import { saveParsedRegion } from "@/queries/parsedRegions";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import { unionBboxes } from "@/lib/specnote-parser";
// [refactor jul5 S026] apiErrorMessage: notes-parse now serves {error:{code,message}}
import { canPersist, regionIdFor, apiErrorMessage } from "@/lib/client-persist";
import type { NotesData, ParsedRegion } from "@/types";

type NotesSubMode = "auto" | "guided" | "paragraph" | "fast-manual" | "manual";

interface PreviewGrid {
  headers: string[];
  rows: Record<string, string>[];
  rowBoundaries?: number[];
  colBoundaries?: number[];
  csiTags?: { code: string; description: string }[];
}

type NotesBbox = [number, number, number, number];

type NotesOperationTarget = Readonly<{
  projectId: number;
  publicId: string | null;
  isDemo: boolean;
  pageNumber: number;
  region: NotesBbox;
  mode: NotesSubMode;
}>;

function clonePreviewGrid(grid: PreviewGrid): PreviewGrid {
  return {
    headers: [...grid.headers],
    rows: grid.rows.map((row) => ({ ...row })),
    rowBoundaries: grid.rowBoundaries ? [...grid.rowBoundaries] : undefined,
    colBoundaries: grid.colBoundaries ? [...grid.colBoundaries] : undefined,
    csiTags: grid.csiTags?.map((tag) => ({ ...tag })),
  };
}

function notesDraftFor(grid: PreviewGrid, region: NotesBbox): ParsedRegion {
  const [x0, y0, x1, y1] = region;
  return {
    id: "draft-notes",
    type: "notes",
    category: "notes-preview",
    bbox: [x0, y0, x1, y1],
    confidence: 0.85,
    source: "user",
    data: {
      headers: grid.headers,
      rows: grid.rows,
      tagColumn: grid.headers[0],
      tableName: "(preview)",
      rowCount: grid.rows.length,
      columnCount: grid.headers.length,
      rowBoundaries: grid.rowBoundaries,
      colBoundaries: grid.colBoundaries,
    },
  };
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
  const queryClient = useQueryClient();
  // Use a distinct selector parameter name: the ownership oracle is intentionally conservative
  // across nested scopes, and this component also has a local viewer snapshot named `s`.
  const projectId = useSessionStore((session) => session.projectId);
  const publicId = useSessionStore((session) => session.publicId);
  const isDemo = useSessionStore((session) => session.isDemo);
  const isRenderedLifecycleCurrent = useProjectLifecycleGuard(publicId, isDemo);
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const textractData = useTextractForPage(pageNumber);

  const { region: notesParseRegion } = useParseFlow("notes");
  const notesOperation = useParseOperation("notes");
  const {
    guidedNotesRows,
    guidedNotesCols,
    notesFastManualGrid,
  } = useNotesParseExtensions();
  const {
    paragraphBatch,
  } = useParagraphWorkspaceExtensions();

  const [mode, setMode] = useState<NotesSubMode>("auto");
  const [preview, setPreview] = useState<PreviewGrid | null>(null);
  const [loadingRevision, setLoadingRevision] = useState<number | null>(null);
  const [savingRevision, setSavingRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = notesOperation.busy && loadingRevision === notesOperation.revision;
  const saving = notesOperation.busy && savingRevision === notesOperation.revision;
  const cleanupLeaseRef = useRef<ParseWorkspaceLease | null>(null);

  const visiblePreview = useMemo<PreviewGrid | null>(() => {
    if (mode !== "fast-manual") return preview;
    return notesFastManualGrid ? clonePreviewGrid(notesFastManualGrid) : null;
  }, [mode, notesFastManualGrid, preview]);

  // Coordinated navigation clears every page-relative workspace before core.setPage. Parent
  // tab/panel commands own Guided teardown before unmount. The component cleanup therefore
  // touches only Notes/Spec draft state; a newer independent Table/Keynote Guided generation wins.
  useEffect(() => () => {
    if (cleanupLeaseRef.current) {
      leaveNotesParserWorkspace(cleanupLeaseRef.current, false);
    }
  }, []);

  const regionReady = !!notesParseRegion;

  const captureTarget = (region: NotesBbox): NotesOperationTarget => ({
    projectId,
    publicId,
    isDemo,
    pageNumber,
    region: [...region] as NotesBbox,
    mode,
  });

  const runAuto = async () => {
    if (!projectId || !notesParseRegion) return;
    const target = captureTarget(notesParseRegion);
    const started = notesOperation.begin();
    if (started.status !== "started") return;
    const token = started.token;
    try {
      const workspaceLease = invalidateParagraphParseOperationsForOperation(token);
      if (!workspaceLease) return;
      if (!commitParseOperation(token, () => {
        cleanupLeaseRef.current = workspaceLease;
        setLoadingRevision(token.revision);
        setSavingRevision(null);
        setError(null);
      })) return;

      const res = await fetch("/api/notes-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: target.projectId,
          pageNumber: target.pageNumber,
          regionBbox: target.region,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Parse failed" }));
        throw new Error(apiErrorMessage(err) || `HTTP ${res.status}`);
      }
      const response = (await res.json()) as PreviewGrid & { note?: string };
      if (!notesOperation.isCurrent(token)) return;
      const payload = clonePreviewGrid(response);
      if (!payload.headers?.length || !payload.rows?.length) {
        commitParseOperation(token, () => {
          setError(response.note ?? "No numbered items found in region");
          setPreview(null);
          useParseFlowStore.getState().setParseDraftRegion(null);
        });
      } else {
        const published = commitParseOperation(token, () => {
          setPreview(payload);
          setLoadingRevision(null);
          setSavingRevision(token.revision);
          setError(null);
          // Shared publication is deliberately last: a synchronous B may revoke A, after which the
          // inherited helper below rechecks before launching persistence.
          useParseFlowStore.getState().setParseDraftRegion(notesDraftFor(payload, target.region));
        });
        if (!published || !notesOperation.isCurrent(token)) return;
        // Preserve Auto's visible fire-and-forget phase transition while the outer root retains its
        // sole revision through the inherited durable continuation.
        await persistPreviewGrid(payload, target.region, token, target);
      }
    } catch (err) {
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Parse failed");
      });
    } finally {
      notesOperation.finish(token);
    }
  };

  const runProposeGuided = async () => {
    if (!projectId || !notesParseRegion) return;
    const target = captureTarget(notesParseRegion);
    const started = notesOperation.begin("supersede");
    if (started.status !== "started") return;
    const token = started.token;
    try {
      const workspaceLease = claimGuidedParseWorkspaceForOperation(token, target.region);
      if (!workspaceLease) return;
      if (!commitParseOperation(token, () => {
        cleanupLeaseRef.current = workspaceLease;
        setLoadingRevision(token.revision);
        setSavingRevision(null);
        setError(null);
      })) return;
      const res = await fetch("/api/notes-parse/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: target.projectId,
          pageNumber: target.pageNumber,
          regionBbox: target.region,
        }),
      });
      if (!res.ok) throw new Error("Propose failed");
      const payload = (await res.json()) as { proposedRows: number[]; proposedCols: number[] };
      publishGuidedProposalForOperation(
        token,
        [...payload.proposedRows],
        [...payload.proposedCols],
      );
    } catch (err) {
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Propose failed");
      });
    } finally {
      notesOperation.finish(token);
    }
  };

  const buildGridFromGuided = (): PreviewGrid | null => {
    if (!textractData) return null;
    const store = useParseFlowStore.getState();
    if (store.guidedParseOwner !== "notes") return null;
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
    if (!notesParseRegion || paragraphBatch.length === 0) return;
    const last = paragraphBatch[paragraphBatch.length - 1];
    const [x0, y0, x1, y1] = last.bbox;
    const h = y1 - y0;
    upsertParagraphForUser("notes", notesParseRegion, {
      id: `para-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bbox: [x0, y1, x1, y1 + h],
      lines: [],
      rowText: { Key: "", Note: "" },
    });
  };

  const saveFromParagraphBatch = async () => {
    if (!isRenderedLifecycleCurrent()) return;
    if (!canPersist(publicId, isDemo) || !notesParseRegion || paragraphBatch.length === 0) return;
    const target = captureTarget(notesParseRegion);
    const capturedBatch = paragraphBatch.map((paragraph) => ({
      ...paragraph,
      bbox: [...paragraph.bbox] as NotesBbox,
      lines: [...paragraph.lines],
      rowText: { ...paragraph.rowText },
      colBoundaries: paragraph.colBoundaries ? [...paragraph.colBoundaries] : undefined,
    }));
    const started = notesOperation.begin();
    if (started.status !== "started") return;
    const token = started.token;
    const canPublishCompletion = () =>
      isRenderedLifecycleCurrent() && notesOperation.isCurrent(token);
    try {
      const workspaceLease = claimParagraphWorkspaceForOperation(
        token,
        "notes",
        notesParseRegion,
      );
      if (!workspaceLease) return;
      if (!commitParseOperation(token, () => {
        cleanupLeaseRef.current = workspaceLease;
        setSavingRevision(token.revision);
        setLoadingRevision(null);
        setError(null);
      })) return;

      const unionBbox = unionBboxes(capturedBatch.map((p) => p.bbox));
      const headers = ["Key", "Note"];
      const rows = capturedBatch.map((p) => ({
        Key: p.rowText.Key ?? "",
        Note: p.rowText.Note ?? p.rowText.Value ?? "",
      }));
      const rowBoundaries = capturedBatch.map((p) => p.bbox[1]);
      rowBoundaries.push(capturedBatch[capturedBatch.length - 1].bbox[3]);
      const data: NotesData = {
        headers,
        rows,
        tagColumn: headers[0],
        tableName: `Notes p.${target.pageNumber} — ${capturedBatch.length} paragraph${capturedBatch.length === 1 ? "" : "s"}`,
        rowCount: rows.length,
        columnCount: headers.length,
        rowBoundaries,
      };
      await saveParsedRegion(
        queryClient,
        {
          publicId: target.publicId,
          isDemo: target.isDemo,
          pageNumber: target.pageNumber,
          canAdopt: isRenderedLifecycleCurrent,
        },
        {
          via: "parser",
          type: "notes",
          regionId: regionIdFor(target.pageNumber, unionBbox),
          bboxMinMax: unionBbox,
          data: data as unknown as Record<string, unknown>,
          category: "notes",
        },
      );
      if (!canPublishCompletion()) return;
      commitParseOperation(token, () => {
        setPreview(null);
        completeNotesParseOperation(token);
      });
    } catch (err) {
      if (!canPublishCompletion()) return;
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Save failed");
      });
    } finally {
      if (canPublishCompletion()) notesOperation.finish(token);
    }
  };

  // Promote a preview grid to a committed ParsedRegion. Shared by the auto-fire
  // (on parse completion in Auto/Guided/Manual sub-modes) and the manual
  // "Save Notes" button. Pass grid + region explicitly so the auto path doesn't
  // race React state updates. Stable regionId → re-parse upserts (replaces).
  const persistPreviewGrid = async (
    grid: PreviewGrid,
    region: NotesBbox,
    inheritedToken?: ParseOperationToken<"notes">,
    inheritedTarget?: NotesOperationTarget,
    publishPreview = false,
  ): Promise<boolean> => {
    if (!isRenderedLifecycleCurrent()) return false;
    const target = inheritedTarget ?? captureTarget(region);
    if (!canPersist(target.publicId, target.isDemo)) return false;
    const input = clonePreviewGrid(grid);
    const ownsToken = inheritedToken === undefined;
    let token = inheritedToken;
    if (ownsToken) {
      const started = notesOperation.begin();
      if (started.status !== "started") return false;
      token = started.token;
    }
    if (!token) return false;
    const activeToken = token;
    const canPublishCompletion = () =>
      isRenderedLifecycleCurrent() && notesOperation.isCurrent(activeToken);
    try {
      if (ownsToken) {
        const workspaceLease = target.mode === "guided"
          ? invalidateNotesWorkspaceOperationsForOperation(token)
          : invalidateParagraphParseOperationsForOperation(token);
        if (!workspaceLease) return false;
        if (!commitParseOperation(token, () => {
          cleanupLeaseRef.current = workspaceLease;
          setSavingRevision(token.revision);
          setLoadingRevision(null);
          setError(null);
          if (publishPreview) {
            setPreview(input);
            useParseFlowStore.getState().setParseDraftRegion(notesDraftFor(input, target.region));
          }
        })) return false;
      } else if (!notesOperation.isCurrent(token)) {
        return false;
      }

      // A shared draft subscriber may synchronously hand the workspace to B during the authorized
      // publication above. Durable work must not start after that handoff.
      if (!notesOperation.isCurrent(token)) return false;

      const data: NotesData = {
        headers: input.headers,
        rows: input.rows,
        tagColumn: input.headers[0],
        tableName: `Notes p.${target.pageNumber}`,
        rowCount: input.rows.length,
        columnCount: input.headers.length,
        rowBoundaries: input.rowBoundaries,
        colBoundaries: input.colBoundaries,
      };
      await saveParsedRegion(
        queryClient,
        {
          publicId: target.publicId,
          isDemo: target.isDemo,
          pageNumber: target.pageNumber,
          canAdopt: isRenderedLifecycleCurrent,
        },
        {
          via: "parser",
          type: "notes",
          regionId: regionIdFor(target.pageNumber, target.region),
          bboxMinMax: target.region,
          data: data as unknown as Record<string, unknown>,
          category: "notes",
          csiTags: input.csiTags ?? [],
        },
      );
      if (!canPublishCompletion()) return false;
      let completed = false;
      commitParseOperation(token, () => {
        setPreview(null);
        completed = completeNotesParseOperation(token, {
          guided: target.mode === "guided",
          fastManual: target.mode === "fast-manual",
        });
      });
      return completed;
    } catch (err) {
      if (!canPublishCompletion()) return false;
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Save failed");
      });
      return false;
    } finally {
      if (ownsToken && canPublishCompletion()) notesOperation.finish(token);
    }
  };

  const handleSave = async () => {
    if (mode === "paragraph") return saveFromParagraphBatch();
    if (!notesParseRegion || !visiblePreview) return;
    return persistPreviewGrid(visiblePreview, notesParseRegion);
  };

  const handleClear = () => {
    setMode("auto");
    setPreview(null);
    setError(null);
    resetNotesParseWorkspace("idle", {
      guided: mode === "guided",
      fastManual: mode === "fast-manual",
    });
  };

  const handleModeChange = (nextMode: NotesSubMode) => {
    if (nextMode === mode) return;
    const lease = transitionNotesParserMode(nextMode, notesParseRegion);
    if (!lease) return;
    cleanupLeaseRef.current = lease;
    setMode(nextMode);
    setPreview(null);
    setError(null);
  };

  const handleRedraw = () => {
    if (!resetNotesParseWorkspace("select-region", {
      guided: mode === "guided",
      fastManual: mode === "fast-manual",
    }, "pointer")) return;
    setMode("auto");
    setPreview(null);
    setError(null);
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
            onClick={() => handleModeChange(m)}
            disabled={!regionReady && m !== "auto"}
            className={`flex-1 px-1 py-1.5 text-[9px] font-medium ${
              mode === m
                ? "text-blue-300 border-b-2 border-blue-400"
                : "text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-40"
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
                setNotesParseStepWithTool("select-region", "pointer");
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10"
            >
              Draw region
            </button>
          ) : (
            <button
              onClick={handleRedraw}
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
                else {
                  if (notesParseRegion) {
                    void persistPreviewGrid(grid, notesParseRegion, undefined, undefined, true);
                  }
                }
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
                onClick={() => {
                  if (notesParseRegion) {
                    setParagraphBatchForUser("notes", notesParseRegion, []);
                  }
                }}
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
                      onClick={() => {
                        if (notesParseRegion) {
                          removeParagraphForUser("notes", notesParseRegion, p.id);
                        }
                      }}
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
                  setNotesParseStepWithTool("define-column", "pointer");
                }}
                disabled={!regionReady}
                className="flex-1 text-[10px] px-2 py-1 rounded border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
              >
                + Column BB
              </button>
              <button
                onClick={() => {
                  setNotesParseStepWithTool("define-row", "pointer");
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
                else {
                  if (notesParseRegion) {
                    void persistPreviewGrid(grid, notesParseRegion, undefined, undefined, true);
                  }
                }
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
        {visiblePreview && (
          <div className="rounded border border-[var(--border)] bg-[var(--surface-2)]/50 p-2 space-y-1">
            <div className="text-[10px] font-semibold text-blue-300">
              Preview: {visiblePreview.rows.length} rows &times; {visiblePreview.headers.length} cols
            </div>
            {visiblePreview.csiTags && visiblePreview.csiTags.length > 0 && (
              <div className="text-[9px] text-[var(--muted)]">
                {visiblePreview.csiTags.length} CSI tag{visiblePreview.csiTags.length === 1 ? "" : "s"} detected
              </div>
            )}
            <div className="max-h-32 overflow-y-auto text-[9px] font-mono text-[var(--fg)]/80 leading-tight">
              {visiblePreview.rows.slice(0, 10).map((row, ri) => (
                <div key={ri} className="flex gap-1">
                  <span className="text-blue-300 w-6 shrink-0">{row[visiblePreview.headers[0]]}</span>
                  <span className="flex-1 truncate">
                    {visiblePreview.headers.slice(1).map((h) => row[h]).filter(Boolean).join(" | ")}
                  </span>
                </div>
              ))}
              {visiblePreview.rows.length > 10 && (
                <div className="text-[var(--muted)]/70 italic">
                  … and {visiblePreview.rows.length - 10} more
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
          disabled={saving || (mode === "paragraph" ? paragraphBatch.length === 0 : !visiblePreview)}
          className="flex-1 text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save Notes"}
        </button>
      </div>
    </div>
  );
}
