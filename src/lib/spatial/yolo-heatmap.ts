/**
 * yolo-heatmap.ts
 *
 * Stage 2a Layer 2: universal YOLO density heatmap.
 *
 * Aggregates any configured YOLO class set into a per-cell density grid,
 * then thresholds + Union-Find-merges high-density cells into
 * `ConfidentRegion[]`. Not notes-specific — the same module serves the Note
 * Suite (text_box + vertical_area + horizontal_area for dense notes/legends),
 * the auto-table-detector (same three classes for schedule candidate bboxes),
 * and any future consumer needing "where is there agreement across N YOLO
 * classes on this page".
 *
 * Algorithm:
 *   1. Filter annotations by class set + per-class min-confidence.
 *   2. For each annotation, increment all grid cells overlapping its bbox
 *      weighted by (confidence × classWeight).
 *   3. Normalize grid values to 0-1 via the max contribution seen.
 *   4. Threshold cells above `minCellDensity` → binary mask.
 *   5. Union-Find on 8-connectivity → connected components.
 *   6. For each component: bbox, set of contributing classes (ranked),
 *      cell count, aggregate confidence.
 *   7. Emit a summary string for LLM context inclusion.
 *
 * Pure function. No storage, no side effects. Input geometry is normalized
 * 0-1; output bboxes are also normalized 0-1 LTWH.
 *
 * Reuses Stage 1 geom primitives: `UnionFind`, `overlap-signals` (for any
 * future downstream fusion; internal math is pure typed-array indexing).
 */

import type {
  BboxLTWH,
  BboxMinMax,
  YoloHeatmap,
  YoloHeatmapGridConfig,
  ConfidentRegion,
} from "@/types";
import { UnionFind } from "@/lib/geom/union-find";

// ═══════════════════════════════════════════════════════════════════
// Input shape — accept the canonical YoloDetectionInput from csi-spatial
// ═══════════════════════════════════════════════════════════════════

/** Subset of `csi-spatial.YoloDetectionInput` — keep shape identical so
 *  callers can pass the same detections to both modules without remapping. */
export interface HeatmapYoloAnnotation {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════════
// Config + constants
// ═══════════════════════════════════════════════════════════════════

export interface YoloHeatmapConfig {
  /** Which YOLO class names to aggregate. All other classes are ignored. */
  classes: string[];
  /** Grid resolution. Default 16 × 16. */
  gridConfig?: YoloHeatmapGridConfig;
  /** Per-class minimum confidence gate (default 0.1 uniformly). */
  minConfidencePerClass?: Record<string, number>;
  /** Per-class contribution weight. Default 1.0 for all. Values < 1 down-weight
   *  noisy classes; values > 1 boost high-signal classes. */
  classWeights?: Record<string, number>;
  /** Normalized cell density threshold to qualify as "high density" (0-1).
   *  Default 0.35 — tuned to suppress single-class outliers while capturing
   *  multi-class agreement. */
  minCellDensity?: number;
}

export const DEFAULT_GRID: YoloHeatmapGridConfig = { rows: 16, cols: 16 };
export const DEFAULT_MIN_CELL_DENSITY = 0.35;
export const DEFAULT_MIN_CONFIDENCE = 0.1;
export const DEFAULT_CLASS_WEIGHT = 1.0;

// ═══════════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════════

export function computeYoloHeatmap(
  pageNumber: number,
  annotations: readonly HeatmapYoloAnnotation[],
  config: YoloHeatmapConfig,
): YoloHeatmap {
  const { rows, cols } = config.gridConfig ?? DEFAULT_GRID;
  const minCellDensity = config.minCellDensity ?? DEFAULT_MIN_CELL_DENSITY;
  const minConfByClass = config.minConfidencePerClass ?? {};
  const classWeights = config.classWeights ?? {};
  const targetClasses = new Set(config.classes);

  // Filter annotations to the target class set + per-class confidence gate.
  const filtered = annotations.filter((a) => {
    if (!targetClasses.has(a.name)) return false;
    const minConf = minConfByClass[a.name] ?? DEFAULT_MIN_CONFIDENCE;
    return a.confidence >= minConf;
  });

  if (filtered.length === 0) {
    return emptyHeatmap(pageNumber, rows, cols, config.classes);
  }

  // 1D grids indexed by (row * cols + col). One global density sum + per-class.
  const cellCount = rows * cols;
  const densityGrid = new Float32Array(cellCount);
  const classGrids = new Map<string, Float32Array>();
  for (const cls of config.classes) classGrids.set(cls, new Float32Array(cellCount));

  // Accumulate contributions.
  for (const ann of filtered) {
    const weight = classWeights[ann.name] ?? DEFAULT_CLASS_WEIGHT;
    const contribution = ann.confidence * weight;

    const [c0, r0, c1, r1] = bboxToCellSpan(ann, cols, rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const idx = r * cols + c;
        densityGrid[idx] += contribution;
        classGrids.get(ann.name)![idx] += contribution;
      }
    }
  }

  // Normalize density grid by max value.
  const maxDensity = densityGrid.reduce((m, v) => (v > m ? v : m), 0);
  if (maxDensity > 0) {
    for (let i = 0; i < densityGrid.length; i++) densityGrid[i] /= maxDensity;
  }

  // Threshold → binary mask.
  const mask = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    if (densityGrid[i] >= minCellDensity) mask[i] = 1;
  }

  // Union-Find on 8-connectivity.
  const uf = new UnionFind(cellCount);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (mask[idx] === 0) continue;
      // 8-connect: E, S, SE, SW (avoid double-counting with W/N/NE/NW).
      tryMerge(uf, mask, idx, idx + 1, c + 1 < cols);
      tryMerge(uf, mask, idx, idx + cols, r + 1 < rows);
      tryMerge(uf, mask, idx, idx + cols + 1, c + 1 < cols && r + 1 < rows);
      tryMerge(uf, mask, idx, idx + cols - 1, c - 1 >= 0 && r + 1 < rows);
    }
  }

  // Collect components (only cells where mask=1).
  const componentCells = new Map<number, number[]>();
  for (let i = 0; i < cellCount; i++) {
    if (mask[i] === 0) continue;
    const root = uf.find(i);
    if (!componentCells.has(root)) componentCells.set(root, []);
    componentCells.get(root)!.push(i);
  }

  // Build ConfidentRegion[] from each component.
  const confidentRegions: ConfidentRegion[] = [];
  for (const cells of componentCells.values()) {
    confidentRegions.push(
      buildConfidentRegion(cells, densityGrid, classGrids, rows, cols),
    );
  }

  // Sort by confidence descending for consistent output.
  confidentRegions.sort((a, b) => b.confidence - a.confidence);

  // Per-class contribution totals (normalized by max over all classes).
  const classContributions = buildClassContributions(classGrids);

  // LLM-facing summary string.
  const summary = buildSummary(confidentRegions, classContributions);

  return {
    pageNumber,
    gridResolution: [rows, cols],
    confidentRegions,
    classContributions,
    summary,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function emptyHeatmap(
  pageNumber: number,
  rows: number,
  cols: number,
  classes: readonly string[],
): YoloHeatmap {
  return {
    pageNumber,
    gridResolution: [rows, cols],
    confidentRegions: [],
    classContributions: Object.fromEntries(classes.map((c) => [c, 0])),
    summary: "No dense YOLO regions detected",
  };
}

function bboxToCellSpan(
  ann: HeatmapYoloAnnotation,
  cols: number,
  rows: number,
): [number, number, number, number] {
  const c0 = clamp(Math.floor(ann.minX * cols), 0, cols - 1);
  const r0 = clamp(Math.floor(ann.minY * rows), 0, rows - 1);
  const c1 = clamp(Math.floor((ann.maxX - 1e-9) * cols), 0, cols - 1);
  const r1 = clamp(Math.floor((ann.maxY - 1e-9) * rows), 0, rows - 1);
  return [c0, r0, Math.max(c0, c1), Math.max(r0, r1)];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function tryMerge(
  uf: UnionFind,
  mask: Uint8Array,
  a: number,
  b: number,
  withinBounds: boolean,
): void {
  if (!withinBounds) return;
  if (mask[a] === 1 && mask[b] === 1) uf.union(a, b);
}

function buildConfidentRegion(
  cells: readonly number[],
  densityGrid: Float32Array,
  classGrids: Map<string, Float32Array>,
  rows: number,
  cols: number,
): ConfidentRegion {
  let minR = Infinity,
    maxR = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  let sumDensity = 0;
  for (const idx of cells) {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
    sumDensity += densityGrid[idx];
  }

  // Normalized LTWH bbox covering the component's grid cells.
  const bbox: BboxLTWH = [
    minC / cols,
    minR / rows,
    (maxC - minC + 1) / cols,
    (maxR - minR + 1) / rows,
  ];

  // Per-class contribution INSIDE this component.
  const classSums: Array<{ name: string; sum: number }> = [];
  for (const [cls, grid] of classGrids) {
    let s = 0;
    for (const idx of cells) s += grid[idx];
    if (s > 0) classSums.push({ name: cls, sum: s });
  }
  classSums.sort((a, b) => b.sum - a.sum);

  const confidence = cells.length > 0 ? sumDensity / cells.length : 0;

  return {
    bbox,
    confidence: Math.min(confidence, 1),
    classes: classSums.map((c) => c.name),
    cellCount: cells.length,
  };
}

function buildClassContributions(
  classGrids: Map<string, Float32Array>,
): Record<string, number> {
  const totals: Record<string, number> = {};
  let maxTotal = 0;
  for (const [cls, grid] of classGrids) {
    let sum = 0;
    for (let i = 0; i < grid.length; i++) sum += grid[i];
    totals[cls] = sum;
    if (sum > maxTotal) maxTotal = sum;
  }
  if (maxTotal > 0) {
    for (const cls of Object.keys(totals)) totals[cls] /= maxTotal;
  }
  return totals;
}

function buildSummary(
  regions: readonly ConfidentRegion[],
  classContributions: Record<string, number>,
): string {
  if (regions.length === 0) {
    const zero = Object.keys(classContributions).filter(
      (c) => classContributions[c] === 0,
    );
    if (zero.length > 0) {
      return `No dense YOLO regions detected (classes with no data: ${zero.join(", ")})`;
    }
    return "No dense YOLO regions detected";
  }

  const parts: string[] = [];
  for (let i = 0; i < Math.min(regions.length, 5); i++) {
    const r = regions[i];
    const zone = bboxZoneLabel(r.bbox);
    const classList = r.classes.length > 0 ? r.classes.join("+") : "—";
    parts.push(
      `${zone} [${r.bbox.map((v) => v.toFixed(2)).join(",")}] conf=${r.confidence.toFixed(2)} classes=${classList}`,
    );
  }
  if (regions.length > 5) parts.push(`(+${regions.length - 5} more)`);
  return `${regions.length} confident region(s): ${parts.join("; ")}`;
}

function bboxZoneLabel(bbox: BboxLTWH): string {
  const cx = bbox[0] + bbox[2] / 2;
  const cy = bbox[1] + bbox[3] / 2;
  const v = cy < 0.33 ? "top" : cy < 0.66 ? "mid" : "bottom";
  const h = cx < 0.33 ? "left" : cx < 0.66 ? "center" : "right";
  return `${v}-${h}`;
}

// ═══════════════════════════════════════════════════════════════════
// Bbox conversion helpers (public — reused by refresh hook)
// ═══════════════════════════════════════════════════════════════════

/** Convert a minmax bbox tuple to LTWH. */
export function minmaxToLtwh(b: BboxMinMax): BboxLTWH {
  return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
}
