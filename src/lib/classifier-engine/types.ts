/**
 * classifier-engine/types.ts — the contract shared by the engine, the proposals UI, the builder UI and the
 * weight fitter (plan: gitignore/projects/classifier_builder/PLAN.md).
 *
 * A RECIPE says where to look (candidates), where it may run (scope), what makes a candidate the target
 * (shared signals → p) and which kind it is (classes, each its own signals → nameP). Every signal yields a
 * value in [0, 1]; a head's logit is `bias + Σ weight × value` over its enabled "score" signals, so a fitted
 * logistic regression over the stored `features` is the same model as the hand weights.
 */

import type { BboxMinMax } from "@/types";
import type { ChannelKind } from "@/lib/pdf-channels/types";
import type { RegionV2Kind, RegionV2Signals } from "@/lib/region-classifier-v2/types";

/** Bump when scoring arithmetic or the stored shape changes (not when a recipe changes; recipes carry their own version). */
export const CLASSIFIER_ENGINE_VERSION = "clf/0.1";

export type ClassifierUnit = "region" | "page";

/** Where candidate boxes come from (unit "region"). A page-unit recipe has one candidate: the whole page. */
export type CandidateSource =
  /** Region classifier v2 L1 output: detector-first, title-block boxes dropped, deduped, widened. */
  | { type: "regions-v2"; kinds: RegionV2Kind[] }
  | { type: "yolo"; model?: string; classes: string[]; minConfidence?: number }
  /** Textract tables no other candidate covers (recall insurance). */
  | { type: "textract-tables"; minRows?: number }
  /** User-committed parsed regions (scored for labels; never re-proposed as new). */
  | { type: "parsed-regions" };

/**
 * Where a signal reads, relative to the candidate:
 *   box        every OCR word whose centre is inside the box
 *   header     the derived title line (top band of the box, or the line just above it)
 *   columns    the column-header rows (first rows under the title)
 *   body       box minus header and columns
 *   above      lines just above the box (titles that sit outside the detector box)
 *   page       the whole page
 *   titleBlock OCR inside the detected title block
 *   sheetTitle the sheet title parsed from the title block
 */
export type SignalScope = "box" | "header" | "columns" | "body" | "above" | "page" | "titleBlock" | "sheetTitle";

export type SignalSpec =
  /** value = 1 − exp(−Σ termWeight × sqrt(min(3, count)) / saturation). Terms are upper-case words or phrases. */
  | { type: "words"; where: SignalScope; terms: Record<string, number>; saturation?: number }
  /**
   * CSI codes from tagging the scope's own words. share = matching / all codes (0 below minCodes); count saturates at 3.
   * [2b additive] where "pageCodes" = every code in `pages.csiCodes` once (division = the code's first two digits,
   * trigger positions ignored; the legacy heuristic rules' `csiDivisionsRequired`); measure "presence" = 1 when any matches.
   */
  | { type: "csi"; where: "box" | "page" | "pageCodes"; divisions?: string[]; sectionPrefixes?: string[]; measure: "share" | "count" | "presence"; minCodes?: number }
  /** Sheet discipline from the sheet-number prefix (A, M, E, P, S, C, L, FP, FA, T, …) and/or a sheet-number regex. 0/1. */
  | { type: "sheet"; disciplines?: string[]; numberPattern?: string }
  /**
   * [2b additive] `classes` may hold "*" (any class). `noDetections`: the value when YOLO did not run on the page
   * (`ClassifierPageInput.yoloAvailable` false) — a "required" gate with 1 passes on text-only runs (legacy
   * yoloAvailabilityMode degrade / ignore). Default: evaluated normally (no detections → 0).
   */
  | { type: "yolo"; where: "inside" | "overlap" | "page" | "near"; classes: string[]; model?: string; minConfidence?: number; measure: "presence" | "count" | "maxConfidence" | "cover"; noDetections?: number }
  /** [2b additive] Whole-word, case-insensitive match on the page's raw OCR text (legacy heuristic keywords). 0/1. */
  | { type: "text"; terms: string[]; mode: "any" | "all" }
  /** [2b additive] The page carries an OCR text region of one of these types (`pageIntelligence.textRegions`, legacy types migrated). 0/1. */
  | { type: "text-region"; regionTypes: string[] }
  /**
   * [2b additive] A legacy heuristic spatial condition between two YOLO classes on the page (classB "*" = any other
   * class): contains = some A holds ≥ minInstances B centres; overlaps = a B covers > 30% of an A; near = centres within
   * maxDistance (default .1); aligned = ≥ minInstances B centres inside one A share an x (vertical) / y (horizontal)
   * centre within .03 of their mean. 0/1.
   */
  | { type: "yolo-spatial"; operator: "contains" | "overlaps" | "near" | "aligned"; classA: string; classB: string; minInstances?: number; axis?: "horizontal" | "vertical" | "any"; maxDistance?: number }
  /** A region-v2 structure signal (or its structureScore), mapped to 0/1 by min/max, or scaled by `scale`. */
  | { type: "structure"; feature: keyof RegionV2Signals | "structureScore"; min?: number; max?: number; scale?: number }
  /** [shape-tags additive] `minRows`: the coinciding Textract table must have at least this many rows (default 0). */
  | { type: "textract-table"; minContainment?: number; minRows?: number }
  /** Shape-parse / yolo_primitive shapes inside the box (count saturates at `min`). */
  | { type: "shapes"; shapes: string[]; where: "inside" | "leftColumn"; min?: number }
  /**
   * [shape-tags 2026-10-25] A vertical COLUMN of tag shapes in the left `leftShare` of the box (default .25): ≥ `minShapes`
   * (default 3) yolo_primitive / classical shapes whose x-centres lie within .5 × their median width (shape-column.ts).
   * count → min(1, n / 8); regular → 1 when the gap CV ≤ `maxGapCv` (default .5); textInside / textRight → the share of
   * column shapes with an OCR word inside / to the right on the row band (centre ± .5 × height). Measured: a legend
   * signal (legend vs notes AUC .67–.74), NOT a schedule signal (AUC .46) — keep its schedule-detect weight ≤ 0.
   */
  | { type: "shape-column"; source: "yolo" | "classical" | "any"; measure: "count" | "regular" | "textInside" | "textRight"; leftShare?: number; minShapes?: number; maxGapCv?: number }
  /**
   * [shape-tags 2026-10-25] The OCR words inside the box as a grid (region v2's cluster rules on word boxes: rows = y-centre
   * clusters with gap > .6 × median height holding ≥ 2 words; cols = left-edge clusters with gap > .5 × h holding ≥ 3; < 6
   * words → 0). rows → min(1, rows / scale (default 8)); cols → / 4; grid → rows × cols / 24; regularity → 1 − CV of the row
   * pitch (0 below 3 rows). Measured: rows × cols AUC .67 (schedule vs not) / .76 (table-ness); rows AUC .91 legend vs title block.
   */
  | { type: "ocr-grid"; measure: "rows" | "cols" | "grid" | "regularity"; scale?: number }
  | { type: "zone"; zone: "titleBlock" | "drawing" | "margin"; minContainment?: number }
  /** Page kind from the PDF channel census. 0/1. */
  | { type: "channel"; pageKinds: ChannelKind[] };

export type SignalRole =
  /** contributes weight × value to the head's logit */
  | "score"
  /** value must be > 0, else the head is rejected (class skipped / candidate dropped) */
  | "required"
  /** value > 0 rejects the head */
  | "veto";

export interface WeightedSignal {
  /** Stable within its recipe; the key in `features` and in fitted overlays. */
  id: string;
  /** Human text for the UI and for contributions ("Div 08 share of CSI codes"). */
  label: string;
  spec: SignalSpec;
  weight: number;
  role: SignalRole;
  enabled: boolean;
  note?: string;
}

export interface ClassifierScope {
  /** Sheet disciplines allowed / excluded (sheet-number prefix). */
  disciplines?: string[];
  excludeDisciplines?: string[];
  sheetNumberPattern?: string;
  pageKinds?: ChannelKind[];
  /** Drop candidates ≥ this containment inside the detected title block (region v2 uses .7). */
  excludeTitleBlock?: boolean;
  minWords?: number;
  maxWords?: number;
}

export interface ClassifierClass {
  /** Stable kind id, e.g. "door", "hvac-air-handling" (PLAN.md vocabulary). */
  id: string;
  name: string;
  /** UI grouping, e.g. "arch", "hvac", "elec". */
  group: string;
  /** Legacy ClassifiedTable category for the bridge, when one applies ("door-schedule"). */
  legacyCategory?: string;
  bias: number;
  signals: WeightedSignal[];
  /** Overrides the recipe's nameThreshold for this class. */
  threshold?: number;
}

export interface ClassifierRecipe {
  id: string;
  name: string;
  /** Bumped on every saved edit; stored on proposals and verdicts. */
  version: number;
  enabled: boolean;
  source: "built-in" | "custom";
  unit: ClassifierUnit;
  /** What the detect head finds: "schedule", "legend", "notes", or a page flag ("has-door-schedule"). */
  target: string;
  candidates: CandidateSource[];
  scope: ClassifierScope;
  /** Detect head: p(candidate is the target). */
  detect: { bias: number; signals: WeightedSignal[]; threshold: number };
  /**
   * [shape-tags additive] Table-ness head: p(the candidate is a TABLE of any kind — schedule, legend, keynote list),
   * evaluated on every proposal the detect head keeps and stored as `tableP` / `tableWhy` (features "table.<id>").
   * Separate from the kind on purpose: a legend with tableP .9 stays a legend. Absent → no `tableP`.
   */
  tableHead?: { bias: number; signals: WeightedSignal[] };
  /** Naming head (may be empty for a binary recipe). */
  classes: ClassifierClass[];
  nameThreshold: number;
  /** Winner's nameP minus the runner-up's must be ≥ this, else fallback. */
  minMargin: number;
  /** Derive the printed title (header / above) and use it as displayName when the class falls back. */
  deriveName: boolean;
  fallbackClassName: string;
  note?: string;
  /** [2b additive] A page-unit recipe ported from the legacy heuristic engine: how its proposal maps back to a HeuristicInference. */
  heuristic?: HeuristicRecipeOutput;
}

/**
 * [2b additive] Legacy heuristic output of a ported page recipe (src/lib/heuristic-port). The detect head carries the
 * old additive ladder as weights with bias −minConfidence (detect threshold .5 ⇔ score ≥ minConfidence); the
 * adapter reports `confidence` = Σ weight × value over the score signals (×0.6 on a text-only run in "degrade" mode).
 */
export interface HeuristicRecipeOutput {
  /** (The rule's `outputLabel` is the recipe's `target`.) */
  minConfidence: number;
  outputCsiCode?: string;
  yoloAvailabilityMode: "require" | "degrade" | "ignore";
  /** The inference's bbox = the first detection of this class (the rule's first yoloRequired class). */
  bboxClass?: string;
}

/**
 * One signal's patch. Keyed in `RecipePatch.signals` by the FEATURE key ("detect.<id>" / "<classId>.<id>",
 * the same key `features` and fitted overlays use) or, legacy, by the bare signal id (then it applies to
 * every head that has a signal of that id).
 * [track 3 builder, additive] `spec` and `note` let the builder edit a built-in signal's parameters
 * (term weights, divisions, classes) in place, keeping its id, so stored features stay comparable.
 */
export type SignalPatch = Partial<Pick<WeightedSignal, "weight" | "role" | "enabled" | "label" | "note" | "spec">>;

export interface RecipePatch {
  version: number;
  enabled?: boolean;
  detectThreshold?: number;
  nameThreshold?: number;
  minMargin?: number;
  signals?: Record<string, SignalPatch>;
  classBias?: Record<string, number>;
  addedSignals?: Array<{ classId: string | null; signal: WeightedSignal }>;
  addedClasses?: ClassifierClass[];
  /**
   * Disabled in this company: "detect.<sid>" / "<classId>.<sid>" (one signal), "class:<classId>" (one class),
   * or a bare id (legacy: every signal of that id and the class of that id).
   */
  removed?: string[];
  // ── additive (track 3 builder): optional, absent on older overlays ──
  /** Detect head bias override. */
  detectBias?: number;
  /** [shape-tags additive] Table-ness head bias override (its signals patch under "table.<id>"). */
  tableBias?: number;
  /**
   * [shape-tags fix round, additive] The built-in's version this patch was saved against (stamped by the builder's
   * save). A patch whose base is older than the built-in (or that has none) was fitted on other head weights, so
   * recipes.ts leaves the built-in's detect / table head numbers in place; class edits still apply.
   */
  baseVersion?: number;
  /** classId → per-class nameP threshold override. */
  classThreshold?: Record<string, number>;
  /** Whole-value overrides of the built-in's scope / candidate sources. */
  scope?: ClassifierScope;
  candidates?: CandidateSource[];
  /** [track 3 fix round] Display name override of the built-in recipe. */
  name?: string;
  /** [track 3 fix round] classId → display edits of a built-in class (name / group / legacy bridge category; null clears it). */
  classMeta?: Record<string, ClassMetaPatch>;
}

export interface ClassMetaPatch {
  name?: string;
  group?: string;
  legacyCategory?: string | null;
}

/** Per-company edits on top of the built-ins: whole custom recipes plus sparse patches of built-ins. */
export interface ClassifierOverlay {
  custom: ClassifierRecipe[];
  /** recipeId → patch. */
  patches: Record<string, RecipePatch>;
  updatedAt?: string;
  updatedBy?: number;
}

export interface SignalContribution {
  /** "detect.<id>" or "<classId>.<id>". */
  signalId: string;
  label: string;
  value: number;
  weight: number;
  /** weight × value (0 for required/veto). */
  delta: number;
  /** Short evidence text ("82% of 11 codes are Div 08"). */
  detail?: string;
}

export interface DerivedName {
  text: string;
  /** 0–1: title-like line (has SCHEDULE/LEGEND/…, is the largest/topmost line, cleaned of scale/number noise). */
  confidence: number;
  source: "header" | "above";
}

export interface ClassifierProposal {
  /** `${recipeId}:p${pageNumber}:${anchor bbox key}` — stable across reruns of the same candidate. */
  id: string;
  recipeId: string;
  recipeVersion: number;
  engineVersion: string;
  pageNumber: number;
  /** Normalized MinMax. Page-unit proposals use [0, 0, 1, 1]. */
  bbox: BboxMinMax;
  target: string;
  /** Detect head probability. */
  p: number;
  /** Winning class id, or null when it fell back. */
  classId: string | null;
  className: string;
  group: string | null;
  nameP: number;
  margin: number;
  runnerUp?: { classId: string; nameP: number };
  derivedName?: DerivedName;
  /** What the UI shows: className, or the derived name when the class fell back. */
  displayName: string;
  /** Top contributions, |delta| descending (≤ 8 each). */
  detectWhy: SignalContribution[];
  nameWhy: SignalContribution[];
  /** Every evaluated signal value, keyed "detect.<id>" / "<classId>.<id>", for refits. */
  features: Record<string, number>;
  // ── additive (2a engine): optional, absent on older records ──
  /** Which candidate source produced the box ("parsed-regions" = a committed region scored for labels, never new). */
  source?: CandidateSource["type"];
  /** The region v2 id when the candidate came from regions-v2 (joins labels and the legacy className). */
  regionId?: string;
  /** The winning class's legacy ClassifiedTable category, when it declares one. */
  legacyCategory?: string;
  // ── additive (shape-tags 2026-10-25): optional, absent on older records ──
  /** Table-ness head probability (recipe `tableHead`), independent of the kind. */
  tableP?: number;
  tableWhy?: SignalContribution[];
  /** The shape-tag column found in the box, with one row per tag shape (≤ TAG_MAP_ROW_CAP). */
  tagMap?: ProposalTagMap;
  /** `pages.drawingNumber` and its discipline prefix, so a tag row reads "tag · row · table · sheet · trade". */
  sheetNumber?: string;
  discipline?: string;
}

/** [shape-tags] One tag shape of a column and the row it anchors. */
export interface ProposalTagRow {
  /** The tag text: the OCR word(s) inside the shape, else the classical crop read; null when neither exists (listed, not mapped). */
  tag: string | null;
  shapeClass: string;
  shapeBbox: BboxMinMax;
  /** The row band: the box's width, the shape's centre ± half its height (continuation lines without a shape fold in). */
  rowBbox: BboxMinMax;
  /** OCR words to the right of the column inside the band, joined. */
  rowText: string;
}

/** [shape-tags] `ClassifierProposal.tagMap`: the column the engine found and its rows. */
export interface ProposalTagMap {
  column: {
    source: "yolo" | "classical";
    /** Majority yolo_primitive / classical class of the column ("hexagon"); the map-tags class to search for. */
    shapeClass: string;
    n: number;
    /** Coefficient of variation of the vertical gaps (0 = perfectly regular; null below 3 gaps). */
    gapCv: number | null;
    /** Share of column shapes with an OCR word inside. */
    textInside: number;
  };
  rows: ProposalTagRow[];
  /** True when more than TAG_MAP_ROW_CAP shapes were found and `rows` is the first cap by y. */
  truncated: boolean;
}

export const TAG_MAP_ROW_CAP = 60;
/** Tags carried on a `ProposalSummaryItem` (the panel's chips); the full rows live on the page record. */
export const SUMMARY_TAGS_CAP = 8;

/** `pageIntelligence.classifierProposals` (computed; refreshed by reprocess; server-owned). */
export interface PageClassifierProposals {
  engineVersion: string;
  /** recipeId → recipe version used. */
  recipes: Record<string, number>;
  proposals: ClassifierProposal[];
}

export type VerdictKind = "accept" | "reject" | "rename";

/** One user label. `pageIntelligence.proposalVerdicts[proposalId]` — user-owned, never touched by reprocess. */
export interface ProposalVerdict {
  proposalId: string;
  recipeId: string;
  recipeVersion: number;
  verdict: VerdictKind;
  /** rename (and optionally accept): the corrected class id, or a free name for "other-schedule". */
  classId?: string;
  name?: string;
  /** Snapshot of the proposal's features and classId at label time, so refits survive recomputation. */
  features: Record<string, number>;
  proposedClassId: string | null;
  userId: number;
  at: string;
  /** [TP-2 WP-2.F, K58] "parse": an accept posted by the SAVE of a parse started from this proposal (stored classId). */
  via?: "parse";
  /** With via "parse": the saved ParsedRegion the parse produced (server-checked against the proposal's box). */
  regionId?: string;
}

export type PageProposalVerdicts = Record<string, ProposalVerdict>;

export interface ProposalSummaryItem {
  id: string;
  recipeId: string;
  pageNumber: number;
  bbox: BboxMinMax;
  target: string;
  classId: string | null;
  className: string;
  group: string | null;
  displayName: string;
  p: number;
  nameP: number;
  verdict?: VerdictKind;
  // ── additive (shape-tags 2026-10-25) ──
  /** Table-ness probability when the recipe has a table head. */
  tableP?: number;
  /** Number of tag rows in the proposal's `tagMap` (absent when no column was found). */
  tagRows?: number;
  /** The first SUMMARY_TAGS_CAP non-null tags of the column (chips in the panel). */
  tags?: string[];
  /** [fix round] Rows whose tag could be read (`tags` is the first SUMMARY_TAGS_CAP of these); absent on older summaries. */
  tagCount?: number;
  /** The column's majority shape class (the Map Tags yolo_primitive class to search for). */
  tagShape?: string;
}

/** `projectIntelligence.proposals` — compact list for the panel. */
export interface ProjectProposalSummary {
  engineVersion: string;
  generatedAt: string;
  total: number;
  truncated: boolean;
  items: ProposalSummaryItem[];
}

export const PROJECT_PROPOSALS_CAP = 1000;
