/** region-classifier-v2 — detector-first region classifier, shadow mode. See ./classify.ts. */
export { classifyRegionsV2, isRegionsV2, storedRegionsV2, tableStructureScore, textStructureScore, DUPLICATE_IOU } from "./classify";
export {
  regionsV2ToClassifiedTables, resolvePreferRegionsV2, legacyCategoryOf,
  PREFER_REGIONS_V2_SETTING_KEY, PREFER_REGIONS_V2_CONFIG_KEY,
} from "./adapter";
export { REGION_CLASS_TABLE, REGION_CLASSES_HASH, validateClassTable, hashClassTable } from "./classes";
export { REGIONS_V2_VERSION, UNCLASSIFIED } from "./types";
export type {
  RegionClassifierInput, RegionDetection, RegionsV2, RegionsV2Stats, RegionV2, RegionV2Kind, RegionV2Anchor, RegionV2Signals,
} from "./types";
