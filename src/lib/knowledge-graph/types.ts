// [graph T8 2026-10-24] Knowledge graph v1 — the node / edge vocabulary (research paper §3 "Layer 2").
//
// One graph per project. Every edge carries provenance (which extractor, which page, where on the
// page) and a confidence, so a consumer can always answer "why is this edge here?". Nothing in
// this module touches the DB or S3: `src/server/services/project-graph.ts` assembles the input
// from stored rows and persists the result (full graph in S3 under the project's data prefix,
// compact summary in projects.projectIntelligence.knowledgeGraph — see summary.ts).
//
// Cross-set linking (the same sheet in two uploads, twin_of across projects) is v2: v1 edges stay
// inside one project, and `revision_of` is only the within-project case (same sheet number on two
// pages, or an admin duplicate mark).

import type { BboxLTWH, BboxMinMax } from "@/types";

export const KNOWLEDGE_GRAPH_VERSION = 1;

export type NodeType =
  | "project"
  | "sheet"
  | "detail"
  | "table"
  | "table_row"
  | "tag_family"
  | "tag"
  | "keynote_code"
  | "csi_code";

export type EdgeType =
  | "references"
  | "defined_in"
  | "scheduled_as"
  | "inside"
  | "has_csi"
  | "revision_of"
  | "is_a";

/** Which code produced the fact. Extractors are strings so a new one never needs a type change. */
export type Extractor =
  | "crossRefs" // pageIntelligence.crossRefs (lib/page-analysis detectCrossRefs)
  | "text-annotations" // textAnnotations sheet-ref / detail-ref / tag items (lib/detectors)
  | "stacked-callout" // a detail number directly over a sheet number (the owner's "3 over R-3")
  | "detail-title" // "N  TITLE" line on the sheet that defines the detail
  | "title-block" // pages.drawing_number (lib/title-block extractDrawingNumber)
  | "classification" // pageIntelligence.classification
  | "classifiedTables" // pageIntelligence.classifiedTables (keyword classifier)
  | "regionsV2" // pageIntelligence.regionsV2 (detector-first classifier)
  | "parsedRegions" // user-promoted schedule rows
  | "csiCodes" // pages.csi_codes (span tagger)
  | "keynotes" // pages.keynotes (shape parse)
  | "duplicateOf" // admin duplicate mark
  | "tag-families" // the tag-families hook (built by another track)
  | "reference-target"; // a detail node implied by a resolved detail reference

export interface Provenance {
  extractor: Extractor;
  page: number;
  /** Normalised [left, top, width, height] on the page, when the extractor had one. */
  bbox?: BboxLTWH;
  /** The text as read (a reference string, a title, a tag), capped by the builder. */
  text?: string;
}

export interface GraphNodeBase {
  id: string;
  type: NodeType;
  label: string;
  /** Page the node lives on; absent for project / csi_code / tag_family. */
  page?: number;
  provenance: Provenance[];
}

export interface ProjectNode extends GraphNodeBase {
  type: "project";
  publicId: string;
}

export interface SheetNode extends GraphNodeBase {
  type: "sheet";
  page: number;
  /** Sheet number as read from the title block (null when none was found). */
  number: string | null;
  /** Normalised sheet number (normaliseSheetNumber); null when none. */
  key: string | null;
  discipline?: string;
  disciplinePrefix?: string;
  subType?: string;
  title?: string;
  revision?: string;
  /** Hidden by an admin duplicate mark (lib/page-dedup). */
  hidden?: boolean;
}

export interface DetailNode extends GraphNodeBase {
  type: "detail";
  page: number;
  /** Detail number / letter on the sheet ("3", "A"). */
  number: string;
  /** How the node came to exist: a title on the sheet, a stacked bubble naming its own sheet, or
   *  only ever as the target of a resolved reference (no title found). */
  origin: "title" | "stacked-title" | "reference-target";
}

export interface TableNode extends GraphNodeBase {
  type: "table";
  page: number;
  category: string;
  bbox: BboxLTWH;
  /** parsedRegions ids are user data; classifier regions carry their own id. */
  sourceId?: string;
}

export interface TableRowNode extends GraphNodeBase {
  type: "table_row";
  page: number;
  tableId: string;
  rowIndex: number;
  /** The row's tag-column value when the parsed table has one. */
  tag?: string;
}

/** Typed hook for the tag-families track (src/lib/tag-mapping is built in parallel): families are
 *  supplied by the caller, never derived here. */
export interface TagFamilyInput {
  /** Stable key (e.g. the family pattern "D##" or a classifier id). */
  key: string;
  label: string;
  /** Members as (page, text) pairs — matched to tag nodes by normalised text. */
  members: Array<{ page: number; text: string; bbox?: BboxLTWH }>;
  confidence?: number;
  /** Family pattern ("D-999": digits → 9). With `pages`, every tag node on those pages whose text
   *  fits the pattern joins the family — how the stored tag-mapping families (which keep only
   *  sample values, not every member) are linked. */
  pattern?: string;
  pages?: number[];
}

export interface TagFamilyNode extends GraphNodeBase {
  type: "tag_family";
  key: string;
}

export interface TagNode extends GraphNodeBase {
  type: "tag";
  page: number;
  text: string;
  /** Text-annotation type that produced it (door-window-tag, equipment-tag, …). */
  tagType: string;
  /** Occurrences on the page (bboxes capped in provenance). */
  count: number;
}

export interface KeynoteCodeNode extends GraphNodeBase {
  type: "keynote_code";
  page: number;
  code: string;
  shape?: string;
  count: number;
}

export interface CsiCodeNode extends GraphNodeBase {
  type: "csi_code";
  code: string;
  description?: string;
  division: string;
}

export type GraphNode =
  | ProjectNode
  | SheetNode
  | DetailNode
  | TableNode
  | TableRowNode
  | TagFamilyNode
  | TagNode
  | KeynoteCodeNode
  | CsiCodeNode;

export type ReferenceStatus = "resolved" | "unresolved" | "ambiguous";
export type ReferenceKind = "sheet" | "detail";
export type CsiMethod = "span" | "propagated" | "default";

export interface GraphEdgeBase {
  id: string;
  type: EdgeType;
  from: string;
  /** Target node id; null only on an unresolved / ambiguous `references` edge. */
  to: string | null;
  confidence: number;
  provenance: Provenance[];
}

export interface ReferenceEdge extends GraphEdgeBase {
  type: "references";
  kind: ReferenceKind;
  /** The sheet number as written at the source ("E-300"), kept for the QA queue. */
  targetSheet: string;
  /** normaliseSheetNumber(targetSheet). */
  targetKey: string;
  /** Detail number / letter when kind === "detail". */
  detail?: string;
  status: ReferenceStatus;
  /** Candidate sheet node ids when the target is ambiguous (prefix match on >1 sheet). */
  candidates?: string[];
  /** The source sheet names itself (a callout to a detail on the same sheet). */
  self?: boolean;
  /** For a resolved detail reference: whether a detail node with that number exists on the sheet. */
  detailFound?: boolean;
  /** Distinct extractors that saw the same reference (crossRefs + text-annotations + stacked). */
  seen: number;
}

export interface HasCsiEdge extends GraphEdgeBase {
  type: "has_csi";
  method: CsiMethod;
  /** 0–1: span = the tagger's own confidence; propagated = low; default = lowest. */
  trust: number;
}

export interface RevisionEdge extends GraphEdgeBase {
  type: "revision_of";
  /** same-number: two pages read the same sheet number; duplicate-mark: admin Data tools. */
  basis: "same-number" | "duplicate-mark";
}

export interface PlainEdge extends GraphEdgeBase {
  type: "defined_in" | "scheduled_as" | "inside" | "is_a";
}

export type GraphEdge = ReferenceEdge | HasCsiEdge | RevisionEdge | PlainEdge;

export interface KnowledgeGraph {
  v: typeof KNOWLEDGE_GRAPH_VERSION;
  computedAt: string;
  project: { publicId: string; pages: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── builder input ──────────────────────────────────────────────────────────────────────────────

/** One stored page, reduced to what the builder reads. Assembled by services/project-graph.ts from
 *  the pages row (never the whole textractData: only line text + bbox and the short words). */
export interface GraphPageInput {
  pageNumber: number;
  name?: string | null;
  drawingNumber: string | null;
  hidden?: boolean;
  /** pageIntelligence.duplicateOf.pageNumber when marked. */
  duplicateOf?: number | null;
  classification?: { discipline?: string; disciplinePrefix?: string; subType?: string } | null;
  crossRefs?: Array<{
    sourceText: string;
    targetDrawing: string;
    refType: string;
    detail?: string;
    bbox?: BboxLTWH;
    confidence?: number;
  }> | null;
  /** textAnnotations.annotations filtered to the reference + tag types (lib/detectors). */
  textAnnotations?: Array<{
    type: string;
    text: string;
    bbox: BboxLTWH;
    confidence?: number;
    meta?: Record<string, unknown>;
    csiTags?: Array<{ code: string; description?: string; division?: string }>;
  }> | null;
  csiCodes?: Array<{
    code: string;
    description?: string;
    division?: string;
    confidence?: number;
    triggers?: Array<{ text?: string; bbox?: BboxLTWH }>;
  }> | null;
  classifiedTables?: Array<{ id?: string; category: string; bbox: BboxLTWH; confidence?: number; headerText?: string }> | null;
  regionsV2?: { regions: Array<{ id: string; kind: string; className: string; bbox: [number, number, number, number]; nameScore: number }> } | null;
  parsedRegions?: Array<{
    id?: string;
    type?: string;
    category?: string;
    bbox?: BboxMinMax; // stored MinMax (K04); build.ts converts it for the LTWH graph nodes
    csiTags?: Array<{ code: string; description?: string; division?: string }>;
    data?: { headers?: string[]; rows?: unknown[]; tagColumn?: number | string | null; keynotes?: Array<{ key: string; description?: string }> } | null;
  }> | null;
  keynotes?: Array<{ shape?: string; text: string; bbox?: [number, number, number, number] }> | null;
  /** Textract LINES as (text, bbox) — detail titles are read from these. */
  lines?: Array<{ text: string; bbox: BboxLTWH; confidence?: number }> | null;
  /** Textract WORDS that look like a detail number or a sheet number — the stacked-callout input. */
  words?: Array<{ text: string; bbox: BboxLTWH; confidence?: number }> | null;
}

export interface GraphBuildInput {
  publicId: string;
  pages: GraphPageInput[];
  /** Typed hook for the tag-families track; absent → no tag_family nodes. */
  tagFamilies?: TagFamilyInput[];
}

export interface GraphBuildOptions {
  now?: Date;
}
