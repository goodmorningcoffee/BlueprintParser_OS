/**
 * classifier-engine/candidates.ts — a recipe's candidate boxes on one page (types.ts
 * `CandidateSource`), in source order, IoU ≥ .6 duplicates collapsed (the first source wins, so a
 * regions-v2 table keeps its structure signals over a bare Textract table), then the recipe's
 * `scope` applied. A page-unit recipe has one candidate: the whole page. Pure.
 */

import type { BboxMinMax } from "@/types";
import { ZONE_CONTAINMENT_THRESHOLD, containmentRatio } from "@/lib/page-zones";
import { DUPLICATE_IOU } from "@/lib/region-classifier-v2/classify";
import { inside, iou, ltwhToMinMax } from "@/lib/region-classifier-v2/geometry";
import type { Candidate, ClassifierPageInput, PageEvidence } from "./evidence";
import type { CandidateSource, ClassifierRecipe } from "./types";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";

const validBox = (b: readonly number[] | null | undefined): b is BboxMinMax =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1];

function fromSource(src: CandidateSource, input: ClassifierPageInput, page: PageEvidence): Candidate[] {
  switch (src.type) {
    case "regions-v2": {
      const kinds = new Set(src.kinds);
      return (input.regionsV2?.regions ?? []).filter((r) => kinds.has(r.kind) && validBox(r.bbox)).map((r) => ({
        source: "regions-v2" as const, bbox: r.bbox, anchorBbox: validBox(r.anchorBbox) ? r.anchorBbox : r.bbox, regionId: r.id,
        structure: { ...r.signals, structureScore: r.structureScore }, detConfidence: r.signals.detConf,
      }));
    }
    case "yolo": {
      const classes = new Set(src.classes);
      return page.detections
        .filter((d) => classes.has(d.name) && (!src.model || d.modelName === src.model) && d.confidence >= (src.minConfidence ?? 0))
        .map((d) => ({ source: "yolo" as const, bbox: d.bbox, anchorBbox: d.bbox, detConfidence: d.confidence }));
    }
    case "textract-tables": {
      const minRows = src.minRows ?? 2;
      return (input.textractData?.tables ?? [])
        .filter((t) => t?.bbox && (t.rowCount ?? 0) >= minRows)
        .map((t) => ltwhToMinMax(t.bbox))
        .filter(validBox)
        .map((bbox) => ({ source: "textract-tables" as const, bbox, anchorBbox: bbox }));
    }
    case "parsed-regions":
      return (input.parsedRegions ?? [])
        .map((r) => parsedRegionMinMax(r)) // stored MinMax (K04); was read as LTWH
        .filter(validBox)
        .map((bbox) => ({ source: "parsed-regions" as const, bbox, anchorBbox: bbox }));
    default:
      return [];
  }
}

const PAGE_BOX: BboxMinMax = [0, 0, 1, 1];

export function collectCandidates(recipe: ClassifierRecipe, input: ClassifierPageInput, page: PageEvidence): Candidate[] {
  if (recipe.unit === "page") return inScope(recipe, [{ source: "regions-v2", bbox: PAGE_BOX, anchorBbox: PAGE_BOX }], page);
  const out: Candidate[] = [];
  for (const src of recipe.candidates) {
    for (const c of fromSource(src, input, page)) {
      if (out.some((k) => iou(k.bbox, c.bbox) >= DUPLICATE_IOU)) continue;
      out.push(c);
    }
  }
  return inScope(recipe, out, page);
}

function inScope(recipe: ClassifierRecipe, cands: Candidate[], page: PageEvidence): Candidate[] {
  const s = recipe.scope;
  if (s.disciplines?.length && !(page.discipline && s.disciplines.map((d) => d.toUpperCase()).includes(page.discipline))) return [];
  if (s.excludeDisciplines?.length && page.discipline && s.excludeDisciplines.map((d) => d.toUpperCase()).includes(page.discipline)) return [];
  if (s.sheetNumberPattern) {
    try { if (!page.sheetNumber || !new RegExp(s.sheetNumberPattern, "i").test(page.sheetNumber)) return []; } catch { return []; }
  }
  if (s.pageKinds?.length && !(page.channelKind && s.pageKinds.includes(page.channelKind))) return [];
  return cands.filter((c) => {
    if (s.excludeTitleBlock && page.titleBlocks.some((tb) => containmentRatio(c.bbox, tb) >= ZONE_CONTAINMENT_THRESHOLD)) return false;
    if (s.minWords !== undefined || s.maxWords !== undefined) {
      const n = page.words.filter((w) => inside(w.c, c.bbox)).length;
      if (s.minWords !== undefined && n < s.minWords) return false;
      if (s.maxWords !== undefined && n > s.maxWords) return false;
    }
    return true;
  });
}
