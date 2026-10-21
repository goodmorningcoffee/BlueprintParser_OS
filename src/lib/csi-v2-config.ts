/**
 * csi-v2-config.ts — client-safe config shape, defaults, bounds and the stored-config reader for
 * the CSI tagger v2 (PLAN §7: config shrinks to `tau`, `maxCodesPerPage`).
 *
 * [csi-v2 S6] IMPLEMENTATION §II S6 names `csi-detect-defs.ts` as the home of
 * `DEFAULT_CSI_V2_CONFIG`, but that file is sha256-pinned by `eval/csi/baseline-old-engine.json`
 * (it holds the OLD engine's defaults, which csi-baseline-freshness.test.ts guards and which must
 * never be rebaselined). The v2 shape therefore lives here, importable by the admin UI, the PUT
 * schema and the server resolver alike (no `fs`, no server-only imports).
 *
 * Values = IMPLEMENTATION §I `V2Config` DEFAULT { tau: 0.75, maxCodesPerPage: 40 }.
 * Structurally identical to `V2Config` in `csi-page.ts` (S4), which this file deliberately does
 * not import.
 */
export interface CsiV2Config {
  /** Minimum page-level confidence a code needs to be emitted (0..1). */
  tau: number;
  /** Hard cap on emitted codes per page, highest confidence first. */
  maxCodesPerPage: number;
}

export const DEFAULT_CSI_V2_CONFIG: Readonly<CsiV2Config> = Object.freeze({
  tau: 0.75,
  maxCodesPerPage: 40,
});

/** Accepted ranges (PUT schema, stored-config reader, admin sliders). `tau` must be > 0 and ≤ 1. */
export const CSI_V2_TAU_MAX = 1;
export const CSI_V2_MAX_CODES_MIN = 1;
export const CSI_V2_MAX_CODES_MAX = 200;

/**
 * The lowest confidence an emitted code can have: its best span needs s ≥ 0.8 (PLAN §6.8) and one
 * occurrence multiplies it by 0.88, so every tau at or below 0.704 behaves identically. Shown in
 * the admin explainer; asserted against csi-page.ts by test.
 */
export const CSI_V2_LOWEST_EMITTED_CONFIDENCE = 0.704;

function validTau(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= CSI_V2_TAU_MAX ? v : undefined;
}

/**
 * Copy the v2 engine fields out of a STORED (untrusted) `pipelineConfig.csi` blob, each validated;
 * `undefined` when none survive (the engine then runs on `DEFAULT_CSI_V2_CONFIG`).
 *   - `tau`: a number in (0, 1]. A row saved by the pre-v2 admin has no `tau` but may carry
 *     `matchingConfidenceThreshold`, which is read AS tau (PLAN §7) only when it is ABOVE
 *     `CSI_V2_LOWEST_EMITTED_CONFIDENCE` and ≤ 1. The old engine's threshold is on another scale and
 *     the pre-v2 admin saved the whole config on every save, so most stored rows carry its default
 *     0.4 (csi-detect-defs.ts) — read as tau that would silently lower the v2 default 0.75 to "no
 *     gate" (measured: 3,070 → 3,459 codes, 207 of 471 corpus pages differ). A legacy value at or
 *     below 0.704 cannot mean "list more than v2 lists by default", so it is ignored; one above it
 *     (an admin who raised the bar) still raises tau.
 *   - `maxCodesPerPage`: an integer in [1, 200].
 * Every other stored key (the pre-v2 tier weights, the orphan tagger sliders, the custom-DB pointer
 * triple) is ignored here and tolerated in storage.
 */
export function pickCsiV2Config(csi: unknown): Partial<CsiV2Config> | undefined {
  if (!csi || typeof csi !== "object" || Array.isArray(csi)) return undefined;
  const src = csi as Record<string, unknown>;
  const out: Partial<CsiV2Config> = {};
  const legacy = validTau(src.matchingConfidenceThreshold);
  const tau = validTau(src.tau) ?? (legacy !== undefined && legacy > CSI_V2_LOWEST_EMITTED_CONFIDENCE ? legacy : undefined);
  if (tau !== undefined) out.tau = tau;
  const m = src.maxCodesPerPage;
  if (typeof m === "number" && Number.isInteger(m) && m >= CSI_V2_MAX_CODES_MIN && m <= CSI_V2_MAX_CODES_MAX) {
    out.maxCodesPerPage = m;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
