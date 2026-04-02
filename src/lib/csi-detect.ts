/**
 * csi-detect.ts
 *
 * Detects CSI MasterFormat codes in page OCR text using 3-tier matching:
 *   Tier 1: Exact subphrase (consecutive words) — 0.95 confidence
 *   Tier 2: Bag-of-words overlap — up to tier2Weight confidence
 *   Tier 3: Keyword anchor matching — up to tier3Weight confidence
 *
 * Config-driven thresholds loaded from company pipeline_config.csi.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { CsiCode } from "@/types";
import { logger } from "@/lib/logger";

// ═══════════════════════════════════════════════════════════════
// Database types
// ═══════════════════════════════════════════════════════════════

interface CsiEntry {
  code: string;
  phraseWords: string[];       // significant words from description
  allWords: string[];          // all words including stop words
  description: string;
  trade: string;
  division: string;
  wordCount: number;           // count of significant words
}

// Re-export shared CSI utilities (client-safe)
export { normalizeCsiCode, normalizeCsiCodes } from "@/lib/csi-utils";

// ═══════════════════════════════════════════════════════════════
// Config defaults (overridable via pipeline_config.csi)
// ═══════════════════════════════════════════════════════════════

export interface CsiDetectConfig {
  matchingConfidenceThreshold: number;
  tier2MinWords: number;
  tier3MinWords: number;
  tier2Weight: number;
  tier3Weight: number;
}

const DEFAULT_CONFIG: CsiDetectConfig = {
  matchingConfidenceThreshold: 0.4,
  tier2MinWords: 3,
  tier3MinWords: 5,
  tier2Weight: 0.75,
  tier3Weight: 0.50,
};

// ═══════════════════════════════════════════════════════════════
// Stop words (filtered from bag-of-words matching)
// ═══════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "not", "no", "all", "any", "each", "other", "such", "than", "that",
  "this", "its", "per", "new",
]);

function getSignificantWords(words: string[]): string[] {
  return words.filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ═══════════════════════════════════════════════════════════════
// Database loading
// ═══════════════════════════════════════════════════════════════

let csiDatabase: CsiEntry[] | null = null;
let wordFrequency: Map<string, number> | null = null;

function loadCsiDatabase(): CsiEntry[] {
  if (csiDatabase) return csiDatabase;

  const paths = [
    join(process.cwd(), "src/data/csi-masterformat.tsv"),
    join(process.cwd(), "csi-masterformat.tsv"),
    join(__dirname, "../../data/csi-masterformat.tsv"),
  ];

  let content = "";
  for (const p of paths) {
    try {
      content = readFileSync(p, "utf-8");
      break;
    } catch { continue; }
  }

  if (!content) {
    logger.error("CSI database not found");
    csiDatabase = [];
    return csiDatabase;
  }

  const lines = content.split("\n").slice(1); // skip header
  csiDatabase = [];
  wordFrequency = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 6) continue;

    const description = cols[3].trim();
    const allWords = description.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
    const phraseWords = getSignificantWords(allWords);

    // Track word frequency across all descriptions (for anchor scoring)
    for (const w of phraseWords) {
      wordFrequency.set(w, (wordFrequency.get(w) || 0) + 1);
    }

    csiDatabase.push({
      code: cols[2].trim(),
      phraseWords,
      allWords,
      description,
      trade: cols[4].trim(),
      division: cols[5].trim(),
      wordCount: phraseWords.length,
    });
  }

  return csiDatabase;
}

/** Get anchor words — rarest words in a description (most distinctive). */
function getAnchorWords(phraseWords: string[], topN: number = 4): string[] {
  if (!wordFrequency) return phraseWords.slice(0, topN);
  return [...phraseWords]
    .sort((a, b) => (wordFrequency!.get(a) || 0) - (wordFrequency!.get(b) || 0))
    .slice(0, topN);
}

// ═══════════════════════════════════════════════════════════════
// Tier 1: Exact subphrase (consecutive words)
// ═══════════════════════════════════════════════════════════════

function isSubphrase(phraseWords: string[], textWords: string[]): boolean {
  if (phraseWords.length === 0) return false;
  const limit = textWords.length - phraseWords.length;
  for (let i = 0; i <= limit; i++) {
    let match = true;
    for (let j = 0; j < phraseWords.length; j++) {
      if (phraseWords[j] !== textWords[i + j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// Tier 2: Bag-of-words overlap
// ═══════════════════════════════════════════════════════════════

function bagOfWordsScore(phraseWords: string[], textWordSet: Set<string>): number {
  if (phraseWords.length === 0) return 0;
  const matched = phraseWords.filter(w => textWordSet.has(w)).length;
  const ratio = matched / phraseWords.length;
  return ratio * ratio; // squared — rewards higher overlap exponentially
}

// ═══════════════════════════════════════════════════════════════
// Tier 3: Keyword anchor matching
// ═══════════════════════════════════════════════════════════════

function anchorScore(phraseWords: string[], textWordSet: Set<string>): number {
  const anchors = getAnchorWords(phraseWords);
  if (anchors.length === 0) return 0;
  const matched = anchors.filter(w => textWordSet.has(w)).length;
  return matched / anchors.length;
}

// ═══════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════

/**
 * Detect CSI codes in page text using 3-tier matching.
 * Returns unique CSI codes found with confidence scores.
 */
export function detectCsiCodes(
  rawText: string,
  config?: Partial<CsiDetectConfig>,
): CsiCode[] {
  if (!rawText || rawText.length < 10) return [];

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const db = loadCsiDatabase();
  const text = rawText.replace(/\n/g, " ").toLowerCase();
  const textWords = text.split(/\s+/).filter(Boolean);
  const textWordSet = new Set(textWords);

  // Track best match per code (highest confidence wins)
  const bestMatches = new Map<string, { entry: CsiEntry; confidence: number; tier: number }>();

  for (const entry of db) {
    if (entry.phraseWords.length === 0) continue;

    let bestConf = 0;
    let bestTier = 0;

    // Tier 1: Exact subphrase — 0.95 confidence
    if (entry.allWords.length > 0 && isSubphrase(entry.allWords, textWords)) {
      bestConf = 0.95;
      bestTier = 1;
    }

    // Tier 2: Bag-of-words (only for descriptions with enough significant words)
    if (bestConf < cfg.tier2Weight && entry.wordCount >= cfg.tier2MinWords) {
      const bow = bagOfWordsScore(entry.phraseWords, textWordSet) * cfg.tier2Weight;
      if (bow > bestConf) {
        bestConf = bow;
        bestTier = 2;
      }
    }

    // Tier 3: Keyword anchors (only for longer descriptions)
    if (bestConf < cfg.tier3Weight && entry.wordCount >= cfg.tier3MinWords) {
      const anchor = anchorScore(entry.phraseWords, textWordSet) * cfg.tier3Weight;
      if (anchor > bestConf) {
        bestConf = anchor;
        bestTier = 3;
      }
    }

    // Multi-tier boost: if Tier 1 didn't fire but both Tier 2 and 3 did
    if (bestTier >= 2) {
      const bow = bagOfWordsScore(entry.phraseWords, textWordSet) * cfg.tier2Weight;
      const anchor = anchorScore(entry.phraseWords, textWordSet) * cfg.tier3Weight;
      if (bow > cfg.matchingConfidenceThreshold && anchor > cfg.matchingConfidenceThreshold * 0.5) {
        bestConf = Math.min(bestConf + 0.05, 0.90); // small boost for multi-tier agreement
      }
    }

    // Apply threshold
    if (bestConf < cfg.matchingConfidenceThreshold) continue;

    // Keep best match per code
    const existing = bestMatches.get(entry.code);
    if (!existing || bestConf > existing.confidence) {
      bestMatches.set(entry.code, { entry, confidence: bestConf, tier: bestTier });
    }
  }

  // Convert to results
  const results: CsiCode[] = [];
  for (const [code, { entry, confidence }] of bestMatches) {
    results.push({
      code: entry.code,
      description: entry.description,
      trade: entry.trade,
      division: entry.division,
    });
  }

  return results;
}

/**
 * Detect CSI codes from a parsed table/keynote grid.
 * Concatenates all cell content and runs standard CSI detection.
 */
export function detectCsiFromGrid(
  headers: string[],
  rows: Record<string, string>[],
  config?: Partial<CsiDetectConfig>,
): CsiCode[] {
  const parts: string[] = [...headers];
  for (const row of rows) {
    for (const val of Object.values(row)) {
      if (val) parts.push(val);
    }
  }
  const text = parts.join(" ");
  return detectCsiCodes(text, config);
}
