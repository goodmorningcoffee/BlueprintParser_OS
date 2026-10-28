"use client";

// [TP-3 WP-3.O] The workspace's own box draw on the page (PLAN §3.1; ARCH C: its own DOM capture, never a
// `tools/registry.ts` tool, never a toolStore field — §1.6 rule 3). One gesture, three uses:
//   "draw-region"   "+ Region" (tablesWorkspaceStore.correction, WP-3.L): a `draw:` item and draft on this page,
//                   opened and focused, and a parse request with NO kind (the engine's kind heads decide, §3.3 F);
//   "continuation"  KindBar "+ Add continuation box": the box joins the item's `parts` (≤ 4, R11) and the item is
//                   re-parsed with them;
//   "draw-rows" / "draw-cols"   "Draw cells": each box is a `user-boxes` op on the open item (stays armed).
// It REFUSES while a viewer tool is active (`toolStore.activeTool !== null`, i.e. not the pointer), so it never
// competes with a markup, takeoff or parse tool for the same drag. Esc cancels it without being swallowed
// (ProposalFocusLayer owns Esc); Enter / Del never leave it (§1.6 rule 14).

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { PARSE_ENGINE_CAPS, type BboxMinMax, type CorrectionOp } from "@/lib/parse-engine/types";
import { GROUP_KINDS, useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { useToolStore } from "@/stores/toolStore";
import { useWorkspaceCanvasStore, type CanvasDrawMode } from "@/stores/workspaceCanvasStore";
import { drawItemKey, openItem } from "@/stores/workspaceCommands";
import { isolateDispatcherKeys } from "../keyboard";
import type { ToPage } from "./LineHandles";
import { boxStyle } from "./StructureLines";
import { pageUnit } from "./lineModel";

export type DrawMode = "draw-region" | CanvasDrawMode;

/** A box smaller than this on either side is a click, not a box. */
export const MIN_BOX = 0.005;

const PROMPTS: Readonly<Record<DrawMode, string>> = {
  "draw-region": "Drag a box around a table or notes block · Esc cancels",
  continuation: "Drag a box around the next block of this table · Esc cancels",
  "draw-rows": "Drag a box over each row · Esc ends",
  "draw-cols": "Drag a box over each column · Esc ends",
};

function cancel(mode: DrawMode): void {
  if (mode === "draw-region") useTablesWorkspaceStore.getState().setCorrection(null);
  else useWorkspaceCanvasStore.getState().disarm();
}

/** What a finished box does in each mode (exported for tests). */
export function completeBox(mode: DrawMode, pageNumber: number, bbox: BboxMinMax): void {
  const ws = useTablesWorkspaceStore.getState();
  const canvas = useWorkspaceCanvasStore.getState();
  if (mode === "draw-region") {
    const kind = GROUP_KINDS[ws.group][0];
    const key = drawItemKey(pageNumber, bbox);
    ws.putDraft(key, { page: pageNumber, bbox, kind, result: null, ops: [], startedAt: 0 });
    ws.setCorrection(null);
    openItem({ id: key, page: pageNumber, b: bbox, kind });
    canvas.requestParse(key, { page: pageNumber, bbox, budget: "instant" });
    return;
  }
  const key = canvas.armed?.itemKey;
  const draft = key ? ws.drafts[key] : undefined;
  if (!key || !draft || draft.page !== pageNumber) {
    canvas.disarm();
    return;
  }
  if (mode === "continuation") {
    canvas.disarm();
    const parts = draft.parts ?? [];
    if (parts.length >= PARSE_ENGINE_CAPS.parts) return;
    const next = [...parts, bbox];
    ws.putDraft(key, { ...draft, parts: next });
    const proposalId = ws.queue.find((q) => q.id === key)?.proposalId;
    canvas.requestParse(key, {
      page: draft.page, bbox: draft.bbox, parts: next, kind: draft.kind, budget: "instant",
      ...(proposalId ? { hints: { proposalId } } : {}),
    });
    return;
  }
  if (draft.ops.length >= PARSE_ENGINE_CAPS.ops) return;
  const op: CorrectionOp = mode === "draw-rows" ? { op: "user-boxes", rows: [bbox], cols: [] } : { op: "user-boxes", rows: [], cols: [bbox] };
  ws.setDraftOps(key, [...draft.ops, op]);
}

export default function BoxDrawCapture({ mode, pageNumber, toPage }: { mode: DrawMode; pageNumber: number; toPage: ToPage }) {
  const activeTool = useToolStore((s) => s.activeTool);
  const start = useRef<[number, number] | null>(null);
  const [rect, setRect] = useState<BboxMinMax | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const refused = activeTool !== null;

  // Take keyboard focus once when the capture appears, so Esc reaches it (no window listener, rule 14).
  useEffect(() => {
    if (!refused) surface.current?.focus({ preventScroll: true });
  }, [refused, mode]);

  if (refused) {
    return (
      <div
        data-workspace-capture="refused"
        role="status"
        style={{ position: "absolute", left: 8, top: 8, pointerEvents: "none", fontSize: 11, padding: "2px 6px", borderRadius: 3, background: "#000000b3", color: "#fff" }}
      >
        Finish or close the active tool to draw a box
      </div>
    );
  }

  const boxFrom = (a: [number, number], b: [number, number]): BboxMinMax =>
    [pageUnit(Math.min(a[0], b[0])), pageUnit(Math.min(a[1], b[1])), pageUnit(Math.max(a[0], b[0])), pageUnit(Math.max(a[1], b[1]))];

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = p;
    setRect([p[0], p[1], p[0], p[1]]);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const p = toPage(e.clientX, e.clientY);
    if (p) setRect(boxFrom(start.current, p));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) return;
    e.stopPropagation();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    start.current = null;
    setRect(null);
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    const box = boxFrom(from, p);
    if (box[2] - box[0] < MIN_BOX || box[3] - box[1] < MIN_BOX) return;
    completeBox(mode, pageNumber, box);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      start.current = null;
      setRect(null);
      cancel(mode);
      return; // never stopped: ProposalFocusLayer owns Esc
    }
    isolateDispatcherKeys(e);
  };
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      data-workspace-capture={mode}
      tabIndex={-1}
      ref={surface}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null; setRect(null); }}
      onMouseDown={stop}
      onClick={stop}
      onKeyDown={onKeyDown}
      style={{ position: "absolute", inset: 0, pointerEvents: "auto", cursor: "crosshair", outline: "none", background: "#00000008" }}
    >
      <div style={{ position: "absolute", left: 8, top: 8, pointerEvents: "none", fontSize: 11, padding: "2px 6px", borderRadius: 3, background: "#000000b3", color: "#fff" }}>
        {PROMPTS[mode]}
      </div>
      {rect && (
        <div data-capture-rect="" style={{ ...boxStyle(rect), boxSizing: "border-box", border: "2px dashed #ff9100", pointerEvents: "none" }} />
      )}
    </div>
  );
}
