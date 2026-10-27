/**
 * Parse-engine geometry primitives (pure, client-safe; E-4, E-8).
 *
 * Every engine box is a normalised MinMax `[x0, y0, x1, y1]`. Legacy LTWH boxes (`TextractWord.bbox`,
 * `TextRegion.bbox`, classic boxes) are converted once, at the loader edge, with `ltwhToMinMax`.
 *
 * `wordsIn` is THE word-in-box predicate: a word belongs to a box when its CENTRE lies inside. That
 * is the rule every legacy parser already uses (re-implemented per file, G3 D11); it lives here once.
 *
 * Import purity: this module imports nothing (see `__tests__/client-safe-imports.test.ts`). The box
 * alias below is structural, so it is interchangeable with `BboxMinMax` from `parse-engine/types`.
 */

type Box = readonly [number, number, number, number];

/** LTWH `[left, top, width, height]` → MinMax `[x0, y0, x1, y1]`. */
export function ltwhToMinMax(b: Box): [number, number, number, number] {
  return [b[0], b[1], b[0] + b[2], b[1] + b[3]];
}

/** MinMax → LTWH, for the few legacy writers that still store LTWH. */
export function minMaxToLtwh(b: Box): [number, number, number, number] {
  return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
}

/** Centre `[cx, cy]` of a MinMax box. */
export function centreOf(b: Box): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/**
 * Edge rule for `centreIn` / `wordsIn`:
 * - `"closed"` (default): `lo <= c <= hi`, for a region crop;
 * - `"half-open"`: `lo <= c < hi`, for cells that tile a grid, so a centre on a shared boundary
 *   lands in exactly one cell.
 */
export type EdgeRule = "closed" | "half-open";

/** True when the centre of `b` lies inside `box` under `edges`. */
export function centreIn(b: Box, box: Box, edges: EdgeRule = "closed"): boolean {
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  if (edges === "half-open") return cx >= box[0] && cx < box[2] && cy >= box[1] && cy < box[3];
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
}

/** The words whose centre lies inside `box`, in input order. */
export function wordsIn<W extends { b: Box }>(
  words: readonly W[],
  box: Box,
  edges: EdgeRule = "closed",
): W[] {
  return words.filter((w) => centreIn(w.b, box, edges));
}

/** Smallest MinMax box covering every box; null for an empty list. */
export function unionBox(boxes: readonly Box[]): [number, number, number, number] | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  }
  return [x0, y0, x1, y1];
}
