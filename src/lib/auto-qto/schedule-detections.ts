import type { ScheduleSummaryEntry } from "@/types";

export interface ScheduleDetection {
  pageNum: number;
  name: string;
  confidence: number;
}

interface EnsembleRegionLike {
  category?: string;
  tableProbability: number;
}

interface ClassifiedTableLike {
  category: string;
  confidence: number;
}

interface PageIntelLike {
  ensembleRegions?: EnsembleRegionLike[];
  classifiedTables?: ClassifiedTableLike[];
}

/**
 * Per-page three-tier fallback for AutoQtoTab schedule detection.
 * Tier 1: ensembleRegions (authoritative cross-signal match).
 * Tier 2: summaries.schedules catalog.
 * Tier 3: classifiedTables.
 *
 * Per-page — not project-wide — so partial reprocessing (some pages with
 * ensembleRegions, others without) still surfaces Tier-2 pages.
 */
export function computeScheduleDetections(
  pageIntelligence: Record<number, PageIntelLike>,
  schedulesSummary: ScheduleSummaryEntry[] | undefined,
  pageNames: Record<number, string | undefined>,
): Record<string, ScheduleDetection[]> {
  const detections: Record<string, ScheduleDetection[]> = {};

  const summariesByPage: Record<number, ScheduleSummaryEntry[]> = {};
  for (const s of schedulesSummary || []) {
    if (!summariesByPage[s.pageNum]) summariesByPage[s.pageNum] = [];
    summariesByPage[s.pageNum].push(s);
  }

  const pageNums = new Set<number>([
    ...Object.keys(pageIntelligence).map(Number),
    ...Object.keys(summariesByPage).map(Number),
  ]);

  for (const pn of pageNums) {
    const pi = pageIntelligence[pn];
    if (pi?.ensembleRegions?.length) {
      for (const er of pi.ensembleRegions) {
        if (!er.category) continue;
        if (!detections[er.category]) detections[er.category] = [];
        detections[er.category].push({
          pageNum: pn,
          name: pageNames[pn] || `Page ${pn}`,
          confidence: er.tableProbability,
        });
      }
    } else if (summariesByPage[pn]?.length) {
      for (const s of summariesByPage[pn]) {
        if (!detections[s.category]) detections[s.category] = [];
        detections[s.category].push({
          pageNum: pn,
          name: pageNames[pn] || s.name,
          confidence: s.confidence,
        });
      }
    } else if (pi?.classifiedTables?.length) {
      for (const t of pi.classifiedTables) {
        if (!detections[t.category]) detections[t.category] = [];
        detections[t.category].push({
          pageNum: pn,
          name: pageNames[pn] || `Page ${pn}`,
          confidence: t.confidence,
        });
      }
    }
  }
  return detections;
}
