/**
 * classifier-engine/engine.ts — run the effective recipes over one page: candidates → detect head
 * → naming head → `ClassifierProposal` (types.ts). Evidence is built once per page; a recipe that
 * throws is skipped (logged by the caller through `errors`), never the page. Pure given its inputs;
 * `ms` is reported beside the record, not inside it, so an unchanged page compares equal.
 */

import type { BboxMinMax } from "@/types";
import { round5 } from "@/lib/region-classifier-v2/geometry";
import { collectCandidates } from "./candidates";
import { CONFIDENT_NAME } from "./derive-name";
import { bboxKey, buildCandidateEvidence, buildPageEvidence, columnWords, shapesInside, type ClassifierPageInput } from "./evidence";
import { evaluateHead, pickClass, topWhy } from "./heads";
import { buildTagMap } from "./shape-column";
import { CLASSIFIER_ENGINE_VERSION, type ClassifierProposal, type ClassifierRecipe, type PageClassifierProposals } from "./types";

export interface EngineRun {
  result: PageClassifierProposals;
  /** Wall time of this page, ms. */
  ms: number;
  /** Recipes that threw, with the message (the page's other recipes still ran). */
  errors: Array<{ recipeId: string; message: string }>;
}

export const proposalId = (recipeId: string, pageNumber: number, anchor: BboxMinMax): string => `${recipeId}:p${pageNumber}:${bboxKey(anchor)}`;

export function runClassifierEngine(input: ClassifierPageInput, recipes: readonly ClassifierRecipe[]): EngineRun {
  const t0 = Date.now();
  const page = buildPageEvidence(input);
  const proposals: ClassifierProposal[] = [];
  const used: Record<string, number> = {};
  const errors: EngineRun["errors"] = [];
  for (const recipe of recipes) {
    if (!recipe.enabled) continue;
    used[recipe.id] = recipe.version;
    try {
      for (const cand of collectCandidates(recipe, input, page)) {
        const ev = buildCandidateEvidence(page, cand);
        const detect = evaluateHead("detect", recipe.detect.bias, recipe.detect.signals, ev, page);
        if (detect.rejected || detect.p < recipe.detect.threshold) continue;
        const pick = recipe.classes.length
          ? pickClass(recipe, ev, page)
          : { classId: null, className: recipe.fallbackClassName, group: null, nameP: 0, margin: 0, why: [], features: {} };
        const derivedName = recipe.deriveName ? ev.derivedName : undefined;
        const displayName = pick.classId ? pick.className
          : derivedName && derivedName.confidence >= CONFIDENT_NAME && derivedName.text ? derivedName.text : pick.className;
        // [shape-tags 2026-10-25] table-ness head (kind kept separate) + the tag column with its rows, region candidates only.
        const table = recipe.tableHead ? evaluateHead("table", recipe.tableHead.bias, recipe.tableHead.signals, ev, page) : null;
        const tagMap = recipe.unit === "region" ? buildTagMap(shapesInside(page, cand.bbox), columnWords(ev), cand.bbox) : undefined;
        proposals.push({
          id: proposalId(recipe.id, input.pageNumber, cand.anchorBbox),
          recipeId: recipe.id, recipeVersion: recipe.version, engineVersion: CLASSIFIER_ENGINE_VERSION,
          pageNumber: input.pageNumber, bbox: cand.bbox.map(round5) as BboxMinMax, target: recipe.target,
          p: detect.p, classId: pick.classId, className: pick.className, group: pick.group, nameP: pick.nameP, margin: pick.margin,
          ...(pick.runnerUp ? { runnerUp: pick.runnerUp } : {}),
          ...(derivedName ? { derivedName } : {}),
          displayName,
          detectWhy: topWhy(detect.contributions), nameWhy: pick.why,
          features: { ...detect.features, ...pick.features, ...(table ? table.features : {}) },
          source: cand.source, ...(cand.regionId ? { regionId: cand.regionId } : {}),
          ...(pick.legacyCategory ? { legacyCategory: pick.legacyCategory } : {}),
          ...(table && !table.rejected ? { tableP: table.p, tableWhy: topWhy(table.contributions) } : {}),
          ...(tagMap ? { tagMap } : {}),
          ...(page.sheetNumber ? { sheetNumber: page.sheetNumber } : {}), ...(page.discipline ? { discipline: page.discipline } : {}),
        });
      }
    } catch (err) {
      errors.push({ recipeId: recipe.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  proposals.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || (a.id < b.id ? -1 : 1));
  return { result: { engineVersion: CLASSIFIER_ENGINE_VERSION, recipes: used, proposals }, ms: Date.now() - t0, errors };
}

/** Type guard for a stored `pageIntelligence.classifierProposals` value (jsonb, so shape is not guaranteed). */
export function isPageClassifierProposals(value: unknown): value is PageClassifierProposals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.engineVersion === "string" && !!v.recipes && typeof v.recipes === "object" && Array.isArray(v.proposals)
    && v.proposals.every((p) => p && typeof p === "object" && typeof (p as ClassifierProposal).id === "string" && Array.isArray((p as ClassifierProposal).bbox));
}

export function storedClassifierProposals(pageIntelligence: unknown): PageClassifierProposals | undefined {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return undefined;
  const v = (pageIntelligence as Record<string, unknown>).classifierProposals;
  return isPageClassifierProposals(v) ? v : undefined;
}
