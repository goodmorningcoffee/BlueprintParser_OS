// Duplicate-page detection — public surface. Pure (no DB). The digest lives in ./digest
// (node:crypto) and is imported directly by the server service only.
export * from "./types";
export { detectDuplicates, blockHides, bulkPairs, bulkTiers, defaultKeep, DEDUP_THRESHOLDS, RUN_BULK_ENABLED } from "./detect";
export { crossProjectReport, pageTextKey, CROSS_PROJECT_COPY_SHARE, type CrossProjectPair } from "./cross-project";
export { lineDiff, type DiffLine } from "./diff";
export { visiblePage, onVisiblePage } from "./visibility";
