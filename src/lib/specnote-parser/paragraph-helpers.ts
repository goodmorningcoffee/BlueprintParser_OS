import type { TextractLine, BboxLTWH } from "@/types";

/**
 * Filter TextractLines whose center falls inside `bbox` (LTWH convention).
 * Used by the paragraph overlay's cluster cache when building per-region or
 * fallback line sets.
 */
export function linesInside(bbox: BboxLTWH, lines: readonly TextractLine[]): TextractLine[] {
  const [rx, ry, rw, rh] = bbox;
  const rRight = rx + rw;
  const rBottom = ry + rh;
  return lines.filter((line) => {
    if (!line.bbox || line.bbox.length < 4) return false;
    const cx = line.bbox[0] + line.bbox[2] / 2;
    const cy = line.bbox[1] + line.bbox[3] / 2;
    return cx >= rx && cx <= rRight && cy >= ry && cy <= rBottom;
  });
}

/**
 * Pick the cluster whose Y-range contains `cursorY`. Clusters are expected
 * to be sorted top-to-bottom (as produced by `clusterLinesByYGap`).
 *
 * Linear scan is fine — typical cluster counts are tens, not hundreds — but
 * the entry points are small enough that a binary search is a drop-in.
 * Returns the cluster index, or -1 if the cursor is between clusters.
 */
export function findClusterIndexByY(
  clusters: readonly TextractLine[][],
  cursorY: number,
): number {
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (cluster.length === 0) continue;
    let top = Infinity;
    let bottom = -Infinity;
    for (const line of cluster) {
      if (line.bbox[1] < top) top = line.bbox[1];
      if (line.bbox[1] + line.bbox[3] > bottom) bottom = line.bbox[1] + line.bbox[3];
    }
    if (cursorY >= top && cursorY <= bottom) return i;
  }
  return -1;
}

/**
 * Compute the union bbox (MinMax) of a cluster of lines.
 */
export function clusterUnionBbox(cluster: readonly TextractLine[]): [number, number, number, number] {
  if (cluster.length === 0) return [0, 0, 0, 0];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const line of cluster) {
    if (!line.bbox || line.bbox.length < 4) continue;
    const [lx, ly, lw, lh] = line.bbox;
    if (lx < minX) minX = lx;
    if (ly < minY) minY = ly;
    if (lx + lw > maxX) maxX = lx + lw;
    if (ly + lh > maxY) maxY = ly + lh;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Scale normalized-to-outer-bbox `colBoundaries` from the source paragraph
 * into the target paragraph's bbox. Used by Cmd+V clipboard paste.
 *
 * Boundaries are stored as normalized X positions [0..1] relative to the
 * outer-bbox left edge — so the same template adapts proportionally
 * across different-sized paragraphs.
 *
 * Input bbox convention: MinMax [x0, y0, x1, y1].
 */
export function scaleColBoundariesToBbox(
  sourceBoundaries: readonly number[],
  sourceBbox: readonly [number, number, number, number],
  targetBbox: readonly [number, number, number, number],
): number[] {
  const [sx0, , sx1] = sourceBbox;
  const [tx0, , tx1] = targetBbox;
  const sw = sx1 - sx0;
  const tw = tx1 - tx0;
  if (sw === 0 || tw === 0) return [];
  return sourceBoundaries.map((b) => {
    const local = (b - sx0) / sw;
    return tx0 + local * tw;
  });
}

/**
 * Derive a simple `{Key, Value}` row from a cluster of lines via the
 * largest-inter-word-gap heuristic. Parallel to bindKeyValueGrid per-line
 * logic but applied to the joined-text "longest line" — a compromise for
 * the batch-commit flow where we want one row per paragraph.
 */
export function rowTextFromClusterKV(cluster: readonly TextractLine[]): { Key: string; Value: string } {
  if (cluster.length === 0) return { Key: "", Value: "" };

  // Pick the line with the biggest inter-word gap as the K:V anchor
  let bestGap = 0;
  let bestLine: TextractLine | undefined;
  for (const line of cluster) {
    if (!line.words || line.words.length < 2) continue;
    const sorted = [...line.words].sort((a, b) => a.bbox[0] - b.bbox[0]);
    for (let i = 1; i < sorted.length; i++) {
      const prevRight = sorted[i - 1].bbox[0] + sorted[i - 1].bbox[2];
      const gap = sorted[i].bbox[0] - prevRight;
      if (gap > bestGap) {
        bestGap = gap;
        bestLine = line;
      }
    }
  }

  if (!bestLine) {
    const joined = cluster.map((l) => l.text.trim()).join(" ").trim();
    return { Key: joined, Value: "" };
  }

  const sorted = [...(bestLine.words ?? [])].sort((a, b) => a.bbox[0] - b.bbox[0]);
  let maxGap = 0;
  let splitIdx = -1;
  for (let i = 1; i < sorted.length; i++) {
    const prevRight = sorted[i - 1].bbox[0] + sorted[i - 1].bbox[2];
    const gap = sorted[i].bbox[0] - prevRight;
    if (gap > maxGap) {
      maxGap = gap;
      splitIdx = i;
    }
  }

  if (splitIdx <= 0) {
    return { Key: bestLine.text.trim(), Value: "" };
  }

  const key = sorted.slice(0, splitIdx).map((w) => w.text).join(" ").trim();
  const value = sorted.slice(splitIdx).map((w) => w.text).join(" ").trim();
  const restLines = cluster.filter((l) => l !== bestLine).map((l) => l.text.trim());
  const fullValue = restLines.length ? `${value} ${restLines.join(" ")}`.trim() : value;
  return { Key: key, Value: fullValue };
}

/**
 * Derive `{Key, Note}` for notes-numbered clusters. First line's leading
 * numeric token becomes Key; the rest is Note.
 */
export function rowTextFromClusterNumbered(cluster: readonly TextractLine[]): { Key: string; Note: string } {
  if (cluster.length === 0) return { Key: "", Note: "" };
  const sorted = [...cluster].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const first = sorted[0];
  const match = /^\s*\(?(\d{1,3})\s*[.):]\s*/.exec(first.words?.[0]?.text ?? "");
  const key = match?.[1] ?? "";
  const afterKey = first.text.replace(/^\s*\(?\d{1,3}\s*[.):]\s*/, "").trim();
  const rest = sorted.slice(1).map((l) => l.text.trim()).join(" ");
  const note = [afterKey, rest].filter(Boolean).join(" ").trim();
  return { Key: key, Note: note };
}

/**
 * Derive `{sectionHeader, body}` for spec clusters. First line is the header,
 * remaining lines concatenate as body.
 */
export function rowTextFromClusterSpec(cluster: readonly TextractLine[]): { sectionHeader: string; body: string } {
  if (cluster.length === 0) return { sectionHeader: "", body: "" };
  const sorted = [...cluster].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const sectionHeader = sorted[0].text.trim();
  const body = sorted.slice(1).map((l) => l.text.trim()).join(" ").trim();
  return { sectionHeader, body };
}

/**
 * Derive `{text}` for generic/notes-general clusters — single-column dump.
 */
export function rowTextFromClusterGeneric(cluster: readonly TextractLine[]): { text: string } {
  if (cluster.length === 0) return { text: "" };
  const sorted = [...cluster].sort((a, b) => a.bbox[1] - b.bbox[1]);
  return { text: sorted.map((l) => l.text.trim()).join(" ").trim() };
}

/**
 * Union bbox of multiple paragraph bboxes — used when Save aggregates the
 * paragraph batch into a single ParsedRegion bbox.
 */
export function unionBboxes(bboxes: ReadonlyArray<readonly [number, number, number, number]>): [number, number, number, number] {
  if (bboxes.length === 0) return [0, 0, 0, 0];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x0, y0, x1, y1] of bboxes) {
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  return [minX, minY, maxX, maxY];
}
