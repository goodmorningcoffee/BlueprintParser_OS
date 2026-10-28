"use client";

// [TP-3 WP-3.M] Accept: POST /api/projects/[id]/parse-engine/commit (WP-3.G's route) through `persistFetchResult`,
// which resolves on a 409 so its body can be read (§1.6 rule 6). One outcome per answer (PLAN §2.1, §3.2):
//   2xx                → adopt the server's page intelligence, summaries, CSI spatial map and the auto-mapped tag
//                        rows (`adoptServerYoloTags`, no reload), invalidate the inbox, discard the draft (WP-3.L
//                        verify LOW-4: a committed op list must never be re-applied on reopen);
//   409 {conflict}     → ConflictDialog (Replace pre-selected, ⏎ confirms; "Keep both" secondary; K36, C3-m2);
//   409 {rebased}      → RebaseNote ("n rows changed after re-scan · Accept again ⏎"; C3-m1);
//   409 {paidExpired}  → offer "Textract this crop again ($)" (a commit never pays; it reads the crop cache only);
//   409 otherwise      → the region changed since it was opened (stale revision): reload it.
// Also the verdict writes the KindBar sends ("Not a table", "Table, not a schedule", Undo) through WP-3.F's
// verdict route, and the bulk "Accept all Notes/Specs ≥ agreement x", which commits one item at a time and
// stops on the first answer that is not a clean commit.
//
// ⚠ INTEGRATION (WP-3.G): the commit route is a sibling work package in the same group, so its wire is not on
// this branch. `CommitRequestBody` / `CommitSuccessBody` below are the client's side of PLAN §2.1 + WP-3.G steps
// 1–11. The 409 details are read at the top level of the body, or inside the `error` envelope, or under
// `error.details` — whichever WP-3.G picks; reconcile and narrow this reader when 3.G merges.

import type { QueryClient } from "@tanstack/react-query";
import { apiErrorMessage, persistFetch, persistFetchResult } from "@/lib/client-persist";
import { refreshPageCsiSpatialMapForTarget } from "@/lib/csi-spatial-refresh-target";
import type { CorrectionOp, ParseRecipe, StructureModel } from "@/lib/parse-engine/types";
import { setPageIntelligenceForPage } from "@/queries/usePageWindow";
import { seedSummariesCache } from "@/queries/useSummaries";
import { invalidateWorkspaceItems } from "@/queries/useWorkspaceItems";
import { adoptServerYoloTags } from "@/queries/useYoloTags";
import { draftFor, originOf, parseItem, parseRequestFor, type ItemOrigin } from "@/queries/useEngineParse";
import { useTablesWorkspaceStore, type WorkspaceDraft, type WorkspaceItemRef } from "@/stores/tablesWorkspaceStore";
import type { PageIntelligence, ProjectSummaries, YoloTag } from "@/types";

const base = (publicId: string) => `/api/projects/${encodeURIComponent(publicId)}/parse-engine`;
export const commitUrl = (publicId: string) => `${base(publicId)}/commit`;
export const verdictUrl = (publicId: string) => `${base(publicId)}/verdict`;

export interface CommitRequestBody {
  pageNumber: number;
  /** The inbox item key (proposal id, `tr:…`, `draw:…` or a region id). */
  itemId: string;
  origin: ItemOrigin;
  /** The request that produced the previewed result; the server re-runs it outside the lock (paid: cache only). */
  recipe: ParseRecipe;
  /** Id-keyed corrections, applied after fusion (E-2). */
  ops: CorrectionOp[];
  /** The evidence the preview was made from; a changed hash makes the server rebase (409 {rebased}). */
  evidenceHash: string;
  /** Saving over an existing region: its id and the revision the user started from (stale → 409). */
  regionId?: string;
  revision?: number;
  proposalId?: string;
  textRegionKey?: string;
  /** Region on another sheet this table continues (`links.continues`, K11, C2-M10). */
  continues?: string;
  classId?: string;
  /** The answer to a 409 {conflict}: replace the overlapping region, or keep both. */
  onConflict?: "replace" | "keep-both";
  /** The one-click confirm of a 409 {rebased}. */
  acceptRebased?: true;
  secondsToAccept?: number;
  /** A "+ Region" box: a table the detector missed (label `missedDetection`). */
  missedDetection?: true;
}

/** "Mapped 14 tags · 212 hits · 3 with none" (WP-3.G step 10). */
export interface TagSummary { tags: number; hits: number; withNone: number; scope?: "sheet" | "project" }

export interface CommitSuccessBody {
  ok: true;
  regionId: string;
  revision: number;
  updatedIntelligence?: PageIntelligence;
  summaries?: ProjectSummaries | null;
  tagSummary?: TagSummary | null;
  /** The projected tag rows that replaced this region's tags (`replace-for-region`), for `adoptServerYoloTags`. */
  yoloTags?: { rows: YoloTag[]; replacedRegionIds: string[]; removedIds?: string[] };
}

export interface ConflictInfo { regionId: string; revision?: number; title?: string; origin?: "workspace" | "classic" }

export type CommitOutcome =
  | { status: "committed"; regionId: string; revision: number; tagSummary: TagSummary | null }
  | { status: "conflict"; conflict: ConflictInfo }
  | { status: "rebased"; model: StructureModel; evidenceHash: string | null; changedRows: number }
  | { status: "paid-expired"; methods: string[]; message: string }
  | { status: "stale-revision"; message: string }
  | { status: "error"; message: string; httpStatus: number };

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A 409 detail, wherever the route put it: the body, the `error` envelope, or `error.details`. */
function detail(body: unknown, key: string): unknown {
  const top = obj(body);
  const err = obj(top?.error);
  return top?.[key] ?? err?.[key] ?? obj(err?.details)?.[key];
}

function readTagSummary(v: unknown): TagSummary | null {
  const t = obj(v);
  if (!t || typeof t.tags !== "number" || typeof t.hits !== "number") return null;
  return {
    tags: t.tags, hits: t.hits, withNone: typeof t.withNone === "number" ? t.withNone : 0,
    ...(t.scope === "sheet" || t.scope === "project" ? { scope: t.scope } : {}),
  };
}

/** Classify a commit answer (pure; exported for tests). */
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
  if (status !== 409) return { status: "error", message, httpStatus: status };
  const conflict = obj(detail(body, "conflict"));
  if (conflict && typeof conflict.regionId === "string") {
    return {
      status: "conflict",
      conflict: {
        regionId: conflict.regionId,
        ...(typeof conflict.revision === "number" ? { revision: conflict.revision } : {}),
        ...(typeof conflict.title === "string" ? { title: conflict.title } : {}),
        ...(conflict.origin === "workspace" || conflict.origin === "classic" ? { origin: conflict.origin } : {}),
      },
    };
  }
  const rebased = obj(detail(body, "rebased"));
  if (rebased) {
    const model = obj(rebased.model) ?? rebased;
    const stamp = obj(rebased.stamp);
    const hash = rebased.evidenceHash ?? stamp?.evidenceHash ?? detail(body, "evidenceHash");
    const changed = detail(body, "changedRows") ?? rebased.changedRows;
    return {
      status: "rebased", model: model as unknown as StructureModel,
      evidenceHash: typeof hash === "string" ? hash : null,
      changedRows: typeof changed === "number" ? changed : 0,
    };
  }
  const paid = detail(body, "paidExpired");
  if (paid !== undefined && paid !== null && paid !== false) {
    const methods = Array.isArray(paid) ? paid.filter((m): m is string => typeof m === "string")
      : Array.isArray(obj(paid)?.methods) ? (obj(paid)!.methods as unknown[]).filter((m): m is string => typeof m === "string") : [];
    return { status: "paid-expired", methods, message };
  }
  return { status: "stale-revision", message };
}

/** Everything the commit needs from the open item (built from its draft; the draft must hold a result). */
export function buildCommitBody(
  item: WorkspaceItemRef & { origin?: unknown },
  draft: WorkspaceDraft,
  extra: Partial<Pick<CommitRequestBody, "onConflict" | "acceptRebased" | "secondsToAccept" | "regionId" | "revision" | "evidenceHash">> = {},
): CommitRequestBody {
  if (!draft.result) throw new Error("Nothing to accept yet: the item has not been parsed.");
  const origin = originOf(item);
  const request = draft.request ?? parseRequestFor(item, draft, { budget: draft.result.stamp.budget });
  const recipeOrigin: ParseRecipe["origin"] =
    origin === "proposal" || origin === "text-region" || origin === "draw" ? origin : origin === "region" ? "saved" : "draw";
  const regionId = extra.regionId ?? draft.regionId ?? item.regionId;
  const revision = extra.revision ?? draft.revision;
  return {
    pageNumber: draft.page,
    itemId: item.id,
    origin,
    recipe: { request, origin: recipeOrigin },
    ops: [...draft.ops],
    evidenceHash: extra.evidenceHash ?? draft.result.stamp.evidenceHash,
    ...(regionId ? { regionId } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(item.proposalId ? { proposalId: item.proposalId } : {}),
    ...(origin === "text-region" ? { textRegionKey: item.id } : {}),
    ...(draft.continues ? { continues: draft.continues } : {}),
    ...(draft.classId ? { classId: draft.classId } : {}),
    ...(extra.onConflict ? { onConflict: extra.onConflict } : {}),
    ...(extra.acceptRebased ? { acceptRebased: true as const } : {}),
    ...(extra.secondsToAccept !== undefined ? { secondsToAccept: extra.secondsToAccept } : {}),
    ...(origin === "draw" ? { missedDetection: true as const } : {}),
  };
}

export interface CommitTarget {
  publicId: string;
  isDemo: boolean;
  itemKey: string;
}

/** POST the commit and, on success, adopt every server answer into the client caches. */
export async function commitStructure(qc: QueryClient, target: CommitTarget, body: CommitRequestBody): Promise<CommitOutcome> {
  const { publicId, isDemo, itemKey } = target;
  if (isDemo || !publicId) return { status: "error", message: "Saving is not available in a demo project.", httpStatus: 403 };
  const res = await persistFetchResult<unknown>(commitUrl(publicId), body, "POST");
  const outcome = classifyCommitResponse(res.status, res.body);
  if (outcome.status !== "committed") return outcome;
  const ok = res.body as CommitSuccessBody;
  if (obj(ok.updatedIntelligence)) setPageIntelligenceForPage(qc, publicId, body.pageNumber, ok.updatedIntelligence as PageIntelligence);
  if (obj(ok.summaries)) seedSummariesCache(qc, publicId, ok.summaries as ProjectSummaries);
  refreshPageCsiSpatialMapForTarget(qc, publicId, body.pageNumber);
  const tags = obj(ok.yoloTags);
  if (tags && Array.isArray(tags.rows) && Array.isArray(tags.replacedRegionIds)) {
    adoptServerYoloTags(qc, publicId, tags.rows as YoloTag[], tags.replacedRegionIds as string[],
      Array.isArray(tags.removedIds) ? (tags.removedIds as string[]) : []);
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
      const draft = useTablesWorkspaceStore.getState().drafts[item.id] ?? { ...draftFor(item), result: parsed.result };
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
