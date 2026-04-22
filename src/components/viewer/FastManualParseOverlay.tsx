"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { BboxLTWH, TextractLine } from "@/types";

interface FastManualGrid {
  headers: string[];
  rows: Record<string, string>[];
  colBoundaries?: number[];
  rowBoundaries?: number[];
}

interface FastManualParseOverlayProps {
  /** Active gate — overlay only renders + captures events when true. */
  active: boolean;
  /** Full page Textract lines (will be filtered to regionBbox internally). */
  textractLines: TextractLine[];
  /** Region the user drew — normalized MinMax [x0, y0, x1, y1]. */
  regionBbox: [number, number, number, number] | null;
  /** Called after each double-click with the current cumulative grid. */
  onGridChange: (grid: FastManualGrid | null) => void;
  width: number;
  height: number;
  cssScale: number;
}

/**
 * FastManualParseOverlay — Stage 4 novel interaction primitive.
 *
 * The user double-clicks a paragraph on the canvas. We hit-test against
 * Textract's LINE bboxes, select the matching line, and:
 *   - On the first selection, derive columns from the line's L/R margins
 *     plus 2px of normalized padding (cssScale-aware).
 *   - On subsequent selections, snap words to the established columns.
 *     If a word falls outside all columns, extend with a new boundary.
 *
 * Each LINE becomes one row. Grid emitted via `onGridChange` after every
 * selection. Pure props/callbacks — no store writes. Reusable for Stage 5
 * Spec + future keynote variants.
 *
 * Written for Stage 4 per the approved plan; designed as a generic primitive
 * per `feedback_composite_approach_with_debug.md` (reusable, testable).
 */
export default memo(function FastManualParseOverlay({
  active,
  textractLines,
  regionBbox,
  onGridChange,
  width,
  height,
  cssScale,
}: FastManualParseOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedLines, setSelectedLines] = useState<TextractLine[]>([]);
  const [columns, setColumns] = useState<number[]>([]); // X-boundaries, sorted

  // Clear state when region or active changes
  useEffect(() => {
    setSelectedLines([]);
    setColumns([]);
    onGridChange(null);
  }, [regionBbox, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived filtered lines (inside the region)
  const linesInRegion = regionBbox
    ? textractLines.filter((line) => {
        if (!line.bbox || line.bbox.length < 4) return false;
        const [x0, y0, x1, y1] = regionBbox;
        const cx = line.bbox[0] + line.bbox[2] / 2;
        const cy = line.bbox[1] + line.bbox[3] / 2;
        return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
      })
    : [];

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0 || !regionBbox) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const [x0, y0, x1, y1] = regionBbox;
    const rx = x0 * width;
    const ry = y0 * height;
    const rw = (x1 - x0) * width;
    const rh = (y1 - y0) * height;

    // Region outline
    ctx.strokeStyle = "rgba(96, 165, 250, 0.6)"; // notes blue
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    // Selected line highlights
    ctx.fillStyle = "rgba(96, 165, 250, 0.18)";
    ctx.strokeStyle = "rgba(96, 165, 250, 0.9)";
    ctx.lineWidth = 1;
    for (const line of selectedLines) {
      const [bx, by, bw, bh] = line.bbox;
      ctx.fillRect(bx * width, by * height, bw * width, bh * height);
      ctx.strokeRect(bx * width, by * height, bw * width, bh * height);
    }

    // Column boundary lines
    if (columns.length > 0) {
      ctx.strokeStyle = "rgba(0, 220, 255, 0.75)";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 3]);
      for (const cx of columns) {
        const px = cx * width;
        ctx.beginPath();
        ctx.moveTo(px, ry);
        ctx.lineTo(px, ry + rh);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Hint
    if (selectedLines.length === 0) {
      ctx.fillStyle = "rgba(96, 165, 250, 0.9)";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText("Double-click a paragraph to begin", rx + 6, ry - 6);
    }
  }, [width, height, regionBbox, selectedLines, columns]);

  useEffect(() => {
    draw();
  }, [draw]);

  const getCanvasPos = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { nx: number; ny: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { nx: 0, ny: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (width / rect.width);
      const y = (e.clientY - rect.top) * (height / rect.height);
      return { nx: x / width, ny: y / height };
    },
    [width, height],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!active || !regionBbox) return;
      const { nx, ny } = getCanvasPos(e);
      e.preventDefault();
      e.stopPropagation();

      const hit = linesInRegion.find((line) => {
        const [bx, by, bw, bh] = line.bbox;
        return nx >= bx && nx <= bx + bw && ny >= by && ny <= by + bh;
      });
      if (!hit) return;
      // Skip if already selected
      if (selectedLines.some((l) => l === hit || (l.text === hit.text && l.bbox[1] === hit.bbox[1]))) return;

      let nextColumns = columns;
      if (columns.length === 0) {
        // First selection: establish columns from LINE's L/R margins + 2px padding
        const paddingPx = 2;
        const padNorm = paddingPx / (cssScale * width);
        const lineLeft = hit.bbox[0];
        const lineRight = hit.bbox[0] + hit.bbox[2];
        // 2-column default (Key | Note). Try to find a gap in the line's words.
        const midSplit = deriveMidSplit(hit);
        nextColumns = midSplit !== null
          ? [
              Math.max(0, lineLeft - padNorm),
              midSplit,
              Math.min(1, lineRight + padNorm),
            ]
          : [
              Math.max(0, lineLeft - padNorm),
              Math.min(1, lineRight + padNorm),
            ];
        setColumns(nextColumns);
      } else {
        // Subsequent: extend columns if any word of the line falls outside all existing bounds
        const leftmost = hit.bbox[0];
        const rightmost = hit.bbox[0] + hit.bbox[2];
        if (leftmost < nextColumns[0]) {
          nextColumns = [leftmost, ...nextColumns];
        }
        if (rightmost > nextColumns[nextColumns.length - 1]) {
          nextColumns = [...nextColumns, rightmost];
        }
        if (nextColumns !== columns) setColumns(nextColumns);
      }

      const nextSelected = [...selectedLines, hit].sort((a, b) => a.bbox[1] - b.bbox[1]);
      setSelectedLines(nextSelected);

      // Emit grid
      const headers = nextColumns.length === 3 ? ["Key", "Note"] : nextColumns.slice(0, -1).map((_, i) => i === 0 ? "Key" : `Col${i + 1}`);
      const rows = nextSelected.map((line) => binLineIntoColumns(line, nextColumns, headers));
      const rowBoundaries = computeRowBoundaries(nextSelected);
      onGridChange({ headers, rows, colBoundaries: nextColumns, rowBoundaries });
    },
    [active, regionBbox, linesInRegion, selectedLines, columns, cssScale, width, getCanvasPos, onGridChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!active) return;
      if (e.key === "Escape") {
        setSelectedLines([]);
        setColumns([]);
        onGridChange(null);
      }
    },
    [active, onGridChange],
  );

  useEffect(() => {
    if (!active) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, handleKeyDown]);

  if (!active || !regionBbox) return null;

  return (
    <canvas
      ref={canvasRef}
      onDoubleClick={handleDoubleClick}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "auto",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
        willChange: "transform",
        zIndex: 31,
        cursor: "crosshair",
      }}
    />
  );
});

/**
 * Find a reasonable Key/Note column split inside a LINE by scanning for the
 * largest inter-word X-gap. Returns normalized X coordinate, or null if the
 * line has fewer than 2 words.
 */
function deriveMidSplit(line: TextractLine): number | null {
  if (!line.words || line.words.length < 2) return null;
  const sorted = [...line.words].sort((a, b) => a.bbox[0] - b.bbox[0]);
  let maxGap = 0;
  let splitAt: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const prevRight = sorted[i - 1].bbox[0] + sorted[i - 1].bbox[2];
    const curLeft = sorted[i].bbox[0];
    const gap = curLeft - prevRight;
    if (gap > maxGap) {
      maxGap = gap;
      splitAt = prevRight + gap / 2;
    }
  }
  // Only use the split if the gap is meaningful (> 1% of line width)
  if (splitAt !== null && maxGap > line.bbox[2] * 0.05) return splitAt;
  return null;
}

function binLineIntoColumns(
  line: TextractLine,
  columns: number[],
  headers: string[],
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const h of headers) row[h] = "";
  if (!line.words) {
    row[headers[0]] = line.text;
    return row;
  }
  for (const word of line.words) {
    const wx = word.bbox[0] + word.bbox[2] / 2;
    let colIdx = 0;
    for (let i = 1; i < columns.length - 1; i++) {
      if (wx >= columns[i]) colIdx = i;
    }
    if (colIdx >= headers.length) colIdx = headers.length - 1;
    row[headers[colIdx]] = row[headers[colIdx]]
      ? `${row[headers[colIdx]]} ${word.text}`
      : word.text;
  }
  return row;
}

function computeRowBoundaries(lines: TextractLine[]): number[] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const boundaries: number[] = [];
  for (const line of sorted) {
    boundaries.push(line.bbox[1]);
  }
  // Final boundary = bottom of last line
  const last = sorted[sorted.length - 1];
  boundaries.push(last.bbox[1] + last.bbox[3]);
  return boundaries;
}

// Suppress unused warning on BboxLTWH — type imported for documentation consistency.
void (null as unknown as BboxLTWH);
