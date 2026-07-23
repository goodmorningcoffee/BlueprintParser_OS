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
 * Shapes currently under log-mode observation. U1 wires scale-calibration only (the
 * pattern-prover: single shape, single writer, own source enum). U2-U5 grow this set
 * one frozen unit at a time (count-marker, linear-polyline, area-polygon, symbol-search).
 */
const OBSERVED_SHAPES: ReadonlySet<AnnotationDataKind> = new Set([
  "scale-calibration",
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
 * @throws ApiError("VALIDATION") ONLY for v-carrying data that is unclassifiable or fails
 *         its shape schema. Never throws for v-absent (legacy/current-wire) data.
 */
export function observeAnnotationData(data: unknown, sink: string): void {
  // jsonb-null / absent data: nothing to observe (classify() would say "unknown", which
  // is unobserved in U1 anyway) and nothing to gate (no `v`).
  if (data === null || data === undefined) return;

  const kind = classifyAnnotationData(data);
  const carriesV =
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).v !== undefined;

  if (carriesV) {
    // V-GATE: new registry-aware writes must be valid. Unclassifiable-but-versioned is
    // itself a contract violation (v implies a recognized v1 shape).
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
    return; // versioned and valid — no observation log needed.
  }

  // LOG-MODE observation (v-absent = every existing wire). Never throws.
  if (!OBSERVED_SHAPES.has(kind)) return;
  const result = SHAPE_SCHEMAS[kind].safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, MAX_LOGGED_ISSUES)
      .map((i) => `${i.path.join(".") || "(root)"}:${i.code}`);
    logger.warn(`[shape-registry] v0 write failed shape validation (log-only)`, {
      sink,
      kind,
      issueCount: result.error.issues.length,
      issues,
    });
  }
}
