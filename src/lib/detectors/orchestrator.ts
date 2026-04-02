/**
 * detectors/orchestrator.ts
 *
 * Runs the text-annotation pipeline: loads enabled detectors from registry,
 * runs each, deduplicates, groups, and builds summary.
 *
 * Replaces the monolithic detectTextAnnotations() function.
 */

import type {
  TextAnnotation,
  TextAnnotationGroup,
  TextAnnotationResult,
  TextAnnotationType,
  TextractPageData,
  CsiCode,
  AnnotationCategory,
} from "@/types";
import type { DetectorContext } from "./types";
import { ALL_DETECTORS } from "./registry";
import { logger } from "@/lib/logger";

// ═══════════════════════════════════════════════════════════════════
// Pipeline input
// ═══════════════════════════════════════════════════════════════════

export interface PipelineInput {
  data: TextractPageData;
  csiCodes?: CsiCode[];
  yoloDetections?: DetectorContext["yoloDetections"];
  enabledDetectorIds?: string[];  // from DB config; null/undefined = all defaults
}

// ═══════════════════════════════════════════════════════════════════
// Priority map for dedup (higher = wins when word indices overlap)
// ═══════════════════════════════════════════════════════════════════

const TYPE_PRIORITY: Record<string, number> = {
  // Contact: high
  "phone": 90, "fax": 91, "email": 92, "url": 90, "zip-code": 80, "address": 88, "csi-code": 75,
  // Codes
  "spec-section": 85, "building-code": 85, "code-compliance": 84,
  // Dimensions
  "imperial-dim": 80, "metric-dim": 80, "scale": 82, "slope": 81,
  // Equipment
  "equipment-tag": 75, "door-window-tag": 76, "finish-code": 74,
  "panel-circuit": 73, "material-code": 40,
  // References
  "sheet-number": 85, "sheet-ref": 70, "detail-ref": 70, "revision": 68, "action-marker": 65,
  // Trade
  "structural": 60, "mechanical": 60, "electrical": 60, "plumbing": 60, "fire-protection": 60,
  // Notes
  "general-note": 50, "typical-marker": 55, "coordination-note": 52,
  // Rooms
  "room-number": 45, "room-name": 48, "area-designation": 47,
  // Abbreviations: lowest — they coexist
  "abbreviation": 10,
  // Future types
  "keynote-table": 55, "schedule-region": 53, "boilerplate-note": 30,
  "heuristic-inference": 60,
};

// ═══════════════════════════════════════════════════════════════════
// Dedup logic (moved from monolith — unchanged)
// ═══════════════════════════════════════════════════════════════════

function dedup(annotations: TextAnnotation[]): TextAnnotation[] {
  const sorted = [...annotations].sort(
    (a, b) => (TYPE_PRIORITY[b.type] ?? 0) - (TYPE_PRIORITY[a.type] ?? 0)
  );

  const consumedIndices = new Set<number>();
  const kept: TextAnnotation[] = [];

  for (const ann of sorted) {
    if (ann.type === "abbreviation") {
      kept.push(ann);
      continue;
    }

    const overlaps = ann.wordIndices.some(idx => consumedIndices.has(idx));
    if (overlaps) continue;

    kept.push(ann);
    for (const idx of ann.wordIndices) {
      consumedIndices.add(idx);
    }
  }

  return kept;
}

function dedupSameType(annotations: TextAnnotation[]): TextAnnotation[] {
  const seen = new Map<string, Set<number>>();
  const kept: TextAnnotation[] = [];

  for (const ann of annotations) {
    const key = ann.type;
    if (!seen.has(key)) seen.set(key, new Set());
    const usedIndices = seen.get(key)!;

    const allSeen = ann.wordIndices.length > 0
      && ann.wordIndices.every(idx => usedIndices.has(idx));
    if (allSeen) continue;

    kept.push(ann);
    for (const idx of ann.wordIndices) {
      usedIndices.add(idx);
    }
  }
  return kept;
}

// ═══════════════════════════════════════════════════════════════════
// Auto-grouping logic (moved from monolith — unchanged)
// ═══════════════════════════════════════════════════════════════════

const DISCIPLINE_PREFIXES: Record<string, string> = {
  T: "Title/Cover", G: "General", C: "Civil", L: "Landscape",
  A: "Architectural", I: "Interior", ID: "Interior Design",
  DM: "Demolition", S: "Structural",
  M: "Mechanical", E: "Electrical", P: "Plumbing",
  FP: "Fire Protection", FA: "Fire Alarm", SP: "Sprinkler", SD: "Standpipe",
};

function autoGroup(annotations: TextAnnotation[]): TextAnnotationGroup[] {
  const groupable = annotations.filter(a =>
    a.group && (a.type === "equipment-tag" || a.type === "material-code"
      || a.type === "finish-code" || a.type === "door-window-tag"
      || a.type === "sheet-number")
  );

  const buckets = new Map<string, TextAnnotation[]>();
  for (const ann of groupable) {
    const key = `${ann.type}:${ann.group}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(ann);
  }

  const groups: TextAnnotationGroup[] = [];
  for (const [, items] of buckets) {
    if (items.length < 2) continue;
    const prefix = items[0].group!;
    const typeLabel = items[0].type === "equipment-tag" ? "Equipment"
      : items[0].type === "door-window-tag" ? (prefix === "D" ? "Doors" : "Windows")
      : items[0].type === "finish-code" ? "Finish"
      : items[0].type === "sheet-number" ? (DISCIPLINE_PREFIXES[prefix] || "Sheets")
      : "Material";
    groups.push({
      prefix,
      count: items.length,
      items,
      label: `${typeLabel} ${prefix} (${items.length} items)`,
    });
  }

  groups.sort((a, b) => b.count - a.count);
  return groups;
}

// ═══════════════════════════════════════════════════════════════════
// Summary builder (moved from monolith — unchanged)
// ═══════════════════════════════════════════════════════════════════

function buildSummary(annotations: TextAnnotation[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const ann of annotations) {
    summary[ann.category] = (summary[ann.category] ?? 0) + 1;
    summary[ann.type] = (summary[ann.type] ?? 0) + 1;
  }
  summary["total"] = annotations.length;
  return summary;
}

// ═══════════════════════════════════════════════════════════════════
// CSI universal tagging post-processor
// ═══════════════════════════════════════════════════════════════════

/** Trade category → CSI division prefix mapping for affinity matching. */
const TRADE_CSI_AFFINITY: Record<string, string[]> = {
  structural: ["03", "05"],         // Concrete, Metals
  mechanical: ["23", "25"],         // HVAC, Integrated Automation
  electrical: ["26", "27", "28"],   // Electrical, Communications, Electronic Safety
  plumbing: ["22"],                 // Plumbing
  "fire-protection": ["21"],        // Fire Suppression
};

/**
 * Tag each annotation with matching CSI codes.
 * Three matching strategies (in order):
 * 1. Direct meta match: annotation already has CSI code in meta (from csi-annotations detector)
 * 2. Keyword overlap: annotation text shares 50%+ words with a CSI description
 * 3. Trade affinity: annotation's trade type maps to CSI division
 */
function tagWithCsi(annotations: TextAnnotation[], csiCodes: CsiCode[]): void {
  if (!csiCodes.length) return;

  for (const ann of annotations) {
    // Skip annotations that are themselves CSI code annotations (already tagged)
    if (ann.type === "csi-code") continue;

    const matches: CsiCode[] = [];

    // Strategy 1: annotation meta already has a CSI code reference
    if (ann.meta?.code && typeof ann.meta.code === "string") {
      const direct = csiCodes.find(c => c.code === ann.meta!.code);
      if (direct) matches.push(direct);
    }

    // Strategy 2: keyword overlap between annotation text and CSI descriptions
    if (matches.length === 0) {
      const annWords = new Set(ann.text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      if (annWords.size > 0) {
        for (const csi of csiCodes) {
          const descWords = csi.description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          if (descWords.length === 0) continue;
          const overlap = descWords.filter(w => annWords.has(w)).length;
          if (overlap >= Math.ceil(descWords.length * 0.5)) {
            matches.push(csi);
          }
        }
      }
    }

    // Strategy 3: trade affinity (mechanical annotations → HVAC CSI codes)
    if (matches.length === 0 && ann.category === "trade") {
      const affinityDivisions = TRADE_CSI_AFFINITY[ann.type];
      if (affinityDivisions) {
        for (const csi of csiCodes) {
          const div = csi.code.substring(0, 2);
          if (affinityDivisions.includes(div)) {
            matches.push(csi);
          }
        }
      }
    }

    if (matches.length > 0) {
      // Deduplicate by code
      const seen = new Set<string>();
      ann.csiTags = matches.filter(c => {
        if (seen.has(c.code)) return false;
        seen.add(c.code);
        return true;
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main pipeline
// ═══════════════════════════════════════════════════════════════════

/**
 * Run the text-annotation pipeline.
 * - Loads enabled detectors from registry
 * - Runs each in try/catch (one failure doesn't break others)
 * - Deduplicates, groups, builds summary
 * - Returns TextAnnotationResult (same shape as the old monolith)
 */
export function runTextAnnotationPipeline(input: PipelineInput): TextAnnotationResult {
  const { data, csiCodes, yoloDetections, enabledDetectorIds } = input;
  const { words, lines } = data;

  if (!words || words.length === 0) {
    return { annotations: [], groups: [], summary: { total: 0 } };
  }

  // Build context once, pass to all detectors
  const ctx: DetectorContext = {
    words,
    lines: (lines || []) as any,
    csiCodes: csiCodes || [],
    yoloDetections,
  };

  // Determine which detectors to run
  const detectors = enabledDetectorIds
    ? ALL_DETECTORS.filter(d => enabledDetectorIds.includes(d.meta.id))
    : ALL_DETECTORS.filter(d => d.meta.defaultEnabled);

  // Run all enabled detectors
  const raw: TextAnnotation[] = [];
  for (const detector of detectors) {
    try {
      const result = detector.detect(ctx);
      raw.push(...result);
    } catch (err) {
      logger.error(`[orchestrator] detector "${detector.meta.id}" failed:`, err);
    }
  }

  // Dedup: same-type then cross-type
  const noDupSameType = dedupSameType(raw);
  const annotations = dedup(noDupSameType);

  // CSI universal tagging: tag every annotation with matching CSI codes
  tagWithCsi(annotations, csiCodes || []);

  // Auto-group
  const groups = autoGroup(annotations);

  // Summary
  const summary = buildSummary(annotations);

  return { annotations, groups, summary };
}
