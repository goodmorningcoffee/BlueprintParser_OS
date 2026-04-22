/**
 * text-region-classifier.ts
 *
 * System 1: OCR-based text region classification.
 *
 * Composite six-stage pipeline (rewritten 2026-04-24):
 *   A. LINE consumption — read Textract `lines[].words[]` as the authoritative
 *      grouping (the pre-rewrite classifier ignored this free signal and
 *      re-clustered words from scratch).
 *   B. Region proposal — column-aware clustering: X-overlap union-find groups
 *      lines into column bands; within each band, Y-gap clustering splits
 *      into paragraph blocks.
 *   C. Whitespace-rectangle discovery (optional, debug-only in v1) — LIR on a
 *      binary word-mask to surface column gutters for tuning visibility.
 *   D. Union-Find merge — stitch adjacent region candidates whose bboxes
 *      overlap by IoU > UNION_FIND_IOU_THRESHOLD or by containment ratio >
 *      UNION_FIND_CONTAIN_THRESHOLD (Docling's insight: containment catches
 *      nested-box cases IoU misses).
 *   E. Per-region analysis — numbered-item ratio, header-font detection,
 *      column-band count, CSI tag inference, tier-keyword matching.
 *   F. Classification decision tree — deterministic scoring against the
 *      notes-numbered / notes-key-value / spec-dense-columns / schedule-table
 *      / paragraph / unknown union, plus grid binding for notes-numbered.
 *
 * Ideas ported (algorithms only; no code imported):
 *   - pdfplumber `cluster_objects` — gap-to-previous tolerance clustering.
 *   - Docling `LayoutPostprocessor` — Union-Find merge with IoU OR containment.
 *   - OpenStitching/lir — Marzeh 2019 largest inscribed rectangle on a mask.
 *
 * Pure TypeScript — no image library (Node side has no sharp/jimp/canvas).
 * Reuses `ocr-utils.ts` helpers (`mergeBbox`, `isSameLine`, etc.) and
 * `spatial-constants.ts` tunables. No new npm deps.
 *
 * Runs during upload processing (see processing.ts:383-428) and via admin
 * reprocess `?scope=intelligence` (see admin/reprocess/route.ts:394-496).
 */

import type {
  TextractPageData,
  TextractLine,
  TextractWord,
  TextRegion,
  TextRegionType,
  CsiCode,
  BboxLTWH,
} from "@/types";
import { mergeBbox, wordsToText } from "@/lib/ocr-utils";
import { clusterByTolerance } from "@/lib/geom/cluster-by-tolerance";
import { UnionFind } from "@/lib/geom/union-find";
import { iou, maxContainment, intersectionArea } from "@/lib/geom/overlap-signals";
import {
  topKInscribedRects,
  rasterizeBboxes,
  type InscribedRect,
} from "@/lib/geom/largest-inscribed-rect";
import { matchTiers, type TierMatch } from "@/lib/note-keyword-tiers";
import {
  CLUSTER_Y_TOLERANCE_FACTOR,
  CLUSTER_X_TOLERANCE,
  UNION_FIND_IOU_THRESHOLD,
  UNION_FIND_CONTAIN_THRESHOLD,
  WHITESPACE_RECT_MIN_AREA_FRACTION,
  WHITESPACE_RECT_GUTTER_RATIO,
  CLASSIFIER_MASK_WIDTH,
  CLASSIFIER_MASK_HEIGHT,
  HEADER_FONT_RATIO,
  NUMBERED_RATIO_THRESHOLD,
  KV_RIGHT_COL_MAX_LEN,
  SPEC_NARROW_MAX_WIDTH,
  SPEC_MIN_WORD_COUNT,
  CLASSIFIER_MIN_CONFIDENCE,
  CLASSIFIER_MIN_REGION_WORDS,
  CLASSIFIER_WHITESPACE_SKIP_WORD_COUNT,
  DEFAULT_TITLE_BLOCK_REGION,
} from "@/lib/spatial-constants";

// ═══════════════════════════════════════════════════════════════════
// Debug bundle
// ═══════════════════════════════════════════════════════════════════

export interface ClassifierDebugBundle {
  pageNumber?: number;
  stages: {
    A: { lineCount: number; medianHeight: number; headerCandidates: string[] };
    B: { candidateBboxes: BboxLTWH[] };
    C?: {
      rectangles: Array<{ bbox: BboxLTWH; kind: "gutter" | "paragraph-break"; area: number }>;
      maskResolution: [number, number];
    };
    D: {
      edges: Array<{ a: number; b: number; signal: "iou" | "contained"; value: number }>;
      componentBboxes: BboxLTWH[];
    };
    E: Array<{
      componentId: number;
      numberedRatio: number;
      headerText?: string;
      tier1?: string;
      tier2?: string;
      trade?: string;
      columnCount: number;
    }>;
    F: Array<{
      componentId: number;
      type: TextRegionType;
      confidence: number;
      decisionTrace: string[];
    }>;
  };
  finalRegions: TextRegion[];
}

// ═══════════════════════════════════════════════════════════════════
// Constants internal to this module
// ═══════════════════════════════════════════════════════════════════

/** OCR-tolerant numbered-item marker at line start. Accepts:
 *  "1." "(1)" "1)" "1:" "1 ." and whitespace variants. */
const RE_NUMBERED_ITEM = /^\s*\(?(\d{1,3})\s*[.):]\s*/;

/** Spec section-header marker ("PART 1 — GENERAL", "SECTION 03 10 00"). */
const RE_SPEC_SECTION = /\b(PART\s*\d|SECTION\s*\d{2})\b/;

// ═══════════════════════════════════════════════════════════════════
// Line features
// ═══════════════════════════════════════════════════════════════════

interface LineFeature {
  line: TextractLine;
  /** Normalized Y-top. */
  top: number;
  /** Normalized Y-bottom. */
  bottom: number;
  /** Normalized X-left. */
  left: number;
  /** Normalized X-right. */
  right: number;
  /** Height in normalized coordinates (proxy for font size). */
  height: number;
  /** First word text (for numbered-item regex). */
  firstWord: string;
  /** Full LINE text, uppercased for keyword scans. */
  upperText: string;
}

function buildLineFeatures(lines: readonly TextractLine[]): LineFeature[] {
  const features: LineFeature[] = [];
  for (const line of lines) {
    if (!line.words || line.words.length === 0) continue;
    if (!line.text || line.text.trim().length === 0) continue;
    features.push({
      line,
      top: line.bbox[1],
      bottom: line.bbox[1] + line.bbox[3],
      left: line.bbox[0],
      right: line.bbox[0] + line.bbox[2],
      height: line.bbox[3],
      firstWord: line.words[0].text,
      upperText: line.text.toUpperCase(),
    });
  }
  return features;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function xRangesOverlap(a: LineFeature, b: LineFeature): boolean {
  return !(a.right < b.left || b.right < a.left);
}

// ═══════════════════════════════════════════════════════════════════
// Stage B — Column-aware region proposal
// ═══════════════════════════════════════════════════════════════════

/**
 * Group lines into candidate regions. Two lines are in the same candidate iff
 * they share X-overlap with some transitively-overlapping line AND their
 * vertical gap (within an X-band) is within `yGapTolerance`.
 *
 * O(n²) X-overlap graph construction — fine for typical n < 500 lines/page.
 * Returns groups indexed into the input `features` array.
 */
function proposeCandidateRegions(
  features: readonly LineFeature[],
  yGapTolerance: number,
): LineFeature[][] {
  if (features.length === 0) return [];

  // Step 1: Union-Find over X-range overlap graph → column-ish bands.
  const uf = new UnionFind(features.length);
  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      if (xRangesOverlap(features[i], features[j])) uf.union(i, j);
    }
  }
  const xClusters = uf.components();

  // Step 2: Within each X-cluster, Y-gap cluster to split paragraph blocks.
  const regions: LineFeature[][] = [];
  for (const cluster of xClusters) {
    const ysorted = cluster
      .map((idx) => features[idx])
      .sort((a, b) => a.top - b.top);

    let current: LineFeature[] = [];
    let currentBottom = -Infinity;
    for (const feat of ysorted) {
      if (current.length === 0) {
        current.push(feat);
        currentBottom = feat.bottom;
        continue;
      }
      const gap = feat.top - currentBottom;
      if (gap <= yGapTolerance) {
        current.push(feat);
        if (feat.bottom > currentBottom) currentBottom = feat.bottom;
      } else {
        regions.push(current);
        current = [feat];
        currentBottom = feat.bottom;
      }
    }
    if (current.length > 0) regions.push(current);
  }

  return regions;
}

// ═══════════════════════════════════════════════════════════════════
// Stage D — Union-Find merge by IoU / containment
// ═══════════════════════════════════════════════════════════════════

function candidateBbox(lines: readonly LineFeature[]): BboxLTWH {
  if (lines.length === 0) return [0, 0, 0, 0];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const l of lines) {
    if (l.left < minX) minX = l.left;
    if (l.top < minY) minY = l.top;
    if (l.right > maxX) maxX = l.right;
    if (l.bottom > maxY) maxY = l.bottom;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

interface MergeResult {
  components: LineFeature[][];
  edges: Array<{ a: number; b: number; signal: "iou" | "contained"; value: number }>;
}

function mergeOverlappingCandidates(
  candidates: readonly LineFeature[][],
): MergeResult {
  const bboxes = candidates.map(candidateBbox);
  const uf = new UnionFind(candidates.length);
  const edges: MergeResult["edges"] = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const iouVal = iou(bboxes[i], bboxes[j]);
      const contVal = maxContainment(bboxes[i], bboxes[j]);
      if (iouVal > UNION_FIND_IOU_THRESHOLD) {
        uf.union(i, j);
        edges.push({ a: i, b: j, signal: "iou", value: iouVal });
      } else if (contVal > UNION_FIND_CONTAIN_THRESHOLD) {
        uf.union(i, j);
        edges.push({ a: i, b: j, signal: "contained", value: contVal });
      }
    }
  }

  const merged: LineFeature[][] = [];
  for (const comp of uf.components()) {
    const lines: LineFeature[] = [];
    for (const candIdx of comp) lines.push(...candidates[candIdx]);
    merged.push(lines);
  }
  return { components: merged, edges };
}

// ═══════════════════════════════════════════════════════════════════
// Stage E — Per-region analysis
// ═══════════════════════════════════════════════════════════════════

interface RegionAnalysis {
  bbox: BboxLTWH;
  lines: LineFeature[];
  wordCount: number;
  numberedCount: number;
  numberedRatio: number;
  headerLines: LineFeature[];
  headerText?: string;
  columnCount: number;
  xBandLefts: number[];
  meanRightColLen: number;
  hasSpecSection: boolean;
  tiers: TierMatch;
}

function analyzeRegion(lines: readonly LineFeature[]): RegionAnalysis {
  const bbox = candidateBbox(lines);
  const wordCount = lines.reduce(
    (sum, l) => sum + (l.line.words?.length ?? 0),
    0,
  );

  const numberedCount = lines.filter((l) => RE_NUMBERED_ITEM.test(l.firstWord)).length;
  const numberedRatio = lines.length > 0 ? numberedCount / lines.length : 0;

  // Header detection: lines with height ≥ HEADER_FONT_RATIO × region median
  const medianH = median(lines.map((l) => l.height));
  const headerLines = lines.filter(
    (l) => l.height >= medianH * HEADER_FONT_RATIO,
  );
  const headerText = headerLines.length > 0 ? headerLines[0].line.text : undefined;

  // Column-band count via X-left clustering
  const xBands = clusterByTolerance(
    [...lines],
    (l) => l.left,
    CLUSTER_X_TOLERANCE,
  );
  const columnCount = xBands.length;
  const xBandLefts = xBands.map((band) => median(band.map((l) => l.left)));

  // Mean right-column string length (used for notes-key-value discrimination)
  let meanRightColLen = 0;
  if (columnCount >= 2) {
    const rightBand = xBands[xBands.length - 1];
    if (rightBand.length > 0) {
      meanRightColLen =
        rightBand.reduce((s, l) => s + l.line.text.length, 0) / rightBand.length;
    }
  }

  // Spec-section header marker anywhere in region
  const hasSpecSection = lines.some((l) => RE_SPEC_SECTION.test(l.upperText));

  // Tier keyword matching — prefer header if present, fall back to full text
  const textForTiers = headerText
    ? `${headerText}\n${lines
        .slice(0, 50)
        .map((l) => l.line.text)
        .join(" ")}`
    : lines
        .slice(0, 50)
        .map((l) => l.line.text)
        .join(" ");
  const tiers = matchTiers(textForTiers);

  return {
    bbox,
    lines: [...lines],
    wordCount,
    numberedCount,
    numberedRatio,
    headerLines,
    headerText,
    columnCount,
    xBandLefts,
    meanRightColLen,
    hasSpecSection,
    tiers,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Stage F — Classification decision tree
// ═══════════════════════════════════════════════════════════════════

interface ClassifyDecision {
  type: TextRegionType;
  confidence: number;
  decisionTrace: string[];
}

function classifyRegion(a: RegionAnalysis): ClassifyDecision {
  const trace: string[] = [];

  // Title-block drop — if region falls entirely inside the default title-block
  // zone and has no strong content, treat as unknown/paragraph to filter it.
  if (isInsideTitleBlock(a.bbox) && a.numberedCount === 0 && !a.headerText) {
    trace.push("In title-block zone with no structural content → paragraph");
    return { type: "paragraph", confidence: 0.2, decisionTrace: trace };
  }

  // Notes-numbered: enough lines are keyed by numbered items
  if (a.numberedRatio >= NUMBERED_RATIO_THRESHOLD && a.columnCount <= 2) {
    trace.push(
      `numberedRatio=${a.numberedRatio.toFixed(2)} ≥ ${NUMBERED_RATIO_THRESHOLD} and columnCount=${a.columnCount} ≤ 2 → notes-numbered`,
    );
    let conf = 0.6 + Math.min(a.numberedCount, 10) * 0.03;
    if (a.headerText) {
      conf += 0.1;
      trace.push(`header '${a.headerText}' → +0.10`);
    }
    return { type: "notes-numbered", confidence: Math.min(conf, 0.95), decisionTrace: trace };
  }

  // Schedule-table: multi-column tabular with a SCHEDULE keyword
  if (a.columnCount >= 3 && a.lines.length >= 3) {
    const tierHit = a.tiers.tier1 === "SCHEDULE" || a.tiers.tier2?.includes("SCHEDULE");
    trace.push(
      `columnCount=${a.columnCount} ≥ 3 and rowCount=${a.lines.length} ≥ 3`,
    );
    if (tierHit) {
      trace.push(`tier matches SCHEDULE → schedule-table`);
      return {
        type: "schedule-table",
        confidence: 0.75 + Math.min(a.columnCount, 10) * 0.02,
        decisionTrace: trace,
      };
    }
    // Multi-column tabular with no SCHEDULE tag is still a schedule-table
    // candidate, but lower confidence.
    trace.push(`no SCHEDULE tier hit → schedule-table (low confidence)`);
    return {
      type: "schedule-table",
      confidence: 0.55 + Math.min(a.columnCount, 10) * 0.01,
      decisionTrace: trace,
    };
  }

  // Notes-key-value: 2 columns, little-to-no numbering, short right column
  if (
    a.columnCount === 2 &&
    a.numberedCount === 0 &&
    a.meanRightColLen > 0 &&
    a.meanRightColLen < KV_RIGHT_COL_MAX_LEN
  ) {
    trace.push(
      `columnCount=2 and numberedCount=0 and meanRightColLen=${a.meanRightColLen.toFixed(1)} < ${KV_RIGHT_COL_MAX_LEN} → notes-key-value`,
    );
    return { type: "notes-key-value", confidence: 0.7, decisionTrace: trace };
  }

  // Spec-dense-columns: narrow width, multi-column, many words, section header marker
  const width = a.bbox[2];
  if (
    a.columnCount >= 2 &&
    width < SPEC_NARROW_MAX_WIDTH &&
    a.wordCount > SPEC_MIN_WORD_COUNT &&
    a.hasSpecSection
  ) {
    trace.push(
      `width=${width.toFixed(2)} < ${SPEC_NARROW_MAX_WIDTH}, wordCount=${a.wordCount} > ${SPEC_MIN_WORD_COUNT}, hasSpecSection → spec-dense-columns`,
    );
    return { type: "spec-dense-columns", confidence: 0.7, decisionTrace: trace };
  }

  // Paragraph: minimal structure but with enough words to be meaningful content
  if (a.wordCount >= CLASSIFIER_MIN_REGION_WORDS * 3 && !a.hasSpecSection) {
    trace.push(`wordCount=${a.wordCount} and no structural signal → paragraph`);
    return { type: "paragraph", confidence: 0.4, decisionTrace: trace };
  }

  // Fallback — low confidence, ambiguous
  trace.push(`no classification rule fired → unknown (low confidence)`);
  return { type: "unknown", confidence: 0.2, decisionTrace: trace };
}

function isInsideTitleBlock(bbox: BboxLTWH): boolean {
  const z = DEFAULT_TITLE_BLOCK_REGION;
  const left = bbox[0];
  const top = bbox[1];
  const right = bbox[0] + bbox[2];
  const bottom = bbox[1] + bbox[3];
  return left >= z.minX && right <= z.maxX && top >= z.minY && bottom <= z.maxY;
}

// ═══════════════════════════════════════════════════════════════════
// Grid binding for notes-numbered regions
// ═══════════════════════════════════════════════════════════════════

function bindNumberedGrid(
  lines: readonly LineFeature[],
): { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[] } | undefined {
  const rows: Record<string, string>[] = [];
  const rowBoundaries: number[] = [];
  let current: { key: string; parts: string[]; top: number } | undefined;

  const ysorted = [...lines].sort((a, b) => a.top - b.top);
  for (const line of ysorted) {
    const match = RE_NUMBERED_ITEM.exec(line.firstWord);
    if (match) {
      if (current) {
        rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
        rowBoundaries.push(current.top);
      }
      const key = match[1];
      const afterKey = line.line.text.replace(/^\s*\(?\d{1,3}\s*[.):]\s*/, "").trim();
      current = { key, parts: afterKey ? [afterKey] : [], top: line.top };
    } else if (current) {
      current.parts.push(line.line.text.trim());
    }
  }
  if (current) {
    rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
    rowBoundaries.push(current.top);
  }

  if (rows.length === 0) return undefined;
  return {
    headers: ["Key", "Note"],
    rows,
    rowBoundaries,
  };
}

// ═══════════════════════════════════════════════════════════════════
// CSI tag inference (ported from pre-rewrite classifier)
// ═══════════════════════════════════════════════════════════════════

function inferCsiTags(words: readonly TextractWord[], csiCodes: readonly CsiCode[]): CsiCode[] {
  if (!csiCodes.length) return [];

  const text = words.map((w) => w.text.toLowerCase()).join(" ");
  const matches: CsiCode[] = [];

  for (const csi of csiCodes) {
    const descWords = csi.description.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (descWords.length === 0) continue;
    const overlap = descWords.filter((w) => text.includes(w)).length;
    if (overlap >= Math.ceil(descWords.length * 0.4)) matches.push(csi);
  }

  const seen = new Set<string>();
  return matches.filter((c) => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════
// Stage C — Whitespace-rectangle discovery (optional, debug-only in v1)
// ═══════════════════════════════════════════════════════════════════

function discoverWhitespaceRects(
  lines: readonly LineFeature[],
): {
  rectangles: Array<{ bbox: BboxLTWH; kind: "gutter" | "paragraph-break"; area: number }>;
  maskResolution: [number, number];
} {
  const mask = rasterizeBboxes(
    lines.map((l) => ({ bbox: [l.left, l.top, l.right - l.left, l.bottom - l.top] as BboxLTWH })),
    CLASSIFIER_MASK_WIDTH,
    CLASSIFIER_MASK_HEIGHT,
  );
  const minAreaCells =
    WHITESPACE_RECT_MIN_AREA_FRACTION * CLASSIFIER_MASK_WIDTH * CLASSIFIER_MASK_HEIGHT;
  const rects: InscribedRect[] = topKInscribedRects(mask, CLASSIFIER_MASK_WIDTH, CLASSIFIER_MASK_HEIGHT, 5)
    .filter((r) => r.area >= minAreaCells);

  return {
    rectangles: rects.map((r) => {
      const normalized: BboxLTWH = [
        r.x / CLASSIFIER_MASK_WIDTH,
        r.y / CLASSIFIER_MASK_HEIGHT,
        r.w / CLASSIFIER_MASK_WIDTH,
        r.h / CLASSIFIER_MASK_HEIGHT,
      ];
      const ratio = r.h / Math.max(r.w, 1);
      return {
        bbox: normalized,
        kind: ratio >= WHITESPACE_RECT_GUTTER_RATIO ? "gutter" : "paragraph-break",
        area: r.area,
      };
    }),
    maskResolution: [CLASSIFIER_MASK_WIDTH, CLASSIFIER_MASK_HEIGHT],
  };
}

// ═══════════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════════

export interface ClassifyTextRegionsOptions {
  /** If true, populates a ClassifierDebugBundle via `onDebug`. */
  debug?: boolean;
  /** Called once per invocation when `debug: true`. */
  onDebug?: (bundle: ClassifierDebugBundle) => void;
  /** Optional page number for inclusion in debug bundle. */
  pageNumber?: number;
}

/**
 * Classify text regions on a page from Textract LINE + WORD data.
 * Signature preserved from the pre-rewrite classifier so call sites
 * (processing.ts:385, admin/reprocess/route.ts:431) are unchanged.
 */
export function classifyTextRegions(
  textractData: TextractPageData,
  csiCodes: CsiCode[],
  opts?: ClassifyTextRegionsOptions,
): TextRegion[] {
  const lines = textractData?.lines ?? [];
  if (lines.length === 0) return [];

  const features = buildLineFeatures(lines);
  if (features.length < CLASSIFIER_MIN_REGION_WORDS) return [];

  // ─── Stage A: LINE consumption ───────────────────────────
  const medianLineHeight = median(features.map((f) => f.height));
  const headerCandidates = features
    .filter((f) => f.height >= medianLineHeight * HEADER_FONT_RATIO)
    .map((f) => f.line.text);

  // ─── Stage B: Column-aware region proposal ───────────────
  const yGapTolerance = CLUSTER_Y_TOLERANCE_FACTOR * medianLineHeight * 8;
  const candidates = proposeCandidateRegions(features, yGapTolerance);
  const candidateBboxes = candidates.map(candidateBbox);

  // ─── Stage C: Optional whitespace-rectangle discovery ────
  let stageC: ClassifierDebugBundle["stages"]["C"];
  const totalWords = features.reduce((s, f) => s + (f.line.words?.length ?? 0), 0);
  if (opts?.debug && totalWords >= CLASSIFIER_WHITESPACE_SKIP_WORD_COUNT) {
    stageC = discoverWhitespaceRects(features);
  }

  // ─── Stage D: Union-Find merge ───────────────────────────
  const merge = mergeOverlappingCandidates(candidates);
  const mergedComponents = merge.components.filter(
    (c) => c.reduce((s, l) => s + (l.line.words?.length ?? 0), 0) >= CLASSIFIER_MIN_REGION_WORDS,
  );
  const componentBboxes = mergedComponents.map(candidateBbox);

  // ─── Stages E + F: Analyze + classify each merged region ─
  const analyses: RegionAnalysis[] = mergedComponents.map(analyzeRegion);
  const decisions = analyses.map(classifyRegion);

  const regions: TextRegion[] = [];
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    const d = decisions[i];

    // Drop low-confidence non-informational regions unless classifiable
    if (d.type === "unknown" && d.confidence < CLASSIFIER_MIN_CONFIDENCE) continue;

    const allWords: TextractWord[] = a.lines.flatMap((l) => l.line.words ?? []);
    const csiTags = inferCsiTags(allWords, csiCodes);
    const containedText = wordsToText(allWords);

    let grid: TextRegion["grid"];
    if (d.type === "notes-numbered") grid = bindNumberedGrid(a.lines);

    const classifiedLabels = {
      tier1: a.tiers.tier1,
      tier2: a.tiers.tier2,
      trade: a.tiers.trade,
    };
    const hasAnyLabel =
      classifiedLabels.tier1 || classifiedLabels.tier2 || classifiedLabels.trade;

    regions.push({
      id: `region-${i}`,
      type: d.type,
      bbox: a.bbox,
      confidence: d.confidence,
      csiTags: csiTags.length > 0 ? csiTags : undefined,
      wordCount: a.wordCount,
      lineCount: a.lines.length,
      columnCount: a.columnCount > 0 ? a.columnCount : undefined,
      rowCount: a.lines.length,
      hasNumberedItems: a.numberedCount >= 2 ? true : undefined,
      headerText: a.headerText,
      classifiedLabels: hasAnyLabel ? classifiedLabels : undefined,
      grid,
      containedText:
        containedText.length > 500 ? containedText.substring(0, 500) + "..." : containedText,
    });
  }

  // Sort by confidence descending for downstream display order
  regions.sort((a, b) => b.confidence - a.confidence);

  // ─── Emit debug bundle if requested ──────────────────────
  if (opts?.debug && opts.onDebug) {
    opts.onDebug({
      pageNumber: opts.pageNumber,
      stages: {
        A: {
          lineCount: features.length,
          medianHeight: medianLineHeight,
          headerCandidates,
        },
        B: { candidateBboxes },
        C: stageC,
        D: { edges: merge.edges, componentBboxes },
        E: analyses.map((a, i) => ({
          componentId: i,
          numberedRatio: a.numberedRatio,
          headerText: a.headerText,
          tier1: a.tiers.tier1,
          tier2: a.tiers.tier2,
          trade: a.tiers.trade,
          columnCount: a.columnCount,
        })),
        F: decisions.map((d, i) => ({
          componentId: i,
          type: d.type,
          confidence: d.confidence,
          decisionTrace: d.decisionTrace,
        })),
      },
      finalRegions: regions,
    });
  }

  // Silence "unused" warnings on the intersection/types exported for future stages
  void intersectionArea;

  return regions;
}
