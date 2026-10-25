// [shape-tags 2026-10-25] The Auto Parse request options (sliders in AutoParseTab's ParseOptionsPanel), moved out
// of AutoParseTab.tsx (at its MAX_LINES ceiling) when the parse hint spread was added to its request body.

export const PARSE_OPTION_DEFAULTS = {
  rowTolerance: 0.006, minColGap: 0.015, colHitRatio: 0.3, headerMode: "auto" as const,
  minHLineLengthRatio: 0.15, minVLineLengthRatio: 0.10, clusteringTolerance: 15,
  mergerEditDistance: 2,
};

export type ParseOptions = {
  rowTolerance: number; minColGap: number; colHitRatio: number; headerMode: "auto" | "first" | "none";
  minHLineLengthRatio: number; minVLineLengthRatio: number; clusteringTolerance: number;
  mergerEditDistance: number;
};
