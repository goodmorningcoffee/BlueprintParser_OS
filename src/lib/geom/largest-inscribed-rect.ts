/**
 * largest-inscribed-rect.ts
 *
 * Find the top-K largest axis-aligned rectangles inscribed entirely in the
 * empty (0-valued) region of a binary mask.
 *
 * Classical "Maximal Rectangle" algorithm (Leetcode 85 formulation): per row,
 * maintain a column histogram of consecutive 0-cells ending at that row, then
 * solve largest-rectangle-in-histogram with a monotonic stack in O(W).
 * Total complexity: O(W·H) per rectangle; K rectangles: O(K·W·H).
 *
 * Conceptually equivalent to the Marzeh/Tahmasbi/Mireh 2019 "Largest Inscribed
 * Rectangle" approach used by OpenStitching/lir (Apache-2.0). Clean re-derivation
 * from Leetcode-85 pseudocode; no code copied.
 *
 * Used by text-region-classifier Stage C: rasterize word bboxes onto a mask
 * at a small resolution (default 500×700) and recover the top-3 inscribed
 * whitespace rectangles. Vertical rectangles (h/w > 3) are column gutters;
 * horizontal rectangles are paragraph breaks.
 *
 * Mask convention: 1 = blocked (word pixel); 0 = empty (whitespace).
 */

export interface InscribedRect {
  /** Left column index (inclusive). */
  x: number;
  /** Top row index (inclusive). */
  y: number;
  /** Width in cells. */
  w: number;
  /** Height in cells. */
  h: number;
  /** w * h. */
  area: number;
}

/**
 * Find the single largest inscribed empty rectangle.
 *
 * @param mask   Row-major binary mask. mask[y*width + x]: 1=blocked, 0=empty.
 * @param width  Mask width in cells (must match mask.length / height).
 * @param height Mask height in cells.
 * @returns The largest empty rectangle, or `{x:0,y:0,w:0,h:0,area:0}` if the
 *          mask is fully blocked.
 */
export function largestInscribedRect(
  mask: Uint8Array,
  width: number,
  height: number,
): InscribedRect {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, w: 0, h: 0, area: 0 };
  if (mask.length < width * height) {
    throw new Error(
      `mask too small: expected ${width * height} cells, got ${mask.length}`,
    );
  }

  const heights = new Int32Array(width);
  let best: InscribedRect = { x: 0, y: 0, w: 0, h: 0, area: 0 };

  for (let y = 0; y < height; y++) {
    // Update column histogram: heights[x] = # consecutive 0s ending at row y
    for (let x = 0; x < width; x++) {
      heights[x] = mask[y * width + x] === 0 ? heights[x] + 1 : 0;
    }
    // Largest rectangle in this row's histogram (stack-based, O(width))
    const r = largestRectInHistogram(heights);
    if (r.area > best.area) {
      best = {
        x: r.left,
        y: y - r.height + 1,
        w: r.right - r.left + 1,
        h: r.height,
        area: r.area,
      };
    }
  }
  return best;
}

/**
 * Find the top-K largest inscribed empty rectangles. After finding each
 * rectangle, its cells are marked blocked on a working copy of the mask,
 * then the search repeats. Returned in descending area order.
 *
 * @param k Maximum number of rectangles to return. Result length may be
 *          smaller if the mask runs out of empty space.
 */
export function topKInscribedRects(
  mask: Uint8Array,
  width: number,
  height: number,
  k: number,
): InscribedRect[] {
  if (k <= 0) return [];
  const workCopy = new Uint8Array(mask); // defensive copy
  const results: InscribedRect[] = [];
  for (let i = 0; i < k; i++) {
    const r = largestInscribedRect(workCopy, width, height);
    if (r.area === 0) break;
    results.push(r);
    // Mark the found rectangle as blocked so the next iteration finds the
    // next-largest *distinct* rectangle.
    for (let y = r.y; y < r.y + r.h; y++) {
      const rowStart = y * width;
      workCopy.fill(1, rowStart + r.x, rowStart + r.x + r.w);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Largest-rectangle-in-histogram — monotonic-stack O(n)
// ═══════════════════════════════════════════════════════════════════

interface HistogramRect {
  left: number;
  right: number;
  height: number;
  area: number;
}

function largestRectInHistogram(heights: Int32Array): HistogramRect {
  const n = heights.length;
  const stack: number[] = []; // indices with monotonically increasing heights
  let best: HistogramRect = { left: 0, right: -1, height: 0, area: 0 };

  // Sentinel pass with i = n simulates a 0-height column at the end to flush stack
  for (let i = 0; i <= n; i++) {
    const curHeight = i === n ? 0 : heights[i];
    while (stack.length > 0 && heights[stack[stack.length - 1]] > curHeight) {
      const topIdx = stack.pop()!;
      const topH = heights[topIdx];
      const leftBound = stack.length === 0 ? 0 : stack[stack.length - 1] + 1;
      const rightBound = i - 1;
      const area = topH * (rightBound - leftBound + 1);
      if (area > best.area) {
        best = { left: leftBound, right: rightBound, height: topH, area };
      }
    }
    stack.push(i);
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════
// Mask helpers — rasterizing word bboxes
// ═══════════════════════════════════════════════════════════════════

export interface MaskBox {
  /** Normalized [0,1] or absolute pixel LTWH. */
  bbox: [number, number, number, number];
}

/**
 * Rasterize a list of word bboxes onto a binary mask. Input bboxes are in
 * normalized [0,1] coordinates by default; set `normalized: false` for
 * absolute pixel coordinates.
 *
 * Allocates and returns a new Uint8Array of length width*height, with
 * 1 = word pixel, 0 = empty.
 */
export function rasterizeBboxes(
  boxes: readonly MaskBox[],
  width: number,
  height: number,
  opts?: { normalized?: boolean },
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const normalized = opts?.normalized ?? true;
  for (const b of boxes) {
    const [bx, by, bw, bh] = b.bbox;
    let left: number, top: number, right: number, bottom: number;
    if (normalized) {
      left = Math.max(0, Math.floor(bx * width));
      top = Math.max(0, Math.floor(by * height));
      right = Math.min(width, Math.ceil((bx + bw) * width));
      bottom = Math.min(height, Math.ceil((by + bh) * height));
    } else {
      left = Math.max(0, Math.floor(bx));
      top = Math.max(0, Math.floor(by));
      right = Math.min(width, Math.ceil(bx + bw));
      bottom = Math.min(height, Math.ceil(by + bh));
    }
    for (let y = top; y < bottom; y++) {
      const rowStart = y * width;
      mask.fill(1, rowStart + left, rowStart + right);
    }
  }
  return mask;
}
