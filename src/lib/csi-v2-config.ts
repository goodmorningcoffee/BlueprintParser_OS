/**
 * csi-v2-config.ts — client-safe config shape + defaults for the CSI tagger v2.
 *
 * [csi-v2 S6 prep] IMPLEMENTATION §II S6 names `csi-detect-defs.ts` as the home of
 * `DEFAULT_CSI_V2_CONFIG`, but that file is sha256-pinned by `eval/csi/baseline-old-engine.json`
 * (it holds the OLD engine's defaults, which csi-baseline-freshness.test.ts guards and which must
 * never be rebaselined). The v2 shape therefore lives here, importable by the admin UI and the
 * server alike (no `fs`, no server-only imports).
 *
 * The OLD keys (matchingConfidenceThreshold, tier*) stay in `CsiDetectConfig` and in
 * `zCsiConfigPut` until the v2 adapter lands, so the live admin CSI panel keeps working;
 * the removal and the CsiTab rewrite ship WITH the adapter.
 *
 * Values = IMPLEMENTATION §I `V2Config` DEFAULT { tau: 0.75, maxCodesPerPage: 40 }.
 * Structurally identical to `V2Config` in `csi-page.ts` (S4), which this file deliberately does
 * not import (that module is server-side and loads the KB).
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

