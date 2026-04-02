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
  yoloRequired: string[];
  yoloBoosters: string[];
  textKeywords: string[];
  overlapRequired: boolean;
  spatialConditions?: SpatialCondition[];
  textRegionType?: string;       // match against TextRegion.type if present
  csiDivisionsRequired?: string[]; // CSI divisions that must be present (first 2 digits, e.g. ["08", "09"])
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
    textKeywords: ["KEYNOTE", "KEYNOTES", "KEY NOTES", "LEGEND"],
    overlapRequired: true,
    spatialConditions: [
      { operator: "contains", classA: "horizontal_area", classB: "oval", minInstances: 3, axis: "vertical" },
    ],
    textRegionType: "key-value",
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
    textKeywords: ["DOOR", "SCHEDULE"],
    overlapRequired: true,
    textRegionType: "table-like",
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
    textKeywords: ["FINISH", "SCHEDULE"],
    overlapRequired: true,
    textRegionType: "table-like",
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
    textKeywords: ["LEGEND", "SYMBOL"],
    overlapRequired: true,
    spatialConditions: [
      { operator: "contains", classA: "horizontal_area", classB: "*", minInstances: 3, axis: "vertical" },
    ],
    textRegionType: "key-value",
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
    textKeywords: ["GENERAL NOTES", "GENERAL NOTE", "NOTES:"],
    overlapRequired: false,
    textRegionType: "notes-block",
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
    textKeywords: ["SCHEDULE"],
    overlapRequired: true,
    textRegionType: "table-like",
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
    textKeywords: [],
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
    textKeywords: ["SECTION"],
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
    textKeywords: ["TYPICAL", "TYP"],
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

  // Text keywords: all must be found
  if (rule.textKeywords.length > 0) {
    const allFound = rule.textKeywords.every(kw => upperText.includes(kw.toUpperCase()));
    if (allFound) {
      score += 0.25;
      evidence.push(`Keywords: ${rule.textKeywords.join(", ")}`);

      // Overlap boost: keywords inside a YOLO bbox
      if (rule.overlapRequired && ctx.yoloDetections) {
        // Check if any keyword text is spatially inside a YOLO detection
        // (simplified: if YOLO classes are present and keywords found, assume overlap)
        if (rule.yoloRequired.some(cls => yoloByClass.has(cls))) {
          score += 0.15;
          evidence.push("Keywords overlap YOLO region");
        }
      }
    } else {
      // Keywords not found — significant penalty for keyword-dependent rules
      if (rule.textKeywords.length > 0 && rule.yoloRequired.length === 0) {
        return { score: 0, evidence: [] };
      }
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
 */
export function getEffectiveRules(companyHeuristics?: HeuristicRule[]): HeuristicRule[] {
  if (!companyHeuristics || companyHeuristics.length === 0) {
    return BUILT_IN_RULES.filter(r => r.enabled);
  }

  // Company config overrides built-in rules by ID
  const configById = new Map(companyHeuristics.map(r => [r.id, r]));
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
 * - Text-only: yoloDetections is undefined, only keyword/textRegion rules fire
 * - YOLO-augmented: full spatial + keyword rules
 */
export function runHeuristicEngine(
  rules: HeuristicRule[],
  ctx: PageContext,
): HeuristicInference[] {
  const inferences: HeuristicInference[] = [];

  for (const rule of rules) {
    // Skip rules requiring YOLO if no YOLO data
    if (!ctx.yoloDetections && rule.yoloRequired.length > 0) continue;

    try {
      const { score, evidence } = scoreRule(rule, ctx);
      if (score >= rule.minConfidence && evidence.length > 0) {
        // Find approximate bbox from the most relevant YOLO detection
        let bbox: BboxLTWH | undefined;
        if (ctx.yoloDetections && rule.yoloRequired.length > 0) {
          const relevantClass = rule.yoloRequired[0];
          const det = ctx.yoloDetections.find(d => d.name === relevantClass);
          if (det) {
            bbox = [det.minX, det.minY, det.maxX - det.minX, det.maxY - det.minY];
          }
        }

        // Infer CSI tags
        let csiTags: CsiCode[] | undefined;
        if (rule.outputCsiCode && ctx.csiCodes) {
          const match = ctx.csiCodes.find(c => c.code === rule.outputCsiCode);
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
      }
    } catch (err) {
      logger.error(`[heuristic-engine] rule "${rule.id}" failed:`, err);
    }
  }

  // Sort by confidence descending
  inferences.sort((a, b) => b.confidence - a.confidence);
  return inferences;
}
