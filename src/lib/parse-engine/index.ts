/**
 * Parse-engine barrel (WP-2.E). Only WP-3.D edits this file after WP-2.E (PLAN §1.6 rule 13); other
 * work packages import their sibling modules by path. Validation schemas (`./schema`) are imported by
 * path too, so the client-safe modules below never pull zod into a bundle that only needs types.
 */

export * from "./types";
export { CAPABILITY_VERSIONS, CAPABILITIES, staleCapabilities } from "./version";
export { runParseEngine } from "./engine";
export { applyOps } from "./ops";
export { wordsToLines, assembleText, lineWordsFromLtwh, type LineWord, type WordLine, type WordsToLinesOptions, type AssembleTextOptions } from "./lines";
export { wordsIn, centreIn, ltwhToMinMax, minMaxToLtwh, centreOf, unionBox, type EdgeRule } from "./geometry";
