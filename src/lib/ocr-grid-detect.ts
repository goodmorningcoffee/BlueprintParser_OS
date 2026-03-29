/**
 * ocr-grid-detect.ts
 *
 * Shared OCR-based grid detection and cell extraction.
 * Extracted from /api/table-parse methodOcrPositions for reuse
 * by the propose endpoint and guided parse flow.
 *
 * Pure functions — no DB access, no side effects.
 */

import type { TextractWord } from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const ROW_Y_TOL = 0.006;
const MIN_COL_GAP = 0.015;

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface RowCluster {
  yCenter: number;
  yMin: number;
  yMax: number;
  words: TextractWord[];
}

export interface ColBound {
  left: number;
  right: number;
  center: number;
}

export interface GridProposal {
  rows: RowCluster[];
  cols: ColBound[];
  /** Y positions between rows (boundaries, not centers) */
  rowBoundaries: number[];
  /** X positions of column boundaries */
  colBoundaries: number[];
  wordCount: number;
  confidence: number;
}

export interface LayoutHint {
  columns?: number;          // force this many columns (e.g., 2 for keynotes)
  tagColumnPosition?: "left" | "right";
}

// ═══════════════════════════════════════════════════════════════════
// Row detection
// ═══════════════════════════════════════════════════════════════════

function clusterRows(words: TextractWord[]): RowCluster[] {
  if (words.length === 0) return [];

  const sorted = [...words].sort(
    (a, b) => (a.bbox[1] + a.bbox[3] / 2) - (b.bbox[1] + b.bbox[3] / 2),
  );

  const clusters: RowCluster[] = [];
  let cur: TextractWord[] = [sorted[0]];
  let curY = sorted[0].bbox[1] + sorted[0].bbox[3] / 2;

  for (let i = 1; i < sorted.length; i++) {
    const wy = sorted[i].bbox[1] + sorted[i].bbox[3] / 2;
    if (Math.abs(wy - curY) <= ROW_Y_TOL) {
      cur.push(sorted[i]);
    } else {
      const sortedRow = cur.sort((a, b) => a.bbox[0] - b.bbox[0]);
      const ys = sortedRow.map((w) => w.bbox[1] + w.bbox[3] / 2);
      clusters.push({
        yCenter: ys.reduce((s, y) => s + y, 0) / ys.length,
        yMin: Math.min(...sortedRow.map((w) => w.bbox[1])),
        yMax: Math.max(...sortedRow.map((w) => w.bbox[1] + w.bbox[3])),
        words: sortedRow,
      });
      cur = [sorted[i]];
      curY = wy;
    }
  }
  if (cur.length > 0) {
    const sortedRow = cur.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const ys = sortedRow.map((w) => w.bbox[1] + w.bbox[3] / 2);
    clusters.push({
      yCenter: ys.reduce((s, y) => s + y, 0) / ys.length,
      yMin: Math.min(...sortedRow.map((w) => w.bbox[1])),
      yMax: Math.max(...sortedRow.map((w) => w.bbox[1] + w.bbox[3])),
      words: sortedRow,
    });
  }

  return clusters;
}

// ═══════════════════════════════════════════════════════════════════
// Column detection
// ═══════════════════════════════════════════════════════════════════

function detectColumns(
  regionWords: TextractWord[],
  rowCount: number,
  regionBbox: [number, number, number, number],
  hint?: LayoutHint,
): ColBound[] {
  const [rMinX, , rMaxX] = regionBbox;

  const allLefts = regionWords.map((w) => w.bbox[0]).sort((a, b) => a - b);
  const clusters: number[][] = [[allLefts[0]]];
  for (let i = 1; i < allLefts.length; i++) {
    if (allLefts[i] - allLefts[i - 1] > MIN_COL_GAP) clusters.push([allLefts[i]]);
    else clusters[clusters.length - 1].push(allLefts[i]);
  }

  const minHits = Math.max(2, Math.floor(rowCount * 0.3));
  let stableClusters = clusters.filter((c) => c.length >= minHits);
  if (stableClusters.length < 2) {
    stableClusters = clusters.length >= 2 ? clusters : [];
  }

  // If layout hint forces N columns and we have more, merge down
  if (hint?.columns && stableClusters.length > hint.columns) {
    // Find the biggest gap — that's the primary column divider
    const centers = stableClusters.map(
      (c) => c.reduce((s, x) => s + x, 0) / c.length,
    ).sort((a, b) => a - b);

    const gaps: { idx: number; size: number }[] = [];
    for (let i = 1; i < centers.length; i++) {
      gaps.push({ idx: i, size: centers[i] - centers[i - 1] });
    }
    gaps.sort((a, b) => b.size - a.size);

    // Keep top (hint.columns - 1) gaps as column boundaries
    const keepGaps = gaps.slice(0, hint.columns - 1).map((g) => g.idx).sort((a, b) => a - b);

    // Merge clusters between kept gaps
    const merged: number[][] = [];
    let start = 0;
    for (const gapIdx of keepGaps) {
      const group: number[] = [];
      for (let j = start; j < gapIdx; j++) group.push(...stableClusters[j]);
      merged.push(group);
      start = gapIdx;
    }
    // Last group
    const lastGroup: number[] = [];
    for (let j = start; j < stableClusters.length; j++) lastGroup.push(...stableClusters[j]);
    merged.push(lastGroup);

    stableClusters = merged;
  }

  if (stableClusters.length < 2) return [];

  const colCenters = stableClusters
    .map((c) => c.reduce((s, x) => s + x, 0) / c.length)
    .sort((a, b) => a - b);

  const maxRight = Math.max(...regionWords.map((w) => w.bbox[0] + w.bbox[2]));

  return colCenters.map((center, i) => ({
    left: Math.max(0, i === 0 ? rMinX - 0.005 : (colCenters[i - 1] + center) / 2),
    right: Math.min(1, i === colCenters.length - 1 ? maxRight + 0.005 : (center + colCenters[i + 1]) / 2),
    center,
  }));
}

// ═══════════════════════════════════════════════════════════════════
// Row boundaries from clusters
// ═══════════════════════════════════════════════════════════════════

function computeRowBoundaries(
  rows: RowCluster[],
  regionBbox: [number, number, number, number],
): number[] {
  if (rows.length < 2) return [];
  const [, rMinY, , rMaxY] = regionBbox;

  const boundaries: number[] = [rMinY];
  for (let i = 1; i < rows.length; i++) {
    // Midpoint between previous row bottom and current row top
    boundaries.push((rows[i - 1].yMax + rows[i].yMin) / 2);
  }
  boundaries.push(rMaxY);
  return boundaries;
}

function computeColBoundaries(
  cols: ColBound[],
  regionBbox: [number, number, number, number],
): number[] {
  if (cols.length < 2) return [];
  const [rMinX, , rMaxX] = regionBbox;

  const boundaries: number[] = [rMinX];
  for (let i = 1; i < cols.length; i++) {
    boundaries.push((cols[i - 1].right + cols[i].left) / 2);
  }
  boundaries.push(rMaxX);
  return boundaries;
}

// ═══════════════════════════════════════════════════════════════════
// Main exports
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect rows and columns from OCR word positions within a region.
 * Returns proposed grid geometry (boundaries) without parsing cell text.
 */
export function detectRowsAndColumns(
  words: TextractWord[],
  regionBbox: [number, number, number, number],
  hint?: LayoutHint,
): GridProposal {
  const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;

  // Filter words inside region
  const regionWords = words.filter((w) => {
    const cx = w.bbox[0] + w.bbox[2] / 2;
    const cy = w.bbox[1] + w.bbox[3] / 2;
    return cx >= rMinX && cx <= rMaxX && cy >= rMinY && cy <= rMaxY;
  });

  if (regionWords.length < 4) {
    return { rows: [], cols: [], rowBoundaries: [], colBoundaries: [], wordCount: regionWords.length, confidence: 0 };
  }

  const rows = clusterRows(regionWords);
  if (rows.length < 2) {
    return { rows, cols: [], rowBoundaries: [], colBoundaries: [], wordCount: regionWords.length, confidence: 0.1 };
  }

  const cols = detectColumns(regionWords, rows.length, regionBbox, hint);
  if (cols.length < 2) {
    return { rows, cols, rowBoundaries: [], colBoundaries: [], wordCount: regionWords.length, confidence: 0.1 };
  }

  const rowBoundaries = computeRowBoundaries(rows, regionBbox);
  const colBoundaries = computeColBoundaries(cols, regionBbox);

  // Confidence: base 0.5, row consistency + col stability
  let confidence = 0.5;
  const avgWordsPerRow = regionWords.length / rows.length;
  if (avgWordsPerRow >= 2) confidence += 0.1;
  if (cols.length >= 2) confidence += 0.1;
  if (rows.length >= 5) confidence += 0.1;
  confidence = Math.min(confidence, 0.9);

  return { rows, cols, rowBoundaries, colBoundaries, wordCount: regionWords.length, confidence };
}

/**
 * Extract cell text from a grid defined by row and column boundaries.
 * Used by guided parse and manual parse flows.
 *
 * @param words - OCR words for the page
 * @param rowBoundaries - Y positions defining row edges [top, mid1, mid2, ..., bottom]
 * @param colBoundaries - X positions defining col edges [left, mid1, ..., right]
 * @returns Parsed grid with headers and data rows
 */
export function extractCellsFromGrid(
  words: TextractWord[],
  rowBoundaries: number[],
  colBoundaries: number[],
): { headers: string[]; rows: Record<string, string>[] } {
  if (rowBoundaries.length < 2 || colBoundaries.length < 2) {
    return { headers: [], rows: [] };
  }

  const numRows = rowBoundaries.length - 1;
  const numCols = colBoundaries.length - 1;

  // Build grid: for each cell, find words whose center falls inside
  const grid: string[][] = [];
  for (let ri = 0; ri < numRows; ri++) {
    const rowTop = rowBoundaries[ri];
    const rowBot = rowBoundaries[ri + 1];
    const cells: string[] = [];

    for (let ci = 0; ci < numCols; ci++) {
      const colLeft = colBoundaries[ci];
      const colRight = colBoundaries[ci + 1];

      const cellWords = words.filter((w) => {
        const cx = w.bbox[0] + w.bbox[2] / 2;
        const cy = w.bbox[1] + w.bbox[3] / 2;
        return cx >= colLeft && cx < colRight && cy >= rowTop && cy < rowBot;
      });

      // Sort left-to-right, concatenate
      cellWords.sort((a, b) => a.bbox[0] - b.bbox[0]);
      cells.push(cellWords.map((w) => w.text).join(" ").trim());
    }
    grid.push(cells);
  }

  // Generate generic column headers — don't consume first row as headers
  // (keynotes and many tables don't have a header row)
  const headers = Array.from({ length: numCols }, (_, i) => `Column ${i + 1}`);
  const dataRows: Record<string, string>[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row: Record<string, string> = {};
    let hasContent = false;
    for (let c = 0; c < headers.length; c++) {
      const val = (grid[r]?.[c] || "").trim();
      row[headers[c]] = val;
      if (val) hasContent = true;
    }
    if (hasContent) dataRows.push(row);
  }

  return { headers, rows: dataRows };
}
