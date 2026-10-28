"use client";

// [TP-3 WP-3.M] Accept: POST /api/projects/[id]/parse-engine/commit (WP-3.G's route) through `persistFetchResult`,
// which resolves on a 409 so its body can be read (§1.6 rule 6). The server re-runs `recipe`, applies `ops` on top
// (re-matching ids against `base`) and stores that; it never takes a client model. One outcome per answer:
//   200                    → adopt the server's page intelligence, summaries, CSI spatial map and the tag rows
//                            (`adoptServerYoloTags`, no reload), invalidate the inbox, discard the draft (WP-3.L
//                            verify LOW-4: a committed op list must never be re-applied on reopen);
//   409 reason conflict    → ConflictDialog (Replace pre-selected = re-send with that region's id, revision and
//                            viewHash; "Keep both" = `onConflict:"keep-both"`; K36, C3-m2);
//   409 reason rebased     → RebaseNote (the rebased model already has the ops applied; C3-m1);
//   409 reason paid-expired→ offer "Textract this crop again ($)" (a commit never pays; it reads the crop cache only);
//   409 reason stale       → the region changed since it was opened; "Reload item" adopts its current revision;
//   409 reason ops-lost    → a correction no longer lands on the re-parse: the commit is refused.
// Re-saving a region always carries its `revision` (0 for a region saved by the classic tools, as WP-3.G counts
// it) and the `viewHash` of the view the draft was loaded on (PLAN §1.1 row 7), read from the page window or, for
// a page outside it, from that page's read.
// Also the verdict writes the KindBar sends ("Not a table", "Table, not a schedule", Undo) through WP-3.F's
// verdict route, and the bulk "Accept all Notes/Specs ≥ agreement x".

import type { QueryClient } from "@tanstack/react-query";
import { apiErrorMessage, persistFetch, persistFetchResult } from "@/lib/client-persist";
import { refreshPageCsiSpatialMapForTarget } from "@/lib/csi-spatial-refresh-target";
import { viewHash } from "@/lib/parse-engine/legacy-view";
import type { BboxMinMax, CorrectionOp, ParseRecipe, StructureKind, StructureModel } from "@/lib/parse-engine/types";
import { ensurePageIntelligence, readPageIntelligence, setPageIntelligenceForPage } from "@/queries/usePageWindow";
import { seedSummariesCache } from "@/queries/useSummaries";
import { invalidateWorkspaceItems } from "@/queries/useWorkspaceItems";
import { adoptServerYoloTags } from "@/queries/useYoloTags";
import { draftFor, originOf, parseItem, parseRequestFor } from "@/queries/useEngineParse";
import { useTablesWorkspaceStore, type WorkspaceDraft, type WorkspaceItemRef } from "@/stores/tablesWorkspaceStore";
import type { PageIntelligence, ProjectSummaries, YoloTag } from "@/types";

const base = (publicId: string) => `/api/projects/${encodeURIComponent(publicId)}/parse-engine`;
export const commitUrl = (publicId: string) => `${base(publicId)}/commit`;
export const verdictUrl = (publicId: string) => `${base(publicId)}/verdict`;

// ── wire ──────────────────────────────────────────────────────────────────────────────────────────
// ⚠ MIRROR, field for field, of WP-3.G's `src/lib/parse-engine/types-commit.ts` (tp/wp-3-g 2f214a8). That file is
// a sibling WP's (§5.1: no shared files inside a group), so it is not on this branch. AT INTEGRATION delete these
// five declarations and write `export type { CommitRequest, TagSummary, CommitTagsDelta, CommitResponse,
// CommitRefusal } from "@/lib/parse-engine/types-commit";` — the tests also check the body against a copy of
// 3.G's `zCommitBody`, to be swapped for the real one then.

export interface CommitRequest {
  recipe: ParseRecipe;
  ops: CorrectionOp[];
  base?: StructureModel;
  evidenceHash?: string;
  regionId?: string;
  revision?: number;
  viewHash?: string;
  onConflict?: "keep-both";
  tableName?: string;
  links?: { proposalId?: string; textRegionKey?: string; continues?: string };
  secondsToAccept?: number;
}

/** "Mapped 14 tags · 212 hits · 3 with none" (C3-M2). Absent when the model has no tag keys. */
export interface TagSummary { keys: number; tags: number; hits: number; none: number; noneKeys: string[]; scope: "sheet" | "project" }

export interface CommitTagsDelta { rows: unknown[]; removed: string[]; replacedRegionIds: string[] }

export interface CommitResponse {
  ok: true;
  regionId: string;
  revision: number;
  kind: StructureKind;
  parsedRegion: unknown;
  updatedIntelligence: unknown;
  csiCodeCount: number;
  tagSummary?: TagSummary;
  tags: CommitTagsDelta;
  summaries: unknown;
}

export type CommitRefusal =
  | { reason: "stale"; regionId: string; revision: number | null; viewHash?: string }
  | { reason: "conflict"; conflict: { regionId: string; kind: StructureKind; title: string; revision: number; viewHash: string; bbox: BboxMinMax } }
  | { reason: "rebased"; rebased: StructureModel; changedRows: number | null; evidenceHash: string }
  | { reason: "ops-lost"; lost: { index: number; op: CorrectionOp["op"] }[] }
  | { reason: "paid-expired"; paidExpired: true; methods: string[] };

// ── outcomes ─────────────────────────────────────────────────────────────────────────────────────

export type ConflictInfo = Extract<CommitRefusal, { reason: "conflict" }>["conflict"];

export type CommitOutcome =
  | { status: "committed"; regionId: string; revision: number; tagSummary: TagSummary | null }
  | { status: "conflict"; conflict: ConflictInfo; message: string }
  | { status: "rebased"; model: StructureModel; evidenceHash: string; changedRows: number | null }
  | { status: "paid-expired"; methods: string[]; message: string }
  | { status: "stale"; regionId: string; revision: number | null; viewHash?: string; message: string }
  | { status: "ops-lost"; lost: { index: number; op: CorrectionOp["op"] }[]; message: string }
  | { status: "error"; message: string; httpStatus: number };

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : []);

function readTagSummary(v: unknown): TagSummary | null {
  const t = obj(v);
  if (!t || ![t.keys, t.tags, t.hits, t.none].every((n) => typeof n === "number")) return null;
  return {
    keys: t.keys as number, tags: t.tags as number, hits: t.hits as number, none: t.none as number,
    noneKeys: strings(t.noneKeys), scope: t.scope === "sheet" ? "sheet" : "project",
  };
}

/** Classify a commit answer by WP-3.G's `reason` (pure; exported for tests). An unknown 409 is an error. */
export function classifyCommitResponse(status: number, body: unknown): CommitOutcome {
  const top = obj(body);
  if (status >= 200 && status < 300 && top && typeof top.regionId === "string") {
    return {
      status: "committed", regionId: top.regionId,
      revision: typeof top.revision === "number" ? top.revision : 0,
      tagSummary: readTagSummary(top.tagSummary),
    };
  }
  const message = apiErrorMessage(body) ?? `Accept failed (HTTP ${status})`;
  if (status === 409 && top) {
    switch (top.reason) {
      case "conflict": {
        const c = obj(top.conflict);
        if (c && typeof c.regionId === "string" && typeof c.revision === "number" && typeof c.viewHash === "string") {
          return {
            status: "conflict", message,
            conflict: {
              regionId: c.regionId, revision: c.revision, viewHash: c.viewHash,
              kind: c.kind as StructureKind, title: typeof c.title === "string" ? c.title : "",
              bbox: (Array.isArray(c.bbox) ? c.bbox : [0, 0, 0, 0]) as BboxMinMax,
            },
          };
        }
        break;
      }
      case "rebased":
        if (obj(top.rebased) && typeof top.evidenceHash === "string") {
          return {
            status: "rebased", model: top.rebased as StructureModel, evidenceHash: top.evidenceHash,
            changedRows: typeof top.changedRows === "number" ? top.changedRows : null,
          };
        }
        break;
      case "paid-expired":
        return { status: "paid-expired", methods: strings(top.methods), message };
      case "ops-lost":
        return { status: "ops-lost", lost: Array.isArray(top.lost) ? (top.lost as { index: number; op: CorrectionOp["op"] }[]) : [], message };
      case "stale":
        if (typeof top.regionId === "string") {
          return {
            status: "stale", regionId: top.regionId, message,
            revision: typeof top.revision === "number" ? top.revision : null,
            ...(typeof top.viewHash === "string" ? { viewHash: top.viewHash } : {}),
          };
        }
        break;
      default:
        break;
    }
  }
  return { status: "error", message, httpStatus: status };
}

// ── the region a re-save starts from ─────────────────────────────────────────────────────────────

export interface RegionBaseline { revision: number; viewHash: string }

/**
 * A saved region's `links.revision` (0 when it has none: a region saved by the classic tools, which WP-3.G counts
 * as revision 0) and the `viewHash` of its stored data, or undefined when this page intelligence does not hold it.
 */
export function regionBaseline(pi: unknown, regionId: string | undefined): RegionBaseline | undefined {
  if (!regionId) return undefined;
  const regions = obj(pi)?.parsedRegions;
  if (!Array.isArray(regions)) return undefined;
  const region = regions.find((r) => obj(r)?.id === regionId) as { data?: { links?: { revision?: unknown } } } | undefined;
  if (!region) return undefined;
  const rev = region.data?.links?.revision;
  return { revision: typeof rev === "number" && Number.isInteger(rev) && rev >= 0 ? rev : 0, viewHash: viewHash(region.data) };
}

/**
 * A re-save draft with no baseline yet (its page was outside the page window when it opened) gets one here: from
 * the window, else from a read of that one page. Unresolved, the commit still sends revision 0 and the server
 * answers 409 stale instead of overwriting.
 */
export async function withRegionBaseline(qc: QueryClient, publicId: string, item: WorkspaceItemRef, draft: WorkspaceDraft): Promise<WorkspaceDraft> {
  const regionId = draft.regionId ?? item.regionId;
  if (!regionId || draft.revision !== undefined) return draft;
  let found = regionBaseline(readPageIntelligence(qc, publicId, draft.page), regionId);
  if (!found) {
    const pi = await ensurePageIntelligence(qc, { publicId, pageNumber: draft.page, isDemo: false }).catch(() => undefined);
    found = regionBaseline(pi, regionId);
  }
  return found ? { ...draft, regionId, ...found } : draft;
}

// ── the body ─────────────────────────────────────────────────────────────────────────────────────

export interface CommitExtra {
  /** Replace after a conflict: the overlapped region's id, revision and viewHash (WP-3.G's Replace). */
  target?: { regionId: string; revision: number; viewHash?: string };
  onConflict?: "keep-both";
  /** The rebased evidence a RebaseNote confirm accepts. */
  evidenceHash?: string;
  secondsToAccept?: number;
}

/**
 * WP-3.G takes the accepted class from the last `set-kind` op (or the model's own `classId`), so a class the item
 * carries (the proposal's, or the kind suggestion the user took) rides on that op; without it the class is lost.
 */
export function opsWithClass(ops: readonly CorrectionOp[], kind: StructureKind, classId: string | undefined, model: StructureModel): CorrectionOp[] {
  const out = [...ops];
  if (!classId || ("classId" in model && model.classId === classId)) return out;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const op = out[i];
    if (op.op === "set-kind") {
      out[i] = { ...op, classId };
      return out;
    }
  }
  out.push({ op: "set-kind", kind, classId });
  return out;
}

/** WP-3.G's `CommitRequest` for the open item (built from its draft; the draft must hold a result). */
export function buildCommitBody(item: WorkspaceItemRef & { origin?: unknown }, draft: WorkspaceDraft, extra: CommitExtra = {}): CommitRequest {
  if (!draft.result) throw new Error("Nothing to accept yet: the item has not been parsed.");
  const origin = originOf(item);
  const request = draft.request ?? parseRequestFor(item, draft, { budget: draft.result.stamp.budget });
  const recipeOrigin: ParseRecipe["origin"] =
    origin === "proposal" || origin === "text-region" || origin === "draw" ? origin : origin === "region" ? "saved" : "draw";
  const regionId = draft.regionId ?? item.regionId;
  const target = extra.target ?? (regionId ? { regionId, revision: draft.revision ?? 0, viewHash: draft.viewHash } : null);
  const links = {
    ...(item.proposalId ? { proposalId: item.proposalId } : {}),
    ...(origin === "text-region" ? { textRegionKey: item.id } : {}),
    ...(draft.continues ? { continues: draft.continues } : {}),
  };
  return {
    recipe: { request, origin: recipeOrigin },
    ops: opsWithClass(draft.ops, draft.kind, draft.classId, draft.result.model),
    base: draft.result.model,
    evidenceHash: extra.evidenceHash ?? draft.result.stamp.evidenceHash,
    ...(target ? { regionId: target.regionId, revision: target.revision, ...(target.viewHash ? { viewHash: target.viewHash } : {}) } : {}),
    ...(extra.onConflict ? { onConflict: extra.onConflict } : {}),
    ...(Object.keys(links).length > 0 ? { links } : {}),
    ...(extra.secondsToAccept !== undefined ? { secondsToAccept: extra.secondsToAccept } : {}),
  };
}

export interface CommitTarget {
  publicId: string;
  isDemo: boolean;
  itemKey: string;
}

/** POST the commit and, on success, adopt every server answer into the client caches. */
export async function commitStructure(qc: QueryClient, target: CommitTarget, body: CommitRequest): Promise<CommitOutcome> {
  const { publicId, isDemo, itemKey } = target;
  if (isDemo || !publicId) return { status: "error", message: "Saving is not available in a demo project.", httpStatus: 403 };
  const res = await persistFetchResult<unknown>(commitUrl(publicId), body, "POST");
  const outcome = classifyCommitResponse(res.status, res.body);
  if (outcome.status !== "committed") return outcome;
  const ok = res.body as Partial<CommitResponse>;
  const pageNumber = body.recipe.request.page;
  if (obj(ok.updatedIntelligence)) setPageIntelligenceForPage(qc, publicId, pageNumber, ok.updatedIntelligence as PageIntelligence);
  if (obj(ok.summaries)) seedSummariesCache(qc, publicId, ok.summaries as ProjectSummaries);
  refreshPageCsiSpatialMapForTarget(qc, publicId, pageNumber);
  const tags = obj(ok.tags);
  if (tags && Array.isArray(tags.rows) && Array.isArray(tags.replacedRegionIds)) {
    adoptServerYoloTags(qc, publicId, tags.rows as YoloTag[], strings(tags.replacedRegionIds), strings(tags.removed));
  }
  useTablesWorkspaceStore.getState().discardDraft(itemKey);
  invalidateWorkspaceItems(qc, publicId);
  return outcome;
}

// ── verdicts (WP-3.F `POST/DELETE …/parse-engine/verdict`) ───────────────────────────────────────

export type ItemVerdict = { verdict: "reject" } | { verdict: "accept"; classId: string };

/** The verdict body for a proposal or a text-region item (WP-3.F `WorkspaceVerdictRequest`). */
export function verdictBody(item: WorkspaceItemRef & { origin?: unknown }, v: ItemVerdict): Record<string, unknown> {
  if (item.proposalId) {
    return { pageNumber: item.page, proposalId: item.proposalId, verdict: v.verdict, ...(v.verdict === "accept" ? { classId: v.classId } : {}) };
  }
  return { pageNumber: item.page, itemId: item.id, origin: originOf(item), kind: item.kind, bbox: [...item.b], verdict: v.verdict };
}

/** Which verdicts the route takes for this item: proposals both, text regions reject only (WP-3.F LOW-1). */
export function verdictsFor(item: WorkspaceItemRef & { origin?: unknown }): { reject: boolean; notASchedule: boolean } {
  const origin = originOf(item);
  return { reject: origin === "proposal" || origin === "text-region", notASchedule: origin === "proposal" && !!item.proposalId };
}

export async function recordItemVerdict(qc: QueryClient, publicId: string, item: WorkspaceItemRef, v: ItemVerdict): Promise<void> {
  try {
    await persistFetch(verdictUrl(publicId), verdictBody(item, v), "POST");
  } finally {
    invalidateWorkspaceItems(qc, publicId);
  }
}

export async function undoItemVerdict(qc: QueryClient, publicId: string, item: WorkspaceItemRef): Promise<void> {
  const body = item.proposalId ? { pageNumber: item.page, proposalId: item.proposalId } : { pageNumber: item.page, itemId: item.id };
  try {
    await persistFetch(verdictUrl(publicId), body, "DELETE");
  } finally {
    invalidateWorkspaceItems(qc, publicId);
  }
}

// ── bulk "Accept all Notes/Specs ≥ agreement x" (C3-M5b) ─────────────────────────────────────────

export interface BulkAcceptReport {
  saved: number;
  /** Below the agreement bar, or with corrections pending: left for review, not committed. */
  skipped: number;
  /** The first item that did not commit cleanly (a conflict, a rebase, a refused parse…): the run stops there. */
  stopped: { item: WorkspaceItemRef; reason: string } | null;
}

/**
 * Parse each item (instant; usually cached by the prefetch) and commit it with no ops when its fused agreement is
 * at least `minAgreement`. Sequential — each commit takes the project lock — and it stops at the first item that
 * does not commit cleanly, leaving the rest untouched.
 */
export async function bulkAcceptItems(
  qc: QueryClient,
  target: Omit<CommitTarget, "itemKey">,
  items: readonly WorkspaceItemRef[],
  minAgreement: number,
  onProgress?: (done: number) => void,
): Promise<BulkAcceptReport> {
  const report: BulkAcceptReport = { saved: 0, skipped: 0, stopped: null };
  let done = 0;
  for (const item of items) {
    if ((useTablesWorkspaceStore.getState().drafts[item.id]?.ops.length ?? 0) > 0) {
      report.skipped++; // the user has corrections pending on this one: it needs its own review
      onProgress?.(++done);
      continue;
    }
    const parsed = await parseItem(qc, target.publicId, item, { budget: "instant" });
    if (parsed.status !== "applied") {
      report.stopped = { item, reason: parsed.status === "error" ? parsed.error.message : "the parse was superseded" };
      break;
    }
    if (!(parsed.result.model.quality.agreement >= minAgreement)) {
      report.skipped++;
    } else {
      const held = useTablesWorkspaceStore.getState().drafts[item.id] ?? { ...draftFor(item), result: parsed.result };
      const draft = await withRegionBaseline(qc, target.publicId, item, held);
      const outcome = await commitStructure(qc, { ...target, itemKey: item.id }, buildCommitBody(item, { ...draft, ops: [] }));
      if (outcome.status !== "committed") {
        report.stopped = { item, reason: outcome.status === "conflict" ? "it overlaps a saved region" : "message" in outcome ? outcome.message : outcome.status };
        break;
      }
      report.saved++;
    }
    onProgress?.(++done);
  }
  return report;
}
