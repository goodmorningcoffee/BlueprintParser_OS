/**
 * cluster-by-tolerance.ts
 *
 * Sequential gap-to-previous clustering with a tolerance threshold.
 * Port of pdfplumber's `cluster_objects` (MIT-licensed, clean re-derivation
 * from documented behavior at jsvine/pdfplumber:utils/clustering.py).
 *
 * Given a list of items and a numeric key, groups consecutive items into
 * clusters whenever key[i] - key[i-1] <= tolerance. When the gap exceeds
 * tolerance, a new cluster opens.
 *
 * Used by text-region-classifier Stage B to group Textract LINES into
 * Y-aligned rows, then re-applied on X-bounds to discover column bands.
 *
 * Deterministic, O(n log n) for the initial sort, O(n) for the walk.
 */

/**
 * Cluster items by a numeric key with a gap-to-previous tolerance.
 *
 * @param items      Unordered input items.
 * @param keyFn      Extracts a numeric key for comparison (e.g., `line => line.bbox[1]`).
 * @param tolerance  Maximum allowed key difference between consecutive items
 *                   in the same cluster. Gap > tolerance opens a new cluster.
 * @returns Array of clusters, each a sub-array of `items` in key-ascending order.
 *          Empty input returns `[]`.
 */
export function clusterByTolerance<T>(
  items: readonly T[],
  keyFn: (item: T) => number,
  tolerance: number,
): T[][] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => keyFn(a) - keyFn(b));
  const clusters: T[][] = [];
  let current: T[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevKey = keyFn(current[current.length - 1]);
    const curKey = keyFn(sorted[i]);
    if (curKey - prevKey <= tolerance) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);
  return clusters;
}
