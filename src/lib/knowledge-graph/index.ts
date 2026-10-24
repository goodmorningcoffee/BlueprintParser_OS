// [graph T8 2026-10-24] Public surface of the knowledge graph v1 — see build.ts and summary.ts.
export * from "./types";
export {
  buildKnowledgeGraph,
  graphLinesFromTextract,
  graphWordsFromTextract,
  pageInputFromStored,
  PROVENANCE_CAP,
  ROWS_PER_TABLE_CAP,
  TAG_TYPES,
  TEXT_CAP,
} from "./build";
export {
  graphIndex,
  graphIndexObjectKey,
  graphObjectKey,
  isKnowledgeGraph,
  KNOWLEDGE_GRAPH_INTELLIGENCE_KEY,
  sheetNeighbourhood,
  storedGraphSummary,
  summarizeGraph,
  UNRESOLVED_QUEUE_CAP,
  UNRESOLVED_TOP_CAP,
  type GraphIndex,
  type GraphLink,
  type GraphSummary,
  type UnresolvedReference,
} from "./summary";
export {
  isDetailNumberLike,
  isSheetNumberLike,
  normaliseDetailNumber,
  normaliseSheetNumber,
  parseDetailSlash,
  sheetPrefix,
} from "./sheet-number";
