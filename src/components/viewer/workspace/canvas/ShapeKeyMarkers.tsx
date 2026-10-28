"use client";

// [TP-3 WP-3.O] Shape-keyed rows on the canvas (PLAN §3.3 B): one marker per row keyed by a shape. The key read
// inside the shape (or from the crop) is shown beside it; a shape whose key is unknown (`text: null`) is RED —
// click it (or focus it and press ⏎) and type the key, which becomes a `set-row-key` op. A legend row keyed by a
// graphic (`symbol`) is outlined only. A key typed in this draft shows at once, before the parse preview re-runs.

import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { CorrectionOp, StructureRow, StructureTableModel } from "@/lib/parse-engine/types";
import { focusScopedKeys, isolateDispatcherKeys } from "../keyboard";
import { boxStyle } from "./StructureLines";

export const KEY_COLOR = "#00c853";
export const MISSING_KEY_COLOR = "#ff1744";
export const SYMBOL_COLOR = "#2979ff";

const stop = (e: MouseEvent | PointerEvent) => e.stopPropagation();

/** The last key typed for each row in this draft's ops. */
function typedKeys(ops: readonly CorrectionOp[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const op of ops) if (op.op === "set-row-key") out.set(op.row, op.text);
  return out;
}

function KeyInput({ row, onDone }: { row: StructureRow; onDone: (text: string | null) => void }) {
  const [text, setText] = useState("");
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    isolateDispatcherKeys(e);
    if (e.key === "Enter") {
      e.preventDefault();
      finish(text.trim() || null);
    } else if (e.key === "Escape") {
      finish(null);
    }
  };
  return (
    <input
      autoFocus
      aria-label={`Key for row ${row.id}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(text.trim() || null)}
      onPointerDown={stop}
      onMouseDown={stop}
      style={{ position: "absolute", left: 0, top: "100%", width: 64, fontSize: 11, pointerEvents: "auto" }}
    />
  );
}

export default function ShapeKeyMarkers({ model, ops, emit }: { model: StructureTableModel; ops: readonly CorrectionOp[]; emit: (op: CorrectionOp) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const typed = typedKeys(ops);
  return (
    <div data-workspace-keys="" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {model.rows.map((row) => {
        const key = row.key;
        if (!key || key.kind === "text") return null;
        if (key.kind === "symbol") {
          return (
            <div
              key={row.id}
              data-key-marker={row.id}
              data-key-state="symbol"
              style={{ ...boxStyle(key.shapeBbox), boxSizing: "border-box", border: `1.5px solid ${SYMBOL_COLOR}` }}
            />
          );
        }
        const text = typed.get(row.id) ?? key.text;
        const missing = text === null;
        const startEdit = () => setEditing(row.id);
        return (
          <div
            key={row.id}
            data-key-marker={row.id}
            data-key-state={missing ? "missing" : "known"}
            role={missing ? "button" : undefined}
            tabIndex={missing ? 0 : undefined}
            aria-label={missing ? `Key unknown for row ${row.id}: click and type it` : undefined}
            title={missing ? "Key unknown: click and type it" : text ?? undefined}
            onClick={missing ? (e) => { e.stopPropagation(); startEdit(); } : undefined}
            onPointerDown={missing ? stop : undefined}
            onMouseDown={missing ? stop : undefined}
            onKeyDown={missing ? focusScopedKeys({ Enter: startEdit }) : undefined}
            style={{
              ...boxStyle(key.shapeBbox),
              boxSizing: "border-box",
              border: `2px solid ${missing ? MISSING_KEY_COLOR : KEY_COLOR}`,
              background: missing ? `${MISSING_KEY_COLOR}26` : undefined,
              pointerEvents: missing ? "auto" : "none",
              cursor: missing ? "text" : undefined,
            }}
          >
            {!missing && (
              <span style={{ position: "absolute", left: "100%", top: 0, marginLeft: 2, fontSize: 10, lineHeight: "12px", color: KEY_COLOR, whiteSpace: "nowrap" }}>
                {text}
              </span>
            )}
            {editing === row.id && (
              <KeyInput
                row={row}
                onDone={(value) => {
                  setEditing(null);
                  if (value) emit({ op: "set-row-key", row: row.id, text: value });
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
