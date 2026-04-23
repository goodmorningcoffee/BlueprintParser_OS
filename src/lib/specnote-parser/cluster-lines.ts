import type { TextractLine } from "@/types";

/**
 * Group lines into paragraph-scale clusters by vertical whitespace gaps.
 *
 * Extracted from the Stage-1 classifier's `proposeCandidateRegions` Y-cluster
 * step, exposed as a standalone utility so user-facing overlays
 * (`ParagraphOverlay`) can re-cluster on demand inside a larger region
 * (Stage-1 merge can fuse paragraphs into column-scale regions).
 *
 * Lines are sorted top-to-bottom, then split whenever the gap from the
 * previous cluster's bottom to this line's top exceeds `yGapTolerance`.
 *
 * Returns clusters in top-to-bottom order. Each cluster preserves input
 * line ordering.
 */
export function clusterLinesByYGap(
  lines: readonly TextractLine[],
  yGapTolerance: number,
): TextractLine[][] {
  const valid = lines.filter((l) => l.bbox && l.bbox.length >= 4);
  if (valid.length === 0) return [];

  const ysorted = [...valid].sort((a, b) => a.bbox[1] - b.bbox[1]);

  const clusters: TextractLine[][] = [];
  let current: TextractLine[] = [];
  let currentBottom = -Infinity;

  for (const line of ysorted) {
    const top = line.bbox[1];
    const bottom = line.bbox[1] + line.bbox[3];

    if (current.length === 0) {
      current.push(line);
      currentBottom = bottom;
      continue;
    }

    const gap = top - currentBottom;
    if (gap <= yGapTolerance) {
      current.push(line);
      if (bottom > currentBottom) currentBottom = bottom;
    } else {
      clusters.push(current);
      current = [line];
      currentBottom = bottom;
    }
  }
  if (current.length > 0) clusters.push(current);

  return clusters;
}
