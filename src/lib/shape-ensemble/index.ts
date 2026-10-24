// [tag-mapping v2 / shape ensemble 2026-10-24] Public surface — see ./ensemble.ts.
export * from "./types";
export { buildShapeEnsemble, DEFAULT_SHAPE_ENSEMBLE_CONFIG, TAG_SHAPE_CLASSES, fuseInnerText, detailCalloutOf, mergeHalfBubbles, type ShapeEnsembleInput } from "./ensemble";
export {
  SHAPE_SUMMARY_CAP, summarizeShapeEnsemble, toCompactShape, fromCompactShape,
  isShapeEnsembleSummary, storedShapeEnsemble, sameShapeEnsemble, stableStringify,
} from "./summary";
export {
  TAG_FAMILIES_VERSION, discoverTagFamilies, tagFamiliesFromStoredPages, patternRegex,
  isTagFamiliesSummary, storedTagFamilies, type TagFamily, type TagFamiliesSummary, type DiscoverTagFamiliesOptions,
} from "./families";
export {
  TAG_LIKE, TAG_STOP_WORDS, normalizeTagText, isTagLike, isShortTag, looksLikeDimension,
  sheetKey, sheetKeySet, isSheetNumber, sameRead, tagPattern,
} from "./text-rules";
