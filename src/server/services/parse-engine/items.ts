/**
 * The Tables & Notes workspace inbox (table pipeline TP-3 WP-3.F; PLAN §1.2 "GET …/parse-engine/items",
 * §3.2, §5 WP-3.F; C1-D6, C2-m5, C2-m7, C3-m7, K58).
 *
 *   GET /api/projects/[id]/parse-engine/items?scope=all          → per-sheet groups, from ONE projects row
 *   GET /api/projects/[id]/parse-engine/items?scope=sheet&page=N → that sheet's detail, from one page row
 *
 * **scope=all reads PJ only** (C1-D6: a per-page read detoasts every page's whole intelligence):
 * `PJ.proposals` (the classifier summary, with verdicts) ∪ `PJ.structureIndex.inbox` (derived per page, refreshed
 * by the verdict routes) ∪ `PJ.structureIndex.regions` (saved regions, classic and workspace). The derived index
 * covers VISIBLE pages only (the summaries pass selects `visiblePage`) and `deriveInboxIndex` writes a key for
 * every one of them, an empty one included, so the inbox's page keys are the visible set and a hidden duplicate
 * page never appears. Before the first summaries pass has derived an index
 * (`indexReady: false`), the list is the proposals summary alone, filtered by one slim hidden-page select.
 *
 * **scope=sheet** reads that page's row (only the keys it needs), skips a hidden page, and adds the
 * low-confidence detail: `classifiedTables` and `ensembleRegions` (C2-m7). Text regions are derived live with
 * the same pure `deriveInboxForPage` as the index, so the sheet and the index agree.
 *
 * Joins and dedupe, per page, inside one kind family (tables never merge with notes/specs):
 *   1. a proposal ↔ saved region by `data.links.proposalId` / the index's `proposalId` (TP-3 commits), else by
 *      `proposalVerdicts[pid].regionId` (TP-2 regions carry no `data.links`, WP-2.F; via the inbox entry's
 *      `regionId`), else by IoU ≥ .5 — the joined proposal reads "parsed" and the region is not listed again;
 *   2. a text region ↔ saved region the same way (`sourceTextRegionId`, else IoU);
 *   3. a text region overlapping a proposal (IoU ≥ .5) folds into the proposal (one item per block);
 *   4. low-confidence detector boxes overlapping any kept item are dropped.
 * Sort: `tableP × p` descending (`p` without a table head), ties by id. Items under `LOW_CONFIDENCE_SCORE`
 * and every classifiedTables/ensembleRegions item go to `lowConfidence` (C3-m7).
 *
 * Demo projects are refused (the inbox carries verdict state; there is no demo workspace).
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import type { ProposalSummaryItem } from "@/lib/classifier-engine/types";
import { visiblePage } from "@/lib/page-dedup";
import { ltwhToMinMax } from "@/lib/parse-engine/geometry";
import { bestOverlap, deriveInboxForPage, isPageUnitBox, proposalInboxKind, REGION_JOIN_IOU, type InboxEntry } from "@/lib/parse-engine/inbox-derive";
import { iouMinMax } from "@/lib/parse-engine/text-region-verdicts";
import type { BboxMinMax, InboxSlim, StructureIndexRegion, StructureKind } from "@/lib/parse-engine/types";
import type { WorkspaceItem, WorkspaceItemsGroup, WorkspaceItemsResponse } from "@/lib/parse-engine/types-items";
import { ApiError } from "@/server/api/envelope";

/** Items scoring below this are returned in `lowConfidence`. */
export const LOW_CONFIDENCE_SCORE = 0.3;

type Rec = Record<string, unknown>;
const records = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === "object" && !Array.isArray(x)) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isBox = (b: unknown): b is BboxMinMax => Array.isArray(b) && b.length === 4 && b.every((v) => num(v) !== null);
const asObject = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const KINDS: readonly StructureKind[] = ["schedule", "keynote", "legend", "notes", "spec"];

const scoreOf = (p: number, tableP?: number) => (typeof tableP === "number" ? tableP * p : p);

/** A saved region as the merge sees it (from the index or from the page row). */
export interface RegionCandidate {
  regionId: string;
  kind: StructureKind;
  b: BboxMinMax;
  title: string | null;
  proposalId?: string;
  sourceTextRegionId?: string;
  origin: "workspace" | "classic";
}

/** Low-confidence detector boxes (scope=sheet only). */
export interface LowCandidate {
  id: string;
  origin: "classified-table" | "ensemble";
  kind: StructureKind;
  b: BboxMinMax;
  title: string | null;
  p: number;
}

function entryItem(page: number, e: InboxEntry): WorkspaceItem {
  const p = num(e.p) ?? 0;
  const tableP = num(e.tableP) ?? undefined;
  return {
    id: e.id, origin: e.origin === "region" ? "region" : e.origin, page, kind: e.kind, title: e.title ?? null, b: e.b, p,
    ...(tableP !== undefined ? { tableP } : {}),
    score: scoreOf(p, tableP), state: e.state,
    ...(e.classId !== undefined ? { classId: e.classId } : {}),
    ...(e.proposalId ? { proposalId: e.proposalId } : {}),
    ...(e.regionId ? { regionId: e.regionId } : {}),
    ...(e.verdict ? { verdict: e.verdict } : {}),
    ...(e.regionType ? { regionType: e.regionType } : {}),
    ...(e.legacyId ? { legacyId: e.legacyId } : {}),
  };
}

const byScore = (a: WorkspaceItem, b: WorkspaceItem) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Join, dedupe, score and split one page's candidates (pure; see the header for the rules).
 */
export function assembleGroup(
  page: number,
  input: { entries: readonly InboxEntry[]; regions: readonly RegionCandidate[]; low?: readonly LowCandidate[]; tagRows?: Readonly<Record<string, number>> },
  threshold = LOW_CONFIDENCE_SCORE,
): WorkspaceItemsGroup {
  const regions = [...input.regions];
  const consumed = new Set<string>();
  const joinRegion = (item: WorkspaceItem, viaSource?: (r: RegionCandidate) => boolean): void => {
    const free = regions.filter((r) => !consumed.has(r.regionId));
    const named = item.regionId ? free.find((r) => r.regionId === item.regionId) : undefined;
    const linked = item.origin === "proposal" ? free.find((r) => r.proposalId === item.id) : undefined;
    const sourced = viaSource ? free.find(viaSource) : undefined;
    const region = named ?? linked ?? sourced ?? bestOverlap(free, item.kind, item.b, (r) => r.regionId);
    // No region to fold: keep the derived state (scope=sheet derives it live; scope=all trusts the slice,
    // which the verdict route refreshes, over an index region list that may predate it).
    if (!region) return;
    consumed.add(region.regionId);
    item.regionId = region.regionId;
    if (item.state !== "rejected") item.state = "parsed";
  };

  const proposals = input.entries.filter((e) => e.origin === "proposal").map((e) => entryItem(page, e));
  for (const p of proposals) {
    const rows = input.tagRows?.[p.id];
    if (typeof rows === "number") p.tagRows = rows;
    joinRegion(p);
  }
  const texts: WorkspaceItem[] = [];
  for (const t of input.entries.filter((e) => e.origin === "text-region").map((e) => entryItem(page, e))) {
    joinRegion(t, (r) => !!t.legacyId && r.sourceTextRegionId === t.legacyId && iouMinMax(r.b, t.b) >= REGION_JOIN_IOU);
    const host = bestOverlap(proposals, t.kind, t.b, (p) => p.id); // the same rule as `foldedTextRegions`
    if (host) {
      // One block, one item: the proposal keeps its id; it adopts a decided text state when it has none. A
      // workspace verdict on the item is mirrored onto the folded text region by the verdict route (MED-2).
      if (host.state === "todo" && t.state !== "todo") {
        host.state = t.state;
        if (t.regionId) host.regionId = t.regionId;
      }
      continue;
    }
    texts.push(t);
  }
  const regionItems: WorkspaceItem[] = regions.filter((r) => !consumed.has(r.regionId)).map((r) => ({
    id: r.regionId, origin: "region", page, kind: r.kind, title: r.title, b: r.b, p: 1, score: 1, state: "parsed",
    regionId: r.regionId, regionOrigin: r.origin,
    ...(r.proposalId ? { proposalId: r.proposalId } : {}),
  }));
  const kept = [...proposals, ...texts, ...regionItems];
  const lowItems: WorkspaceItem[] = (input.low ?? [])
    .filter((l) => !bestOverlap(kept, l.kind, l.b, (k) => k.id))
    .map((l) => ({ id: l.id, origin: l.origin, page, kind: l.kind, title: l.title, b: l.b, p: l.p, score: l.p, state: "todo" }));
  const items: WorkspaceItem[] = [];
  const lowConfidence: WorkspaceItem[] = [...lowItems];
  for (const item of kept) (item.origin !== "region" && item.score < threshold ? lowConfidence : items).push(item);
  return { page, items: items.sort(byScore), lowConfidence: lowConfidence.sort(byScore) };
}

// ── scope=all (PJ only) ─────────────────────────────────────────────────────────────────────────────

function summaryEntry(item: ProposalSummaryItem): InboxEntry | null {
  const kind = proposalInboxKind(item.target, item.classId);
  if (!kind || !isBox(item.bbox) || isPageUnitBox(item.bbox) || typeof item.id !== "string") return null;
  return {
    id: item.id, origin: "proposal", kind, b: item.bbox, title: str(item.displayName) ?? str(item.className), p: num(item.p) ?? 0,
    state: item.verdict === "reject" ? "rejected" : "todo", proposalId: item.id, classId: item.classId ?? null,
    ...(typeof item.tableP === "number" ? { tableP: item.tableP } : {}),
    ...(item.verdict ? { verdict: item.verdict } : {}),
  };
}

function indexRegion(r: StructureIndexRegion): RegionCandidate | null {
  if (!r || typeof r.regionId !== "string" || !isBox(r.bbox)) return null;
  const kind = KINDS.includes(r.kind) ? r.kind : "schedule";
  return {
    regionId: r.regionId, kind, b: r.bbox, title: str(r.title), origin: r.origin === "workspace" ? "workspace" : "classic",
    ...(typeof r.proposalId === "string" ? { proposalId: r.proposalId } : {}),
  };
}

/**
 * The per-sheet groups of scope=all from the PJ slices (pure). `index` null = not derived yet; then every
 * summary proposal is listed except those on `hiddenPages`.
 */
export function assembleAll(
  summaryItems: readonly ProposalSummaryItem[],
  index: { inbox: Readonly<Record<string, readonly InboxSlim[]>>; regions: Readonly<Record<string, readonly StructureIndexRegion[]>> } | null,
  hiddenPages: ReadonlySet<number> = new Set(),
): WorkspaceItemsGroup[] {
  const byPage = new Map<number, ProposalSummaryItem[]>();
  for (const item of summaryItems) {
    if (!item || typeof item.pageNumber !== "number") continue;
    (byPage.get(item.pageNumber) ?? byPage.set(item.pageNumber, []).get(item.pageNumber)!).push(item);
  }
  const visible = index
    ? new Set([...Object.keys(index.inbox), ...Object.keys(index.regions)].map(Number).filter((n) => Number.isInteger(n) && n > 0))
    : new Set([...byPage.keys()].filter((n) => !hiddenPages.has(n)));
  const groups: WorkspaceItemsGroup[] = [];
  for (const page of [...visible].sort((a, b) => a - b)) {
    const fromIndex = index ? (index.inbox[String(page)] ?? []) as InboxEntry[] : [];
    const indexed = new Map(fromIndex.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
    const entries: InboxEntry[] = [];
    const tagRows: Record<string, number> = {};
    for (const s of byPage.get(page) ?? []) {
      const base = summaryEntry(s);
      if (!base) continue;
      if (typeof s.tagRows === "number") tagRows[s.id] = s.tagRows;
      const derived = indexed.get(s.id);
      // The summary carries the display fields; the derived slice carries the state and the K58 region link.
      entries.push(derived ? { ...base, state: derived.state, ...(derived.regionId ? { regionId: derived.regionId } : {}) } : base);
      indexed.delete(s.id);
    }
    for (const e of indexed.values()) if (e.origin === "proposal" || e.origin === "text-region") entries.push(e);
    const regions = (index ? (index.regions[String(page)] ?? []) : []).map(indexRegion).filter((r): r is RegionCandidate => !!r);
    const group = assembleGroup(page, { entries, regions, tagRows });
    if (group.items.length + group.lowConfidence.length > 0) groups.push(group);
  }
  return groups;
}

// ── scope=sheet (one page row) ──────────────────────────────────────────────────────────────────────

function lowKind(category: unknown): StructureKind {
  if (category === "keynote-table") return "keynote";
  if (category === "symbol-legend") return "legend";
  return "schedule";
}

/** `classifiedTables` and `ensembleRegions` (LTWH, converted here: E-4) as low-confidence candidates. */
export function lowCandidates(pi: Rec): LowCandidate[] {
  const out: LowCandidate[] = [];
  for (const t of records(pi.classifiedTables)) {
    if (!isBox(t.bbox) || t.category === "general-notes" || t.category === "spec-text") continue; // text blocks come from textRegions
    const b = ltwhToMinMax(t.bbox);
    out.push({ id: `ct:${b.map((v) => v.toFixed(3)).join(",")}`, origin: "classified-table", kind: lowKind(t.category), b, title: str(t.headerText), p: num(t.confidence) ?? 0 });
  }
  for (const e of records(pi.ensembleRegions)) {
    if (!isBox(e.bbox)) continue;
    const b = ltwhToMinMax(e.bbox);
    out.push({ id: `ens:${b.map((v) => v.toFixed(3)).join(",")}`, origin: "ensemble", kind: lowKind(e.category), b, title: str(e.category), p: num(e.tableProbability) ?? 0 });
  }
  return out;
}

/** The page's saved regions as merge candidates (stored MinMax, K04). */
export function pageRegions(pi: Rec): RegionCandidate[] {
  const out: RegionCandidate[] = [];
  for (const r of records(pi.parsedRegions)) {
    const id = str(r.id);
    if (!id || !isBox(r.bbox)) continue;
    const links = asObject(asObject(r.data).links);
    out.push({
      regionId: id, kind: KINDS.includes(r.type as StructureKind) ? (r.type as StructureKind) : "schedule", b: r.bbox,
      title: str(r.category), origin: Object.keys(links).length > 0 && links.origin === "workspace" ? "workspace" : "classic",
      ...(str(links.proposalId) ? { proposalId: str(links.proposalId)! } : {}),
      ...(str(r.sourceTextRegionId) ? { sourceTextRegionId: str(r.sourceTextRegionId)! } : {}),
    });
  }
  return out;
}

function proposalTagRows(pi: Rec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of records(asObject(pi.classifierProposals).proposals)) {
    const rows = asObject(p.tagMap).rows;
    if (typeof p.id === "string" && Array.isArray(rows)) out[p.id] = rows.length;
  }
  return out;
}

// ── route ───────────────────────────────────────────────────────────────────────────────────────────

export interface ItemsQuery {
  scope: "all" | "sheet";
  page?: number;
}

export async function getWorkspaceItems(project: ProjectAccessRow, _session: AuthSession | null, query: ItemsQuery): Promise<WorkspaceItemsResponse> {
  if (project.isDemo) throw new ApiError("FORBIDDEN", "Demo projects have no workspace");
  if (query.scope === "sheet") {
    if (!query.page) throw new ApiError("VALIDATION", "scope=sheet requires page");
    return sheetItems(project.id, query.page);
  }
  const [row] = await db
    .select({
      proposals: sql<unknown>`${projects.projectIntelligence}->'proposals'->'items'`,
      inbox: sql<unknown>`${projects.projectIntelligence}->'structureIndex'->'inbox'`,
      regions: sql<unknown>`${projects.projectIntelligence}->'structureIndex'->'regions'`,
    })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);
  const summary = Array.isArray(row?.proposals) ? (row!.proposals as ProposalSummaryItem[]) : [];
  const inbox = row?.inbox && typeof row.inbox === "object" && !Array.isArray(row.inbox) ? (row.inbox as Record<string, InboxSlim[]>) : null;
  if (inbox) {
    const regions = asObject(row?.regions) as Record<string, StructureIndexRegion[]>;
    return { scope: "all", indexReady: true, threshold: LOW_CONFIDENCE_SCORE, groups: assembleAll(summary, { inbox, regions }) };
  }
  // Transitional (no derived index yet): one slim select of the hidden page numbers.
  const hidden = summary.length === 0 ? [] : await db
    .select({ pageNumber: pages.pageNumber })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), sql`NOT (${visiblePage(pages.pageIntelligence)})`));
  return {
    scope: "all", indexReady: false, threshold: LOW_CONFIDENCE_SCORE,
    groups: assembleAll(summary, null, new Set(hidden.map((h) => h.pageNumber))),
  };
}

async function sheetItems(projectId: number, pageNumber: number): Promise<WorkspaceItemsResponse> {
  const key = String(pageNumber);
  const [row] = await db
    .select({
      hidden: sql<boolean>`NOT (${visiblePage(pages.pageIntelligence)})`,
      textRegions: sql<unknown>`${pages.pageIntelligence}->'textRegions'`,
      rejectedTextRegionIds: sql<unknown>`${pages.pageIntelligence}->'rejectedTextRegionIds'`,
      textRegionVerdicts: sql<unknown>`${pages.pageIntelligence}->'textRegionVerdicts'`,
      parsedRegions: sql<unknown>`${pages.pageIntelligence}->'parsedRegions'`,
      classifierProposals: sql<unknown>`${pages.pageIntelligence}->'classifierProposals'`,
      proposalVerdicts: sql<unknown>`${pages.pageIntelligence}->'proposalVerdicts'`,
      classifiedTables: sql<unknown>`${pages.pageIntelligence}->'classifiedTables'`,
      ensembleRegions: sql<unknown>`${pages.pageIntelligence}->'ensembleRegions'`,
      prev: sql<unknown>`(select ${projects.projectIntelligence}->'structureIndex'->'inbox'->(${key}::text) from ${projects} where ${projects.id} = ${projectId})`,
    })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Page not found");
  const base = { scope: "sheet" as const, page: pageNumber, indexReady: true, threshold: LOW_CONFIDENCE_SCORE };
  if (row.hidden) return { ...base, groups: [] };
  const { hidden: _h, prev, ...pi } = row;
  const entries = deriveInboxForPage({ page: pageNumber, pageIntelligence: pi, prev: Array.isArray(prev) ? (prev as InboxSlim[]) : null });
  const group = assembleGroup(pageNumber, {
    entries, regions: pageRegions(pi as Rec), low: lowCandidates(pi as Rec), tagRows: proposalTagRows(pi as Rec),
  });
  return { ...base, groups: [group] };
}
