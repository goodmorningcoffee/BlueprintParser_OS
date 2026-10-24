/**
 * region-classifier-v2/adapter.ts — the one-line switch, prepared but not thrown.
 *
 * `regionsV2ToClassifiedTables` emits the legacy `ClassifiedTable[]` vocabulary from a
 * `regionsV2` record so KeynotePanel, TableParsePanel, the CSI spatial map, the LLM context and
 * the ensemble can consume v2 output with no UI change once a caller prefers it.
 * `resolvePreferRegionsV2` reads that preference (company `pipelineConfig.preferRegionsV2`, else
 * the root `app_settings` row, else false). Nothing in the pipeline reads either yet: v2 is
 * computed and persisted in shadow beside `classifiedTables`, which stays the live output.
 */

import type { BboxLTWH, ClassifiedTable, ClassifiedTableCategory } from "@/types";
import { minMaxToLtwh } from "./geometry";
import { UNCLASSIFIED, type RegionsV2, type RegionV2 } from "./types";

/** `app_settings.key` of the root-level default (`{ "value": true }`). */
export const PREFER_REGIONS_V2_SETTING_KEY = "region_classifier_v2:prefer";
/** `companies.pipeline_config` key of the per-company override (boolean). */
export const PREFER_REGIONS_V2_CONFIG_KEY = "preferRegionsV2";

/**
 * Per-company flag wins when it is a boolean; else the root app setting; else false.
 * Pure — the caller hands in the rows it already loaded.
 */
export function resolvePreferRegionsV2(src: {
  pipelineConfig?: unknown;
  /** The stored `app_settings` value for `PREFER_REGIONS_V2_SETTING_KEY` (`{value: boolean}` or a bare boolean). */
  appSetting?: unknown;
}): boolean {
  const cfg = src.pipelineConfig;
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const v = (cfg as Record<string, unknown>)[PREFER_REGIONS_V2_CONFIG_KEY];
    if (typeof v === "boolean") return v;
  }
  const s = src.appSetting;
  if (typeof s === "boolean") return s;
  if (s && typeof s === "object" && typeof (s as { value?: unknown }).value === "boolean") return (s as { value: boolean }).value;
  return false;
}

/** Fine v2 class name → legacy category. Unlisted schedules are `material-schedule` (the legacy catch-all). */
const CLASS_TO_CATEGORY: Record<string, ClassifiedTableCategory> = {
  "door schedule": "door-schedule",
  "finish schedule": "finish-schedule",
  keynotes: "keynote-table",
  "symbol legend": "symbol-legend",
  "general notes": "general-notes",
  "sheet / coded notes": "general-notes",
  "demolition notes": "general-notes",
  "code / life-safety notes": "general-notes",
  "structural notes": "general-notes",
  "notes (untitled)": "general-notes",
  abbreviations: "general-notes",
  "specification text": "spec-text",
};

export function legacyCategoryOf(region: Pick<RegionV2, "kind" | "className">): ClassifiedTableCategory | null {
  const mapped = CLASS_TO_CATEGORY[region.className];
  if (mapped) return mapped;
  if (region.kind === "table") return region.className === UNCLASSIFIED ? "unknown-table" : "material-schedule";
  if (region.kind === "legend") return "symbol-legend";
  if (region.kind === "keynotes") return "keynote-table";
  return null; // an unclassified notes box has no legacy category
}

/**
 * Legacy `ClassifiedTable[]` view of a `regionsV2` record. Confidence = structure × name strength
 * (an unclassified table keeps its structure score, as `unknown-table`); bbox is LTWH like every
 * `TextRegion`; `id` is the stable v2 region id so promote / dismiss labels can join back.
 */
export function regionsV2ToClassifiedTables(regionsV2: RegionsV2 | null | undefined, pageNumber: number): ClassifiedTable[] {
  if (!regionsV2) return [];
  const out: ClassifiedTable[] = [];
  for (const r of regionsV2.regions) {
    const category = legacyCategoryOf(r);
    if (!category) continue;
    const named = r.className !== UNCLASSIFIED && !["unknown-table"].includes(category);
    const confidence = Math.round(Math.min(1, Math.max(0, r.structureScore * (named ? Math.max(r.nameScore, 0.5) : 1))) * 1000) / 1000;
    const bbox = minMaxToLtwh(r.bbox) as BboxLTWH;
    out.push({
      id: r.id,
      type: r.kind === "table" ? "schedule-table" : r.kind === "legend" ? "notes-key-value" : "paragraph",
      bbox,
      confidence,
      wordCount: r.signals.words,
      headerText: named ? r.className : undefined,
      category,
      evidence: [`region-classifier-v2 ${r.modelVersion}`, ...r.evidence],
      pageNumber,
      isPageSpecific: true,
    });
  }
  return out;
}
