"use client";

// [TP-3 WP-3.F, C2-M12] The classic Notes/Spec cards honour workspace verdicts. A text region the workspace
// rejected (or accepted: committed there) leaves the classic card list too, matched by CONTENT (type + IoU ≥ .7
// with the verdict's box, `findTextRegionVerdict`), never by the positional id that a reprocess rebinds (K30).
// The cards' own legacy filter (`rejectedTextRegionIds`, `sourceTextRegionId`) is untouched; this only removes
// more. Sibling hook, so the card files change by one call (PLAN §2.3).

import { useMemo } from "react";
import { findTextRegionVerdict, textRegionMinMax } from "@/lib/parse-engine/text-region-verdicts";
import { useTextRegionVerdicts } from "@/queries/useTextRegionVerdicts";
import type { TextRegion } from "@/types";

/** `regions` minus those a workspace verdict covers (the same array while there are none). */
export function useTextRegionVerdictFilter<T extends TextRegion>(regions: T[], pageNumber: number): T[] {
  const verdicts = useTextRegionVerdicts(pageNumber);
  return useMemo(() => {
    if (!verdicts || Object.keys(verdicts).length === 0) return regions;
    return regions.filter((tr) => {
      const b = textRegionMinMax(tr);
      return !b || !findTextRegionVerdict(verdicts, tr.type, b);
    });
  }, [regions, verdicts]);
}
