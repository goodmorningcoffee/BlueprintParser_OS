"use client";

// [TP-3 WP-3.O] The Tables & Notes workspace on the page (PLAN §3.1). Mounted inside ProposalFocusLayer's root (so
// PDFPage.tsx, pinned by several topology freezes, needs no edit), above the proposal outlines and beneath the
// hover / focus boxes. It renders ONLY while the workspace is open AND
//   • the selected item's page is this page (its draft's page, K29, else its inbox row's page): the structure lines
//     (StructureLines), shape-key markers (ShapeKeyMarkers) and line handles (LineHandles) of a table, or the
//     paragraph boxes (ParagraphBoxes) of a notes / spec item, all after the draft's correction ops; or
//   • a box draw is armed here (BoxDrawCapture): "+ Region" on the page on screen, or an item-bound draw on the
//     item's page.
// The root is `pointer-events: none` like its parent; only handles, red key markers, rails and the capture take the
// pointer. No `window` listener (§1.6 rule 14): keys are handled on focused elements, and Enter / Del never bubble
// out of this layer to the annotation dispatcher.

import { useCallback, useMemo, useRef } from "react";
import { PARSE_ENGINE_CAPS, type CorrectionOp } from "@/lib/parse-engine/types";
import { useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useWorkspaceCanvasStore } from "@/stores/workspaceCanvasStore";
import { isolateDispatcherKeys } from "../keyboard";
import BoxDrawCapture, { type DrawMode } from "./BoxDrawCapture";
import LineHandles, { type ToPage } from "./LineHandles";
import ParagraphBoxes from "./ParagraphBoxes";
import ShapeKeyMarkers from "./ShapeKeyMarkers";
import StructureLines from "./StructureLines";
import { canvasLines, isTableModel, partBoxes, previewModel } from "./lineModel";

export default function WorkspaceCanvasLayer({ pageNumber }: { pageNumber: number }) {
  const open = useTablesWorkspaceStore((s) => s.open && s.enabled);
  const selectedKey = useTablesWorkspaceStore((s) => s.selectedKey);
  const draft = useTablesWorkspaceStore((s) => (s.selectedKey ? s.drafts[s.selectedKey] : undefined));
  const queuePage = useTablesWorkspaceStore((s) => (s.selectedKey ? s.queue.find((q) => q.id === s.selectedKey)?.page : undefined));
  const correction = useTablesWorkspaceStore((s) => s.correction);
  const armed = useWorkspaceCanvasStore((s) => s.armed);
  const currentPage = useViewerCoreStore((s) => s.pageNumber);
  const rootRef = useRef<HTMLDivElement>(null);

  const result = draft?.result ?? null;
  const ops = draft?.ops;
  const view = useMemo(() => {
    if (!result || !ops) return null;
    const preview = previewModel(result, ops);
    if (!isTableModel(preview.model)) return { preview, rows: [], cols: [] };
    return { preview, rows: canvasLines(result, ops, preview, "rows"), cols: canvasLines(result, ops, preview, "cols") };
  }, [result, ops]);

  const toPage: ToPage = useCallback((clientX, clientY) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return [(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height];
  }, []);

  const emit = useCallback((op: CorrectionOp) => {
    const state = useTablesWorkspaceStore.getState();
    const key = state.selectedKey;
    const current = key ? state.drafts[key] : undefined;
    if (!key || !current || current.ops.length >= PARSE_ENGINE_CAPS.ops) return;
    state.setDraftOps(key, [...current.ops, op]);
  }, []);

  if (!open) return null;
  const itemPage = draft?.page ?? queuePage ?? null;
  const itemHere = selectedKey !== null && itemPage === pageNumber;
  const drawMode: DrawMode | null =
    correction === "draw-region" && pageNumber === currentPage
      ? "draw-region"
      : armed && itemHere && armed.itemKey === selectedKey
        ? armed.mode
        : null;
  if (!itemHere && !drawMode) return null;

  const model = itemHere && view ? view.preview.model : null;
  return (
    <div
      ref={rootRef}
      data-workspace-canvas={pageNumber}
      onKeyDown={isolateDispatcherKeys}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {model && view && isTableModel(model) && (
        <>
          <StructureLines model={model} rows={view.rows} cols={view.cols} />
          <ShapeKeyMarkers model={model} ops={ops ?? []} emit={emit} />
          {!drawMode && <LineHandles rows={view.rows} cols={view.cols} boxes={partBoxes(model)} toPage={toPage} emit={emit} />}
        </>
      )}
      {model && !isTableModel(model) && <ParagraphBoxes doc={model} />}
      {drawMode && <BoxDrawCapture mode={drawMode} pageNumber={pageNumber} toPage={toPage} />}
    </div>
  );
}
