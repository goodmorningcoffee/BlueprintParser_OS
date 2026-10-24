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
  /** CSI codes from tagging the scope's own words. share = matching / all codes (0 below minCodes); count saturates at 3. */
  | { type: "csi"; where: "box" | "page"; divisions?: string[]; sectionPrefixes?: string[]; measure: "share" | "count"; minCodes?: number }
  /** Sheet discipline from the sheet-number prefix (A, M, E, P, S, C, L, FP, FA, T, …) and/or a sheet-number regex. 0/1. */
  | { type: "sheet"; disciplines?: string[]; numberPattern?: string }
  | { type: "yolo"; where: "inside" | "overlap" | "page" | "near"; classes: string[]; model?: string; minConfidence?: number; measure: "presence" | "count" | "maxConfidence" | "cover" }
  /** A region-v2 structure signal (or its structureScore), mapped to 0/1 by min/max, or scaled by `scale`. */
  | { type: "structure"; feature: keyof RegionV2Signals | "structureScore"; min?: number; max?: number; scale?: number }
  | { type: "textract-table"; minContainment?: number }
  /** Shape-parse / yolo_primitive shapes inside the box (count saturates at `min`). */
  | { type: "shapes"; shapes: string[]; where: "inside" | "leftColumn"; min?: number }
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
  /** Naming head (may be empty for a binary recipe). */
  classes: ClassifierClass[];
  nameThreshold: number;
  /** Winner's nameP minus the runner-up's must be ≥ this, else fallback. */
  minMargin: number;
  /** Derive the printed title (header / above) and use it as displayName when the class falls back. */
  deriveName: boolean;
  fallbackClassName: string;
  note?: string;
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
}

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
