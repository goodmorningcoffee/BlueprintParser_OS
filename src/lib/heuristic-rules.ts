/**
 * heuristic-rules.ts — the legacy heuristic rule shape (`companies.pipeline_config.heuristics[]`, edited in the
 * admin Heuristics tab) and the built-in rule set. Moved verbatim out of heuristic-engine.ts [2b heuristic port,
 * 2026-10-24] so the admin tab and the port (src/lib/heuristic-port, which runs these rules as page-unit classifier
 * recipes) read them without importing the retired engine. `BUILT_IN_RULES` and
 * src/data/classifiers/heuristics.v1.json are pinned equal through the port's converter
 * (src/lib/heuristic-port/__tests__/convert.test.ts).
 */


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


// ═══════════════════════════════════════════════════════════════════
// Built-in Rules
// ═══════════════════════════════════════════════════════════════════

/**
 * [fix 2026-10-24 T1a] RETIRED built-ins: door-schedule, finish-schedule, material-schedule and
 * table-confidence-boost all REQUIRED YOLO class "table"; the model emits "tables", so they never
 * fired. Measured name-fixed over the corpus they would fire on 174/179 table pages and were right
 * 0/12, and `heuristicInferences` is present on 0 pages in 216 exports — nothing depends on them.
 * The Heuristics tab saves every rule it shows, so companies hold stored copies (source
 * "built-in"); `getEffectiveRules` and the admin GET drop those. A CUSTOM rule may reuse an id.
 */
export const RETIRED_BUILT_IN_RULE_IDS: ReadonlySet<string> = new Set([
  "door-schedule",
  "finish-schedule",
  "material-schedule",
  "table-confidence-boost",
]);

/** Company rules minus stored copies of retired built-ins (custom rules always survive). */
export function withoutRetiredBuiltIns<T extends { id: string; source?: string }>(rules: readonly T[]): T[] {
  return rules.filter((r) => !(r.source === "built-in" && RETIRED_BUILT_IN_RULE_IDS.has(r.id)));
}

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

