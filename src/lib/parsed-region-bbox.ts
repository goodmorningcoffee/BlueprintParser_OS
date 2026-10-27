/**
 * The one reader for a saved `ParsedRegion.bbox` (K04).
 *
 * Every writer stores that box as normalised MinMax `[x0, y0, x1, y1]` (`regions.ts` converts the
 * classifier path; the parser path sends MinMax), but the type says `BboxLTWH`, and five consumers
 * read it as LTWH: a schedule saved at `[.6, .1, .9, .4]` became `[.6, .1, 1.5, .5]`. Read it here.
 * Stored rows are not migrated; this reader never re-interprets the numbers.
 *
 * Returns a fresh MinMax tuple, or null when the box is missing or not four finite numbers.
 */

import type { BboxMinMax } from "@/types";

export function parsedRegionMinMax(
  region: { bbox?: readonly number[] | null } | null | undefined,
): BboxMinMax | null {
  const b = region?.bbox;
  if (!Array.isArray(b) || b.length !== 4) return null;
  if (!b.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return [b[0], b[1], b[2], b[3]];
}
