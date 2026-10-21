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

import type { CsiCode, CsiCodeTrigger, TextractWord, BboxLTWH } from "@/types";
import { DEFAULT_CSI_DETECT_CONFIG, type CsiDetectConfig } from "@/lib/csi-detect-defs";
// [refactor jul9 P2-A C1] DB types + builtin loader extracted to their own
// module (SPEC_FINAL §1.0/§1.1) so the C3 company-DB resolver never imports
// through csi-detect — several route tests full-factory-mock this module and
// would zero out any loader re-exported here (C3-F-1). Deliberately NOT
// re-exported from this file for the same reason.
import { type CsiDatabase, type CsiEntry, loadBuiltinCsiDatabase } from "@/lib/csi-database";

// Re-export the client-safe types so existing server-side callers that
// `import { CsiDetectConfig } from "@/lib/csi-detect"` keep working.
export type { CsiDetectConfig };

// Re-export shared CSI utilities (client-safe)
export { normalizeCsiCode, normalizeCsiCodes } from "@/lib/csi-utils";

// ═══════════════════════════════════════════════════════════════
// Config defaults (overridable via pipeline_config.csi)
//
// The interface and defaults live in csi-detect-defs.ts (client-safe,
// no `fs` import) so the admin UI can share them without bundling
// server-only code. We alias the canonical default locally so the
// existing `{ ...DEFAULT_CONFIG, ...config }` spread keeps working.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = DEFAULT_CSI_DETECT_CONFIG;

// [refactor jul9 P2-A C1] Stop words, TSV parsing, and the builtin loader now
// live in @/lib/csi-database (extraction is behavior-identical — proven by the
// C0 freeze-first baselines staying green through this commit). The engine
// below is pure matching logic; `wordFrequency` is threaded explicitly instead
// of read from module lets so a per-company bundle (C3+) scores anchors
// against ITS OWN frequency map (invariant I-2).

/** Get anchor words — rarest words in a description (most distinctive). */
// [refactor jul9 P2-A C1] `wordFrequency` was a module let; now a param.
// Guard kept from that era (was `!wordFrequency`): an empty map (builtin DB
// file not found → empty memoized bundle) short-circuits to the first-N slice.
function getAnchorWords(
  phraseWords: string[],
  wordFrequency: Map<string, number>,
  topN: number = 4,
): string[] {
  if (wordFrequency.size === 0) return phraseWords.slice(0, topN);
  return [...phraseWords]
    .sort((a, b) => (wordFrequency.get(a) || 0) - (wordFrequency.get(b) || 0))
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

// [refactor jul9 P2-A C1] wordFrequency threaded through (see getAnchorWords).
function anchorScore(
  phraseWords: string[],
  textWordSet: Set<string>,
  wordFrequency: Map<string, number>,
): number {
  const anchors = getAnchorWords(phraseWords, wordFrequency);
  if (anchors.length === 0) return 0;
  const matched = anchors.filter(w => textWordSet.has(w)).length;
  return matched / anchors.length;
}

// ═══════════════════════════════════════════════════════════════
// Trigger collection — record the words/phrases on the page that
// caused a CSI code to be detected. Called only when textractWords
// are provided. Matches the same normalization as detection.
// ═══════════════════════════════════════════════════════════════

interface NormalizedWord {
  text: string;
  bbox: BboxLTWH;
  idx: number;
}

function normalizeTextractWords(textractWords: TextractWord[]): NormalizedWord[] {
  const out: NormalizedWord[] = [];
  for (let i = 0; i < textractWords.length; i++) {
    const w = textractWords[i];
    // Match detection's normalization: lowercase only, no punctuation strip
    // (keeps parity with how rawText is tokenized in detectCsiCodes)
    const text = w.text.toLowerCase();
    if (!text) continue;
    out.push({ text, bbox: w.bbox, idx: i });
  }
  return out;
}

/**
 * Collect trigger words/phrases on the page that fire an entry's detection tiers.
 *
 * Walks the normalized Textract word list and labels each matching word by its
 * strongest tier: Tier 1 (consecutive phrase span), Tier 3 (anchor / rarest
 * words), then Tier 2 (other phrase words). A word is labeled at most once.
 *
 * The labeling priority is phrase > anchor > word, so the user sees the most
 * specific reason for each highlight in the UI.
 */
function collectTriggersForEntry(
  entry: CsiEntry,
  normalizedWords: NormalizedWord[],
  // [refactor jul9 P2-A C1] threaded — Tier-3 anchor labeling must use the
  // frequency map of the SAME database the entry came from (I-2).
  wordFrequency: Map<string, number>,
): CsiCodeTrigger[] {
  const triggers: CsiCodeTrigger[] = [];
  const usedIdxs = new Set<number>();

  // ── Tier 1: consecutive phrase spans matching entry.allWords ──
  const allWords = entry.allWords;
  if (allWords.length > 0 && normalizedWords.length >= allWords.length) {
    const limit = normalizedWords.length - allWords.length;
    for (let i = 0; i <= limit; i++) {
      let match = true;
      for (let j = 0; j < allWords.length; j++) {
        if (normalizedWords[i + j].text !== allWords[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;

      // Union bbox across the matching span
      let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
      const textParts: string[] = [];
      for (let j = 0; j < allWords.length; j++) {
        const w = normalizedWords[i + j];
        const [L, T, W, H] = w.bbox;
        if (L < minL) minL = L;
        if (T < minT) minT = T;
        if (L + W > maxR) maxR = L + W;
        if (T + H > maxB) maxB = T + H;
        textParts.push(w.text);
        usedIdxs.add(w.idx);
      }
      triggers.push({
        text: textParts.join(" "),
        bbox: [minL, minT, maxR - minL, maxB - minT],
        tier: 1,
      });
    }
  }

  // ── Tier 3: anchor words (rare/distinctive — label these before plain Tier 2) ──
  const anchorSet = new Set(getAnchorWords(entry.phraseWords, wordFrequency));
  if (anchorSet.size > 0) {
    for (const nw of normalizedWords) {
      if (usedIdxs.has(nw.idx)) continue;
      if (anchorSet.has(nw.text)) {
        triggers.push({ text: nw.text, bbox: nw.bbox, tier: 3 });
        usedIdxs.add(nw.idx);
      }
    }
  }

  // ── Tier 2: remaining phrase words ──
  const phraseSet = new Set(entry.phraseWords);
  if (phraseSet.size > 0) {
    for (const nw of normalizedWords) {
      if (usedIdxs.has(nw.idx)) continue;
      if (phraseSet.has(nw.text)) {
        triggers.push({ text: nw.text, bbox: nw.bbox, tier: 2 });
        usedIdxs.add(nw.idx);
      }
    }
  }

  return triggers;
}

// ═══════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════

/**
 * Detect CSI codes in page text using 3-tier matching.
 * Returns unique CSI codes found with confidence scores.
 *
 * If `textractWords` is provided, each returned code also includes `triggers`:
 * the exact words/phrases on the page that fired its detection, with bboxes.
 * Callers that only have raw text (e.g. table-parse grids) can omit the param;
 * the function works as before and returns codes without triggers.
 *
 * [refactor jul9 P2-A C1] Optional 4th param `db`: a CsiDatabase bundle
 * (entries + their own wordFrequency, I-2). Omitted ⇒ builtin DB, output
 * byte-identical to the pre-refactor engine (I-6). The engine stays fully
 * synchronous (I-1) — async company-DB resolution happens in the caller
 * (C3's resolver) and arrives here as a plain argument.
 */
export function detectCsiCodes(
  rawText: string,
  textractWords?: TextractWord[],
  config?: Partial<CsiDetectConfig>,
  db?: CsiDatabase,
): CsiCode[] {
  if (!rawText || rawText.length < 10) return [];

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const database = db ?? loadBuiltinCsiDatabase();
  const wordFrequency = database.wordFrequency;
  const text = rawText.replace(/\n/g, " ").toLowerCase();
  const textWords = text.split(/\s+/).filter(Boolean);
  const textWordSet = new Set(textWords);

  // Pre-normalize Textract words once if available (shared across all entries)
  const normalizedWords = textractWords ? normalizeTextractWords(textractWords) : null;

  // Track best match per code (highest confidence wins)
  const bestMatches = new Map<string, { entry: CsiEntry; confidence: number; tier: number }>();

  for (const entry of database.entries) {
    if (entry.phraseWords.length === 0) continue;

    let bestConf = 0;
    let bestTier = 0;

    // Tier 1: Exact subphrase — 0.95 confidence, weighted by description length.
    // Short descriptions (1-2 significant words) are down-weighted so they fall
    // below the threshold. See tier1WeightByWordCount in csi-detect-defs.ts.
    if (entry.allWords.length > 0 && isSubphrase(entry.allWords, textWords)) {
      const weights = cfg.tier1WeightByWordCount;
      const n = entry.wordCount; // significant words (stop-word-filtered)
      const weight = weights && weights.length > 0
        ? (n < weights.length ? weights[n] : weights[weights.length - 1])
        : 1;
      bestConf = 0.95 * weight;
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
      const anchor = anchorScore(entry.phraseWords, textWordSet, wordFrequency) * cfg.tier3Weight;
      if (anchor > bestConf) {
        bestConf = anchor;
        bestTier = 3;
      }
    }

    // Multi-tier boost: if Tier 1 didn't fire but both Tier 2 and 3 did
    if (bestTier >= 2) {
      const bow = bagOfWordsScore(entry.phraseWords, textWordSet) * cfg.tier2Weight;
      const anchor = anchorScore(entry.phraseWords, textWordSet, wordFrequency) * cfg.tier3Weight;
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

  // Convert to results (collect triggers only for codes that passed the threshold)
  const results: CsiCode[] = [];
  for (const [, { entry }] of bestMatches) {
    const code: CsiCode = {
      code: entry.code,
      description: entry.description,
      trade: entry.trade,
      division: entry.division,
    };
    if (normalizedWords) {
      code.triggers = collectTriggersForEntry(entry, normalizedWords, wordFrequency);
    }
    results.push(code);
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
  db?: CsiDatabase, // [refactor jul9 P2-A C1] forwarded — see detectCsiCodes
): CsiCode[] {
  const parts: string[] = [...headers];
  for (const row of rows) {
    for (const val of Object.values(row)) {
      if (val) parts.push(val);
    }
  }
  const text = parts.join(" ");
  // Grid cells have no Textract word positions — call without textractWords.
  return detectCsiCodes(text, undefined, config, db);
}
