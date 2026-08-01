// [refactor jul23 P4.1 U10] Log-mode shape observation at the two CLIENT region-data
// persistence sinks — regions.promote (Parser-Save verbatim + server-binder) and
// pages.intelligence (PATCH). Sibling to annotation-data-observe.ts.
//
// DELIBERATELY SIMPLER than the annotation module: it has exactly ONE job — OBSERVE, and
// it NEVER throws. There is NO v-gate here at all, and that omission is load-bearing (WHY it
// is correct, not an oversight — RD-U10 / recon §3):
//
//   • NO region write carries the in-blob version tag `v` at HEAD. promoteRegion persists
//     either server-binder output (the spec/grid `regionData = {…}` literals in promoteRegion)
//     or the client's overrides.data VERBATIM (its Parser-Save branch) — neither stamps `v`;
//     updatePageIntelligence's tx UPDATE writes the shallow-merged PI as-is — no `v` stamp
//     either. No region upgrader
//     exists (RD-K defers them), and REGION_DATA_VERSION is referenced by NO writer. A v-gate
//     would therefore be 100% INERT — every leg dead code.
//   • WORSE, it could not even be built correctly yet: the region schemas are bare `.loose()`
//     (region-data.ts, spec Verdict 1 / RD-A) — a `v` key is tolerated as an unknown extra, so
//     a gate over REGION_SCHEMAS[kind] would NOT reject a non-1 `v` the way annotation-data's
//     zVersionTag-spread schemas do. Arming v-semantics requires adding `v: z.literal(1).…` to
//     each region member, which lands WITH the future region-upgrader unit (the first code to
//     produce v-carrying region round-trips, and thus the owner of v-semantics — RD-K).
//
// So U10 is LOG-MODE ONLY: classify the blob about to be persisted, validate against its
// registry schema, emit ONE structured logger.warn on mismatch. The write proceeds
// byte-identical either way — "log-mode IS the probe" (the sandbox can't inspect prod data;
// the canary logs tell the owner whether real region traffic violates the schemas, gating a
// later canary→reject flip that is its OWN frozen unit — not part of U10).
//
// NO allowlist (contrast annotation-data's OBSERVED_SHAPES): every classified kind is
// validated. That is safe because the classifier's catch-all "unknown" maps to
// zUnknownRegionData (z.record — accepts any object), so a blob that matches no specific shape
// is silent; only a blob that LOOKS like a known shape but fails its schema warns.
//
// Log hygiene: PATHS and CODES only — never blob values. Region data carries OCR'd table text
// and user-authored keynote/legend descriptions; a value dump would leak project content.
import { logger } from "@/lib/logger";
import {
  classifyRegionData,
  REGION_SCHEMAS,
  type RegionDataKind,
} from "@/types/shapes";

/** Cap issue detail per log entry — enough to locate the field, no value dumps. */
const MAX_LOGGED_ISSUES = 5;

/**
 * Observe the shape of a single ParsedRegion.data blob at a persistence sink. NEVER throws
 * (no v-gate — see the module header). A malformed blob persists byte-identical and emits one
 * structured "[shape-registry]" warn; a valid or unclassifiable blob is silent.
 *
 * @param data the value that will be persisted (e.g. promoteRegion's assembled
 *             `parsedRegion.data` — this covers BOTH the server-binder grid/spec shape AND the
 *             Parser-Save verbatim client blob in ONE call, since both flow into that field)
 * @param sink stable sink identifier for the structured log (e.g. "regions.promote")
 */
export function observeRegionData(data: unknown, sink: string): void {
  // jsonb-null / absent: nothing to observe (classify() → "unknown" → z.record accepts anyway).
  if (data === null || data === undefined) return;
  const kind = classifyRegionData(data);
  const failure = validateForLog(data, kind);
  if (failure) {
    logger.warn(`[shape-registry] region data failed shape validation (log-only)`, {
      sink,
      kind,
      issueCount: failure.issueCount,
      issues: failure.paths.slice(0, MAX_LOGGED_ISSUES),
    });
  }
}

/**
 * Batch-sink variant [parallels observeAnnotationDataBatch / U5-review MED]: ONE warn per
 * (sink, kind) per CALL, not per row. PATCH /api/pages/intelligence round-trips the client's
 * WHOLE cached parsedRegions array (TableParsePanel.tsx:164 / KeynotePanel.tsx:264,878 spread
 * the existing regions alongside the new one, all persisted), so a page full of legacy-drifted
 * regions would otherwise flood the canary and drown the exact signal log-mode exists to
 * surface. Aggregating collapses same-kind drift into a single entry carrying per-batch counts.
 */
export function observeRegionDataBatch(datas: unknown[], sink: string): void {
  const agg = new Map<
    RegionDataKind,
    { failedCount: number; issueCount: number; paths: Set<string> }
  >();
  for (const data of datas) {
    if (data === null || data === undefined) continue;
    const kind = classifyRegionData(data);
    const failure = validateForLog(data, kind);
    if (!failure) continue;
    const entry = agg.get(kind) ?? { failedCount: 0, issueCount: 0, paths: new Set() };
    entry.failedCount += 1;
    entry.issueCount += failure.issueCount;
    for (const p of failure.paths) entry.paths.add(p);
    agg.set(kind, entry);
  }
  for (const [kind, entry] of agg) {
    logger.warn(`[shape-registry] region data batch failed shape validation (log-only)`, {
      sink,
      kind,
      rowCount: datas.length,
      failedCount: entry.failedCount,
      issueCount: entry.issueCount,
      issues: [...entry.paths].slice(0, MAX_LOGGED_ISSUES),
    });
  }
}

/** Log-mode leg: returns the failure summary for a blob that fails its classified schema (else null). */
function validateForLog(
  data: unknown,
  kind: RegionDataKind,
): { issueCount: number; paths: string[] } | null {
  const result = REGION_SCHEMAS[kind].safeParse(data);
  if (result.success) return null;
  return {
    issueCount: result.error.issues.length,
    paths: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}:${i.code}`),
  };
}
