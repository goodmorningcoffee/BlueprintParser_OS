export { parseNotesFromRegion, type ParsedNotesGrid } from "./parse-notes";
export { bindNumberedGrid } from "./bind-numbered";
export { bindKeyValueGrid } from "./bind-key-value";
export { clusterLinesByYGap } from "./cluster-lines";
export {
  bindSpecSections,
  bindSpecSectionsInRegion,
  type SpecSection,
  type BoundSpec,
} from "./bind-sections";
export {
  buildLineFeatures,
  median,
  RE_NUMBERED_ITEM,
  type LineFeature,
} from "./shared";
export {
  linesInside,
  findClusterIndexByY,
  clusterUnionBbox,
  scaleColBoundariesToBbox,
  rowTextFromClusterKV,
  rowTextFromClusterNumbered,
  rowTextFromClusterSpec,
  rowTextFromClusterGeneric,
  unionBboxes,
} from "./paragraph-helpers";
