import type { TextractLine, BboxLTWH } from "@/types";

/**
 * Detect multi-column layout inside a notes region by X-histogram gutter
 * analysis, and return one bbox per column (top-to-bottom, left-to-right).
 *
 * Canonical case: a user drags a region around a 3-column notes block
 * (Building Dept / General / Renovation). Without splitting, Y-clustering
 * interleaves lines across the columns and every binder produces garbage.
 *
 * Algorithm:
 *   1. Bin word-center X positions into histogram (default 200 bins)
 *   2. Smooth with 3-bin moving average
 *   3. Find contiguous runs of low-density bins (< densityFloor × peak)
 *      whose width exceeds `minGutterWidthFraction` of the region
 *   4. Split the region at the midpoint of each qualifying gutter
 *
 * Safety rails:
 *   - Region must be wide enough (`minRegionWidth`) to consider splitting
 *   - Must find ≥1 gutter AND the resulting sub-regions must each contain
 *     meaningful content (≥ minWordsPerColumn words)
 *   - Gutters within `edgeMargin` of region edges are ignored (that's
 *     just the region bbox's own padding)
 *
 * Returns:
 *   - `{columns: BboxLTWH[]}` with ≥2 entries when a split succeeded
 *   - `undefined` when the region is single-column (caller treats the
 *     original region as one column)
 */

export interface MultiColumnSplitOptions {
  /** Minimum region width (normalized page units) to attempt splitting. */
  minRegionWidth?: number;
  /** Number of histogram bins across the region. */
  bins?: number;
  /** Density threshold for gutter detection (fraction of peak bin). */
  densityFloor?: number;
  /** Minimum contiguous low-density run width (fraction of region width). */
  minGutterWidthFraction?: number;
  /** Minimum words that must remain in each resulting sub-region. */
  minWordsPerColumn?: number;
  /** Ignore gutters closer than this fraction to either region edge. */
  edgeMargin?: number;
}

const DEFAULT_OPTS: Required<MultiColumnSplitOptions> = {
  minRegionWidth: 0.2,
  bins: 200,
  densityFloor: 0.1,
  minGutterWidthFraction: 0.03,
  minWordsPerColumn: 4,
  edgeMargin: 0.05,
};

export function detectColumnsInRegion(
  lines: readonly TextractLine[],
  regionBbox: BboxLTWH,
  options?: MultiColumnSplitOptions,
): { columns: BboxLTWH[] } | undefined {
  const opts = { ...DEFAULT_OPTS, ...(options ?? {}) };
  const [rx, ry, rw, rh] = regionBbox;

  if (rw < opts.minRegionWidth) return undefined;

  // Collect word centers inside the region. The histogram must be word-level
  // (not line-level) because column detection depends on the horizontal
  // density of content — lines span wide ranges and would over-count.
  const xs: number[] = [];
  for (const line of lines) {
    if (!line.words) continue;
    for (const w of line.words) {
      if (!w.bbox || w.bbox.length < 4) continue;
      const cx = w.bbox[0] + w.bbox[2] / 2;
      const cy = w.bbox[1] + w.bbox[3] / 2;
      if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) {
        xs.push(cx);
      }
    }
  }
  if (xs.length < opts.minWordsPerColumn * 2) return undefined;

  // Build histogram
  const hist = new Array<number>(opts.bins).fill(0);
  for (const x of xs) {
    const bin = Math.min(opts.bins - 1, Math.max(0, Math.floor(((x - rx) / rw) * opts.bins)));
    hist[bin]++;
  }

  // 3-bin moving average smooth
  const smoothed = new Array<number>(opts.bins).fill(0);
  for (let i = 0; i < opts.bins; i++) {
    const a = i > 0 ? hist[i - 1] : hist[i];
    const b = hist[i];
    const c = i < opts.bins - 1 ? hist[i + 1] : hist[i];
    smoothed[i] = (a + b + c) / 3;
  }

  const peak = Math.max(...smoothed);
  if (peak === 0) return undefined;
  const threshold = peak * opts.densityFloor;

  // Find contiguous low-density runs (candidate gutters)
  const edgeBins = Math.floor(opts.edgeMargin * opts.bins);
  const minGutterBins = Math.max(1, Math.floor(opts.minGutterWidthFraction * opts.bins));

  const gutters: { startBin: number; endBin: number }[] = [];
  let runStart = -1;
  for (let i = edgeBins; i < opts.bins - edgeBins; i++) {
    if (smoothed[i] <= threshold) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1 && i - runStart >= minGutterBins) {
        gutters.push({ startBin: runStart, endBin: i - 1 });
      }
      runStart = -1;
    }
  }
  // Flush trailing run
  if (runStart !== -1 && opts.bins - edgeBins - runStart >= minGutterBins) {
    gutters.push({ startBin: runStart, endBin: opts.bins - edgeBins - 1 });
  }

  if (gutters.length === 0) return undefined;

  // Convert each gutter's midpoint bin to a normalized-x boundary, then
  // slice the region into [rx, b1, b2, ..., rx+rw] sub-columns.
  const boundaries = gutters.map((g) => {
    const midBin = (g.startBin + g.endBin) / 2;
    return rx + (midBin / opts.bins) * rw;
  });
  const allBoundaries = [rx, ...boundaries, rx + rw];
  const columns: BboxLTWH[] = [];
  for (let i = 0; i < allBoundaries.length - 1; i++) {
    const colLeft = allBoundaries[i];
    const colRight = allBoundaries[i + 1];
    columns.push([colLeft, ry, colRight - colLeft, rh]);
  }

  // Reject the split if any resulting column has too few words
  const wordsPerColumn = columns.map((col) => {
    const [cx, , cw] = col;
    return xs.filter((x) => x >= cx && x < cx + cw).length;
  });
  if (wordsPerColumn.some((n) => n < opts.minWordsPerColumn)) return undefined;

  return { columns };
}
