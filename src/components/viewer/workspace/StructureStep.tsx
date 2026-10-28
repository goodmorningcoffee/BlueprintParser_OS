"use client";

// [TP-3 WP-3.N] Step 1 of the open item (PLAN §3.1 StructureStep, §3.3 A/B/C step 3): what the parse found and
// the user's corrections, previewed in the browser.
//   SourceSwitcher        which method's lines each axis uses (`pin-source`)
//   CorrectionBar         Adjust lines · Draw rows/columns · Edit cells · Header rows ▾ · Key column ▾ · Source ▾ ·
//                         Split/merge ¶ · Undo / Reset
//   StructurePreviewGrid  the table after the ops (tint = source; column ▾ role) · "Wide view ▸" → WideViewDrawer
//   ParagraphPreviewList  notes / spec paragraphs with their addresses (split / merge / rekey / block header)
// Every correction is an op appended to the item's draft (`tablesWorkspaceStore.setDraftOps`, mirrored to
// localStorage by the store). The preview is `applyOpsDetailed(result, ops)` (WP-3.D, pure and client-safe, E-8):
// no correction fetches, and the canvas (WP-3.O) previews the same list. Accept sends the result's model as `base`
// plus these ops; the server re-applies them (WP-3.G).
//   • While an accept waits on its rebase confirm, the preview is the server's rebased model, which ALREADY has the
//     ops (WP-3.M integration note 2): it is shown as is, and corrections are paused until the confirm.
//   • An op that no longer lands on this parse (its row or paragraph id is gone after a re-scan) is counted; it
//     stays in the list (the commit refuses a rebase that loses an op), and Reset or Undo removes it.
//   • Undo removes the last correction — a "Source ▾" pin of both axes is one correction — and Reset removes all.

import { useMemo, useRef, useState } from "react";
import { applyOpsDetailed } from "@/lib/parse-engine/ops";
import { PARSE_ENGINE_CAPS, type Axis, type CorrectionOp, type MethodId, type ParseResult, type StructureModel } from "@/lib/parse-engine/types";
import { useSessionStore } from "@/stores/sessionStore";
import { useTablesWorkspaceStore, type WorkspaceItemRef } from "@/stores/tablesWorkspaceStore";
import { focusItem } from "@/stores/workspaceCommands";
import CorrectionBar, { type StructureMode } from "./CorrectionBar";
import { isolateDispatcherKeys } from "./keyboard";
import ParagraphPreviewList from "./ParagraphPreviewList";
import SourceSwitcher, { METHOD_LABELS } from "./SourceSwitcher";
import StructurePreviewGrid, { SOURCE_TINT } from "./StructurePreviewGrid";
import WideViewDrawer from "./WideViewDrawer";
import { wsButton } from "./WorkspaceHeader";

export function resultSummary(result: Pick<ParseResult, "model">): string {
  const m = result.model;
  if ("paragraphs" in m) {
    const n = m.paragraphs.length;
    return `${n} paragraph${n === 1 ? "" : "s"} in ${m.blocks.length} block${m.blocks.length === 1 ? "" : "s"}`;
  }
  const body = m.rows.filter((r) => r.role !== "header").length;
  return `${body} row${body === 1 ? "" : "s"} × ${m.cols.length} column${m.cols.length === 1 ? "" : "s"}${m.headerRows ? ` · ${m.headerRows} header row${m.headerRows === 1 ? "" : "s"}` : ""}`;
}

export interface StructurePreview {
  model: StructureModel;
  /** How many of the ops did not land on this parse. */
  lost: number;
  error?: string;
}

/** The draft's preview: the result's model after its ops (the rebased model as is). Pure. */
export function structurePreview(result: ParseResult, ops: readonly CorrectionOp[], rebased: StructureModel | null): StructurePreview {
  if (rebased) return { model: rebased, lost: 0 };
  if (ops.length === 0) return { model: result.model, lost: 0 };
  try {
    const out = applyOpsDetailed(result, ops);
    return { model: out.model, lost: out.landed.filter((l) => !l).length };
  } catch (e) {
    return { model: result.model, lost: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

const TINT_LEGEND: ReadonlyArray<[string, string]> = [
  ["textract-cells", METHOD_LABELS["textract-cells"]],
  ["shape-centres", METHOD_LABELS["shape-centres"]],
  ["edit", "Edited"],
];

export default function StructureStep({
  item,
  result,
  ops,
  rebased,
  title,
  regionId,
}: {
  item: WorkspaceItemRef;
  result: ParseResult;
  ops: CorrectionOp[];
  /** The rebased model while an accept waits on its confirm (already has the ops), else null. */
  rebased: StructureModel | null;
  title: string;
  regionId?: string;
}) {
  const [mode, setMode] = useState<StructureMode>(null);
  const [wide, setWide] = useState(false);
  const drawingNumber = useSessionStore((s) => s.pageDrawingNumbers[item.page] ?? null);
  // Undo groups: each emit call is one correction (a "Source ▾" pin is two ops). A list changed elsewhere (a canvas
  // gesture) no longer matches the top of the stack, and Undo then removes one op.
  const groups = useRef<{ after: CorrectionOp[]; size: number }[]>([]);
  const preview = useMemo(() => structurePreview(result, ops, rebased), [result, ops, rebased]);
  const readOnly = rebased !== null;

  const write = (nextOps: CorrectionOp[]) => useTablesWorkspaceStore.getState().setDraftOps(item.id, nextOps);
  const emitMany = (add: CorrectionOp[]) => {
    const current = useTablesWorkspaceStore.getState().drafts[item.id]?.ops;
    if (readOnly || !current || add.length === 0 || current.length + add.length > PARSE_ENGINE_CAPS.ops) return;
    const nextOps = [...current, ...add];
    groups.current.push({ after: nextOps, size: add.length });
    write(nextOps);
  };
  const emit = (op: CorrectionOp) => emitMany([op]);
  const onPin = (axis: Axis, method: MethodId | null) => emit({ op: "pin-source", axis, method });
  const onUndo = () => {
    const current = useTablesWorkspaceStore.getState().drafts[item.id]?.ops ?? [];
    if (current.length === 0) return;
    const top = groups.current[groups.current.length - 1];
    if (top && top.after === current) {
      groups.current.pop();
      write(current.slice(0, current.length - top.size));
    } else {
      groups.current = [];
      write(current.slice(0, -1));
    }
  };
  const onReset = () => {
    groups.current = [];
    write([]);
  };

  const model = preview.model;
  const isTable = !("paragraphs" in model);
  const flags = model.quality.flags;
  return (
    <div aria-label="Structure" onKeyDown={isolateDispatcherKeys} className="flex flex-col min-h-0">
      <div aria-label="Result" className="px-2 py-1 text-[11px] text-[var(--fg)]">
        <p>{resultSummary({ model })}</p>
        <p className="text-[10px] text-[var(--muted)]">
          Agreement {Math.round(model.quality.agreement * 100)}% · confidence {Math.round(model.quality.conf * 100)}%
          {flags.length > 0 ? ` · ${flags.join(", ")}` : ""}
        </p>
      </div>
      {isTable ? <SourceSwitcher result={result} ops={ops} disabled={readOnly} onPin={onPin} /> : null}
      <CorrectionBar
        itemKey={item.id}
        result={result}
        model={model}
        ops={ops}
        mode={mode}
        readOnly={readOnly}
        setMode={setMode}
        emit={emit}
        emitMany={emitMany}
        onShowOnPage={() => focusItem(item)}
        onUndo={onUndo}
        onReset={onReset}
      />
      {readOnly ? <p role="note" className="px-2 py-0.5 text-[10px] text-[var(--muted)]">Showing the re-scanned result. Confirm it below to keep editing.</p> : null}
      {preview.lost > 0 ? (
        <p role="note" className="px-2 py-0.5 text-[10px] text-amber-400">
          {preview.lost} correction{preview.lost === 1 ? " no longer applies" : "s no longer apply"} to this parse. Undo or Reset removes {preview.lost === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {preview.error ? <p role="alert" className="px-2 py-0.5 text-[10px] text-red-400">Corrections could not be previewed: {preview.error}</p> : null}
      {"paragraphs" in model ? (
        <ParagraphPreviewList
          doc={model}
          words={result.words}
          page={item.page}
          drawingNumber={drawingNumber}
          regionId={regionId ?? item.id}
          editing={mode === "paragraphs"}
          emit={readOnly ? undefined : emit}
        />
      ) : (
        <div className="flex flex-col gap-1 px-2 py-1">
          <div className="flex items-center gap-2 text-[9px] text-[var(--muted)]">
            {TINT_LEGEND.map(([src, label]) => (
              <span key={src} className="flex items-center gap-0.5">
                <span aria-hidden className="inline-block w-2 h-2 rounded-sm" style={{ background: SOURCE_TINT[src] }} />
                {label}
              </span>
            ))}
            <button type="button" onClick={() => setWide(true)} className={`ml-auto ${wsButton(wide)}`}>
              Wide view ▸
            </button>
          </div>
          <StructurePreviewGrid model={model} emit={readOnly ? undefined : emit} editCells={mode === "cells"} />
          {wide ? (
            <WideViewDrawer
              title={title}
              model={model}
              emit={readOnly ? undefined : emit}
              editCells={mode === "cells"}
              onToggleEdit={readOnly ? undefined : () => setMode(mode === "cells" ? null : "cells")}
              onClose={() => setWide(false)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
