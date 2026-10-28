/**
 * Parse-engine barrel (WP-2.E; filled by WP-3.D). Only WP-3.D edits this file (PLAN §1.6 rule 13); other work
 * packages import their sibling modules by path. Validation schemas (`./schema`) are imported by path too, so the
 * client-safe modules below never pull zod into a bundle that only needs types.
 *
 * ⚠ This barrel re-exports `runParseEngine`, which is SERVER-only (it reads the printed title through
 * `server/services/parse-engine/title.ts` and the R8 profile from disk). Client code imports the client-safe
 * modules by path (`@/lib/parse-engine/ops`, `…/snapshot`, `…/assemble`, `…/types`), never this barrel.
 */

export * from "./types";
export { CAPABILITY_VERSIONS, CAPABILITIES, staleCapabilities } from "./version";
export { runParseEngine, type RunParseEngineOptions } from "./engine";
export { applyOps, applyOpsDetailed, paragraphLines, type ApplyOpsResult } from "./ops";
export { snapshotOf, snapshotHash, diffSnapshots, stableHash, type SnapshotDiff } from "./snapshot";
export { replayPlan, replayRegion, type ReplayPlan, type ReplayOutcome, type EngineRunner } from "./replay-core";
export { DEFAULT_PROFILE, DEFAULT_COL_WEIGHTS, loadParseEngineProfile, parseProfile, type ParseEngineProfile } from "./profile";
export { kindFromClassId } from "./engine-kind";
export { wordsToLines, assembleText, lineWordsFromLtwh, type LineWord, type WordLine, type WordsToLinesOptions, type AssembleTextOptions } from "./lines";
export { wordsIn, centreIn, ltwhToMinMax, minMaxToLtwh, centreOf, unionBox, type EdgeRule } from "./geometry";
