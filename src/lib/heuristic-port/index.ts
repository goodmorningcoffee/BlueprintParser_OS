/**
 * heuristic-port — the legacy heuristic engine (src/lib/heuristic-engine.ts, retired at runtime) ported onto the
 * classifier engine [2b, 2026-10-24; plan gitignore/projects/classifier_builder/PLAN.md]. Every live built-in rule
 * is a page-unit recipe in src/data/classifiers/heuristics.v1.json; a company's `pipeline_config.heuristics` is
 * converted ON READ (convert.ts; nothing is written back). The adapter maps each page proposal back to the
 * `HeuristicInference` shape, so `pageIntelligence.heuristicInferences` and its consumers (table-classifier,
 * llm/tools, the intelligence panel) are unchanged.
 *
 * Kept from the old engine, deliberately: built-in recipes read YOLO layout classes from their own model
 * (lib/yolo-class-scope.ts) while custom ones see every detection; confidence = the old additive score
 * (capped .99) and the old `score < minConfidence` drop, evaluated in the old order so floating-point ties
 * resolve identically; evidence strings; bbox = the first detection of the first yoloRequired class; csiTags.
 * Changed, deliberately: D7 — required keywords gate every rule (see convert.ts); a malformed company rule is
 * skipped on read instead of throwing out of the whole page.
 */

import type { BboxLTWH, CsiCode, HeuristicInference } from "@/types";
import { HEURISTIC_RECIPES, runClassifierEngine, validateRecipe, type ClassifierProposal, type ClassifierRecipe } from "@/lib/classifier-engine";
import { BUILT_IN_RULES, withoutRetiredBuiltIns, type HeuristicRule } from "@/lib/heuristic-rules";
import { migrateRule, type LegacyHeuristicRule } from "@/lib/heuristic-rule-migrate";
import { scopeLayoutDetections } from "@/lib/yolo-class-scope";
import { csiDedupeKey } from "@/lib/csi-utils";
import { logger } from "@/lib/logger";
import { DEGRADE_FACTOR, ruleToRecipe, YOLO_AVAILABLE_SIGNAL } from "./convert";

export { ruleToRecipe, LEGACY_LADDER, DEGRADE_FACTOR } from "./convert";

export interface HeuristicDetection {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence: number;
  modelName?: string;
}

/** The old `runHeuristicEngine` page context, unchanged (call sites only swap the function). */
export interface HeuristicPageContext {
  rawText: string;
  /** Undefined = text-only run (YOLO has not run on the page). */
  yoloDetections?: HeuristicDetection[];
  /** `pageIntelligence.textRegions` (legacy type names are migrated). */
  textRegions?: unknown;
  csiCodes?: CsiCode[] | null;
  pageNumber: number;
}

function convertSafe(rule: HeuristicRule): ClassifierRecipe | null {
  try {
    return validateRecipe(ruleToRecipe(rule), rule.source === "built-in" ? "built-in" : "custom");
  } catch (err) {
    logger.error(`[heuristic-port] rule "${String((rule as { id?: unknown })?.id)}" skipped:`, err);
    return null;
  }
}

/**
 * The recipes a company runs — the old `getEffectiveRules` merge, as recipes: a company copy of a built-in replaces
 * it field by field (`{...builtIn, ...override}`, as before), stored copies of retired built-ins are dropped, the
 * rest are custom; disabled rules are left out. No company rules → the built-in recipes as shipped.
 */
export function getEffectiveHeuristicRecipes(companyHeuristics?: readonly unknown[] | null): ClassifierRecipe[] {
  const builtIn = new Map(HEURISTIC_RECIPES.map((r) => [r.id, r]));
  if (!Array.isArray(companyHeuristics) || companyHeuristics.length === 0) return HEURISTIC_RECIPES.filter((r) => r.enabled);
  const migrated = withoutRetiredBuiltIns(companyHeuristics.flatMap((r) => {
    try { return [migrateRule(r as LegacyHeuristicRule)]; } catch { return []; }
  }));
  const configById = new Map(migrated.map((r) => [r.id, r]));
  const out: ClassifierRecipe[] = [];
  for (const rule of BUILT_IN_RULES) {
    const override = configById.get(rule.id);
    if (override) {
      configById.delete(rule.id);
      const rec = convertSafe({ ...rule, ...override, source: "built-in" });
      if (rec) out.push(rec);
    } else {
      const rec = builtIn.get(rule.id);
      if (rec) out.push(rec);
    }
  }
  for (const custom of configById.values()) {
    const rec = convertSafe({ ...custom, source: "custom" });
    if (rec) out.push(rec);
  }
  return out.filter((r) => r.enabled);
}

const division2 = (code: string): string => code.substring(0, 2).replace(/\s/g, "");

/** One page proposal of a ported recipe → the legacy inference, or null when the old engine would not have emitted it. */
export function proposalToInference(
  recipe: ClassifierRecipe,
  proposal: Pick<ClassifierProposal, "features">,
  ctx: { detections: readonly HeuristicDetection[] | undefined; csiCodes: readonly CsiCode[]; yoloAvailable: boolean },
): HeuristicInference | null {
  const h = recipe.heuristic;
  if (!h) return null;
  const present = new Set((ctx.detections ?? []).map((d) => d.name));
  let score = 0;
  const evidence: string[] = [];
  for (const s of recipe.detect.signals) {
    if (!s.enabled || s.role !== "score" || s.id === YOLO_AVAILABLE_SIGNAL) continue;
    const v = proposal.features[`detect.${s.id}`] ?? 0;
    if (!(v > 0)) continue;
    score += s.weight * v;
    if (s.id === "yolo-required" && s.spec.type === "yolo") {
      evidence.push(`YOLO: ${s.spec.classes.filter((c) => present.has(c)).join(", ")} detected`);
    } else if (s.id === "csi" && s.spec.type === "csi") {
      const pageDivisions = new Set(ctx.csiCodes.map((c) => division2(c.code)));
      evidence.push(`CSI division: ${(s.spec.divisions ?? []).filter((d) => pageDivisions.has(d)).join(", ")}`);
    } else {
      evidence.push(s.label);
    }
  }
  if (!evidence.length) return null;
  const gate = recipe.detect.signals.find((s) => s.id === "yolo-gate" && s.enabled);
  if (!ctx.yoloAvailable && h.yoloAvailabilityMode === "degrade" && gate?.spec.type === "yolo") {
    score = score * DEGRADE_FACTOR;
    evidence.push(`YOLO unavailable: ${gate.spec.classes.join(", ")} (degraded to text-only)`);
  }
  if (score < h.minConfidence) return null;
  let bbox: BboxLTWH | undefined;
  if (ctx.detections && h.bboxClass) {
    const det = ctx.detections.find((d) => d.name === h.bboxClass);
    if (det) bbox = [det.minX, det.minY, det.maxX - det.minX, det.maxY - det.minY];
  }
  let csiTags: CsiCode[] | undefined;
  if (h.outputCsiCode) {
    const want = csiDedupeKey(h.outputCsiCode);
    const match = ctx.csiCodes.find((c) => csiDedupeKey(c.code) === want);
    if (match) csiTags = [match];
  }
  return { ruleId: recipe.id, ruleName: recipe.name, label: recipe.target, confidence: Math.min(score, 0.99), evidence, bbox, csiTags };
}

/**
 * Run the recipes on one page → `heuristicInferences` (confidence descending, recipe order on ties). Built-in recipes
 * see layout-scoped detections, custom ones every detection. A recipe that throws is logged and skipped.
 */
export function runHeuristicRecipes(recipes: readonly ClassifierRecipe[], ctx: HeuristicPageContext): HeuristicInference[] {
  const yoloAvailable = !!ctx.yoloDetections;
  const csiCodes = (ctx.csiCodes ?? []).filter((c) => c && typeof c.code === "string"); // a malformed stored row is skipped, not thrown
  const textRegions = Array.isArray(ctx.textRegions) ? (ctx.textRegions as Array<{ type?: string | null }>) : null;
  const groups: Array<{ recipes: ClassifierRecipe[]; detections: HeuristicDetection[] | undefined }> = [
    { recipes: recipes.filter((r) => r.source === "built-in"), detections: ctx.yoloDetections ? scopeLayoutDetections(ctx.yoloDetections) : undefined },
    { recipes: recipes.filter((r) => r.source !== "built-in"), detections: ctx.yoloDetections },
  ];
  const byRecipe = new Map<string, HeuristicInference>();
  for (const g of groups) {
    const page = g.recipes.filter((r) => r.unit === "page" && r.heuristic);
    if (!page.length) continue;
    const run = runClassifierEngine({
      pageNumber: ctx.pageNumber, detections: g.detections ?? [], rawText: ctx.rawText ?? "", textRegions, csiCodes, yoloAvailable,
    }, page);
    for (const e of run.errors) logger.error(`[heuristic-port] recipe "${e.recipeId}" failed: ${e.message}`);
    for (const p of run.result.proposals) {
      const recipe = page.find((r) => r.id === p.recipeId);
      const inf = recipe ? proposalToInference(recipe, p, { detections: g.detections, csiCodes, yoloAvailable }) : null;
      if (inf) byRecipe.set(recipe!.id, inf);
    }
  }
  const out = recipes.flatMap((r) => (byRecipe.has(r.id) ? [byRecipe.get(r.id)!] : []));
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}
