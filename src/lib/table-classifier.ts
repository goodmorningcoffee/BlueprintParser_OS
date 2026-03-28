/**
 * table-classifier.ts
 *
 * System 3: Table/Schedule/Keynote Meta-Classifier.
 * Combines System 1 (OCR text regions) + System 2 (heuristic inferences) +
 * keyword signals to produce confident ClassifiedTable[] objects.
 *
 * ClassifiedTable extends TextRegion — same base shape, additional metadata.
 * Downstream consumers (keynote parser, table→CSV export, LLM context) work
 * with the same base shape.
 *
 * Runs as a separate analysis step in processing.ts.
 * Can run OCR-only (during initial processing) or with YOLO data (after YOLO load).
 */

import type {
  TextRegion,
  ClassifiedTable,
  ClassifiedTableCategory,
  HeuristicInference,
  CsiCode,
  BboxLTWH,
} from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Category Keyword Patterns
// ═══════════════════════════════════════════════════════════════════

interface CategoryPattern {
  category: ClassifiedTableCategory;
  keywords: string[];                  // ALL must match (case-insensitive)
  keywordsAny?: string[];              // ANY one must match
  requiredRegionType?: string;         // TextRegion.type must match
  csiDivisionAffinity?: string[];      // boost if CSI codes from these divisions present
  isPageSpecific: boolean;
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: "keynote-table",
    keywords: [],
    keywordsAny: ["KEYNOTE", "KEYNOTES", "KEY NOTES", "KEY NOTE"],
    requiredRegionType: "key-value",
    isPageSpecific: true,
  },
  {
    category: "door-schedule",
    keywords: ["DOOR"],
    keywordsAny: ["SCHEDULE"],
    requiredRegionType: "table-like",
    csiDivisionAffinity: ["08"],
    isPageSpecific: false,
  },
  {
    category: "finish-schedule",
    keywords: ["FINISH"],
    keywordsAny: ["SCHEDULE"],
    requiredRegionType: "table-like",
    csiDivisionAffinity: ["09"],
    isPageSpecific: false,
  },
  {
    category: "symbol-legend",
    keywords: [],
    keywordsAny: ["LEGEND", "SYMBOL LEGEND", "SYMBOLS"],
    requiredRegionType: "key-value",
    isPageSpecific: true,
  },
  {
    category: "material-schedule",
    keywords: [],
    keywordsAny: ["SCHEDULE", "EQUIPMENT SCHEDULE", "PLUMBING SCHEDULE", "MECHANICAL SCHEDULE"],
    requiredRegionType: "table-like",
    isPageSpecific: false,
  },
  {
    category: "general-notes",
    keywords: [],
    keywordsAny: ["GENERAL NOTES", "GENERAL NOTE", "DRAWING NOTES", "SHEET NOTES"],
    requiredRegionType: "notes-block",
    isPageSpecific: false,
  },
  {
    category: "spec-text",
    keywords: [],
    keywordsAny: ["SPECIFICATION", "SPECIFICATIONS"],
    requiredRegionType: "spec-text",
    isPageSpecific: false,
  },
];

// ═══════════════════════════════════════════════════════════════════
// Scoring Engine
// ═══════════════════════════════════════════════════════════════════

interface ClassificationInput {
  textRegions: TextRegion[];
  heuristicInferences?: HeuristicInference[];
  csiCodes?: CsiCode[];
  pageNumber: number;
}

function scoreRegionForCategory(
  region: TextRegion,
  pattern: CategoryPattern,
  heuristicInferences: HeuristicInference[],
  csiCodes: CsiCode[],
): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];
  const upperHeader = (region.headerText || "").toUpperCase();
  const upperText = (region.containedText || "").toUpperCase();

  // Region type match
  if (pattern.requiredRegionType) {
    if (region.type === pattern.requiredRegionType) {
      score += 0.3;
      evidence.push(`OCR region: ${region.type}`);
    } else {
      // Wrong region type — still possible but lower base
      score += 0.05;
    }
  }

  // Required keywords (ALL must match)
  if (pattern.keywords.length > 0) {
    const allFound = pattern.keywords.every(kw =>
      upperHeader.includes(kw) || upperText.includes(kw)
    );
    if (allFound) {
      score += 0.2;
      evidence.push(`Keywords: ${pattern.keywords.join(", ")}`);
    } else {
      return { score: 0, evidence: [] }; // Required keywords missing — bail
    }
  }

  // Any keywords (at least one must match)
  if (pattern.keywordsAny && pattern.keywordsAny.length > 0) {
    const found = pattern.keywordsAny.filter(kw =>
      upperHeader.includes(kw) || upperText.includes(kw)
    );
    if (found.length > 0) {
      // Header match is stronger than body text match
      const inHeader = found.some(kw => upperHeader.includes(kw));
      score += inHeader ? 0.25 : 0.15;
      evidence.push(`Keyword${inHeader ? " (header)" : ""}: ${found[0]}`);
    }
  }

  // Heuristic inference match — if the heuristic engine already flagged this area
  const matchingInference = heuristicInferences.find(inf =>
    inf.label === pattern.category && inf.confidence >= 0.4
  );
  if (matchingInference) {
    score += 0.2;
    evidence.push(`Heuristic: ${matchingInference.ruleName} (${Math.round(matchingInference.confidence * 100)}%)`);
  }

  // Column/row structure boost for table categories
  if (pattern.requiredRegionType === "table-like" && region.columnCount && region.rowCount) {
    if (region.columnCount >= 3 && region.rowCount >= 3) {
      score += 0.1;
      evidence.push(`Structure: ${region.columnCount} cols × ${region.rowCount} rows`);
    }
  }

  // CSI division affinity
  if (pattern.csiDivisionAffinity && csiCodes.length > 0) {
    const matchingCsi = csiCodes.filter(c =>
      pattern.csiDivisionAffinity!.some(div => c.code.startsWith(div))
    );
    if (matchingCsi.length > 0) {
      score += 0.1;
      evidence.push(`CSI affinity: Division ${pattern.csiDivisionAffinity.join("/")}`);
    }
  }

  // Numbered items boost for notes
  if (region.hasNumberedItems && pattern.category === "general-notes") {
    score += 0.1;
    evidence.push("Numbered items detected");
  }

  return { score, evidence };
}

// ═══════════════════════════════════════════════════════════════════
// Main Export
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify text regions into specific table/schedule/keynote categories.
 * Each TextRegion is scored against all category patterns. The highest-scoring
 * category above threshold wins.
 *
 * Returns ClassifiedTable[] (extends TextRegion with category + evidence).
 */
export function classifyTables(input: ClassificationInput): ClassifiedTable[] {
  const { textRegions, heuristicInferences, csiCodes, pageNumber } = input;

  if (!textRegions || textRegions.length === 0) return [];

  const inferences = heuristicInferences || [];
  const codes = csiCodes || [];
  const results: ClassifiedTable[] = [];

  for (const region of textRegions) {
    // Skip paragraphs — they're not classifiable as tables/schedules
    if (region.type === "paragraph") continue;

    let bestCategory: ClassifiedTableCategory = "unknown-table";
    let bestScore = 0;
    let bestEvidence: string[] = [];

    for (const pattern of CATEGORY_PATTERNS) {
      const { score, evidence } = scoreRegionForCategory(region, pattern, inferences, codes);
      if (score > bestScore) {
        bestScore = score;
        bestCategory = pattern.category;
        bestEvidence = evidence;
      }
    }

    // Threshold: 0.3 for possible, 0.5 for confident
    if (bestScore < 0.3) continue;

    // Determine page specificity
    const isPageSpecific = CATEGORY_PATTERNS.find(p => p.category === bestCategory)?.isPageSpecific ?? false;

    results.push({
      // Spread TextRegion base fields
      ...region,
      // ClassifiedTable additional fields
      category: bestCategory,
      evidence: bestEvidence,
      pageNumber,
      isPageSpecific,
      // Override confidence with classification score
      confidence: Math.min(bestScore, 0.99),
    });
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}
