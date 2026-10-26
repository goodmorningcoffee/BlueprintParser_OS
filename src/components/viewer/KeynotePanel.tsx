"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParseFlow } from "@/hooks/useParseFlow";
import { useProjectLifecycleGuard } from "@/hooks/useProjectLifecycleGuard";
import {
  commitParseOperation,
  useParseOperation,
  type ParseOperationToken,
} from "@/hooks/useParseOperation";
import {
  useGuidedParseExtensions,
  useKeynoteParseExtensions,
  useParseFlowStore,
} from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import {
  beginGuidedGridEdit,
  claimGuidedParseWorkspaceForOperation,
  completeKeynoteParseOperation,
  invalidateGuidedParseOperations,
  invalidateParseOperationAtRevision,
  navigateViewerPage,
  openTableReviewTarget,
  openTableReviewWorkspace,
  publishGuidedProposalForOperation,
  resetAllTools,
  resetKeynoteGuidedParse,
  setKeynoteManualInputsForUser,
  setKeynoteParseStepWithTool,
  toggleKeynoteParsePanel,
  transitionKeynoteParseTab,
} from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useUiStore } from "@/stores/uiStore";
import { useProject, useSessionStore } from "@/stores/sessionStore";
// [refactor jul11 P2.2⑦] summaries is now the cache-only {summaries,setSummaries} facade.
import { useSummaries } from "@/queries/useSummaries";
import { useAnnotations } from "@/queries/useAnnotations";
import { updatePageIntelligenceForPage, usePageIntelligenceByPage } from "@/queries/usePageWindow";
import { saveParsedRegion } from "@/queries/parsedRegions";
import { readTextractForPage } from "@/queries/textractCache";
import { useTextractForPage } from "@/queries/useTextract";
import { useYoloTagActions, useYoloTagRows } from "@/queries/useYoloTags";
import HelpTooltip from "./HelpTooltip";
import KeynoteItem from "./KeynoteItem";
import CompareEditTab from "./CompareEditTab";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import { requestMapTagsBatch } from "@/lib/client-map-tags";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import { regionIdFor, canPersist } from "@/lib/client-persist";
import ExportCsvModal from "./ExportCsvModal";
import type { YoloTag, QtoItemType } from "@/types";
// CSI detection runs server-side (csi-detect.ts uses fs); client components can't import it directly

/** Convert keynote parsedRegion data to grid format for TableCompareModal */
function keynoteDataToGrid(data: any): { headers: string[]; rows: Record<string, string>[]; tagColumn: string; tableName?: string } {
  if (data.headers && data.rows) return { headers: data.headers, rows: data.rows, tagColumn: data.tagColumn || data.headers[0], tableName: data.tableName };
  // Shape A: { keynotes: [{key, description}] } → grid
  const headers = ["Key", "Description"];
  const rows = (data.keynotes || []).map((k: any) => ({ Key: k.key || "", Description: k.description || "" }));
  return { headers, rows, tagColumn: "Key", tableName: data.tableName };
}

type KeynoteBbox = [number, number, number, number];
type KeynoteKey = { key: string; description: string };
type KeynoteCsiTag = { code: string; description: string };

type KeynotePersistTarget = {
  publicId: string;
  isDemo: boolean;
  pageNumber: number;
  bbox: KeynoteBbox;
  columnBBs: KeynoteBbox[];
  rowBBs: KeynoteBbox[];
};

type KeynoteSaveInput = {
  keys: KeynoteKey[];
  tableName?: string;
  csiTags?: KeynoteCsiTag[];
  persistToDb?: boolean;
  target: KeynotePersistTarget;
};

const EMPTY_GUIDED_LINES: number[] = [];

type KeynoteProposalOverrides = Partial<{
  rowTolerance: number;
  minColGap: number;
  minHitsRatio: number;
  expectedColumns: number | null;
}>;

type KeynoteProposalExpectation = Readonly<{
  keynoteRevision: number;
  region: KeynoteBbox;
}>;

/**
 * KeynotePanel — Keynote parsing and management tool.
 *
 * 3 tabs: All Keynotes, Guided Parse, Manual Parse
 * Keynotes are 2-column key:value tables (tag + description)
 * with YOLO shape assignment for tag-to-drawing mapping.
 *
 * Guided Parse: user draws region BB, system proposes a grid (rows+cols),
 * user adjusts lines on canvas, then parses via extractCellsFromGrid.
 *
 * `embedded`: when true the outer panel chrome (border, shadow, width, own
 * header+close-button) is skipped so the panel body can be hosted inside a
 * parent orchestrator (e.g. SpecsNotesPanel). The inner tab bar + content
 * remain intact.
 */
export default function KeynotePanel({ embedded = false }: { embedded?: boolean } = {}) {
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const pageNames = useSessionStore((s) => s.pageNames);
  const pageIntelligence = usePageIntelligenceByPage();
  // Manual parsing intentionally captures the current page payload from this render. Guided parsing
  // below remains an invocation-time read because its grid may stay open while OCR is replaced.
  const pageTextract = useTextractForPage(pageNumber);
  // [refactor jul11 P2.2⑥] Subscribe to the one chunk-windowed cache entry, not viewerStore.
  const { annotations } = useAnnotations();
  const {
    step: keynoteParseStep,
    region: keynoteParseRegion,
    reset: resetKeynoteParse,
  } = useParseFlow("keynote");
  const keynoteOperation = useParseOperation("keynote");
  const {
    keynoteParseTab,
    keynoteColumnBBs,
    keynoteRowBBs,
    keynoteYoloClass,
    parsedKeynoteData,
    addParsedKeynote,
  } = useKeynoteParseExtensions();
  const activeKeynoteHighlight = useUiStore((s) => s.activeKeynoteHighlight);
  const setActiveKeynoteHighlight = useUiStore((s) => s.setActiveKeynoteHighlight);
  const projectId = useSessionStore((s) => s.projectId);
  // One collection observer owns the whole keynote list. Passing the same row array down avoids
  // creating one query observer per expanded/collapsed KeynoteItem.
  const yoloTags = useYoloTagRows();
  // Action-only facade keeps async map responses behind the captured project/epoch guard.
  const { addYoloTagsBulk } = useYoloTagActions();
  const showParsedRegions = useUiStore((s) => s.showParsedRegions);
  const { publicId, isDemo } = useProject();
  // Context-only handle for optimistic page writes and both C2 shared save-command paths — zero
  // subscription; summaries publication happens inside the captured-target command.
  const queryClient = useQueryClient();
  const isRenderedLifecycleCurrent = useProjectLifecycleGuard(publicId, isDemo);

  // This proposed-grid workspace is shared with Table guided parsing, not Keynote-owned state.
  const {
    guidedParseOwner,
    guidedParseActive: sharedGuidedParseActive,
    guidedParseRegion: sharedGuidedParseRegion,
    guidedParseRows: sharedGuidedParseRows,
    guidedParseCols: sharedGuidedParseCols,
  } = useGuidedParseExtensions();
  const ownsGuidedWorkspace = guidedParseOwner === "keynote";
  const guidedParseActive = ownsGuidedWorkspace && sharedGuidedParseActive;
  const guidedParseRegion = ownsGuidedWorkspace ? sharedGuidedParseRegion : null;
  const guidedParseRows = ownsGuidedWorkspace ? sharedGuidedParseRows : EMPTY_GUIDED_LINES;
  const guidedParseCols = ownsGuidedWorkspace ? sharedGuidedParseCols : EMPTY_GUIDED_LINES;

  // Coordinated page navigation already resets Parse before core.setPage. Direct unmounts may
  // revoke only the exact revision rendered by this instance, never a reentrant replacement B.
  useEffect(() => () => {
    invalidateParseOperationAtRevision("keynote", keynoteOperation.revision);
  }, [keynoteOperation.revision]);

  const captureKeynoteTarget = useCallback((bbox: KeynoteBbox | null): KeynotePersistTarget => ({
    publicId,
    isDemo,
    pageNumber,
    bbox: bbox ? [...bbox] as KeynoteBbox : [0, 0, 1, 1],
    columnBBs: keynoteColumnBBs.map((entry) => [...entry] as KeynoteBbox),
    rowBBs: keynoteRowBBs.map((entry) => [...entry] as KeynoteBbox),
  }), [publicId, isDemo, pageNumber, keynoteColumnBBs, keynoteRowBBs]);

  // Save parsed keynotes to pageIntelligence so All Keynotes tab persists
  // across panel close. Writes the full grid shape (headers + rows +
  // tagColumn + tableName) so ParseRegionLayer renders row/column grid lines
  // over the saved region, matching the Table Parse behavior. The legacy
  // `keynotes: [{key, description}]` field is retained for backward compat
  // with existing saved regions read via keynoteDataToGrid().
  // Optional colBoundaries / rowBoundaries capture the user's Manual-mode
  // column/row BBs so the rendered grid lines match exact placements
  // instead of falling back to uniform boundaries derived from header count.
  // Saves parsed keynotes. Routes through the transactional /api/regions/promote
  // (upsert) helper instead of the old pages/intelligence blob-overwrite, with a
  // stable regionId derived from the keynote region bbox so re-parsing the same
  // region REPLACES the prior region instead of stacking duplicates. THROWS on
  // failure so callers surface it (was previously fire-and-forget → silent loss).
  // Gated on publicId (canPersist), NOT the numeric projectId (starts at 0).
  // After a successful DB write we adopt the server's authoritative
  // intelligence + summaries (mirrors NotesParser).
  const saveKeynoteToIntelligence = useCallback(async (
    input: KeynoteSaveInput,
    token: ParseOperationToken<"keynote">,
  ): Promise<boolean> => {
    const canPublish = () =>
      isRenderedLifecycleCurrent() && keynoteOperation.isCurrent(token);
    // A nested helper inherits admission. It may finish durable work that it starts here, but it
    // must not begin new Query/persistence work after a synchronous subscriber has already revoked A.
    if (!canPublish()) return false;
    const keys = input.keys.map((entry) => ({ ...entry }));
    const csiTags = input.csiTags?.map((entry) => ({ ...entry })) ?? [];
    const persistToDb = input.persistToDb ?? true;
    const target = input.target;
    const headers = ["Key", "Description"];
    const rows = keys.map((k) => ({ Key: k.key, Description: k.description }));

    // If user drew Manual-mode column BBs, derive column boundaries from them
    // (normalized 0-1 X positions). Draws all verticals at BB edges so the
    // rendered grid matches the user's hand-drawn layout exactly.
    const colBBs = target.columnBBs;
    const rowBBs = target.rowBBs;
    let colBoundaries: number[] | undefined;
    let rowBoundaries: number[] | undefined;
    if (colBBs.length > 0) {
      const cb: number[] = [colBBs[0][0]];
      for (const bb of colBBs) cb.push(bb[2]);
      colBoundaries = cb;
    }
    if (rowBBs.length > 0) {
      const rb: number[] = [rowBBs[0][1]];
      for (const bb of rowBBs) rb.push(bb[3]);
      rowBoundaries = rb;
    }

    const bbox = target.bbox;
    const regionId = regionIdFor(target.pageNumber, bbox);
    const data = {
      headers,
      rows,
      tagColumn: "Key",
      tableName: input.tableName || "Keynotes",
      rowCount: rows.length,
      columnCount: headers.length,
      keynotes: keys.map((k) => ({ key: k.key, description: k.description })),
      isPageSpecific: true,
      ...(colBoundaries ? { colBoundaries } : {}),
      ...(rowBoundaries ? { rowBoundaries } : {}),
    };
    // Optimistic local write so the region renders immediately.
    const newRegion = {
      id: regionId,
      type: "keynote" as const,
      category: "keynote-table",
      bbox,
      confidence: 0.9,
      csiTags,
      data,
    };
    // Functional publication is the handler-live read: preserve any page fields/regions written
    // since render while installing this one already-created region synchronously.
    updatePageIntelligenceForPage(queryClient, target.publicId, target.pageNumber, (current) => ({
      ...(current ?? {}),
      // The legacy keynote payload carries the CSI subset returned by /csi/detect; the server
      // enriches it on promote. Keep that established wire shape at this compatibility boundary.
      parsedRegions: [...(current?.parsedRegions ?? []), newRegion as any],
    }));

    // Query observers are synchronous. If that optimistic publication handed the workspace to B,
    // A must not start a fresh persistence/spatial request afterward.
    if (!canPublish()) return false;

    if (!persistToDb) return true;
    if (canPersist(target.publicId, target.isDemo)) {
      // C2 correction: persistent spatial recompute belongs after authoritative adoption. The
      // command owns P -> A -> S? -> X; local/demo keeps the original wrapper path below.
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
          type: "keynote",
          regionId,
          bboxMinMax: bbox,
          data,
          category: "keynote-table",
          csiTags,
        },
      );
      if (!canPublish()) return false;
    } else {
      // Preserve the synchronous local/demo spatial publication; do not await the command's local
      // result and insert a microtask into the existing UI sequence.
      refreshPageCsiSpatialMap(queryClient, target.publicId, target.pageNumber);
      if (!canPublish()) return false;
    }
    return true;
  }, [isRenderedLifecycleCurrent, queryClient, keynoteOperation.isCurrent]);

  const [autoParsingRevision, setAutoParsingRevision] = useState<number | null>(null);
  const autoParsing = keynoteOperation.busy && autoParsingRevision === keynoteOperation.revision;
  const [showExportModal, setShowExportModal] = useState(false);
  // Surfaces keynote-save failures so a parsed keynote is never silently lost
  // (these writes were previously fire-and-forget).
  const [keynoteSaveError, setKeynoteSaveError] = useState<string | null>(null);

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
  const loadExistingKeynote = useCallback((parsed: any, targetPage?: number) => {
    const grid = keynoteDataToGrid(parsed.data || {});
    const publication = {
      region: parsed.bbox
        ? [parsed.bbox[0], parsed.bbox[1], parsed.bbox[2], parsed.bbox[3]] as KeynoteBbox
        : null,
      grid: {
        headers: grid.headers,
        rows: grid.rows,
        tagColumn: grid.tagColumn,
        tableName: grid.tableName, regionId: parsed.id,
      },
      meta: null,
    };
    if (targetPage !== undefined && targetPage !== pageNumber) {
      openTableReviewTarget(targetPage, publication, "keynote");
    } else {
      openTableReviewWorkspace(publication, "keynote");
    }
  }, [pageNumber]);

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
  // Phase 4: replaces the legacy client-side mapYoloToOcrText loop with one typed
  // map-tags-batch request per parse. Preserves scope:"page"
  // semantics by passing `selectedPages: [pageNumber]`. Results come back
  // as ScoredMatch[] which is a structural superset of YoloTagInstance.
  const mapKeynoteKeysToYoloTags = useCallback(async (params: {
    publicId: string;
    keys: KeynoteKey[];
    yoloClass?: string;
    yoloModel?: string;
    pageNumber: number;
  }, token: ParseOperationToken<"keynote">): Promise<boolean> => {
    const canPublish = () =>
      isRenderedLifecycleCurrent() && keynoteOperation.isCurrent(token);
    if (!canPublish()) return false;
    const { publicId, keys, yoloClass, yoloModel, pageNumber } = params;
    if (!publicId) return false;
    const uniqueKeys = [...new Set(
      keys.map((k) => k.key?.trim()).filter((k): k is string => Boolean(k)),
    )];
    if (uniqueKeys.length === 0) return true;
    const descByKey = new Map<string, string>();
    for (const k of keys) {
      if (k.key?.trim()) descByKey.set(k.key.trim(), k.description);
    }
    const itemType: QtoItemType = yoloClass ? "yolo-with-inner-text" : "text-only";
    try {
      const result = await requestMapTagsBatch(
        publicId,
        {
          tags: uniqueKeys,
          yoloClass: yoloClass || undefined,
          yoloModel: yoloModel || undefined,
          itemType,
          selectedPages: [pageNumber],
        },
      );
      if (!isRenderedLifecycleCurrent()) return false;
      if (!result.ok) {
        commitParseOperation(token, () => {
          console.error(`[KeynotePanel] Map Tags failed: HTTP ${result.status}`);
        });
        return true;
      }
      const { results } = result.data;
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
      // Captured-key Query adoption may settle for A; subsequent parse/tool/reset tails still
      // re-authorize through the inherited token.
      if (!isRenderedLifecycleCurrent()) return false;
      if (newTags.length > 0) addYoloTagsBulk(newTags);
    } catch (e) {
      if (canPublish()) {
        commitParseOperation(token, () => {
          console.error("[KeynotePanel] Map Tags error", e);
        });
      }
    }
    return canPublish();
  }, [addYoloTagsBulk, isRenderedLifecycleCurrent, keynoteOperation.isCurrent]);

  // ─── Parse keynotes from column/row intersections ───────
  const parseKeynotes = useCallback(async () => {
    if (!isRenderedLifecycleCurrent()) return;
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
      const started = keynoteOperation.begin();
      if (started.status === "busy") return;
      const token = started.token;
      const canPublish = () =>
        isRenderedLifecycleCurrent() && keynoteOperation.isCurrent(token);

      try {
        const targetKeys = keys.map((entry) => ({ ...entry }));
        const target = captureKeynoteTarget(keynoteParseRegion as KeynoteBbox | null);
        const targetYoloClass = keynoteYoloClass ? { ...keynoteYoloClass } : null;
        const tableName = `Keynotes p.${target.pageNumber}`;
        const admitted = commitParseOperation(token, () => {
          setKeynoteSaveError(null);
          addParsedKeynote({
            pageNumber: target.pageNumber,
            keys: targetKeys,
            yoloClass: targetYoloClass
              ? `${targetYoloClass.model}:${targetYoloClass.className}`
              : undefined,
            tableName,
          });
        });
        if (!admitted || !canPublish()) return;

        // Auto-persist on parse. The helper starts only while this token is current; once started,
        // its captured Query/durable work may settle even if a later flow revokes the UI owner.
        const saved = await saveKeynoteToIntelligence({
          keys: targetKeys,
          tableName,
          target,
        }, token);
        if (!saved || !canPublish()) return;
        const mapped = await mapKeynoteKeysToYoloTags({
          publicId: target.publicId,
          keys: targetKeys,
          yoloClass: targetYoloClass?.className,
          yoloModel: targetYoloClass?.model,
          pageNumber: target.pageNumber,
        }, token);
        if (!mapped || !canPublish()) return;
        completeKeynoteParseOperation(token);
      } catch (err) {
        if (canPublish()) {
          commitParseOperation(token, () => {
            setKeynoteSaveError(err instanceof Error ? err.message : "Could not save keynotes");
          });
        }
      } finally {
        if (isRenderedLifecycleCurrent()) keynoteOperation.finish(token);
      }
    }
  }, [
    pageTextract,
    keynoteColumnBBs,
    keynoteRowBBs,
    keynoteYoloClass,
    keynoteParseRegion,
    addParsedKeynote,
    captureKeynoteTarget,
    isRenderedLifecycleCurrent,
    saveKeynoteToIntelligence,
    mapKeynoteKeysToYoloTags,
    keynoteOperation.begin,
    keynoteOperation.finish,
    keynoteOperation.isCurrent,
  ]);

  // ─── Auto parse via API ─────────────────────────────────
  const autoParseKeynote = useCallback(async (bbox: [number, number, number, number]) => {
    if (!isRenderedLifecycleCurrent()) return;
    const started = keynoteOperation.begin();
    if (started.status === "busy") return;
    const token = started.token;
    const canPublish = () =>
      isRenderedLifecycleCurrent() && keynoteOperation.isCurrent(token);

    try {
      const targetProjectId = projectId;
      const target = captureKeynoteTarget(bbox);
      const tableName = `Keynotes p.${target.pageNumber}`;
      const admitted = commitParseOperation(token, () => {
        setAutoParsingRevision(token.revision);
        setKeynoteSaveError(null);
      });
      if (!admitted) return;

      const resp = await fetch("/api/table-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: targetProjectId,
          pageNumber: target.pageNumber,
          regionBbox: target.bbox,
        }),
      });
      if (!canPublish()) return;
      if (!resp.ok) throw new Error("API error");
      const result = await resp.json();
      if (!canPublish()) return;
      if (result.headers?.length >= 2 && result.rows?.length > 0) {
        // First column = key, rest = description
        const tagHeader = result.headers[0];
        const descHeaders = result.headers.slice(1);
        const keys = result.rows.map((row: any) => ({
          key: (row[tagHeader] || "").trim(),
          description: descHeaders.map((h: string) => row[h] || "").join(" ").trim(),
        })).filter((k: any) => k.key || k.description);

        if (keys.length > 0) {
          const targetKeys: KeynoteKey[] = keys.map((entry: KeynoteKey) => ({ ...entry }));
          const completionPublished = commitParseOperation(token, () => {
            setKeynoteSaveError(null);
            addParsedKeynote({
              pageNumber: target.pageNumber,
              keys: targetKeys,
              tableName,
            });
          });
          if (!completionPublished || !canPublish()) return;

          const saved = await saveKeynoteToIntelligence({
            keys: targetKeys,
            tableName,
            csiTags: result.csiTags || [],
            target,
          }, token);
          if (!saved || !canPublish()) return;
          // Auto-parse doesn't pick a YOLO class, so we map as text-only.
          const mapped = await mapKeynoteKeysToYoloTags({
            publicId: target.publicId,
            keys: targetKeys,
            pageNumber: target.pageNumber,
          }, token);
          if (!mapped || !canPublish()) return;
          completeKeynoteParseOperation(token);
        }
      }
    } catch (err) {
      if (canPublish()) {
        commitParseOperation(token, () => {
          console.error("[keynote auto-parse] Failed:", err);
          setKeynoteSaveError(err instanceof Error ? err.message : "Auto-parse failed");
        });
      }
    } finally {
      if (isRenderedLifecycleCurrent()) keynoteOperation.finish(token);
    }
  }, [
    projectId,
    addParsedKeynote,
    captureKeynoteTarget,
    isRenderedLifecycleCurrent,
    saveKeynoteToIntelligence,
    mapKeynoteKeysToYoloTags,
    keynoteOperation.begin,
    keynoteOperation.finish,
    keynoteOperation.isCurrent,
  ]);

  // ─── Guided parse: propose grid ─────────────────────────
  const [proposalRevision, setProposalRevision] = useState<number | null>(null);
  const guidedLoading = keynoteOperation.busy && proposalRevision === keynoteOperation.revision;
  const [guidedError, setGuidedError] = useState<string | null>(null);
  const [showGuidedTune, setShowGuidedTune] = useState(false);
  const [guidedRowTol, setGuidedRowTol] = useState(0.006);
  const [guidedColGap, setGuidedColGap] = useState(0.015);
  const [guidedColConf, setGuidedColConf] = useState(0.3);
  const [guidedExpCols, setGuidedExpCols] = useState<number | null>(2); // keynotes default 2

  const proposeGrid = useCallback(async (
    overrides: KeynoteProposalOverrides = {},
    expectation?: KeynoteProposalExpectation,
  ) => {
    const region = useParseFlowStore.getState().keynoteParseRegion;
    if (!region || !projectId) return;
    if (expectation) {
      const before = useParseFlowStore.getState();
      if (
        before.guidedParseOwner !== "keynote" ||
        before.parseOperations.keynote.revision !== expectation.keynoteRevision ||
        before.parseOperations.keynote.busy ||
        before.keynoteParseRegion !== expectation.region
      ) return;
    }
    const started = keynoteOperation.begin("supersede");
    if (started.status === "busy") return;
    const token = started.token;

    try {
      const target = {
        projectId,
        pageNumber,
        regionBbox: [...region] as KeynoteBbox,
        rowTolerance: overrides.rowTolerance ?? guidedRowTol,
        minColGap: overrides.minColGap ?? guidedColGap,
        minHitsRatio: overrides.minHitsRatio ?? guidedColConf,
        expectedColumns: overrides.expectedColumns === undefined
          ? guidedExpCols
          : overrides.expectedColumns,
      };
      // The proposed grid is a Table/Keynote/Notes shared workspace. Revoke peer owners before the
      // first shared seed while retaining this newly admitted Keynote token.
      const workspaceLease = claimGuidedParseWorkspaceForOperation(token, target.regionBbox);
      if (!workspaceLease) return;
      const admitted = commitParseOperation(token, () => {
        setProposalRevision(token.revision);
        setGuidedError(null);
      });
      if (!admitted || !keynoteOperation.isCurrent(token)) return;

      const resp = await fetch("/api/table-parse/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: target.projectId,
          pageNumber: target.pageNumber,
          regionBbox: target.regionBbox,
          layoutHint: target.expectedColumns ? { columns: target.expectedColumns } : undefined,
          gridOptions: {
            rowTolerance: target.rowTolerance,
            minColGap: target.minColGap,
            minHitsRatio: target.minHitsRatio,
          },
        }),
      });
      if (!resp.ok) throw new Error("Proposal failed");
      const data = await resp.json();
      publishGuidedProposalForOperation(
        token,
        data.proposedRows || [],
        data.proposedCols || [],
      );
    } catch (err: any) {
      commitParseOperation(token, () => {
        setGuidedError(err.message || "Failed to propose grid");
      });
    } finally {
      keynoteOperation.finish(token);
    }
  }, [
    projectId,
    pageNumber,
    guidedRowTol,
    guidedColGap,
    guidedColConf,
    guidedExpCols,
    keynoteOperation.begin,
    keynoteOperation.finish,
    keynoteOperation.isCurrent,
  ]);

  const retuneGuidedGrid = useCallback((
    overrides: KeynoteProposalOverrides,
    publishLocal: () => void,
  ) => {
    if (!keynoteParseRegion) return;
    const lease = beginGuidedGridEdit("keynote", guidedParseRegion);
    if (!lease) return;
    publishLocal();
    void proposeGrid(overrides, {
      keynoteRevision: lease.keynoteRevision,
      region: keynoteParseRegion,
    });
  }, [guidedParseRegion, keynoteParseRegion, proposeGrid]);

  // ─── Guided parse: parse from grid ─────────────────────
  const parseFromGuidedGrid = useCallback(async () => {
    if (!isRenderedLifecycleCurrent()) return;
    // Unlike the manual path, guided parsing is a live action read: a user can leave the grid open
    // across an OCR replacement. The imperative facade touches LRU recency without an observer.
    const pageTextract = readTextractForPage(queryClient, publicId, pageNumber);
    if (!ownsGuidedWorkspace || !pageTextract?.words ||
        guidedParseRows.length < 2 || guidedParseCols.length < 2) return;

    const result = extractCellsFromGrid(pageTextract.words, guidedParseRows, guidedParseCols);
    if (result.rows.length === 0) return;

    const started = keynoteOperation.begin();
    if (started.status === "busy") return;
    const token = started.token;
    const canPublish = () =>
      isRenderedLifecycleCurrent() && keynoteOperation.isCurrent(token);

    try {
      const target = {
        publicId,
        isDemo,
        pageNumber,
        bbox: guidedParseRegion
          ? [...guidedParseRegion] as KeynoteBbox
          : [0, 0, 1, 1] as KeynoteBbox,
        headers: [...result.headers],
        rows: result.rows.map((row) => ({ ...row })),
      };
      const regionId = regionIdFor(target.pageNumber, target.bbox);
      const data = {
        headers: target.headers,
        rows: target.rows,
        tagColumn: target.headers[0],
        tableName: "Keynotes",
        rowCount: target.rows.length,
        columnCount: target.headers.length,
      };
      const tagHeader = target.headers[0];
      const descHeaders = target.headers.slice(1);
      const keys: KeynoteKey[] = target.rows.map((row: any) => ({
        key: (row[tagHeader] || "").trim(),
        description: descHeaders.map((header) => row[header] || "").join(" ").trim(),
      })).filter((keynote) => keynote.key || keynote.description);

      const workspaceAdmitted = commitParseOperation(token, () => {
        invalidateGuidedParseOperations("keynote");
      });
      if (!workspaceAdmitted || !canPublish()) return;
      const admitted = commitParseOperation(token, () => {
        setKeynoteSaveError(null);
      });
      if (!admitted || !canPublish()) return;

      // Detect CSI
      let csiTags: KeynoteCsiTag[] = [];
      try {
        const csiResp = await fetch("/api/csi/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ headers: target.headers, rows: target.rows }),
        });
        if (!canPublish()) return;
        if (csiResp.ok) {
          const csiData = await csiResp.json();
          if (!canPublish()) return;
          csiTags = csiData.csiTags || [];
        }
      } catch { /* best-effort */ }

      // CSI was the admitted request. Do not launch a new optimistic/promotion/map chain if a page,
      // tab, grid edit, or parser handoff revoked this root while CSI was pending.
      if (!canPublish()) return;

      // Save as parsed keynote (optimistic local write).
      const newRegion = {
        id: regionId,
        type: "keynote" as const,
        category: "keynote-table",
        bbox: target.bbox,
        confidence: 0.85,
        csiTags,
        data,
      };
      updatePageIntelligenceForPage(queryClient, target.publicId, target.pageNumber, (current) => ({
        ...(current ?? {}),
        parsedRegions: [...(current?.parsedRegions ?? []), newRegion as any],
      }));

      // The optimistic Query write can synchronously hand control to B. Re-authorize before any
      // additional local publication or newly launched promotion/spatial work.
      if (!canPublish()) return;

      // Also save as parsedKeynoteData for All Keynotes tab
      if (keys.length > 0) {
        const appendPublished = commitParseOperation(token, () => {
          addParsedKeynote({
            pageNumber: target.pageNumber,
            keys,
            tableName: `Keynotes p.${target.pageNumber}`,
          });
        });
        if (!appendPublished || !canPublish()) return;
      }

      // Auto-persist on parse via the transactional promote upsert. Gated on
      // publicId (canPersist), NOT numeric projectId. Throws on failure → we
      // surface it and bail before reset so the user can retry.
      if (canPersist(target.publicId, target.isDemo)) {
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
            type: "keynote",
            regionId,
            bboxMinMax: target.bbox,
            data,
            category: "keynote-table",
            csiTags,
          },
        );
        if (!canPublish()) return;
      } else {
        refreshPageCsiSpatialMap(queryClient, target.publicId, target.pageNumber);
        if (!canPublish()) return;
      }

      if (keys.length > 0) {
        const mapped = await mapKeynoteKeysToYoloTags({
          publicId: target.publicId,
          keys,
          pageNumber: target.pageNumber,
        }, token);
        if (!mapped || !canPublish()) return;
      }

      if (!canPublish()) return;
      completeKeynoteParseOperation(token, { resetGuided: true });
    } catch (err) {
      if (canPublish()) {
        commitParseOperation(token, () => {
          setKeynoteSaveError(err instanceof Error ? err.message : "Could not save keynotes");
        });
      }
    } finally {
      if (isRenderedLifecycleCurrent()) keynoteOperation.finish(token);
    }
  }, [
    pageNumber,
    publicId,
    isDemo,
    guidedParseRows,
    guidedParseCols,
    guidedParseRegion,
    ownsGuidedWorkspace,
    addParsedKeynote,
    isRenderedLifecycleCurrent,
    mapKeynoteKeysToYoloTags,
    queryClient,
    keynoteOperation.begin,
    keynoteOperation.finish,
    keynoteOperation.isCurrent,
  ]);

  // ─── Repeat row down ───────────────────────────────────
  const repeatRowDown = useCallback((rowBB: [number, number, number, number]) => {
    if (!keynoteParseRegion) return;
    const rowH = rowBB[3] - rowBB[1];
    const bottom = keynoteParseRegion[3];
    let y = rowBB[3];
    const keynoteRowBBsNext = [...keynoteRowBBs];
    while (y + rowH * 0.5 < bottom) {
      keynoteRowBBsNext.push([rowBB[0], y, rowBB[2], Math.min(y + rowH, bottom)]);
      y += rowH;
    }
    if (keynoteRowBBsNext.length === keynoteRowBBs.length) return;
    setKeynoteManualInputsForUser({ keynoteRowBBs: keynoteRowBBsNext });
  }, [keynoteParseRegion, keynoteRowBBs]);

  // ─── Repeat column right ──────────────────────────────
  const repeatColumnRight = useCallback((colBB: [number, number, number, number]) => {
    if (!keynoteParseRegion) return;
    const colW = colBB[2] - colBB[0];
    const right = keynoteParseRegion[2];
    let x = colBB[2];
    const keynoteColumnBBsNext = [...keynoteColumnBBs];
    while (x + colW * 0.5 < right) {
      keynoteColumnBBsNext.push([x, colBB[1], Math.min(x + colW, right), colBB[3]]);
      x += colW;
    }
    if (keynoteColumnBBsNext.length === keynoteColumnBBs.length) return;
    setKeynoteManualInputsForUser({ keynoteColumnBBs: keynoteColumnBBsNext });
  }, [keynoteColumnBBs, keynoteParseRegion]);

  const handleKeynoteYoloClassChange = useCallback((selection: {
    model: string;
    className: string;
  }) => {
    setKeynoteManualInputsForUser({ keynoteYoloClass: selection });
  }, []);

  const handleNavigatePage = useCallback((nextPage: number) => {
    navigateViewerPage(nextPage);
  }, []);

  const handleKeynoteTabChange = useCallback((tab: typeof keynoteParseTab) => {
    transitionKeynoteParseTab(tab);
  }, []);

  // ─── Render ─────────────────────────────────────────────
  return (
    <div className={embedded ? "flex flex-col h-full" : "w-80 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg"}>
      {/* Header — skipped in embedded mode (parent orchestrator owns it). */}
      {!embedded && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
          <h3 className="text-sm font-semibold text-[var(--fg)]">Keynotes</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => useUiStore.getState().toggleParsedRegions()}
              className={`text-sm px-1 ${showParsedRegions ? "text-amber-300" : "text-[var(--muted)]/30"}`}
              title="Toggle region outlines on canvas"
            >
              {showParsedRegions ? "\u25CF" : "\u25CB"}
            </button>
            {keynoteParseStep !== "idle" && (
              <button
                onClick={resetAllTools}
                className="text-[10px] px-2 py-0.5 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                title="Cancel the current parse (clears BBs + region, stays on this tab)"
              >
                Cancel
              </button>
            )}
            <button onClick={toggleKeynoteParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
          </div>
        </div>
      )}

      {/* Embedded-mode Cancel row — parent orchestrator owns the header+close
          button, so surface Cancel here when a parse is mid-flight. */}
      {embedded && keynoteParseStep !== "idle" && (
        <div className="px-3 py-1 border-b border-[var(--border)] flex justify-end">
          <button
            onClick={resetAllTools}
            className="text-[10px] px-2 py-0.5 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
            title="Cancel the current parse (clears BBs + region, stays on this tab)"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "auto", "guided", "manual", "compare"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => handleKeynoteTabChange(tab)}
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
        {keynoteSaveError && (
          <div className="text-[10px] text-red-400 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 flex items-start justify-between gap-2">
            <span>{keynoteSaveError}</span>
            <button onClick={() => setKeynoteSaveError(null)} className="text-red-400/70 hover:text-red-300 shrink-0">&times;</button>
          </div>
        )}
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
                        onNavigate={() => handleNavigatePage(kn.pageNumber)}
                        activeHighlight={activeKeynoteHighlight}
                        onHighlight={(key) => setActiveKeynoteHighlight(
                          activeKeynoteHighlight?.key === key && activeKeynoteHighlight?.pageNumber === kn.pageNumber
                            ? null
                            : { pageNumber: kn.pageNumber, key }
                        )}
                        onDelete={() => {
                          const store = useParseFlowStore.getState();
                          const all = store.parsedKeynoteData;
                          if (all) {
                            store.setParsedKeynoteData(all.filter((entry) =>
                              !(entry.pageNumber === kn.pageNumber && entry.tableName === kn.tableName)
                            ));
                          }
                        }}
                        region={matchingRegion}
                        publicId={publicId}
                        yoloTags={yoloTags}
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
                    resetKeynoteGuidedParse();
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
                        onChange={(e) => {
                          const value = parseFloat(e.target.value);
                          retuneGuidedGrid(
                            { rowTolerance: value },
                            () => setGuidedRowTol(value),
                          );
                        }}
                        className="w-full h-1 accent-amber-400" />
                      <div className="flex justify-between text-[8px] text-[var(--muted)]"><span>Tight</span><span>Loose</span></div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-[var(--muted)]">Column Sensitivity</label>
                        <span className="text-[9px] text-[var(--fg)] tabular-nums">{guidedColGap.toFixed(3)}</span>
                      </div>
                      <input type="range" min={0.005} max={0.05} step={0.005} value={guidedColGap}
                        onChange={(e) => {
                          const value = parseFloat(e.target.value);
                          retuneGuidedGrid(
                            { minColGap: value },
                            () => setGuidedColGap(value),
                          );
                        }}
                        className="w-full h-1 accent-amber-400" />
                      <div className="flex justify-between text-[8px] text-[var(--muted)]"><span>More cols</span><span>Fewer cols</span></div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-[var(--muted)]">Column Confidence</label>
                        <span className="text-[9px] text-[var(--fg)] tabular-nums">{(guidedColConf * 100).toFixed(0)}%</span>
                      </div>
                      <input type="range" min={0.1} max={0.8} step={0.05} value={guidedColConf}
                        onChange={(e) => {
                          const value = parseFloat(e.target.value);
                          retuneGuidedGrid(
                            { minHitsRatio: value },
                            () => setGuidedColConf(value),
                          );
                        }}
                        className="w-full h-1 accent-amber-400" />
                      <div className="flex justify-between text-[8px] text-[var(--muted)]"><span>Keep weak</span><span>Strict</span></div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] text-[var(--muted)]">Expected Columns</label>
                        <select value={guidedExpCols ?? "auto"}
                          onChange={(e) => {
                            const value = e.target.value === "auto" ? null : parseInt(e.target.value);
                            retuneGuidedGrid(
                              { expectedColumns: value },
                              () => setGuidedExpCols(value),
                            );
                          }}
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
                  disabled={keynoteOperation.busy}
                  className="w-full text-xs px-3 py-2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 font-medium"
                >
                  Parse Keynotes
                </button>
                <button
                  onClick={() => {
                    resetKeynoteGuidedParse();
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
                  <span className="text-amber-300">Region selected. Click &quot;Propose Grid&quot; to auto-detect rows and columns.</span>
                </div>
                <button
                  onClick={() => proposeGrid()}
                  disabled={guidedLoading}
                  className="w-full text-xs px-3 py-2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 font-medium disabled:opacity-50"
                >
                  {guidedLoading ? "Proposing..." : "Propose Grid (2-col Keynote)"}
                </button>
                {guidedError && <p className="text-red-400 text-[10px] px-1">{guidedError}</p>}
                <button
                  onClick={() => {
                    resetKeynoteGuidedParse();
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
                  Draw a bounding box around the keynote table, then click &quot;Propose Grid&quot;.
                  <br /><span className="text-[9px]">Exclude any title text (e.g. &quot;KEYNOTES&quot;) that sits above the table.</span>
                </div>
                <HelpTooltip id="keynote-guided-draw"><button
                  onClick={() => {
                    const next = keynoteParseStep === "select-region" ? "idle" : "select-region";
                    setKeynoteParseStepWithTool(next, next !== "idle" ? "pointer" : "move");
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
                    onDoubleClick={() => handleNavigatePage(ck.pageNum)}
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
                  setKeynoteParseStepWithTool(next, next !== "idle" ? "pointer" : "move");
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
                  onClick={resetKeynoteParse}
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
                    setKeynoteParseStepWithTool(next, next !== "idle" ? "pointer" : "move");
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
                        onClick={() => handleKeynoteYoloClassChange({
                          model: g.model,
                          className: g.className,
                        })}
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
                  Draw a BB around each row. Use &quot;Repeat Down&quot; after the first to auto-fill evenly spaced rows.
                </div>
                <button
                  onClick={() => {
                    const next = keynoteParseStep === "define-row" ? "idle" : "define-row";
                    setKeynoteParseStepWithTool(next, next !== "idle" ? "pointer" : "move");
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
                  disabled={keynoteOperation.busy}
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
                  onClick={resetKeynoteParse}
                  className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Parse Another
                </button>
              </div>
            ) : keynoteParseRegion ? (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--muted)] px-1">
                  <span className="text-amber-300">Region selected.</span> Click &quot;Auto Parse&quot; to detect rows and columns automatically.
                </div>
                <button
                  onClick={() => autoParseKeynote(keynoteParseRegion as [number, number, number, number])}
                  disabled={keynoteOperation.busy}
                  className="w-full text-xs px-3 py-2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 font-medium disabled:opacity-50"
                >
                  {autoParsing ? "Parsing..." : "Auto Parse Keynotes"}
                </button>
                <button
                  onClick={resetKeynoteParse}
                  className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Clear Region
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--muted)] px-1">
                  Draw a bounding box around the keynote table, then click &quot;Auto Parse&quot;.
                  <br /><span className="text-[9px]">Exclude any title text above the table.</span>
                </div>
                <button
                  onClick={() => {
                    const next = keynoteParseStep === "select-region" ? "idle" : "select-region";
                    setKeynoteParseStepWithTool(next, next !== "idle" ? "pointer" : "move");
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
                    onDoubleClick={() => handleNavigatePage(ck.pageNum)}
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
          />
        )}
      </div>
    </div>
  );
}
