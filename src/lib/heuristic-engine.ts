/**
 * heuristic-engine.ts
 *
 * System 2: Data-driven rule engine for detecting higher-level page constructs.
 * Rules combine YOLO spatial signals + OCR text keywords + text-region classifications.
 *
 * Two-phase execution:
 * - Text-only mode: runs during initial processing (no YOLO needed, keyword rules only)
 * - YOLO-augmented mode: runs after YOLO load (spatial conditions + keyword rules)
 *
 * All rules are JSON data, not code. Built-in rules ship as defaults.
 * Users can modify, disable, or add custom rules via admin UI.
 * Stored in companies.pipeline_config.heuristics[].
 */

import type {
  TextractPageData,
  TextRegion,
  HeuristicInference,
  CsiCode,
  BboxLTWH,
} from "@/types";
import { bboxCenterLTWH, bboxContainsPoint, bboxAreaLTWH, wordsToText } from "@/lib/ocr-utils";
import { logger } from "@/lib/logger";
import { migrateRule, type LegacyHeuristicRule } from "@/lib/heuristic-rule-migrate";
import { migrateTextRegions } from "@/lib/text-region-migrate";

// ═══════════════════════════════════════════════════════════════════
// Rule Types
// ═══════════════════════════════════════════════════════════════════

export interface SpatialCondition {
  operator: "contains" | "overlaps" | "near" | "aligned";
  classA: string;
  classB: string;
  minInstances?: number;
  axis?: "horizontal" | "vertical" | "any";
  maxDistance?: number;
}

export interface HeuristicRule {
  id: string;
  name: string;
  source: "built-in" | "custom";
  enabled: boolean;
  modelId?: number;              // optional association with a specific YOLO model
  modelName?: string;

  // ─── YOLO side ──────────────────────────────────────────
  yoloRequired: string[];
  yoloBoosters: string[];
  /** Per-rule floor for YOLO confidence. Reserved for future use — current
   *  evaluator treats YOLO presence binary. */
  yoloRequiredMinConfidence?: number;
  /**
   * What to do when `yoloRequired` classes are missing from the page.
   * - "require": rule doesn't fire (matches pre-2026-04-24 behavior).
   * - "degrade": rule fires at 0.6× score with `YOLO unavailable` evidence.
   * - "ignore":  rule treats yoloRequired as pure boosters.
   * Default `"require"` preserves legacy behavior.
   */
  yoloAvailabilityMode: "require" | "degrade" | "ignore";

  // ─── Text side ──────────────────────────────────────────
  /** At least one (or all, per `textKeywordsMode`) must match. */
  textKeywordsRequired: string[];
  /** Each match adds +0.05 to score. No gating. */
  textKeywordsBoosters: string[];
  textKeywordsMode: "any-required" | "all-required";

  // ─── Spatial / CSI ──────────────────────────────────────
  overlapRequired: boolean;
  spatialConditions?: SpatialCondition[];
  textRegionType?: string;       // match against TextRegion.type if present
  csiDivisionsRequired?: string[]; // CSI divisions that must be present (first 2 digits, e.g. ["08", "09"])

  // ─── Output ─────────────────────────────────────────────
  outputLabel: string;
  outputCsiCode?: string;
  minConfidence: number;
}

interface YoloDetection {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════════
// Built-in Rules
// ═══════════════════════════════════════════════════════════════════

export const BUILT_IN_RULES: HeuristicRule[] = [
  {
    id: "keynote-table",
    name: "Keynote Table Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: ["horizontal_area"],
    yoloBoosters: ["table", "grid"],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["KEYNOTE", "KEYNOTES", "KEY NOTES", "LEGEND"],
    textKeywordsBoosters: [],
    textKeywordsMode: "any-required",
    overlapRequired: true,
    spatialConditions: [
      { operator: "contains", classA: "horizontal_area", classB: "oval", minInstances: 3, axis: "vertical" },
    ],
    textRegionType: "notes-key-value",
    outputLabel: "keynote-table",
    minConfidence: 0.5,
  },
  {
    id: "door-schedule",
    name: "Door Schedule Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: ["table"],
    yoloBoosters: ["grid", "horizontal_area"],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["DOOR", "SCHEDULE"],
    textKeywordsBoosters: [],
    textKeywordsMode: "all-required",
    overlapRequired: true,
    textRegionType: "schedule-table",
    outputLabel: "door-schedule",
    outputCsiCode: "08 11 16",
    minConfidence: 0.5,
  },
  {
    id: "finish-schedule",
    name: "Finish Schedule Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: ["table"],
    yoloBoosters: ["grid", "horizontal_area"],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["FINISH", "SCHEDULE"],
    textKeywordsBoosters: [],
    textKeywordsMode: "all-required",
    overlapRequired: true,
    textRegionType: "schedule-table",
    outputLabel: "finish-schedule",
    outputCsiCode: "09 00 00",
    minConfidence: 0.5,
  },
  {
    id: "symbol-legend",
    name: "Symbol Legend Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: ["horizontal_area"],
    yoloBoosters: ["table", "symbol_legend"],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["LEGEND", "SYMBOL"],
    textKeywordsBoosters: [],
    textKeywordsMode: "any-required",
    overlapRequired: true,
    spatialConditions: [
      { operator: "contains", classA: "horizontal_area", classB: "*", minInstances: 3, axis: "vertical" },
    ],
    textRegionType: "notes-key-value",
    outputLabel: "symbol-legend",
    minConfidence: 0.5,
  },
  {
    id: "general-notes",
    name: "General Notes Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: [],
    yoloBoosters: ["text_box", "vertical_area"],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["GENERAL NOTES", "GENERAL NOTE", "NOTES:"],
    textKeywordsBoosters: [],
    textKeywordsMode: "any-required",
    overlapRequired: false,
    textRegionType: "notes-numbered",
    outputLabel: "general-notes",
    minConfidence: 0.4,
  },
  {
    id: "material-schedule",
    name: "Material Schedule Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: ["table"],
    yoloBoosters: ["grid", "horizontal_area"],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["SCHEDULE"],
    textKeywordsBoosters: [],
    textKeywordsMode: "any-required",
    overlapRequired: true,
    textRegionType: "schedule-table",
    outputLabel: "material-schedule",
    minConfidence: 0.5,
  },
  {
    id: "table-confidence-boost",
    name: "Multi-Model Table Confidence",
    source: "built-in",
    enabled: true,
    yoloRequired: ["table"],
    yoloBoosters: ["horizontal_area"],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: [],
    textKeywordsBoosters: [],
    textKeywordsMode: "any-required",
    overlapRequired: false,
    spatialConditions: [
      { operator: "overlaps", classA: "table", classB: "horizontal_area" },
    ],
    outputLabel: "confirmed-table",
    minConfidence: 0.4,
  },
  {
    id: "section-cut",
    name: "Section Cut Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: ["horizontal_area"],
    yoloBoosters: [],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["SECTION"],
    textKeywordsBoosters: [],
    textKeywordsMode: "any-required",
    overlapRequired: false,
    outputLabel: "section-cut",
    minConfidence: 0.5,
  },
  {
    id: "typical-plan",
    name: "Typical Floor Plan Detection",
    source: "built-in",
    enabled: true,
    yoloRequired: [],
    yoloBoosters: [],
    yoloAvailabilityMode: "require",
    textKeywordsRequired: ["TYPICAL", "TYP"],
    textKeywordsBoosters: [],
    textKeywordsMode: "any-required",
    overlapRequired: false,
    outputLabel: "typical-plan",
    minConfidence: 0.4,
  },
];

// ═══════════════════════════════════════════════════════════════════
// Spatial Operator Implementations
// ═══════════════════════════════════════════════════════════════════

function bboxOverlapArea(a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a): number {
  const overlapX = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const overlapY = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return overlapX * overlapY;
}

function evalContains(
  classADetections: YoloDetection[],
  classBDetections: YoloDetection[],
  minInstances: number,
): boolean {
  for (const a of classADetections) {
    let contained = 0;
    for (const b of classBDetections) {
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      if (cx >= a.minX && cx <= a.maxX && cy >= a.minY && cy <= a.maxY) {
        contained++;
      }
    }
    if (contained >= minInstances) return true;
  }
  return false;
}

function evalOverlaps(
  classADetections: YoloDetection[],
  classBDetections: YoloDetection[],
): boolean {
  for (const a of classADetections) {
    const aArea = (a.maxX - a.minX) * (a.maxY - a.minY);
    for (const b of classBDetections) {
      const overlap = bboxOverlapArea(a, b);
      if (aArea > 0 && overlap / aArea > 0.3) return true;
    }
  }
  return false;
}

function evalNear(
  classADetections: YoloDetection[],
  classBDetections: YoloDetection[],
  maxDistance: number,
): boolean {
  for (const a of classADetections) {
    const acx = (a.minX + a.maxX) / 2;
    const acy = (a.minY + a.maxY) / 2;
    for (const b of classBDetections) {
      const bcx = (b.minX + b.maxX) / 2;
      const bcy = (b.minY + b.maxY) / 2;
      const dist = Math.sqrt((acx - bcx) ** 2 + (acy - bcy) ** 2);
      if (dist <= maxDistance) return true;
    }
  }
  return false;
}

function evalAligned(
  classADetections: YoloDetection[],
  classBDetections: YoloDetection[],
  minInstances: number,
  axis: "horizontal" | "vertical" | "any",
): boolean {
  // Find classB instances inside any classA, then check alignment
  for (const a of classADetections) {
    const inside = classBDetections.filter(b => {
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      return cx >= a.minX && cx <= a.maxX && cy >= a.minY && cy <= a.maxY;
    });

    if (inside.length < minInstances) continue;

    // Check vertical alignment: X-centers within tolerance
    if (axis === "vertical" || axis === "any") {
      const xCenters = inside.map(b => (b.minX + b.maxX) / 2);
      const xMean = xCenters.reduce((s, x) => s + x, 0) / xCenters.length;
      const xAligned = xCenters.filter(x => Math.abs(x - xMean) < 0.03).length;
      if (xAligned >= minInstances) return true;
    }

    // Check horizontal alignment: Y-centers within tolerance
    if (axis === "horizontal" || axis === "any") {
      const yCenters = inside.map(b => (b.minY + b.maxY) / 2);
      const yMean = yCenters.reduce((s, y) => s + y, 0) / yCenters.length;
      const yAligned = yCenters.filter(y => Math.abs(y - yMean) < 0.03).length;
      if (yAligned >= minInstances) return true;
    }
  }
  return false;
}

function evalSpatialCondition(
  condition: SpatialCondition,
  yoloByClass: Map<string, YoloDetection[]>,
): boolean {
  const classADets = yoloByClass.get(condition.classA) || [];
  if (classADets.length === 0) return false;

  // classB "*" means any class
  let classBDets: YoloDetection[];
  if (condition.classB === "*") {
    classBDets = [...yoloByClass.values()].flat().filter(d => d.name !== condition.classA);
  } else {
    classBDets = yoloByClass.get(condition.classB) || [];
  }
  if (classBDets.length === 0) return false;

  switch (condition.operator) {
    case "contains":
      return evalContains(classADets, classBDets, condition.minInstances || 1);
    case "overlaps":
      return evalOverlaps(classADets, classBDets);
    case "near":
      return evalNear(classADets, classBDets, condition.maxDistance || 0.1);
    case "aligned":
      return evalAligned(classADets, classBDets, condition.minInstances || 3, condition.axis || "any");
    default:
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Rule Scoring
// ═══════════════════════════════════════════════════════════════════

interface PageContext {
  rawText: string;                          // full page OCR text (for keyword search)
  yoloDetections?: YoloDetection[];         // YOLO bounding boxes (null in text-only mode)
  textRegions?: TextRegion[];               // from System 1
  csiCodes?: CsiCode[];
  pageNumber: number;
}

function scoreRule(rule: HeuristicRule, ctx: PageContext): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];
  const upperText = ctx.rawText.toUpperCase();

  // Group YOLO detections by class
  const yoloByClass = new Map<string, YoloDetection[]>();
  if (ctx.yoloDetections) {
    for (const d of ctx.yoloDetections) {
      if (!yoloByClass.has(d.name)) yoloByClass.set(d.name, []);
      yoloByClass.get(d.name)!.push(d);
    }
  }

  // YOLO required: at least one must be present
  if (rule.yoloRequired.length > 0) {
    const hasRequired = rule.yoloRequired.some(cls => (yoloByClass.get(cls)?.length || 0) > 0);
    if (hasRequired) {
      score += 0.3;
      const found = rule.yoloRequired.filter(cls => yoloByClass.has(cls));
      evidence.push(`YOLO: ${found.join(", ")} detected`);
    } else if (ctx.yoloDetections) {
      // YOLO data exists but required classes not found — this rule doesn't apply
      return { score: 0, evidence: [] };
    }
    // If no YOLO data at all, skip this condition (text-only mode)
  }

  // YOLO boosters: each present one adds confidence
  for (const cls of rule.yoloBoosters) {
    if (yoloByClass.has(cls)) {
      score += 0.1;
      evidence.push(`YOLO booster: ${cls}`);
    }
  }

  // Required text keywords: mode-aware match ("all-required" or "any-required").
  // Bails if required text is missing AND this is a text-only rule (no YOLO gate).
  if (rule.textKeywordsRequired.length > 0) {
    const upperKeywords = rule.textKeywordsRequired.map(kw => kw.toUpperCase());
    const match = rule.textKeywordsMode === "all-required"
      ? upperKeywords.every(kw => upperText.includes(kw))
      : upperKeywords.some(kw => upperText.includes(kw));
    if (match) {
      score += 0.25;
      evidence.push(`Required keywords: ${rule.textKeywordsRequired.join(", ")}`);

      // Overlap boost: keywords inside a YOLO bbox
      if (rule.overlapRequired && ctx.yoloDetections) {
        if (rule.yoloRequired.some(cls => yoloByClass.has(cls))) {
          score += 0.15;
          evidence.push("Keywords overlap YOLO region");
        }
      }
    } else if (rule.yoloRequired.length === 0) {
      // Keyword-only rule with no match — doesn't apply
      return { score: 0, evidence: [] };
    }
  }

  // Booster keywords: each present adds +0.05, no gating
  for (const kw of rule.textKeywordsBoosters) {
    if (upperText.includes(kw.toUpperCase())) {
      score += 0.05;
      evidence.push(`Booster keyword: ${kw}`);
    }
  }

  // Spatial conditions
  if (rule.spatialConditions && ctx.yoloDetections) {
    for (const cond of rule.spatialConditions) {
      if (evalSpatialCondition(cond, yoloByClass)) {
        score += 0.2;
        evidence.push(`Spatial: ${cond.classA} ${cond.operator} ${cond.classB}${cond.minInstances ? ` (${cond.minInstances}+)` : ""}`);
      }
    }
  }

  // Text region type match
  if (rule.textRegionType && ctx.textRegions) {
    const matching = ctx.textRegions.filter(r => r.type === rule.textRegionType);
    if (matching.length > 0) {
      score += 0.15;
      evidence.push(`OCR region: ${rule.textRegionType} detected`);
    }
  }

  // CSI division requirement: page must have codes from specified divisions
  if (rule.csiDivisionsRequired && rule.csiDivisionsRequired.length > 0 && ctx.csiCodes) {
    const pageDivisions = new Set(ctx.csiCodes.map(c => c.code.substring(0, 2).replace(/\s/g, "")));
    const hasRequired = rule.csiDivisionsRequired.some(div => pageDivisions.has(div));
    if (hasRequired) {
      score += 0.15;
      const matched = rule.csiDivisionsRequired.filter(div => pageDivisions.has(div));
      evidence.push(`CSI division: ${matched.join(", ")}`);
    } else {
      // Required divisions not present — rule doesn't apply
      return { score: 0, evidence: [] };
    }
  }

  return { score, evidence };
}

// ═══════════════════════════════════════════════════════════════════
// Main Export
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the effective rule set: merge built-in defaults with company config overrides.
 * Company config can enable/disable, modify, or add custom rules.
 *
 * Incoming `companyHeuristics` may carry the legacy shape (pre-2026-04-24:
 * `textKeywords` instead of `textKeywordsRequired`/`textKeywordsBoosters`,
 * no `yoloAvailabilityMode`). `migrateRule` normalizes each entry in-memory
 * before merging — company DB JSONB is untouched.
 */
export function getEffectiveRules(
  companyHeuristics?: HeuristicRule[] | LegacyHeuristicRule[],
): HeuristicRule[] {
  if (!companyHeuristics || companyHeuristics.length === 0) {
    return BUILT_IN_RULES.filter(r => r.enabled);
  }

  // Normalize legacy-shape rules before merging
  const migrated = companyHeuristics.map(migrateRule);

  // Company config overrides built-in rules by ID
  const configById = new Map(migrated.map(r => [r.id, r]));
  const rules: HeuristicRule[] = [];

  // Apply overrides to built-in rules
  for (const builtIn of BUILT_IN_RULES) {
    const override = configById.get(builtIn.id);
    if (override) {
      rules.push({ ...builtIn, ...override, source: "built-in" });
      configById.delete(builtIn.id);
    } else {
      rules.push(builtIn);
    }
  }

  // Add remaining custom rules
  for (const custom of configById.values()) {
    rules.push({ ...custom, source: "custom" });
  }

  return rules.filter(r => r.enabled);
}

/**
 * Run the heuristic engine on a page.
 * Works in two modes:
 * - Text-only: yoloDetections is undefined. Rules with `yoloRequired` branch
 *   on `yoloAvailabilityMode`: "require" skips, "degrade" fires × 0.6 with
 *   an advisory evidence tag, "ignore" treats yoloRequired as boosters.
 * - YOLO-augmented: full spatial + keyword rules; availability mode is a no-op.
 *
 * `ctx.textRegions` is migrated in-place (new schema) so rules targeting
 * `textRegionType: "notes-numbered"` match legacy `notes-block`-labeled pages
 * until reprocess rewrites them.
 */
export function runHeuristicEngine(
  rules: HeuristicRule[],
  ctx: PageContext,
): HeuristicInference[] {
  const normalizedCtx: PageContext = {
    ...ctx,
    textRegions: migrateTextRegions(ctx.textRegions),
  };
  const inferences: HeuristicInference[] = [];

  for (const rule of rules) {
    try {
      const yoloMissing = !normalizedCtx.yoloDetections && rule.yoloRequired.length > 0;
      let score: number;
      let evidence: string[];

      if (yoloMissing) {
        const mode = rule.yoloAvailabilityMode ?? "require";
        if (mode === "require") continue; // preserves pre-2026-04-24 skip
        // Re-score treating yoloRequired as extra boosters (pure text-only eval).
        const promoted: HeuristicRule = {
          ...rule,
          yoloRequired: [],
          yoloBoosters: [...rule.yoloBoosters, ...rule.yoloRequired],
        };
        const result = scoreRule(promoted, normalizedCtx);
        if (result.score === 0) continue;
        if (mode === "degrade") {
          score = result.score * 0.6;
          evidence = [
            ...result.evidence,
            `YOLO unavailable: ${rule.yoloRequired.join(", ")} (degraded to text-only)`,
          ];
        } else { // "ignore"
          score = result.score;
          evidence = result.evidence;
        }
      } else {
        const result = scoreRule(rule, normalizedCtx);
        score = result.score;
        evidence = result.evidence;
      }

      if (score < rule.minConfidence || evidence.length === 0) continue;

      // Find approximate bbox from the most relevant YOLO detection
      let bbox: BboxLTWH | undefined;
      if (normalizedCtx.yoloDetections && rule.yoloRequired.length > 0) {
        const relevantClass = rule.yoloRequired[0];
        const det = normalizedCtx.yoloDetections.find(d => d.name === relevantClass);
        if (det) {
          bbox = [det.minX, det.minY, det.maxX - det.minX, det.maxY - det.minY];
        }
      }

      // Infer CSI tags
      let csiTags: CsiCode[] | undefined;
      if (rule.outputCsiCode && normalizedCtx.csiCodes) {
        const match = normalizedCtx.csiCodes.find(c => c.code === rule.outputCsiCode);
        if (match) csiTags = [match];
      }

      inferences.push({
        ruleId: rule.id,
        ruleName: rule.name,
        label: rule.outputLabel,
        confidence: Math.min(score, 0.99),
        evidence,
        bbox,
        csiTags,
      });
    } catch (err) {
      logger.error(`[heuristic-engine] rule "${rule.id}" failed:`, err);
    }
  }

  // Sort by confidence descending
  inferences.sort((a, b) => b.confidence - a.confidence);
  return inferences;
}
