// [refactor jul23 P4.1 U1] Log-mode shape observation at annotation persistence sinks.
//
// P4.1's landing contract (spec Verdict 2): ZERO behavior change on existing wires. This
// module therefore has exactly two jobs at a sink:
//
//  1. OBSERVE (never throw): classify the blob about to be persisted; if its shape is in
//     the observed allowlist, validate against the registry schema and emit ONE structured
//     logger.warn on mismatch. The write itself proceeds byte-identical either way —
//     "log-mode IS the probe" (we cannot inspect prod data from the sandbox; the canary
//     logs tell the owner whether real traffic ever violates the schemas, gating the later
//     canary→reject flip, which is its OWN frozen unit — not part of P4.1).
//  2. V-GATE (throws ApiError): a blob carrying the in-blob version tag `v` was written by
//     NEW registry-aware code and MUST be valid (cheap, self-inflicted-only — no current
//     writer stamps `v`, so no existing wire can hit this). Invalid v-carrying data → 400.
//
// Placement contract (RD-D): call at the SINK, after the demo gate / write-capability
// checks, on the value ACTUALLY persisted (post-mergeAutoCsi) — never at the frozen
// validate-before-auth 400 boundary (error-order and envelope shapes there are pinned).
// We deliberately call just BEFORE the tx opens rather than inside it: validation is pure
// CPU, the observed value is final by then, and keeping it out of the tx avoids holding
// row locks during zod work (same observability, better physics).
//
// Log hygiene: we log issue PATHS and CODES only — never blob values (annotation data can
// carry user content). Structured ctx keys land as top-level JSON fields on the log entry
// (logger.ts spreads plain-object ctx), so per-shape counts are queryable downstream.
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/api/envelope";
import {
  classifyAnnotationData,
  SHAPE_SCHEMAS,
  type AnnotationDataKind,
} from "@/types/shapes";

/**
 * Shapes currently under log-mode observation. U1 wired scale-calibration (the
 * pattern-prover: single shape, single writer, own source enum). U2-U4 add the three
 * remaining client takeoff shapes (count-marker, linear-polyline, area-polygon) — same
 * single-sink mechanism, one concern per landed unit. The allowlist still grows one
 * frozen unit at a time: U5 adds symbol-search (and extends observation to the batch
 * sink), and U6+ bring empty-markup + the server-pipeline / mutate-in-place sinks.
 */
const OBSERVED_SHAPES: ReadonlySet<AnnotationDataKind> = new Set([
  "scale-calibration",
  // [refactor jul23 P4.1 U2-U4] client takeoff shapes join the log-mode allowlist.
  "count-marker",
  "linear-polyline",
  "area-polygon",
  // [refactor jul23 P4.1 U5] symbol-search joins as the batch sink comes under
  // observation (createAnnotationBatch). shape-parse stays unobserved until U7
  // (it is shared with the server-pipeline writers, which U7 wires as log+skip).
  "symbol-search",
  // [refactor jul23 P4.1 U6] empty-markup joins as the PUT sink (annotations.update)
  // comes under observation. Its schema is all-optional, so only wrong-TYPED known
  // keys (csiCodes/keywords/v) can ever warn — unknown keys stay tolerated.
  "empty-markup",
]);

/** Cap issue detail per log entry — enough to locate the field, no value dumps. */
const MAX_LOGGED_ISSUES = 5;

/**
 * Observe (and, for v-carrying blobs, enforce) the shape of an annotation `data` blob at
 * a persistence sink.
 *
 * @param data the value that will be persisted (post-mergeAutoCsi — observe what actually
 *             lands in the column, not the client's pre-merge payload)
 * @param sink stable sink identifier for the structured log (e.g. "annotations.create")
 * @param opts.gate default true. Pass FALSE when the value was SEEDED FROM AN EXISTING
 *        ROW rather than client-supplied (e.g. a note-only PUT re-persisting the row's
 *        own blob): the reject leg is for NEW v-carrying writes only (Verdict 2), and the
 *        historic corpus is unsampleable — a legacy blob with a coincidental top-level
 *        `v` key must never 400 an existing wire. With gate:false, v-carrying data falls
 *        through to plain log-mode observation. [refactor jul23 P4.1 U6-hazard]
 * @throws ApiError("VALIDATION") ONLY when gate is on AND the data carries `v` AND it is
 *         unclassifiable or fails its shape schema. Never throws for v-absent data.
 */
export function observeAnnotationData(
  data: unknown,
  sink: string,
  opts: { gate?: boolean } = {},
): void {
  // jsonb-null / absent data: nothing to observe (classify() would say "unknown", which
  // is unobserved in U1 anyway) and nothing to gate (no `v`).
  if (data === null || data === undefined) return;

  const kind = classifyAnnotationData(data);
  if (opts.gate !== false) {
    gateVCarrying(data, kind, sink);
    if (vPresent(data)) return; // versioned and valid — no observation log needed.
  }

  // LOG-MODE observation (v-absent = every existing wire). Never throws.
  const failure = validateForLog(data, kind);
  if (failure) {
    logger.warn(`[shape-registry] v0 write failed shape validation (log-only)`, {
      sink,
      kind,
      issueCount: failure.issueCount,
      issues: failure.paths.slice(0, MAX_LOGGED_ISSUES),
    });
  }
}

/**
 * Batch-sink variant [refactor jul23 P4.1 U5-review MED]: one warn per (sink, kind) per
 * CALL, not per row. A symbol-search save carries visibleMatches.map(...) — dozens to
 * hundreds of rows — and the server-pipeline writers (U7) are bigger still; under a
 * systematic v0 drift, per-row warns would flood the log and drown the exact canary
 * signal log-mode exists to surface. The v-gate is UNCHANGED (still per-row, still
 * throws on the first v-carrying invalid row — before any logging, before the tx).
 */
export function observeAnnotationDataBatch(datas: unknown[], sink: string): void {
  const agg = new Map<
    AnnotationDataKind,
    { failedCount: number; issueCount: number; paths: Set<string> }
  >();
  for (const data of datas) {
    if (data === null || data === undefined) continue;
    const kind = classifyAnnotationData(data);
    gateVCarrying(data, kind, sink); // throws → whole batch 400s pre-tx
    if (vPresent(data)) continue;
    const failure = validateForLog(data, kind);
    if (!failure) continue;
    const entry = agg.get(kind) ?? { failedCount: 0, issueCount: 0, paths: new Set() };
    entry.failedCount += 1;
    entry.issueCount += failure.issueCount;
    for (const p of failure.paths) entry.paths.add(p);
    agg.set(kind, entry);
  }
  for (const [kind, entry] of agg) {
    logger.warn(`[shape-registry] v0 batch writes failed shape validation (log-only)`, {
      sink,
      kind,
      rowCount: datas.length,
      failedCount: entry.failedCount,
      issueCount: entry.issueCount,
      issues: [...entry.paths].slice(0, MAX_LOGGED_ISSUES),
    });
  }
}

// NOTE [U5 review]: the gate arms on ANY non-undefined `v` — v:null / v:2 / v:"1" all
// count as "carrying a version tag" and must validate (z.literal(1) then rejects them).
// "Absent ⇒ v0" means literally absent. Upgraders (RD-F) must therefore stamp literal 1.
function vPresent(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).v !== undefined
  );
}

/** V-GATE: new registry-aware (v-carrying) writes must be valid. Throws ApiError. */
function gateVCarrying(data: unknown, kind: AnnotationDataKind, sink: string): void {
  if (!vPresent(data)) return;
  // Unclassifiable-but-versioned is itself a contract violation (v ⇒ a recognized v1 shape).
  if (kind === "unknown") {
    throw new ApiError(
      "VALIDATION",
      "annotation data carries a version tag but matches no registered shape",
    );
  }
  const gate = SHAPE_SCHEMAS[kind].safeParse(data);
  if (!gate.success) {
    // Paths/codes only — no values (see log-hygiene note above).
    const issues = gate.error.issues
      .slice(0, MAX_LOGGED_ISSUES)
      .map((i) => `${i.path.join(".") || "(root)"}:${i.code}`);
    logger.warn(`[shape-registry] rejected v-carrying write`, {
      sink,
      kind,
      issueCount: gate.error.issues.length,
      issues,
    });
    throw new ApiError(
      "VALIDATION",
      `annotation data (v1, ${kind}) failed shape validation`,
    );
  }
}

/** Log-mode leg: returns the failure summary for an OBSERVED, v-absent blob (else null). */
function validateForLog(
  data: unknown,
  kind: AnnotationDataKind,
): { issueCount: number; paths: string[] } | null {
  if (!OBSERVED_SHAPES.has(kind)) return null;
  const result = SHAPE_SCHEMAS[kind].safeParse(data);
  if (result.success) return null;
  return {
    issueCount: result.error.issues.length,
    paths: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}:${i.code}`),
  };
}
