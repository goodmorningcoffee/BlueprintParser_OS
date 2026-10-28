/**
 * The DERIVED project structure index (table pipeline PLAN §1.1-18, §2.1 `StructureIndexV1`; WP-3.H,
 * C1-B2, C2-M8).
 *
 * Nobody writes `PJ.structureIndex` by hand. `computeProjectSummaries` (`lib/project-analysis.ts`) derives
 * it from the visible pages it already loads, in its one locked write, so every path that recomputes
 * summaries (promote, classic `DELETE /api/regions`, the pages PATCH, YOLO load, processing, reprocess,
 * commit, region delete) re-indexes classic saves too. Hidden duplicate pages never appear: the summaries
 * query selects `visiblePage(...)` only.
 *
 * The index is keyed by PAGE, never by sheet: an address is computed at read time from the page's
 * current drawing number, so a drawing-number change leaves nothing stale (C2-M8).
 *   regions       → viewer bootstrap (`viewerProjectIntelligence` keeps only this slice)
 *   keys          → server-only: keyNorm → [regionId, kind, targetId (rowId | paragraphId), blockHeaderNorm]
 *   specSections  → server-only: "087100" → [page, regionId][]
 *   inbox         → server-only: the page's text-region items (`deriveInboxForPage`, shared with the
 *                   WP-3.F verdict route's one-page `jsonb_set` refresh). Because that route writes the
 *                   slice too, the summaries pass re-derives `inbox` from page rows read INSIDE its project
 *                   lock (`withLockedInbox` in project-analysis.ts), so a verdict that
 *                   commits between the pre-lock read and the lock is never overwritten (WP-3.H verify MED-2).
 *
 * Pure and deterministic (E-7): the caller passes `at`; ordering follows page then region order.
 */

import type { PageIntelligence, ParsedRegion, TextRegion } from "@/types";
import type { PageProposalVerdicts } from "@/lib/classifier-engine/types";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";
import { ltwhToMinMax } from "./geometry";
import { readStructure, itemKeyNorm, sectionNorm, specSectionOf } from "./read";
import type {
  BboxMinMax,
  InboxSlim,
  StructureIndexKeyEntry,
  StructureIndexRegion,
  StructureIndexV1,
  StructureKind,
  StructureModel,
  StructureParagraphDoc,
  TextRegionVerdict,
} from "./types";
import { staleCapabilities } from "./version";

export const STRUCTURE_INDEX_VERSION = 1 as const;
/** A text-region verdict matches a current text region of the same type at IoU ≥ this (K30). */
export const TEXT_REGION_VERDICT_IOU = 0.7;
/** A committed region "parses" a text region it overlaps at IoU ≥ this (same kind family). */
export const TEXT_REGION_PARSED_IOU = 0.5;
/** `paragraph` text regions enter the inbox only with numbered items and at least this many keys (§2.1, C2-m5). */
export const PARAGRAPH_MIN_KEYS = 3;

/** The page fields the index reads (the summaries pass already loads them). */
export interface IndexPageInput {
  pageNumber: number;
  pageIntelligence: PageIntelligence | null | undefined;
}

/** What a page's intelligence may carry beyond the typed `PageIntelligence` (TP-2/TP-3 user-owned keys). */
interface IndexPageIntelligence extends PageIntelligence {
  textRegionVerdicts?: Record<string, TextRegionVerdict>;
  proposalVerdicts?: PageProposalVerdicts;
}

export interface DeriveInboxOptions {
  /**
   * The bbox each legacy `rejectedTextRegionIds` entry had at reject time, when known. A legacy id whose
   * box is known is honoured only while the current text region with that id still overlaps it at
   * IoU ≥ .7 (reprocess renumbers `region-${i}`, C2-M12). TP-2 data records no such box, so an id
   * without one is honoured as the classic cards honour it.
   */
  legacyRejectBoxes?: Record<string, BboxMinMax>;
}

// ── geometry ──────────────────────────────────────────────────────────────────────────────────────

export function iou(a: readonly number[], b: readonly number[]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

function finiteBox(b: unknown): b is [number, number, number, number] {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));
}

// ── text regions → inbox ──────────────────────────────────────────────────────────────────────────

/** `TextRegion` content key (`tr:${type}:${q2(bbox)}`, §2.1): the type and the MinMax box at 2 decimals. */
export function textRegionContentKey(type: string, b: readonly number[]): string {
  return `${type}:${b.map((v) => v.toFixed(2)).join(",")}`;
}

/** Leading item keys on the lines of a text region's `containedText` ("1.", "(2)", "A.", "K-01"). */
export function countLeadingKeys(text: string | null | undefined): number {
  if (typeof text !== "string") return 0;
  return text.split(/\r?\n/).filter((l) => /^\s*(\(\s*[A-Za-z0-9]{1,3}\s*\)|[A-Z]{1,2}-\d{1,3}\.?|\d{1,3}(?:\.\d{1,3})*[.)]|[A-Z][.)])\s+\S/.test(l)).length;
}

function isLegendKeyValue(tr: TextRegion): boolean {
  const tier1 = (tr.classifiedLabels?.tier1 ?? "").toUpperCase();
  if (tier1 === "LEGEND" || tier1 === "ABBREVIATIONS") return true;
  const header = tr.grid?.headers?.[0];
  const keys = header ? (tr.grid?.rows ?? []).map((r) => (r?.[header] ?? "").trim()).filter(Boolean) : [];
  if (!keys.length) return false;
  const short = keys.filter((k) => !/^\d+(\.\d+)*\.?$/.test(k) && k.length <= 8 && !/\s/.test(k)).length;
  return short / keys.length >= 0.6;
}

/** The structure kind of a classifier text region, or null when it is not an inbox item (§2.1 table, C2-m8). */
export function textRegionKind(tr: TextRegion): StructureKind | null {
  switch (tr.type) {
    case "notes-numbered": return "notes";
    case "notes-key-value": return isLegendKeyValue(tr) ? "legend" : "notes";
    case "spec-dense-columns": return "spec";
    case "schedule-table": return (tr.classifiedLabels?.tier1 ?? "").toUpperCase() === "KEYNOTE" ? "keynote" : "schedule";
    case "paragraph": {
      if (!tr.hasNumberedItems) return null;
      const keys = Math.max(countLeadingKeys(tr.containedText), typeof tr.rowCount === "number" ? tr.rowCount : 0);
      return keys >= PARAGRAPH_MIN_KEYS ? "notes" : null;
    }
    default: return null;
  }
}

const FAMILY: Record<StructureKind, "table" | "paragraphs"> = { schedule: "table", keynote: "table", legend: "table", notes: "paragraphs", spec: "paragraphs" };

function regionFamily(r: ParsedRegion): "table" | "paragraphs" {
  return r.type === "notes" || r.type === "spec" ? "paragraphs" : "table";
}

/**
 * The inbox slice of ONE page: its classifier text regions with their state (todo / parsed / rejected).
 * It reads ONLY `textRegions`, `textRegionVerdicts`, `rejectedTextRegionIds` and `parsedRegions[].{id, type,
 * bbox, sourceTextRegionId}`. `withLockedInbox` (project-analysis.ts) projects exactly those keys for the
 * in-lock re-read; widen both together (the route test pins their parity).
 */
export function deriveInboxForPage(pi: PageIntelligence | null | undefined, options: DeriveInboxOptions = {}): InboxSlim[] {
  const intel = (pi ?? {}) as IndexPageIntelligence;
  const regions = Array.isArray(intel.parsedRegions) ? intel.parsedRegions : [];
  const verdicts = intel.textRegionVerdicts && typeof intel.textRegionVerdicts === "object" ? Object.values(intel.textRegionVerdicts) : [];
  const legacyRejected = new Set(Array.isArray(intel.rejectedTextRegionIds) ? intel.rejectedTextRegionIds : []);
  const out: InboxSlim[] = [];
  for (const tr of Array.isArray(intel.textRegions) ? intel.textRegions : []) {
    if (!tr || !finiteBox(tr.bbox)) continue;
    const kind = textRegionKind(tr);
    if (!kind) continue;
    const b = ltwhToMinMax(tr.bbox) as BboxMinMax;
    const verdict = verdicts
      .filter((v) => v && v.type === tr.type && finiteBox(v.b) && iou(v.b, b) >= TEXT_REGION_VERDICT_IOU)
      .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))[0];
    const parsed = regions.find((r) => r.sourceTextRegionId === tr.id)
      ?? regions.find((r) => {
        const rb = parsedRegionMinMax(r); // the one ParsedRegion bbox reader (K04)
        return regionFamily(r) === FAMILY[kind] && !!rb && iou(rb, b) >= TEXT_REGION_PARSED_IOU;
      });
    const legacyBox = options.legacyRejectBoxes?.[tr.id];
    const legacyReject = legacyRejected.has(tr.id) && (!legacyBox || iou(legacyBox, b) >= TEXT_REGION_VERDICT_IOU);
    const state: InboxSlim["state"] = verdict
      ? (verdict.verdict === "reject" ? "rejected" : parsed ? "parsed" : "todo")
      : parsed ? "parsed" : legacyReject ? "rejected" : "todo";
    out.push({
      id: `tr:${textRegionContentKey(tr.type, b)}`,
      origin: "text-region",
      kind,
      b,
      title: tr.headerText?.trim() || tr.classifiedLabels?.tier2 || null,
      p: typeof tr.confidence === "number" ? tr.confidence : 0,
      state,
      ...(parsed && state === "parsed" ? { regionId: parsed.id } : {}),
    });
  }
  return out;
}

// ── regions, keys, spec sections ──────────────────────────────────────────────────────────────────

function proposalIdFor(regionId: string, verdicts: PageProposalVerdicts | undefined): string | undefined {
  // TP-2 regions carry no `data.links`; the parse-save accept records `proposalVerdicts[pid].regionId` (amended 2026-10-27).
  if (!verdicts || typeof verdicts !== "object") return undefined;
  return Object.keys(verdicts).sort().find((pid) => verdicts[pid]?.regionId === regionId);
}

function isParagraphDoc(model: StructureModel): model is StructureParagraphDoc {
  return model.kind === "notes" || model.kind === "spec";
}

function modelRows(model: StructureModel | null): { rows: number; cols?: number } {
  if (!model) return { rows: 0 };
  if (isParagraphDoc(model)) return { rows: model.paragraphs.length };
  return { rows: model.rows.filter((r) => r.role !== "header").length, cols: model.cols.length };
}

function keyEntries(regionId: string, model: StructureModel): [string, StructureIndexKeyEntry][] {
  if (isParagraphDoc(model)) {
    const headerOf = new Map(model.blocks.map((b) => [b.id, b.headerNorm]));
    return model.paragraphs
      .filter((p) => p.keyNorm)
      .map((p) => [p.keyNorm, [regionId, model.kind, p.id, headerOf.get(p.blockId) ?? null]]);
  }
  if (!model.tag) return [];
  const tagCol = model.tag.col;
  const text = new Map(model.cells.filter((c) => c.col === tagCol).map((c) => [c.row, c.text]));
  const out: [string, StructureIndexKeyEntry][] = [];
  for (const row of model.rows) {
    if (row.role === "header") continue;
    const keyText = row.key && row.key.kind !== "symbol" ? row.key.text : text.get(row.id);
    const norm = itemKeyNorm(keyText);
    if (norm) out.push([norm, [regionId, model.kind, row.id, null]]);
  }
  return out;
}

function specSectionsOf(model: StructureModel | null): string[] {
  if (!model || model.kind !== "spec") return [];
  const found = [model.spec?.section ?? null, ...model.blocks.map((b) => specSectionOf(b.header))].filter((s): s is string => !!s);
  return [...new Set(found.map(sectionNorm))];
}

/** One page's index slices (regions, keys, spec sections, inbox). */
export function deriveStructureIndexForPage(page: IndexPageInput, options: DeriveInboxOptions = {}): {
  regions: StructureIndexRegion[];
  keys: Record<string, StructureIndexKeyEntry[]>;
  specSections: [section: string, regionId: string][];
  inbox: InboxSlim[];
} {
  const intel = (page.pageIntelligence ?? {}) as IndexPageIntelligence;
  const regions: StructureIndexRegion[] = [];
  const keys: Record<string, StructureIndexKeyEntry[]> = {};
  const specSections: [string, string][] = [];
  for (const region of Array.isArray(intel.parsedRegions) ? intel.parsedRegions : []) {
    const box = parsedRegionMinMax(region); // the one ParsedRegion bbox reader (K04)
    if (!region || typeof region.id !== "string" || !box) continue;
    const read = readStructure(region);
    const model = read.model;
    const kind = (model?.kind ?? region.type) as StructureKind;
    const links = read.origin === "workspace" ? read.links : undefined;
    const data = (region.data ?? {}) as { tableName?: unknown; engine?: { caps?: Record<string, number> } };
    const title = model?.title?.text || (typeof data.tableName === "string" && data.tableName) || region.category || region.type;
    const stale = read.origin === "workspace" ? staleCapabilities(data.engine?.caps) : [];
    const proposalId = links?.proposalId ?? proposalIdFor(region.id, intel.proposalVerdicts);
    const classId = model && "classId" in model && typeof model.classId === "string" ? model.classId : undefined;
    regions.push({
      regionId: region.id,
      kind,
      title: String(title),
      ...(classId ? { classId } : {}),
      bbox: box,
      ...modelRows(model),
      ...(links ? { revision: links.revision } : {}),
      ...(proposalId ? { proposalId } : {}),
      ...(links?.continues ? { continues: links.continues } : {}),
      origin: read.origin,
      ...(stale.length ? { stale } : {}),
    });
    if (model) {
      for (const [norm, entry] of keyEntries(region.id, model)) (keys[norm] ??= []).push(entry);
      for (const s of specSectionsOf(model)) specSections.push([s, region.id]);
    }
  }
  return { regions, keys, specSections, inbox: deriveInboxForPage(page.pageIntelligence, options) };
}

/** Only the `inbox` slice of the project index (same shape and rule as `deriveStructureIndex(...).inbox`). */
export function deriveInboxIndex(pages: readonly IndexPageInput[]): StructureIndexV1["inbox"] {
  const inbox: StructureIndexV1["inbox"] = {};
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const slice = deriveInboxForPage(page.pageIntelligence);
    if (slice.length) inbox[String(page.pageNumber)] = slice;
  }
  return inbox;
}

/** The whole project index from its VISIBLE pages (the caller filters hidden duplicates). */
export function deriveStructureIndex(pages: readonly IndexPageInput[], at: string): StructureIndexV1 {
  const index: StructureIndexV1 = { v: STRUCTURE_INDEX_VERSION, at, regions: {}, keys: {}, specSections: {}, inbox: {} };
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of ordered) {
    const slice = deriveStructureIndexForPage(page);
    const pn = String(page.pageNumber);
    if (slice.regions.length) index.regions[pn] = slice.regions;
    if (Object.keys(slice.keys).length) index.keys[pn] = slice.keys;
    if (slice.inbox.length) index.inbox[pn] = slice.inbox;
    for (const [section, regionId] of slice.specSections) (index.specSections[section] ??= []).push([page.pageNumber, regionId]);
  }
  return index;
}
