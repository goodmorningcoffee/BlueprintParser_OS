/**
 * csi-detect-defs.ts
 *
 * Client-safe type definitions and default config values for CSI detection.
 * Split out from csi-detect.ts (which is server-only because it imports `fs`
 * to load the CSI masterformat TSV at runtime).
 *
 * Both csi-detect.ts (server) and CsiTab.tsx (client) import from here, so
 * there's a single source of truth for detection defaults — they can't drift.
 */

export interface CsiDetectConfig {
  matchingConfidenceThreshold: number;
  tier2MinWords: number;
  tier3MinWords: number;
  tier2Weight: number;
  tier3Weight: number;
  /** Tier 1 confidence multiplier by description word count.
   *  Index = number of significant words in the CSI description (stop words
   *  excluded, matches `CsiEntry.phraseWords.length`). Index 0 is unused. For
   *  word counts ≥ array length, the last value is used.
   *
   *  Default [0, 0.01, 0.19, 0.80, 0.80, 0.80]:
   *    1-word:  0.95 × 0.01 = 0.0095 (below 0.4 threshold → rejected)
   *    2-word:  0.95 × 0.19 = 0.1805 (below threshold → rejected)
   *    3+ word: 0.95 × 0.80 = 0.76   (above threshold → accepted)
   *
   *  Purpose: short descriptions like "doors" / "concrete" / "masonry" fire
   *  Tier 1 for almost every page, producing noise that makes the CSI filter
   *  dropdown useless. Down-weighting them kills the noise while leaving
   *  legitimate multi-word matches unchanged. */
  tier1WeightByWordCount: number[];
}

export const DEFAULT_CSI_DETECT_CONFIG: CsiDetectConfig = {
  matchingConfidenceThreshold: 0.4,
  tier2MinWords: 3,
  tier3MinWords: 5,
  tier2Weight: 0.75,
  tier3Weight: 0.50,
  tier1WeightByWordCount: [0, 0.01, 0.19, 0.80, 0.80, 0.80],
};
