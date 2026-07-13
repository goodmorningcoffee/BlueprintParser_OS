"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readTextractForPage } from "@/queries/textractCache";
import { useParseFlow } from "@/hooks/useParseFlow";
import { commitParseOperation, useParseOperation } from "@/hooks/useParseOperation";
import {
  useGuidedParseExtensions,
  useParseFlowStore,
  useTableParseExtensions,
} from "@/stores/parseFlowStore";
import {
  beginGuidedGridEdit,
  claimGuidedParseWorkspaceForOperation,
  invalidateGuidedParseOperations,
  publishGuidedProposalForOperation,
  publishTableReviewForOperation,
  resetGuidedParseWorkspace,
  setGuidedParseColsForLease,
  setGuidedParseRowsForLease,
  setTableParseStepWithTool,
} from "@/stores/viewerCommands";
import { useNavigation } from "@/stores/viewerCoreStore";
import { useProject } from "@/stores/sessionStore";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import MapTagsSection, { type MapTagsStrictness } from "./MapTagsSection";
import type { DetectCsiAndPersist } from "./table-operation-types";

interface GuidedParseTabProps {
  detectCsiAndPersist: DetectCsiAndPersist;
  yoloInTableRegion: { model: string; className: string; count: number }[];
  tagYoloClass: { model: string; className: string } | null;
  setTagYoloClass: (cls: { model: string; className: string } | null) => void;
  handleMapTags: () => void;
  tagMappingDone: boolean;
  tagMappingCount: number;
  setTagMappingDone: (done: boolean) => void;
  // Phase 3 — Map Tags strictness + drawing-number-prefix scope + audit
  mapTagsStrictness: MapTagsStrictness;
  setMapTagsStrictness: (s: MapTagsStrictness) => void;
  drawingNumberPrefixes: string[];
  setDrawingNumberPrefixes: (prefixes: string[]) => void;
  availablePrefixes: string[];
  lastDropCounts: Record<string, number> | null;
}

type TableProposalExpectation = Readonly<{
  owner: "table" | null;
  tableRevision: number;
  region: [number, number, number, number];
}>;

const EMPTY_GUIDED_LINES: number[] = [];

export default function GuidedParseTab({
  detectCsiAndPersist,
  yoloInTableRegion,
  tagYoloClass, setTagYoloClass,
  handleMapTags, tagMappingDone, tagMappingCount, setTagMappingDone,
  mapTagsStrictness, setMapTagsStrictness,
  drawingNumberPrefixes, setDrawingNumberPrefixes,
  availablePrefixes,
  // lastDropCounts intentionally unused here — audit line lives in AutoParseTab
}: GuidedParseTabProps) {
  const { pageNumber } = useNavigation();
  const { projectId, publicId } = useProject();
  // Context-only handle: guided parsing reads Textract at click time and creates zero observers.
  const queryClient = useQueryClient();
  const {
    region: tableParseRegion,
  } = useParseFlow("table");
  const tableOperation = useParseOperation("table");
  const {
    tableParsedGrid, setTableParsedGrid,
  } = useTableParseExtensions();

  // Shared grid workspace: explicit beside the Table lifecycle because it is also used by Keynote.
  const {
    guidedParseOwner,
    guidedParseActive: sharedGuidedParseActive,
    guidedParseRegion: sharedGuidedParseRegion,
    guidedParseRows: sharedGuidedParseRows,
    guidedParseCols: sharedGuidedParseCols,
  } = useGuidedParseExtensions();
  const ownsGuidedWorkspace = guidedParseOwner === "table";
  const guidedParseActive = ownsGuidedWorkspace && sharedGuidedParseActive;
  const guidedParseRows = ownsGuidedWorkspace ? sharedGuidedParseRows : EMPTY_GUIDED_LINES;
  const guidedParseCols = ownsGuidedWorkspace ? sharedGuidedParseCols : EMPTY_GUIDED_LINES;

  // Tuning sliders
  const [rowTolerance, setRowTolerance] = useState(0.006);
  const [colGap, setColGap] = useState(0.015);
  const [colConfidence, setColConfidence] = useState(0.3);
  const [expectedCols, setExpectedCols] = useState<number | null>(null);
  const [showTune, setShowTune] = useState(false);

  // Proposal state
  const [proposalRevision, setProposalRevision] = useState<number | null>(null);
  const proposing = tableOperation.busy && proposalRevision === tableOperation.revision;
  const [proposalInfo, setProposalInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsedRevision, setParsedRevision] = useState<number | null>(null);
  const parsed = parsedRevision !== null && parsedRevision === tableOperation.revision &&
    !tableOperation.busy && guidedParseOwner === null;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuningKey = `${rowTolerance}|${colGap}|${colConfidence}|${expectedCols ?? "auto"}`;
  const lastTuningKeyRef = useRef(tuningKey);

  // ─── Propose grid ──────────────────────────────────────────
  const proposeGrid = useCallback(async (
    region: [number, number, number, number],
    expectation: TableProposalExpectation,
  ) => {
    if (!projectId) return;
    const before = useParseFlowStore.getState();
    if (
      before.guidedParseOwner !== expectation.owner ||
      before.parseOperations.table.revision !== expectation.tableRevision ||
      before.parseOperations.table.busy ||
      before.tableParseRegion !== expectation.region
    ) return;
    // Tuning is latest-intent work: each debounced proposal supersedes the prior proposal token.
    const started = tableOperation.begin("supersede");
    if (started.status === "busy") return;
    const token = started.token;
    try {
      const target = {
        projectId,
        pageNumber,
        regionBbox: [...region] as [number, number, number, number],
        expectedCols,
        rowTolerance,
        colGap,
        colConfidence,
      };
      // Keynote/Notes share this grid. Owner, region, empty bytes, and peer revocation publish once.
      // Keep the claim inside the token's try/finally: a synchronous subscriber can deny the claim
      // or revoke A during its publication, but neither path may strand Table in busy state.
      const workspaceLease = claimGuidedParseWorkspaceForOperation(token, target.regionBbox);
      if (!workspaceLease) return;

      const admitted = commitParseOperation(token, () => {
        setProposalRevision(token.revision);
        setError(null);
      });
      // The peer invalidation above is a synchronous publication. A subscriber may revoke Table A;
      // deny both its shared seed and its request in that case.
      if (!admitted || !tableOperation.isCurrent(token)) return;

      const resp = await fetch("/api/table-parse/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: target.projectId,
          pageNumber: target.pageNumber,
          regionBbox: target.regionBbox,
          layoutHint: target.expectedCols ? { columns: target.expectedCols } : undefined,
          gridOptions: {
            rowTolerance: target.rowTolerance,
            minColGap: target.colGap,
            minHitsRatio: target.colConfidence,
          },
        }),
      });
      if (!resp.ok) throw new Error("Proposal failed");
      const data = await resp.json();
      if (!publishGuidedProposalForOperation(
        token,
        data.proposedRows || [],
        data.proposedCols || [],
      )) return;
      commitParseOperation(token, () => {
        setProposalInfo(`${data.rowCount} rows × ${data.colCount} cols (conf: ${(data.confidence * 100).toFixed(0)}%)`);
      });
    } catch (err: any) {
      commitParseOperation(token, () => {
        setError(err.message || "Failed to propose grid");
        setProposalInfo(null);
      });
    } finally {
      tableOperation.finish(token);
    }
  }, [projectId, pageNumber, rowTolerance, colGap, colConfidence, expectedCols,
    tableOperation.begin, tableOperation.finish, tableOperation.isCurrent]);

  const authorizeTuningChange = useCallback(() => (
    beginGuidedGridEdit("table", sharedGuidedParseRegion) !== null
  ), [sharedGuidedParseRegion]);

  // ─── Debounced re-propose on slider change ─────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const tuningChanged = lastTuningKeyRef.current !== tuningKey;
    lastTuningKeyRef.current = tuningKey;
    if (!tuningChanged || !ownsGuidedWorkspace || !guidedParseActive ||
        !tableParseRegion || tableOperation.busy) return;
    const expectation: TableProposalExpectation = {
      owner: "table",
      tableRevision: tableOperation.revision,
      region: tableParseRegion,
    };
    debounceRef.current = setTimeout(() => {
      proposeGrid(tableParseRegion, expectation);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [guidedParseActive, ownsGuidedWorkspace, proposeGrid, tableOperation.busy,
    tableOperation.revision, tableParseRegion, tuningKey]);

  // ─── Capture drawn region ──────────────────────────────────
  useEffect(() => {
    if (
      tableParseRegion && !guidedParseActive && !parsed && !tableOperation.busy &&
      (guidedParseOwner === null || guidedParseOwner === "table")
    ) {
      proposeGrid(tableParseRegion, {
        owner: guidedParseOwner,
        tableRevision: tableOperation.revision,
        region: tableParseRegion,
      });
    }
  }, [tableParseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Parse from grid ───────────────────────────────────────
  const handleParse = useCallback(async () => {
    const pageTextract = readTextractForPage(queryClient, publicId, pageNumber);
    if (!ownsGuidedWorkspace || !pageTextract?.words ||
        guidedParseRows.length < 2 || guidedParseCols.length < 2) return;

    const result = extractCellsFromGrid(pageTextract.words, guidedParseRows, guidedParseCols);
    if (result.rows.length === 0) {
      setError("No cells found in grid");
      return;
    }

    const started = tableOperation.begin();
    if (started.status === "busy") return;
    const token = started.token;

    try {
      const workspaceAdmitted = commitParseOperation(token, () => {
        invalidateGuidedParseOperations("table");
      });
      if (!workspaceAdmitted || !tableOperation.isCurrent(token)) return;
      // Set parsed grid for review/map tags.
      const reviewCommitted = publishTableReviewForOperation(token, {
        grid: { headers: result.headers, rows: result.rows },
        // Guided parse doesn't use the merger; clear stale source-picker metadata atomically.
        meta: null,
      });
      if (!reviewCommitted) return;

      // Save via shared detectCsiAndPersist — surface PATCH failures to the
      // user via the local error state so we don't silently lose the parse.
      await detectCsiAndPersist({
        headers: result.headers,
        rows: result.rows,
        tableName: `Table p.${pageNumber}`,
      }, {
        resetGuided: true,
        onLocalSuccess: () => {
          // The terminal command advances Table exactly once. Keying this local success to that
          // revision prevents a later Table B (or peer Guided owner) from rendering A's result.
          setParsedRevision(token.revision + 1);
        },
      }, token);
    } catch (err) {
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Save failed");
      });
    } finally {
      tableOperation.finish(token);
    }
  }, [queryClient, publicId, pageNumber, guidedParseRows, guidedParseCols,
    ownsGuidedWorkspace, detectCsiAndPersist, tableOperation.begin, tableOperation.finish]);

  // ─── Repeat row down ───────────────────────────────────────
  const repeatRowDown = useCallback(() => {
    if (guidedParseRows.length < 3 || !tableParseRegion) return;
    const lastRowH = guidedParseRows[guidedParseRows.length - 1] - guidedParseRows[guidedParseRows.length - 2];
    const bottom = tableParseRegion[3];
    let y = guidedParseRows[guidedParseRows.length - 1];
    const newRows = [...guidedParseRows];
    while (y + lastRowH * 0.5 < bottom) {
      y += lastRowH;
      newRows.push(Math.min(y, bottom));
    }
    const lease = beginGuidedGridEdit("table", sharedGuidedParseRegion);
    if (!lease) return;
    setGuidedParseRowsForLease(newRows, lease);
  }, [guidedParseRows, sharedGuidedParseRegion, tableParseRegion]);

  // ─── Repeat column right ──────────────────────────────────
  const repeatColRight = useCallback(() => {
    if (guidedParseCols.length < 3 || !tableParseRegion) return;
    const lastColW = guidedParseCols[guidedParseCols.length - 1] - guidedParseCols[guidedParseCols.length - 2];
    const right = tableParseRegion[2];
    let x = guidedParseCols[guidedParseCols.length - 1];
    const newCols = [...guidedParseCols];
    while (x + lastColW * 0.5 < right) {
      x += lastColW;
      newCols.push(Math.min(x, right));
    }
    const lease = beginGuidedGridEdit("table", sharedGuidedParseRegion);
    if (!lease) return;
    setGuidedParseColsForLease(newCols, lease);
  }, [guidedParseCols, sharedGuidedParseRegion, tableParseRegion]);

  // ─── Cancel ────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setProposalInfo(null);
    setError(null);
    setParsedRevision(null);
    resetGuidedParseWorkspace("table");
  }, []);

  // ─── Set drawing mode on mount ─────────────────────────────
  useEffect(() => {
    if (!tableParseRegion && !guidedParseActive && !parsed) {
      setTableParseStepWithTool("select-region", "pointer");
    }
    // Parent tab/panel commands own shared teardown before this child unmounts. A child cleanup
    // cannot distinguish a newly mounted peer generation and therefore must not publish Parse.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      {/* Instructions */}
      {!tableParseRegion && !guidedParseActive && !parsed && (
        <div className="text-[10px] text-[var(--muted)] text-center py-4 px-2">
          Draw a bounding box around the table you want to parse.
          <br />
          <span className="text-[9px]">The system will propose row/column boundaries that you can tune.</span>
        </div>
      )}

      {/* Proposing indicator */}
      {proposing && (
        <div className="text-[10px] text-[var(--accent)] text-center py-2">Proposing grid...</div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[10px] text-red-400 px-2 py-1 rounded bg-red-500/10 border border-red-500/20">{error}</div>
      )}

      {/* Proposal info + controls */}
      {proposalInfo && guidedParseActive && (
        <>
          <div className="text-[10px] text-emerald-400 font-medium px-1">{proposalInfo}</div>

          {/* Tune section */}
          <button
            onClick={() => setShowTune(!showTune)}
            className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] px-1 flex items-center gap-1"
          >
            <span className={`transition-transform ${showTune ? "rotate-90" : ""}`}>&#9656;</span>
            Tune Detection
          </button>

          {showTune && (
            <div className="space-y-2 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface)]">
              {/* Row Sensitivity */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Row Sensitivity</label>
                  <span className="text-[9px] text-[var(--fg)] tabular-nums">{rowTolerance.toFixed(3)}</span>
                </div>
                <input type="range" min={0.002} max={0.02} step={0.001} value={rowTolerance}
                  onChange={(e) => {
                    if (!authorizeTuningChange()) return;
                    setRowTolerance(parseFloat(e.target.value));
                  }}
                  className="w-full h-1 accent-pink-400" />
                <div className="flex justify-between text-[8px] text-[var(--muted)]">
                  <span>Tight</span><span>Loose</span>
                </div>
              </div>

              {/* Column Sensitivity */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Column Sensitivity</label>
                  <span className="text-[9px] text-[var(--fg)] tabular-nums">{colGap.toFixed(3)}</span>
                </div>
                <input type="range" min={0.005} max={0.05} step={0.005} value={colGap}
                  onChange={(e) => {
                    if (!authorizeTuningChange()) return;
                    setColGap(parseFloat(e.target.value));
                  }}
                  className="w-full h-1 accent-pink-400" />
                <div className="flex justify-between text-[8px] text-[var(--muted)]">
                  <span>More cols</span><span>Fewer cols</span>
                </div>
              </div>

              {/* Column Confidence */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Column Confidence</label>
                  <span className="text-[9px] text-[var(--fg)] tabular-nums">{(colConfidence * 100).toFixed(0)}%</span>
                </div>
                <input type="range" min={0.1} max={0.8} step={0.05} value={colConfidence}
                  onChange={(e) => {
                    if (!authorizeTuningChange()) return;
                    setColConfidence(parseFloat(e.target.value));
                  }}
                  className="w-full h-1 accent-pink-400" />
                <div className="flex justify-between text-[8px] text-[var(--muted)]">
                  <span>Keep weak</span><span>Strict</span>
                </div>
              </div>

              {/* Expected Columns */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Expected Columns</label>
                  <select
                    value={expectedCols ?? "auto"}
                    onChange={(e) => {
                      if (!authorizeTuningChange()) return;
                      setExpectedCols(e.target.value === "auto" ? null : parseInt(e.target.value));
                    }}
                    className="text-[9px] px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                  >
                    <option value="auto">Auto</option>
                    {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Repeat buttons */}
          <div className="flex gap-2 px-1">
            <button
              onClick={repeatRowDown}
              disabled={tableOperation.busy || guidedParseRows.length < 3}
              className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--muted)]/40 disabled:opacity-30"
            >
              Repeat ↓
            </button>
            <button
              onClick={repeatColRight}
              disabled={tableOperation.busy || guidedParseCols.length < 3}
              className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--muted)]/40 disabled:opacity-30"
            >
              Repeat →
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 px-1 pt-1">
            <button
              onClick={handleCancel}
              className="flex-1 text-[10px] px-2 py-1.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Cancel
            </button>
            <button
              onClick={handleParse}
              disabled={tableOperation.busy || guidedParseRows.length < 2 || guidedParseCols.length < 2}
              className="flex-1 text-[10px] px-2 py-1.5 rounded border border-pink-400/40 bg-pink-500/10 text-pink-300 hover:bg-pink-500/20 disabled:opacity-30"
            >
              Parse Grid
            </button>
          </div>
        </>
      )}

      {/* Post-parse: review + map tags */}
      {parsed && tableParsedGrid && (
        <div className="space-y-2">
          <div className="text-[10px] text-emerald-400 font-medium px-1">
            Parsed: {tableParsedGrid.headers.length} columns, {tableParsedGrid.rows.length} rows
          </div>
          <button
            onClick={() => { setParsedRevision(null); handleCancel(); }}
            className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Parse Another
          </button>
          <MapTagsSection
            grid={tableParsedGrid}
            yoloInTableRegion={yoloInTableRegion}
            tagYoloClass={tagYoloClass}
            onTagYoloClassChange={setTagYoloClass}
            onMapTags={handleMapTags}
            tagMappingDone={tagMappingDone}
            tagMappingCount={tagMappingCount}
            strictness={mapTagsStrictness}
            onStrictnessChange={setMapTagsStrictness}
            drawingNumberPrefixes={drawingNumberPrefixes}
            onDrawingNumberPrefixesChange={setDrawingNumberPrefixes}
            availablePrefixes={availablePrefixes}
          />
        </div>
      )}
    </div>
  );
}
