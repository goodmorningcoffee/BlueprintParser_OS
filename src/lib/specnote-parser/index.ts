export { parseNotesFromRegion, type ParsedNotesGrid } from "./parse-notes";
export { bindNumberedGrid } from "./bind-numbered";
export { bindLetteredGrid } from "./bind-lettered";
export { bindTaggedKeynoteGrid } from "./bind-tagged-keynote";
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
  RE_LETTERED_ITEM,
  RE_TAG_PREFIX,
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
