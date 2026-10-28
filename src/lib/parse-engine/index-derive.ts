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
 *   inbox         → server-only: the page's proposal and text-region items, derived by WP-3.F's ONE pure
 *                   function (`inbox-derive.ts` `deriveInboxForPage` / `deriveInboxIndex`), which the
 *                   verdict routes' one-page `jsonb_set` refresh also uses (TP-3 integrate g2b, WP-3.F
 *                   HIGH-1). Because those routes write the slice too, the summaries pass re-derives `inbox`
 *                   from page rows read INSIDE its project lock, passing the stored inbox as `prevInbox` so
 *                   the legacy-reject bindings survive (`withLockedInbox` in project-analysis.ts; WP-3.H
 *                   verify MED-2). Every visible page gets an inbox key, an empty one included.
 *
 * Pure and deterministic (E-7): the caller passes `at`; ordering follows page then region order.
 */

import type { PageIntelligence } from "@/types";
import type { PageProposalVerdicts } from "@/lib/classifier-engine/types";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";
import { deriveInboxForPage } from "./inbox-derive";
import { readStructure, itemKeyNorm, sectionNorm, specSectionOf } from "./read";
import type {
  InboxSlim,
  StructureIndexKeyEntry,
  StructureIndexRegion,
  StructureIndexV1,
  StructureKind,
  StructureModel,
  StructureParagraphDoc,
} from "./types";
import { staleCapabilities } from "./version";

export const STRUCTURE_INDEX_VERSION = 1 as const;

/** The page fields the index reads (the summaries pass already loads them). */
export interface IndexPageInput {
  pageNumber: number;
  pageIntelligence: PageIntelligence | null | undefined;
}

/** What a page's intelligence may carry beyond the typed `PageIntelligence` (TP-2 user-owned key). */
interface IndexPageIntelligence extends PageIntelligence {
  proposalVerdicts?: PageProposalVerdicts;
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

/** One page's index slices (regions, keys, spec sections, inbox). `prev` is the page's stored inbox slice. */
export function deriveStructureIndexForPage(page: IndexPageInput, prev?: readonly InboxSlim[] | null): {
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
  const inbox = deriveInboxForPage({ page: page.pageNumber, pageIntelligence: page.pageIntelligence, prev });
  return { regions, keys, specSections, inbox };
}

/**
 * The whole project index from its VISIBLE pages (the caller filters hidden duplicates). `prevInbox` is the
 * stored `structureIndex.inbox`, which carries the legacy-reject bindings forward (WP-3.F `deriveInboxIndex`).
 */
export function deriveStructureIndex(
  pages: readonly IndexPageInput[],
  at: string,
  prevInbox?: StructureIndexV1["inbox"] | null,
): StructureIndexV1 {
  const index: StructureIndexV1 = { v: STRUCTURE_INDEX_VERSION, at, regions: {}, keys: {}, specSections: {}, inbox: {} };
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of ordered) {
    const pn = String(page.pageNumber);
    const prev = prevInbox && Array.isArray(prevInbox[pn]) ? prevInbox[pn] : null; // as deriveInboxIndex reads it
    const slice = deriveStructureIndexForPage(page, prev);
    if (slice.regions.length) index.regions[pn] = slice.regions;
    if (Object.keys(slice.keys).length) index.keys[pn] = slice.keys;
    index.inbox[pn] = slice.inbox; // every visible page keyed, an empty one included (= deriveInboxIndex)
    for (const [section, regionId] of slice.specSections) (index.specSections[section] ??= []).push([page.pageNumber, regionId]);
  }
  return index;
}
