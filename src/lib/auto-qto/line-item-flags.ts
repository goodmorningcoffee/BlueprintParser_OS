// [tag-mapping v2 2026-10-24] Pure helpers behind AutoQtoTab's review step: the line-item flags
// (moved verbatim from the tab's inline `computeFlags`) plus the completeness certificate —
// the schedule's quantity column (arbitrated by body content, src/lib/tag-mapping/schedule-rules.ts)
// against the counted instances. A MISMATCH sets the `qty-mismatch` flag that was declared in
// QtoFlag and never set anywhere (research/tools_audit).

import type { QtoFlag } from "@/types";
import type { ScoredMatch } from "@/lib/tag-mapping";
import {
  arbitrateColumnRoles,
  buildCompletenessCertificate,
  type ColumnRoles,
  type CompletenessCertificate,
} from "@/lib/tag-mapping";

export function qtoLineItemFlags(instances: ReadonlyArray<Pick<ScoredMatch, "confidenceTier" | "confidence">>, certificate?: CompletenessCertificate | null): QtoFlag[] {
  const flags: QtoFlag[] = [];
  if (instances.length === 0) flags.push("not-found");
  const mediumCount = instances.filter((i) => i.confidenceTier === "medium").length;
  const lowCount = instances.filter((i) => i.confidenceTier === "low").length;
  // Fallback for pre-Phase-2 instances missing tier: use confidence
  const fuzzyCount = instances.filter((i) => i.confidenceTier === undefined && i.confidence < 1.0).length;
  if (mediumCount > 0) flags.push("medium-confidence");
  if (lowCount > 0 || fuzzyCount > 0) flags.push("low-confidence");
  if (certificate?.verdict === "MISMATCH") flags.push("qty-mismatch");
  return flags;
}

export interface ScheduleLike {
  headers: string[];
  rows: Record<string, string>[];
  tagColumn: string;
}

/** Column roles of the parsed schedule the tab is mapping (the user's tag column preferred). */
export function scheduleColumnRoles(schedule: ScheduleLike): ColumnRoles {
  return arbitrateColumnRoles(schedule.headers, schedule.rows, { preferredTagColumn: schedule.tagColumn });
}

/** The certificate for one tag's row (null when the schedule has no quantity column). */
export function lineItemCertificate(
  tag: string,
  row: Record<string, string> | undefined,
  roles: ColumnRoles,
  instances: ReadonlyArray<{ pageNumber: number }>,
): CompletenessCertificate | null {
  if (!roles.qtyColumn || roles.drawingList) return null;
  return buildCompletenessCertificate({
    tag,
    quantityRaw: row?.[roles.qtyColumn],
    sheetRaw: roles.sheetColumn ? row?.[roles.sheetColumn] : null,
    grid: roles.grid,
    instances,
    drawingNumbers: {},
  });
}
