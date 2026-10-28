"use client";

// [TP-3 WP-3.O] The structure of the open item drawn on its page: the table box (and each continuation box),
// every row and column line coloured by its source (PLAN §3.3 A: "lines coloured by source"). Display only:
// `pointer-events: none`, so the annotation canvas underneath keeps every click. Lines are moved by LineHandles.

import type { CSSProperties } from "react";
import type { BboxMinMax, StructureTableModel } from "@/lib/parse-engine/types";
import { mapColToPart, partBoxes, type CanvasLine, type LineSource } from "./lineModel";

/** One colour per line source (user edits stand out; methods match the Structure step's SourceSwitcher). */
export const LINE_COLORS: Readonly<Record<LineSource, string>> = {
  user: "#ff9100",
  fused: "#2979ff",
  "ocr-lines": "#7c4dff",
  "shape-centres": "#00bfa5",
  "textract-cells": "#d500f9",
  layout: "#6d4c41",
  "primitive-grid": "#546e7a",
  "hanging-indent": "#8d6e63",
  "x-starts": "#3949ab",
  rulings: "#00897b",
  img2table: "#c0ca33",
  tatr: "#f50057",
};

export function pct(v: number): string {
  return `${v * 100}%`;
}

export function boxStyle(b: BboxMinMax): CSSProperties {
  return { position: "absolute", left: pct(b[0]), top: pct(b[1]), width: pct(b[2] - b[0]), height: pct(b[3] - b[1]) };
}

export default function StructureLines({ model, rows, cols }: { model: StructureTableModel; rows: CanvasLine[]; cols: CanvasLine[] }) {
  const boxes = partBoxes(model);
  return (
    <div data-workspace-structure="" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {boxes.map((b, part) => (
        <div
          key={`box-${part}`}
          data-structure-box={part}
          style={{ ...boxStyle(b), boxSizing: "border-box", border: `2px ${part === 0 ? "solid" : "dashed"} ${LINE_COLORS.fused}` }}
        />
      ))}
      {rows.map((l, i) => {
        const b = boxes[l.part] ?? boxes[0];
        return (
          <div
            key={`r-${l.part}-${l.after ?? i}`}
            data-structure-line={`rows:${l.after ?? `#${i}`}`}
            data-src={l.src}
            style={{ position: "absolute", left: pct(b[0]), width: pct(b[2] - b[0]), top: pct(l.at), height: 0, borderTop: `1.5px solid ${LINE_COLORS[l.src]}` }}
          />
        );
      })}
      {cols.flatMap((l, i) =>
        boxes.map((b, part) => {
          const x = part === 0 ? l.at : mapColToPart(l.at, boxes[0], b);
          return (
            <div
              key={`c-${part}-${l.after ?? i}`}
              data-structure-line={part === 0 ? `cols:${l.after ?? `#${i}`}` : undefined}
              data-src={l.src}
              style={{ position: "absolute", top: pct(b[1]), height: pct(b[3] - b[1]), left: pct(x), width: 0, borderLeft: `1.5px ${part === 0 ? "solid" : "dashed"} ${LINE_COLORS[l.src]}` }}
            />
          );
        }),
      )}
    </div>
  );
}
