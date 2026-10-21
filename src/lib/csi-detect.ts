/**
 * csi-detect.ts — the CSI detection entry point every caller imports.
 *
 * [csi-v2 S6 prep] The 3-tier engine moved, byte-identical, to `csi-detect-legacy.ts`
 * (`eval/csi/baseline-old-engine.json` pins its sha256; csi-baseline-freshness.test.ts maps
 * the recorded old path to the new one). Until the v2 adapter lands this file only
 * re-exports the legacy engine, so behaviour is unchanged and route tests that mock
 * `@/lib/csi-detect` keep mocking the same surface.
 */
export * from "@/lib/csi-detect-legacy";
