/**
 * Parse-engine contract (table pipeline PLAN §2.1; WP-2.E). Pure types plus a few constants.
 *
 * Owned by WP-2.E and frozen in shape for TP-3's parallel work packages (PLAN §1.6 rule 13): later
 * WPs add SIBLING type files (`types-rows.ts`, `types-paragraphs.ts`, …) and never edit this file in
 * parallel. Runtime validation of these shapes (zod, caps) lives in `./schema.ts`, because this module
 * is client-safe and imports nothing (E-8, `__tests__/client-safe-imports.test.ts`).
 *
 * Every engine bbox is a normalised MinMax `[x0, y0, x1, y1]` (E-4); legacy LTWH is converted at the
 * loader edge (`server/services/parse-engine/evidence.ts`).
 */

export const PARSE_ENGINE_VERSION = "pe/1.0.0";
export type BboxMinMax = [number, number, number, number]; // normalised, ALWAYS MinMax
export type StructureKind = "schedule" | "keynote" | "legend" | "notes" | "spec";
export type Budget = "instant" | "standard" | "thorough";
export type MethodId =
  | "ocr-lines" | "shape-centres" | "textract-cells" | "layout" | "primitive-grid"
  | "hanging-indent" | "x-starts" | "rulings" | "img2table" | "tatr";
export type Capability =
  | "evidence" | "rows" | "cols" | "cells" | "headers" | "tagColumn" | "title" | "kind"
  | "csi" | "paragraphs" | "refs" | "tagMap"; // versions live in version.ts

/** Every method id, in the §1.4 table order (runtime list for validation and stamps). */
export const METHOD_IDS: readonly MethodId[] = [
  "ocr-lines", "shape-centres", "textract-cells", "layout", "primitive-grid",
  "hanging-indent", "x-starts", "rulings", "img2table", "tatr",
];
export const STRUCTURE_KINDS: readonly StructureKind[] = ["schedule", "keynote", "legend", "notes", "spec"];

/**
 * Stored-model caps (§2.1). zod enforces them on parse and commit (`./schema.ts`); the engine stores a
 * model over a cap truncated, with the quality flag `truncated`.
 */
export const PARSE_ENGINE_CAPS = {
  rows: 500,
  cols: 40,
  cells: 12_000,
  cellText: 2_000,
  paragraphs: 1_000,
  paragraphText: 8_000,
  parts: 4,
  ops: 2_000,
  /** R12: each alternative's geometry is capped at this many row lines. */
  alternativeRows: 500,
} as const;

/** Thrown by the WP-2.E stubs (`engine.ts`, `ops.ts`) until WP-3.D fills them. */
export class ParseEngineNotImplementedError extends Error {
  readonly code = "NOT_IMPLEMENTED" as const;
  constructor(what: string) {
    super(`parse engine: ${what} is not implemented yet (lands in WP-3.D)`);
    this.name = "ParseEngineNotImplementedError";
  }
}

// ── page-evidence contract (built server-side, once per page). Named Engine* because
//    classifier-engine/evidence.ts already exports PageEvidence/EvWord with other shapes (C1-D13).
/** Same values as `pdf-channels/types.ts` ChannelKind (repeated: this module imports nothing, E-8). */
export type EngineChannelKind = "vector" | "text-only" | "scanned" | "mixed" | "blank";
export interface EngineWord { t: string; b: BboxMinMax; conf: number; lineId: number }
/** Compact Textract LAYOUT block kinds as stored in `textract_data.layout` (no text). */
export type LayoutKind = "list" | "text" | "section-header" | "title" | "table";
export interface EngineLayoutBlock { k: LayoutKind; b: BboxMinMax }
export interface EngineTextractCell { r: number; c: number; rs: number; cs: number; b: BboxMinMax; hdr?: true }
export interface EngineShape {
  b: BboxMinMax; cls: string; src: "yolo" | "classical";
  text: string | null; textSrc: "inside" | "crop" | null;
}
export interface EngineProposalTagRow { tag: string | null; shapeClass: string; shapeBbox: BboxMinMax; rowBbox: BboxMinMax }
export interface EngineProposal {
  id: string; b: BboxMinMax; classId: string | null; p: number; tableP?: number;   // classId null = class fell back
  tagMap?: { rows: EngineProposalTagRow[] };
}
export interface EnginePageEvidence {
  v: 1; page: number;
  sheet: { raw: string | null; key: string | null };                 // drawing_number → sheetKey() (K67)
  channelKind: EngineChannelKind | null;                             // `pageIntelligence.channels.kind` (census)
  words: EngineWord[]; lines: { text: string; b: BboxMinMax; wordIdx: number[] }[];
  layout?: EngineLayoutBlock[];                                       // compact, when stored
  textractTables: { b: BboxMinMax; cells: EngineTextractCell[] }[];
  shapes: EngineShape[];
  primitives: { b: BboxMinMax; cls: "grid" | "horizontal_area" | "vertical_area" }[];
  detections: { b: BboxMinMax; model: string; cls: string; conf: number }[];
  zones?: unknown;
  proposals: EngineProposal[];
  evidenceHash: string;                                               // sha1 over the region-relevant slices
}

/** Which evidence exists for a box (ParseResult.evidence, ParseLabel.evidence; shape from ARCH C §3.2). */
export interface EvidenceAvailability {
  words: number; lines: number;
  textractTable?: { containment: number; cells: number; spans: boolean; cached: "page" | "crop" | null };
  shapeColumn?: { source: "yolo" | "classical"; shapeClass: string; n: number; gapCv: number | null };
  ocrGrid?: { rows: number; cols: number; regularity: number };
  primitiveCover?: { grid: number; vArea: number; hArea: number };
  rulings?: { h: number; v: number };
  layout?: { list: number; text: number; header: number };
  paidCropAvailable: boolean;
}

// ── request / hypotheses / result ───────────────────────────────────────────────────────────────
export interface ParseRequest {
  page: number; bbox: BboxMinMax; kind?: StructureKind;             // absent → kind heads on the box
  parts?: BboxMinMax[];                                               // continuation boxes, same page (R11, C3-M3)
  budget: Budget;
  hints?: {
    proposalId?: string; headerRows?: number; tagCol?: number; expectedCols?: number;
    tatr?: boolean; allowPaidTextract?: boolean;
  };
  prior?: StructureModel;                                             // for id re-matching on re-parse
}
export interface Hypothesis {                                         // geometry only (E-1)
  method: MethodId; methodVersion: number; conf: number;
  rowLines?: number[]; colLines?: number[]; headerRows?: number;
  cells?: { r: number; c: number; rs: number; cs: number; b: BboxMinMax; header?: true }[];
  rowAnchors?: { y: number; key: RowKey }[]; error?: string; ms?: number;
}
export interface ParseAlternative {
  method: MethodId; rows: number; cols: number; agreement: number; conf: number;
  geometry: { rowLines: number[]; colLines: number[] };               // client pin-source preview
}
export interface ParseResult {
  model: StructureModel;
  alternatives: ParseAlternative[];
  evidence: EvidenceAvailability;
  kindSuggestion?: { kind: StructureKind; classId: string | null; p: number; title?: string };
  words: { t: string; b: BboxMinMax }[];                              // region words → client applyOps preview
  stamp: EngineStamp;
}

// ── the cell model (tables, keynotes, legends) ──────────────────────────────────────────────────
export type RowKey =
  | { kind: "text"; text: string }
  | { kind: "shape-text"; text: string | null; shapeClass: string; shapeBbox: BboxMinMax; textSource: "inside" | "crop" | "user" }
  | { kind: "symbol"; shapeBbox: BboxMinMax; yoloClass?: string };   // legend row keyed by a graphic
export type ColRole = "tag" | "qty" | "description" | "type" | "size" | "material" | "remarks" | "sheet" | "other";
export const COL_ROLES: readonly ColRole[] = ["tag", "qty", "description", "type", "size", "material", "remarks", "sheet", "other"];
export type RowRole = "header" | "body" | "section" | "footer";
export interface StructureRow { id: string /* "r7" */; y0: number; y1: number; part?: number; role: RowRole; key?: RowKey; csi?: CsiRef[] }
export interface StructureCol { id: string /* "c3" */; x0: number; x1: number; label: string; labelRaw: string; group?: string; role?: ColRole }
export interface StructureCell {
  row: string; col: string; rs?: number; cs?: number;
  text: string; /* lines joined "\n" */
  b?: BboxMinMax; src: MethodId | "edit"; conf?: number; csi?: CsiRef[];
}
export interface StructureTitle { text: string; src: "header-band" | "above" | "proposal" | "user"; conf: number }
export interface StructureQuality { conf: number; agreement: number; flags: string[] }
export interface StructureTableModel {
  v: 1; kind: "schedule" | "keynote" | "legend"; bbox: BboxMinMax; parts?: BboxMinMax[];
  title?: StructureTitle;
  classId?: string;
  rows: StructureRow[]; cols: StructureCol[]; cells: StructureCell[]; headerRows: number;
  tag?: { col: string; src: "shape" | "header" | "body" | "user"; shapeClass?: string; pattern?: string; scope: "sheet" | "project" };
  notes?: StructureParagraphDoc;                                      // the schedule's own NOTES block (footnotes, C2-M3d)
  sources: { rows: MethodId[]; cols: MethodId[] };
  quality: StructureQuality;
  opsBase?: TableOpsBase;                                             // set by applyOps (see TableOpsBase)
}
/**
 * The band ids of the MACHINE model a correction list was applied to. `applyOps` sets it when the ops changed a band
 * (and keeps an existing one); a re-parse with this model as `prior` re-matches ids against it, never against the
 * corrected bands, so a replayed `add-line` / `split-paragraph` mints the same id again (WP-3.D verify HIGH-1).
 */
export interface TableOpsBase { rows: { id: string; y0: number; y1: number; part?: number }[]; cols: { id: string; x0: number; x1: number }[] }
export interface ParagraphOpsBase { blocks: { id: string; b: BboxMinMax }[]; paragraphs: { id: string; b: BboxMinMax }[] }
export interface CsiRef { code: string; description: string; conf?: number; src: "engine" | "company" | "user" }

// ── the paragraph model (notes, specs, text keynote lists): planset › sheet# › paragraph# ─────────
export interface ParagraphBlock { id: string /* "b1" */; header: string | null; headerNorm: string | null; b: BboxMinMax; continued?: true }
export interface Paragraph {
  id: string /* "p12" */; blockId: string;
  key: string | null;            // as printed: "4", "2.3", "A", "K-01", "1.01"; null = unnumbered lead-in (K35)
  keyPath: string[];             // spec "1.01 › A › 1" → ["1.01","A","1"]; notes "4" → ["4"]
  keyNorm: string;               // "K01", "2.3"; "" when key is null
  depth: number; text: string; b: BboxMinMax; lineCount: number;
  csi?: CsiRef[];
}
export interface StructureParagraphDoc {
  v: 1; kind: "notes" | "spec"; bbox: BboxMinMax; title?: StructureTitle;
  spec?: { section?: string /* "08 71 00" */ };
  blocks: ParagraphBlock[]; paragraphs: Paragraph[];
  sources: { segment: MethodId[] }; quality: StructureQuality;
  opsBase?: ParagraphOpsBase;                                         // set by applyOps (see TableOpsBase)
}
export type StructureModel = StructureTableModel | StructureParagraphDoc;
// Address. NOT stored anywhere: computed at read time from the page's CURRENT drawing number (C2-M8).
export interface ParagraphAddress {
  planset: string; sheet: string /* sheetKey ?? "p<page>" */; page: number; regionId: string;
  blockHeader: string | null; keyPath: string[]; targetId: string;
}
// display "A-501 › ELECTRICAL NOTES › 3"; machine "para:A-501/ELECTRICAL NOTES/3"; spec "08 71 00 › 2.3.A"

// ── corrections (pure, id-keyed, applied after fusion: E-2) ─────────────────────────────────────
export type Axis = "rows" | "cols";
export type CorrectionOp =
  | { op: "pin-source"; axis: Axis; method: MethodId | null }
  | { op: "set-lines"; axis: Axis; at: number[] }                                // classic Guided import, replay
  | { op: "move-line"; axis: Axis; after: string; at: number }
  | { op: "add-line"; axis: Axis; at: number }
  | { op: "remove-line"; axis: Axis; after: string }
  | { op: "user-boxes"; rows: BboxMinMax[]; cols: BboxMinMax[] }
  | { op: "set-header-rows"; n: number }
  | { op: "set-tag-col"; col: string | null }
  | { op: "set-tag-scope"; scope: "sheet" | "project" }
  | { op: "set-col-role"; col: string; role: ColRole | null }                    // QTY drives expectedQty / Auto-QTO (C3-m3)
  | { op: "rename-col"; col: string; label: string }
  | { op: "edit-cell"; row: string; col: string; text: string }
  | { op: "merge-cells"; row: string; col: string; rs: number; cs: number }
  | { op: "set-row-key"; row: string; text: string }
  | { op: "split-paragraph"; p: string; atLine: number }
  | { op: "merge-paragraph"; p: string }
  | { op: "set-paragraph-key"; p: string; key: string | null }
  | { op: "mark-block-header"; lineIndex: number }
  | { op: "set-csi"; target: { row?: string; p?: string }; codes: CsiRef[] }
  | { op: "set-title"; text: string }
  | { op: "set-kind"; kind: StructureKind; classId?: string };
export type CorrectionOpName = CorrectionOp["op"];
// applyOps(base: ParseResult, ops: CorrectionOp[]): StructureModel — pure; a stub in ./ops.ts until WP-3.D.

// ── provenance, versioning, replay ─────────────────────────────────────────────────────────────
export interface EngineStamp {
  engine: string; caps: Partial<Record<Capability, number>>;
  methods: { id: MethodId; v: number; conf: number; used: boolean; error?: string; cached?: true }[];
  budget: Budget; evidenceHash: string; paramsHash: string; at: string;
}
export interface ParseRecipe { request: ParseRequest; origin: "proposal" | "draw" | "text-region" | "saved" | "classic" }
export interface RegionLinks {
  origin: "workspace" | "classic-engine"; revision: number;
  viewHash: string;
  proposalId?: string; textRegionKey?: string; continues?: string /* regionId on another sheet (K11, C2-M10) */;
  acceptedAt: string; acceptedBy?: number;
}
export interface RegionDataExt { structure?: StructureModel; links?: RegionLinks; engine?: EngineStamp; recipe?: ParseRecipe; ops?: CorrectionOp[] }

// ── labels ──────────────────────────────────────────────────────────────────────────────────────
export interface StructureSnapshot {
  kind: StructureKind; rowY: number[]; colX: number[]; headerRows: number; tagCol?: number;
  cellHash: string[]; paragraphs?: { key: string | null; y0: number; y1: number }[];
}
export interface ParseLabel {
  v: 1; regionId: string; kind: StructureKind; source: "verdict-bar" | "workspace" | "classic-save";
  verdict: "correct" | "wrong" | "corrected" | "committed";   // "corrected" is server-inferred (C3-m4)
  by?: number; at: string; engine?: EngineStamp; snapshotHash: string;
  machine?: StructureSnapshot;   // RECOMPUTED server-side
  accepted?: StructureSnapshot; ops?: { op: CorrectionOpName; n: number }[];
  proposalId?: string; kindMachine?: string; classIdMachine?: string | null; classIdAccepted?: string;
  evidence?: EvidenceAvailability; secondsToAccept?: number; missedDetection?: true;
}
export interface TextRegionVerdict { verdict: "reject" | "accept"; type: string; b: BboxMinMax; at: string; by?: number }
// key = `tr:${type}:${q2(bbox)}`; read side matches by IoU ≥ .7 (K30). Legacy rejectedTextRegionIds are honoured
// only when the stored TextRegion with that id still has IoU ≥ .7 with the bbox recorded at reject time (C2-M12).

// ── tags ────────────────────────────────────────────────────────────────────────────────────────
export interface TagMapV1 {                                           // PJ.tagMaps[regionId] (TP-4)
  v: 1; regionId: string; regionRev: number; page: number; scope: "sheet" | "project";
  column: { col: string; src: "shape" | "header" | "body" | "user"; shapeClass?: string };
  run: { at: string; by?: number; strictness: "strict" | "balanced" | "lenient"; pages: number[] | "all"; sheetPrefixes?: string[] };
  defs: Record<string /* rowId | paragraphId */, TagDefV1>;           // paragraph keys can be tags (C3-M4)
}
export interface TagDefV1 {
  targetId: string; text: string; norm: string; family?: { pattern?: string; shapeClass?: string };
  instances: TagInstanceV1[]; expectedQty?: number; dropCounts?: Record<string, number>;
}
export interface TagInstanceV1 {
  id: string; page: number; b: BboxMinMax;
  anchor: { annotationId?: number; cls?: string; src: "yolo" | "classical" | "text" | "template" | "manual" };
  score: number; tier: "high" | "medium" | "low"; status: "auto" | "confirmed" | "rejected";
}
// Projection to YoloTag instances (ScoredMatch field names): pageNumber ← page; bbox ← b; confidence ← score;
// annotationId ← anchor.annotationId ?? -1 (finite, so the client isYoloTag guard keeps it, C1-M2).
// YoloTag (types/index.ts, unchanged type) gains optional fields via the sibling type YoloTagLinks:
export interface YoloTagLinks { key?: string; regionId?: string; rowId?: string; kind?: "legend" | "keynote" | "schedule" | "notes" }
// A legend tag is source "keynote" | "schedule" + links.kind "legend". YoloTag.source is NOT widened (C2-M9).
// server key: `${source}|${scope}|${scope === "page" ? pageNumber : "*"}|${regionId ?? "*"}|${TAGTEXT}|${yoloClass ?? ""}`

// ── project index: DERIVED in computeProjectSummaries, never hand-written (C1-B2) ────────────────
/**
 * One inbox entry in `PJ.structureIndex.inbox[page]` (server-only). §2.1 names the type without a
 * shape; this is the minimum the TP-3 items service needs. WP-3.F may extend it with a sibling type.
 */
export interface InboxSlim {
  id: string;                                   // proposal id, `tr:<contentKey>` or a region id
  origin: "proposal" | "text-region" | "region";
  kind: StructureKind; b: BboxMinMax; title: string | null; p: number;
  state: "todo" | "parsed" | "rejected";
  regionId?: string; proposalId?: string;
}
export interface StructureIndexRegion {
  regionId: string; kind: StructureKind; title: string; classId?: string; bbox: BboxMinMax;
  rows: number; cols?: number; revision?: number; proposalId?: string; continues?: string;
  origin: "workspace" | "classic"; stale?: Capability[];
}
export type StructureIndexKeyEntry = [regionId: string, kind: StructureKind, targetId: string, blockHeaderNorm: string | null];
export interface StructureIndexV1 {                                   // PJ.structureIndex
  v: 1; at: string;
  regions: Record<string /* page */, StructureIndexRegion[]>;                                    // viewer bootstrap
  keys: Record<string /* page */, Record<string /* keyNorm */, StructureIndexKeyEntry[]>>;        // server-only
  specSections: Record<string /* "087100" */, [page: number, regionId: string][]>;                // server-only
  inbox: Record<string /* page */, InboxSlim[]>;                                                  // server-only
}

// ── flags (`app_settings.parseEngine`; resolved by server/services/parse-engine/flags.ts) ───────────
export type ParseEngineMode = "legacy" | "engine";
export type ParseEngineToolId =
  | "tablesRoute" | "keynoteRoute" | "notesClassifier" | "specClassifier" | "notesAuto" | "specAuto" | "workspace";
export const PARSE_ENGINE_TOOL_IDS: readonly ParseEngineToolId[] = [
  "tablesRoute", "keynoteRoute", "notesClassifier", "specClassifier", "notesAuto", "specAuto", "workspace",
];
/** The effective flags a caller acts on (after code defaults, the stored value and the kill switch). */
export interface ParseEngineFlags {
  killSwitch: boolean;
  tools: Record<ParseEngineToolId, ParseEngineMode>;
  /** Governs only the standard-budget crop caches; paid results are always cached for signed-in users (E-3). */
  cropCache: boolean;
}
