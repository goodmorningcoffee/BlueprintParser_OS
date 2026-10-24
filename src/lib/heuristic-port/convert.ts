/**
 * heuristic-port/convert.ts — one legacy heuristic rule (src/lib/heuristic-rules.ts `HeuristicRule`) → one page-unit
 * classifier recipe (src/lib/classifier-engine/types.ts). Pure; used to generate src/data/classifiers/heuristics.v1.json
 * from BUILT_IN_RULES (pinned equal by __tests__/convert.test.ts) and, ON READ, for company rules in
 * `companies.pipeline_config.heuristics` (nothing is written back).
 *
 * The old additive ladder becomes the detect head's weights, in the old evaluation order, with bias −minConfidence
 * and detect threshold .5 (p ≥ .5 ⇔ score ≥ minConfidence). Gates are weight-0 "required" signals beside their
 * scoring twin, so the logit carries the same increments the old score did:
 *
 *   yolo-gate (required)        any yoloRequired class on the page; on a text-only run it passes only in
 *                               yoloAvailabilityMode degrade / ignore (`noDetections: 1`)
 *   yolo-required    +.30       same classes present
 *   yolo-booster-i   +.10 each
 *   keywords-gate (required)    ★ D7 FIX: the required keywords now gate EVERY rule. The old engine let a
 *                               YOLO-gated rule fire without them (REPORT §5 D7).
 *   keywords         +.25
 *   overlap          +.15       old "Keywords overlap YOLO region" (fires iff a yoloRequired class is present)
 *   keyword-booster-i +.05 each
 *   spatial-i        +.20 each  (yolo-spatial)
 *   text-region      +.15
 *   csi-gate (required) + csi +.15   page codes of a required division
 *   yolo-available              degrade only: weight min/.6 − min with bias −min/.6, so a text-only run needs
 *                               .6 × score ≥ min — the old ×.6 degrade, as an additive term
 */

import type { ClassifierRecipe, SignalSpec, WeightedSignal } from "@/lib/classifier-engine/types";
import type { HeuristicRule } from "@/lib/heuristic-rules";

/** The legacy engine's increments (heuristic-engine.ts `scoreRule`). */
export const LEGACY_LADDER = {
  yoloRequired: 0.3, yoloBooster: 0.1, keywords: 0.25, overlap: 0.15, keywordBooster: 0.05, spatial: 0.2, textRegion: 0.15, csi: 0.15,
} as const;
/** Old "degrade" mode: a text-only run scores × this. */
export const DEGRADE_FACTOR = 0.6;
/** The signal that carries the degrade threshold shift; never part of the reported confidence. */
export const YOLO_AVAILABLE_SIGNAL = "yolo-available";

function strings(v: unknown, field: string, id: string): string[] {
  if (!Array.isArray(v)) throw new Error(`heuristic rule "${id}": ${field} must be an array`);
  return v.filter((s): s is string => typeof s === "string");
}

const yoloPresence = (classes: string[], extra?: { noDetections: number }): SignalSpec =>
  ({ type: "yolo", where: "page", classes, measure: "presence", ...(extra ?? {}) });

export function ruleToRecipe(rule: HeuristicRule): ClassifierRecipe {
  const id = typeof rule?.id === "string" && rule.id ? rule.id : "";
  if (!id) throw new Error("heuristic rule needs an id");
  const yoloRequired = strings(rule.yoloRequired, "yoloRequired", id);
  const yoloBoosters = strings(rule.yoloBoosters, "yoloBoosters", id);
  const keywords = strings(rule.textKeywordsRequired, "textKeywordsRequired", id);
  const keywordBoosters = strings(rule.textKeywordsBoosters ?? [], "textKeywordsBoosters", id);
  const mode = rule.yoloAvailabilityMode === "degrade" || rule.yoloAvailabilityMode === "ignore" ? rule.yoloAvailabilityMode : "require";
  const minConfidence = typeof rule.minConfidence === "number" && Number.isFinite(rule.minConfidence) ? rule.minConfidence : 0;
  const signals: WeightedSignal[] = [];
  const add = (sid: string, label: string, spec: SignalSpec, weight: number, role: WeightedSignal["role"] = "score") =>
    signals.push({ id: sid, label, spec, weight, role, enabled: true });

  if (yoloRequired.length) {
    add("yolo-gate", `YOLO required: ${yoloRequired.join(", ")}`, yoloPresence(yoloRequired, mode === "require" ? undefined : { noDetections: 1 }), 0, "required");
    add("yolo-required", `YOLO: ${yoloRequired.join(", ")} detected`, yoloPresence(yoloRequired), LEGACY_LADDER.yoloRequired);
  }
  yoloBoosters.forEach((cls, i) => add(`yolo-booster-${i}`, `YOLO booster: ${cls}`, yoloPresence([cls]), LEGACY_LADDER.yoloBooster));
  if (keywords.length) {
    const spec: SignalSpec = { type: "text", terms: keywords, mode: rule.textKeywordsMode === "all-required" ? "all" : "any" };
    add("keywords-gate", `Required keywords (${spec.mode}): ${keywords.join(", ")}`, spec, 0, "required");
    add("keywords", `Required keywords: ${keywords.join(", ")}`, spec, LEGACY_LADDER.keywords);
    if (rule.overlapRequired && yoloRequired.length) add("overlap", "Keywords overlap YOLO region", yoloPresence(yoloRequired), LEGACY_LADDER.overlap);
  }
  keywordBoosters.forEach((kw, i) => add(`keyword-booster-${i}`, `Booster keyword: ${kw}`, { type: "text", terms: [kw], mode: "any" }, LEGACY_LADDER.keywordBooster));
  (Array.isArray(rule.spatialConditions) ? rule.spatialConditions : []).forEach((c, i) => add(
    `spatial-${i}`, `Spatial: ${c.classA} ${c.operator} ${c.classB}${c.minInstances ? ` (${c.minInstances}+)` : ""}`,
    {
      type: "yolo-spatial", operator: c.operator, classA: c.classA, classB: c.classB,
      ...(c.minInstances !== undefined ? { minInstances: c.minInstances } : {}), ...(c.axis ? { axis: c.axis } : {}),
      ...(c.maxDistance !== undefined ? { maxDistance: c.maxDistance } : {}),
    },
    LEGACY_LADDER.spatial,
  ));
  if (rule.textRegionType) add("text-region", `OCR region: ${rule.textRegionType} detected`, { type: "text-region", regionTypes: [rule.textRegionType] }, LEGACY_LADDER.textRegion);
  const divisions = Array.isArray(rule.csiDivisionsRequired) ? rule.csiDivisionsRequired.filter((d): d is string => typeof d === "string") : [];
  if (divisions.length) {
    const spec: SignalSpec = { type: "csi", where: "pageCodes", divisions, measure: "presence" };
    add("csi-gate", `CSI division required: ${divisions.join(", ")}`, spec, 0, "required");
    add("csi", `CSI division: ${divisions.join(", ")}`, spec, LEGACY_LADDER.csi);
  }
  const degrade = mode === "degrade" && yoloRequired.length > 0;
  if (degrade) {
    add(YOLO_AVAILABLE_SIGNAL, "YOLO ran on the page (degrade threshold shift)", yoloPresence(["*"], { noDetections: 0 }), minConfidence / DEGRADE_FACTOR - minConfidence);
  }

  return {
    id, name: typeof rule.name === "string" ? rule.name : id, version: 1, enabled: !!rule.enabled,
    source: rule.source === "built-in" ? "built-in" : "custom", unit: "page", target: typeof rule.outputLabel === "string" ? rule.outputLabel : id,
    candidates: [], scope: {},
    detect: { bias: degrade ? -minConfidence / DEGRADE_FACTOR : -minConfidence, signals, threshold: 0.5 },
    classes: [], nameThreshold: 0, minMargin: 0, deriveName: false, fallbackClassName: typeof rule.name === "string" ? rule.name : id,
    note: "Ported from the legacy heuristic engine (src/lib/heuristic-port/convert.ts).",
    heuristic: {
      minConfidence, yoloAvailabilityMode: mode,
      ...(typeof rule.outputCsiCode === "string" && rule.outputCsiCode ? { outputCsiCode: rule.outputCsiCode } : {}),
      ...(yoloRequired.length ? { bboxClass: yoloRequired[0] } : {}),
    },
  };
}
