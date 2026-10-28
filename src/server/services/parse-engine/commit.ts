/**
 * POST /api/projects/[id]/parse-engine/commit — the Tables & Notes workspace's Accept (table pipeline PLAN §3.2,
 * §3.3 A/B/C, §1.1 rows 1/2/7/9/10; WP-3.G; C1-D1, C1-D5, C3-M2, C3-m1, C3-m2).
 *
 * The client sends what it parsed (`recipe`) and what it corrected (`ops`); the server never stores a client
 * model. In order:
 *   1. zod + caps (`zCommitBody`; unknown fields such as a forged `machine` snapshot are dropped);
 *   2. OUTSIDE any lock: re-run `recipe` through the run service in `cache-only` mode, so a paid method is read
 *      from the crop cache and a miss is 409 `paid-expired` (a commit never pays twice), then `applyOps` (E-2);
 *   3. evidence changed since the draft (`evidenceHash`): the re-parse used the draft's model as `prior`, so ids
 *      re-match; when every op still lands → 409 `rebased` with the rebased model and `changedRows` for a
 *      one-click confirm; when an op no longer lands → 409 `ops-lost` (refused);
 *      also outside the lock: the region's CSI (company context) and the tag matches (accept-tags);
 *   4. `withProjectWrite` (project row first), then the page row FOR UPDATE (rule 11: project → page);
 *   5. region id: a re-save names its `regionId` + `revision` (stale → 409 `stale`); a new item gets
 *      `sr-${kind}-${page}-${q3(bbox)}`, unless a same-page same-family region overlaps it at IoU ≥ .8 → 409
 *      `conflict` (Replace = re-send with that region's id and revision; Keep both = `onConflict:"keep-both"`);
 *   6. the region: `data = {...legacyView(model), structure, links, engine, recipe, ops}` (E-5);
 *   7. one UPDATE: `parsedRegions` (`||`), `parseLabels[regionId]` (`jsonb_set`, a `committed` label whose
 *      `machine` snapshot is recomputed here from the re-run), the proposal verdict / text-region verdict;
 *   8. the proposal verdict is `accept` WITH the accepted classId (K58), mirrored on the project's proposal list;
 *   9. page CSI = codes the page owns (trigger-bearing text codes, YOLO class codes) ∪ every current region's
 *      codes; a replaced region's codes that nothing else carries are dropped (K50, `page-csi.ts`);
 *  10. tags: `replace-for-region` with the accept-tags rows (`links {regionId,rowId,kind}`); the response carries
 *      the rows for `adoptServerYoloTags` and the AcceptBar summary;
 *  11. after the transaction: `computeProjectSummaries` (which derives `PJ.structureIndex`).
 * Demo projects are refused (assertProjectWritable); the route is off while `tools.workspace` is not `engine`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { pages, projects } from "@/lib/db/schema";
import type { AuthSession, ProjectAccessRow, ProjectAccessScope } from "@/lib/api-utils";
import { detectCsiCodes, detectCsiFromGrid } from "@/lib/csi-detect";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { getCompanyCsiContext, type CompanyCsiContext } from "@/lib/csi-company-db";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { logger } from "@/lib/logger";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";
import { PARSED_REGION_DEFAULT_CONFIDENCE } from "@/lib/spatial-constants";
import { trustedClientIp } from "@/lib/trusted-client-ip";
import { scheduleKind } from "@/lib/classifier-engine/vocabulary";
import type { ClassifierProposal, PageProposalVerdicts } from "@/lib/classifier-engine/types";
import { applyOps as engineApplyOps } from "@/lib/parse-engine/ops";
import { ltwhToMinMax } from "@/lib/parse-engine/geometry";
import { legacyView, viewHash, type LegacyView } from "@/lib/parse-engine/legacy-view";
import { zCorrectionOps, zParseRecipe, zStructureModel } from "@/lib/parse-engine/schema";
import type {
  BboxMinMax,
  CorrectionOp,
  CorrectionOpName,
  CsiRef,
  ParseEngineFlags,
  ParseLabel,
  ParseRecipe,
  ParseResult,
  RegionLinks,
  StructureKind,
  StructureModel,
  TextRegionVerdict,
} from "@/lib/parse-engine/types";
import type { CommitRefusal, CommitResponse, TagSummary } from "@/lib/parse-engine/types-commit";
import type { CsiCode, PageIntelligence, ParsedRegion, TextRegion } from "@/types";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  type ProjectWriteCapability,
  type ProjectWriteTransaction,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import { serializePageWindowIntelligence } from "@/server/services/page-window-serialization";
import { regionSnapshot, snapshotHashOf } from "@/server/services/parse-labels";
import { buildVerdict, findStoredProposal, patchSummaryVerdict } from "@/server/services/proposal-verdicts";
import { applyTagOps, type StoredYoloTag, type TagOpsResult } from "@/server/services/tag-ops";
import {
  acceptTagPlan,
  buildAcceptTagRows,
  computeAcceptTagMatches,
  legacyTagIdsToRetire,
  type AcceptTagMatches,
  type AcceptTagPlan,
} from "./accept-tags";
import { q3Key } from "./crop-cache";
import { readParseEngineFlags } from "./flags";
import { pageCsiAfterRegionChange } from "./page-csi";
import { PaidCropExpiredError, runParse, type ParseCaller, type RunParseInput } from "./run";

// ── request ─────────────────────────────────────────────────────────────────────────────────────

const ID = z.string().min(1).max(300);
/** Not strict on purpose: a field the server computes (`machine`, a label, a stamp) is dropped, never trusted. */
export const zCommitBody = z.object({
  recipe: zParseRecipe,
  ops: zCorrectionOps.default([]),
  base: zStructureModel.optional(),
  evidenceHash: z.string().min(1).max(128).optional(),
  regionId: ID.optional(),
  revision: z.number().int().min(0).optional(),
  onConflict: z.literal("keep-both").optional(),
  tableName: z.string().trim().min(1).max(200).optional(),
  links: z.object({
    proposalId: z.string().min(1).max(256).optional(),
    textRegionKey: z.string().min(1).max(256).optional(),
    continues: z.string().min(1).max(128).optional(),
  }).optional(),
  secondsToAccept: z.number().finite().min(0).max(7 * 24 * 3600).optional(),
}).refine((b) => b.regionId === undefined || b.revision !== undefined, { message: "regionId needs the revision it was loaded at", path: ["revision"] });
export type CommitBody = z.infer<typeof zCommitBody>;

export function parseCommitBody(body: unknown): CommitBody {
  const parsed = zCommitBody.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError("VALIDATION", `Invalid commit: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

// ── refusals (409 with a body the workspace acts on) ───────────────────────────────────────────

export class CommitRefusalError extends ApiError {
  readonly body: CommitRefusal;
  constructor(message: string, body: CommitRefusal) {
    super("CONFLICT", message);
    this.name = "CommitRefusalError";
    this.body = body;
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────────────────────────

const FAMILY: Record<StructureKind, "table" | "paragraphs"> = { schedule: "table", keynote: "table", legend: "table", notes: "paragraphs", spec: "paragraphs" };
export const familyOf = (kind: string): "table" | "paragraphs" => (kind === "notes" || kind === "spec" ? "paragraphs" : "table");

/** A same-page same-family region at IoU ≥ this is the same item (K36, C3-m2). */
export const COMMIT_CONFLICT_IOU = 0.8;

export function iou(a: readonly number[], b: readonly number[]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy;
  return union > 0 ? (ix * iy) / union : 0;
}

const isParagraphDoc = (m: StructureModel): m is Extract<StructureModel, { paragraphs: unknown }> => m.kind === "notes" || m.kind === "spec";

/** The row / column / paragraph ids a model carries (an op lands only on ids that exist). */
function modelIds(model: StructureModel): { rows: Set<string>; cols: Set<string>; paragraphs: Set<string> } {
  if (isParagraphDoc(model)) return { rows: new Set(), cols: new Set(), paragraphs: new Set(model.paragraphs.map((p) => p.id)) };
  return { rows: new Set(model.rows.map((r) => r.id)), cols: new Set(model.cols.map((c) => c.id)), paragraphs: new Set() };
}

/** The ids an op names, by axis. Ops that name no id always land. */
export function opRefs(op: CorrectionOp): { rows: string[]; cols: string[]; paragraphs: string[] } {
  const out = { rows: [] as string[], cols: [] as string[], paragraphs: [] as string[] };
  switch (op.op) {
    case "move-line":
    case "remove-line":
      (op.axis === "rows" ? out.rows : out.cols).push(op.after);
      break;
    case "set-tag-col":
      if (op.col !== null) out.cols.push(op.col);
      break;
    case "set-col-role":
    case "rename-col":
      out.cols.push(op.col);
      break;
    case "edit-cell":
    case "merge-cells":
      out.rows.push(op.row);
      out.cols.push(op.col);
      break;
    case "set-row-key":
      out.rows.push(op.row);
      break;
    case "split-paragraph":
    case "merge-paragraph":
    case "set-paragraph-key":
      out.paragraphs.push(op.p);
      break;
    case "set-csi":
      if (op.target.row !== undefined) out.rows.push(op.target.row);
      if (op.target.p !== undefined) out.paragraphs.push(op.target.p);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Ops whose ids exist neither in the re-parsed model nor in the model after all ops (an id an earlier op
 * minted counts as present). Such an op no longer lands: the commit refuses instead of guessing (C3-m1).
 */
export function lostOps(base: StructureModel, final: StructureModel, ops: readonly CorrectionOp[]): { index: number; op: CorrectionOpName }[] {
  const a = modelIds(base);
  const b = modelIds(final);
  const has = (axis: "rows" | "cols" | "paragraphs", id: string) => a[axis].has(id) || b[axis].has(id);
  const lost: { index: number; op: CorrectionOpName }[] = [];
  ops.forEach((op, index) => {
    const refs = opRefs(op);
    const ok = refs.rows.every((id) => has("rows", id)) && refs.cols.every((id) => has("cols", id)) && refs.paragraphs.every((id) => has("paragraphs", id));
    if (!ok) lost.push({ index, op: op.op });
  });
  return lost;
}

const MOVE_TOL = 0.002;

/** Rows (paragraphs) of `next` that differ from `prev` by id, band or text; null without a `prev`. */
export function changedRows(prev: StructureModel | undefined, next: StructureModel): number | null {
  if (!prev) return null;
  if (isParagraphDoc(next) || isParagraphDoc(prev)) {
    if (!isParagraphDoc(next) || !isParagraphDoc(prev)) return isParagraphDoc(next) ? next.paragraphs.length : next.rows.length;
    const before = new Map(prev.paragraphs.map((p) => [p.id, p]));
    let n = 0;
    const seen = new Set<string>();
    for (const p of next.paragraphs) {
      seen.add(p.id);
      const q = before.get(p.id);
      if (!q || q.text !== p.text || q.key !== p.key || p.b.some((v, i) => Math.abs(v - q.b[i]) > MOVE_TOL)) n += 1;
    }
    for (const id of before.keys()) if (!seen.has(id)) n += 1;
    return n;
  }
  const textOf = (m: Extract<StructureModel, { rows: unknown }>, rowId: string) =>
    m.cells.filter((c) => c.row === rowId).map((c) => `${c.col}=${c.text}`).sort().join("\u0001");
  const before = new Map(prev.rows.map((r) => [r.id, r]));
  let n = 0;
  const seen = new Set<string>();
  for (const r of next.rows) {
    seen.add(r.id);
    const q = before.get(r.id);
    if (!q || Math.abs(q.y0 - r.y0) > MOVE_TOL || Math.abs(q.y1 - r.y1) > MOVE_TOL || textOf(prev, r.id) !== textOf(next, r.id)) n += 1;
  }
  for (const id of before.keys()) if (!seen.has(id)) n += 1;
  return n;
}

/** `sr-${kind}-${page}-${q3(bbox)}` (§2.1 ids); kind-aware, so a schedule and its notes never share an id. */
export function mintRegionId(kind: StructureKind, page: number, bbox: readonly number[]): string {
  return `sr-${kind}-${page}-${q3Key(bbox)}`;
}

/** The stored workspace revision of a region (0 for a classic region, which has no `links`). */
export function regionRevision(region: { data?: unknown } | null | undefined): number {
  const links = (region?.data as { links?: { revision?: unknown } } | undefined)?.links;
  return typeof links?.revision === "number" && Number.isInteger(links.revision) && links.revision >= 0 ? links.revision : 0;
}

const hasWorkspaceLinks = (region: { data?: unknown } | null | undefined): boolean =>
  !!(region?.data as { links?: unknown } | undefined)?.links;

/** The table / paragraph model's classId (tables only), or the `set-kind` op's. */
function acceptedClassId(model: StructureModel, ops: readonly CorrectionOp[]): string | undefined {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (op.op === "set-kind" && op.classId) return op.classId;
  }
  return "classId" in model && typeof model.classId === "string" ? model.classId : undefined;
}

function opCounts(ops: readonly CorrectionOp[]): { op: CorrectionOpName; n: number }[] {
  const counts = new Map<CorrectionOpName, number>();
  for (const op of ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
  return [...counts].map(([op, n]) => ({ op, n }));
}

/** `tr:${type}:${x0},${y0},${x1},${y1}` (WP-3.F's content key) → its parts, or null. */
export function parseTextRegionKey(key: string): { type: string; b: BboxMinMax } | null {
  const m = /^tr:([a-z][a-z-]{0,40}):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(key);
  if (!m) return null;
  const b = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])] as BboxMinMax;
  return b[2] > b[0] && b[3] > b[1] ? { type: m[1], b } : null;
}

const TEXT_REGION_MATCH_IOU = 0.7;

function defaultTableName(kind: StructureKind, page: number): string {
  const label = kind === "notes" ? "Notes" : kind === "spec" ? "Spec" : kind;
  return `${label} p.${page}`;
}

/** As promote's `inferCategory` (regions.ts): the table name dashed, else `${type}-region`. */
function categoryOf(kind: StructureKind, tableName: string | undefined): string {
  return tableName ? tableName.toLowerCase().replace(/\s+/g, "-") : `${kind}-region`;
}

function modelCsiRefs(model: StructureModel): CsiRef[] {
  if (isParagraphDoc(model)) return model.paragraphs.flatMap((p) => p.csi ?? []);
  return [...model.rows.flatMap((r) => r.csi ?? []), ...model.cells.flatMap((c) => c.csi ?? [])];
}

/** Region-level CSI (the existing detectors, company context) ∪ the model's own codes (set-csi, engine). */
export function regionCsi(model: StructureModel, view: LegacyView, ctx: Pick<CompanyCsiContext, "config" | "db"> | null): CsiCode[] {
  let detected: CsiCode[] = [];
  try {
    if ("sections" in view) {
      const text = view.sections.map((s) => `${s.sectionHeader}\n${s.body}`).join("\n\n");
      detected = detectCsiCodes(text, undefined, ctx?.config, ctx?.db);
    } else {
      detected = detectCsiFromGrid(view.headers, view.rows, ctx?.config, ctx?.db);
    }
  } catch (err) {
    logger.warn("[parse-engine/commit] CSI detect failed (non-fatal)", { error: err });
  }
  // The model's own codes (set-csi, engine) join as {code, description}; mergeCsiCodes derives division/trade.
  return mergeCsiCodes(detected, modelCsiRefs(model).map((r) => ({ code: r.code, description: r.description })));
}

// ── dependencies (injectable for tests) ────────────────────────────────────────────────────────

export interface CommitDeps {
  readFlags(): Promise<ParseEngineFlags>;
  parse(input: RunParseInput): Promise<ParseResult>;
  applyOps(base: ParseResult, ops: readonly CorrectionOp[]): StructureModel;
  csiContext(companyId: number): Promise<Pick<CompanyCsiContext, "config" | "db"> | null>;
  matchTags(projectId: number, plan: AcceptTagPlan): Promise<AcceptTagMatches>;
  summaries(projectId: number, capability: ProjectWriteCapability): Promise<unknown>;
  now(): Date;
}

export const defaultCommitDeps: CommitDeps = {
  readFlags: readParseEngineFlags,
  parse: (input) => runParse(input),
  applyOps: (base, ops) => engineApplyOps(base, ops),
  csiContext: (companyId) => getCompanyCsiContext(companyId),
  matchTags: computeAcceptTagMatches,
  summaries: (projectId, capability) => computeProjectSummaries(projectId, capability),
  now: () => new Date(),
};

// ── the service ────────────────────────────────────────────────────────────────────────────────

export interface CommitContext {
  req: Request;
  body: unknown;
  project: ProjectAccessRow;
  session: AuthSession | null;
  scope: ProjectAccessScope | null;
}

type WriteTx = ProjectWriteTransaction;

interface Prepared {
  body: CommitBody;
  recipe: ParseRecipe;
  fresh: ParseResult;
  model: StructureModel;
  view: LegacyView;
  tableName: string;
  csi: CsiCode[];
  plan: AcceptTagPlan | null;
  matches: AcceptTagMatches | null;
}

/** Steps 1-3: validate, re-run (cache-only), apply ops, rebase / refuse, CSI and tag matches. No lock held. */
async function prepare(ctx: CommitContext, deps: CommitDeps, userId: number): Promise<Prepared> {
  const body = parseCommitBody(ctx.body);
  const flags = await deps.readFlags();
  if (flags.tools.workspace !== "engine") throw new ApiError("FORBIDDEN", "The parse engine is switched off");
  const { prior: clientPrior, ...request } = body.recipe.request;
  const recipe: ParseRecipe = { origin: body.recipe.origin, request };
  const caller: ParseCaller = { userId, isRoot: ctx.session?.user?.isRootAdmin === true, ip: trustedClientIp(ctx.req.headers.get("x-forwarded-for")) };
  const prior = body.base ?? clientPrior;
  let fresh: ParseResult;
  try {
    fresh = await deps.parse({ project: ctx.project, caller, scope: ctx.scope, request: prior ? { ...request, prior } : request, mode: "cache-only", flags });
  } catch (err) {
    if (err instanceof PaidCropExpiredError) {
      throw new CommitRefusalError("A paid result is no longer cached; run it again before accepting", { reason: "paid-expired", paidExpired: true, methods: err.methods });
    }
    throw err;
  }
  const model = deps.applyOps(fresh, body.ops);
  const lost = lostOps(fresh.model, model, body.ops);
  if (lost.length) {
    throw new CommitRefusalError(`${lost.length} correction(s) no longer apply to the re-parsed item; review it again`, { reason: "ops-lost", lost });
  }
  if (body.evidenceHash !== undefined && body.evidenceHash !== fresh.stamp.evidenceHash) {
    throw new CommitRefusalError("The page changed since this item was parsed; confirm the re-scanned result", {
      reason: "rebased", rebased: model, changedRows: changedRows(prior, fresh.model), evidenceHash: fresh.stamp.evidenceHash,
    });
  }
  const checked = zStructureModel.safeParse(model);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new ApiError("VALIDATION", `The corrected item is outside the stored-model limits (${issue?.path.join(".") ?? ""} ${issue?.message ?? ""})`.trim());
  }
  if (model.bbox[2] <= model.bbox[0] || model.bbox[3] <= model.bbox[1]) throw new ApiError("VALIDATION", "The item has an empty box");
  const tableName = body.tableName ?? (model.title?.text?.trim() || defaultTableName(model.kind, request.page));
  const view = legacyView(model, { tableName });
  const csiCtx = await deps.csiContext(ctx.project.companyId).catch((err) => {
    logger.warn("[parse-engine/commit] company CSI context failed; builtin KB used", { error: err });
    return null;
  });
  const csi = regionCsi(model, view, csiCtx);
  const plan = acceptTagPlan(model, request.page);
  const matches = plan ? await deps.matchTags(ctx.project.id, plan) : null;
  return { body, recipe, fresh, model, view, tableName, csi, plan, matches };
}

interface Written {
  parsedRegion: ParsedRegion;
  revision: number;
  pageIntelligence: PageIntelligence;
  csiCodeCount: number;
  tagSummary?: TagSummary;
  tags: TagOpsResult;
}

async function lockPage(tx: WriteTx, projectId: number, pageNumber: number) {
  const [row] = await tx
    .select({ id: pages.id, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)))
    .for("update")
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Page not found");
  return row;
}

const pageBase = sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb)`;
const objectKey = (key: string): SQL =>
  sql`case when jsonb_typeof(${pageBase}->${key}) = 'object' then ${pageBase}->${key} else '{}'::jsonb end`;

/** Mirror one verdict on the project's proposal list (project row already locked by withProjectWrite). */
async function mirrorProposalSummary(tx: WriteTx, projectId: number, proposalId: string): Promise<void> {
  const [row] = await tx.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const next = patchSummaryVerdict((row?.pi as Record<string, unknown> | null)?.proposals, proposalId, "accept");
  if (!next) return;
  await tx
    .update(projects)
    .set({ projectIntelligence: sql`coalesce(${projects.projectIntelligence}, '{}'::jsonb) || ${JSON.stringify({ proposals: next })}::jsonb` })
    .where(eq(projects.id, projectId));
}

/** Steps 4-10, inside `withProjectWrite`. */
async function write(
  tx: WriteTx, capability: ProjectWriteCapability, projectId: number, userId: number, p: Prepared, deps: CommitDeps,
): Promise<Written> {
  const { body, model, fresh, recipe } = p;
  const pageNumber = recipe.request.page;
  const page = await lockPage(tx, projectId, pageNumber);
  const pi = (page.pageIntelligence ?? {}) as PageIntelligence & Record<string, unknown>;
  const regions = Array.isArray(pi.parsedRegions) ? pi.parsedRegions : [];

  // 5. id, revision, conflict
  let regionId: string;
  let previous: ParsedRegion | undefined;
  if (body.regionId !== undefined) {
    previous = regions.find((r) => r && r.id === body.regionId);
    const stored = previous ? regionRevision(previous) : null;
    if (!previous || stored !== body.revision) {
      throw new CommitRefusalError("This item was changed or removed since you opened it; reload it", { reason: "stale", regionId: body.regionId, revision: stored });
    }
    regionId = body.regionId;
  } else {
    const family = FAMILY[model.kind];
    const clash = regions.find((r) => {
      const rb = parsedRegionMinMax(r);
      return !!r && familyOf(r.type) === family && !!rb && iou(rb, model.bbox) >= COMMIT_CONFLICT_IOU;
    });
    if (clash && body.onConflict !== "keep-both") {
      const data = (clash.data ?? {}) as { tableName?: unknown };
      throw new CommitRefusalError("A saved item already covers this box", {
        reason: "conflict",
        conflict: {
          regionId: clash.id, kind: (clash.type as StructureKind), revision: regionRevision(clash),
          title: typeof data.tableName === "string" ? data.tableName : clash.category ?? clash.type,
          bbox: parsedRegionMinMax(clash) as BboxMinMax,
        },
      });
    }
    const taken = new Set(regions.map((r) => r?.id));
    const minted = mintRegionId(model.kind, pageNumber, model.bbox);
    regionId = minted;
    for (let n = 2; taken.has(regionId); n += 1) regionId = `${minted}~${n}`;
  }
  const revision = (previous ? regionRevision(previous) : 0) + 1;
  const at = deps.now().toISOString();

  // proposal / text-region links
  const proposalId = body.links?.proposalId ?? recipe.request.hints?.proposalId;
  const proposal: ClassifierProposal | null = proposalId ? findStoredProposal(pi, proposalId) : null;
  const trKey = body.links?.textRegionKey ? parseTextRegionKey(body.links.textRegionKey) : null;
  const textRegion = trKey
    ? (Array.isArray(pi.textRegions) ? pi.textRegions : []).find((tr: TextRegion) =>
      tr && tr.type === trKey.type && Array.isArray(tr.bbox) && iou(ltwhToMinMax(tr.bbox), trKey.b) >= TEXT_REGION_MATCH_IOU)
    : undefined;

  // 6. the region
  const links: RegionLinks = {
    origin: "workspace", revision, viewHash: viewHash(p.view),
    ...(proposal ? { proposalId: proposal.id } : {}),
    ...(trKey ? { textRegionKey: body.links!.textRegionKey! } : {}),
    ...(body.links?.continues ? { continues: body.links.continues } : {}),
    acceptedAt: at, acceptedBy: userId,
  };
  const parsedRegion = {
    id: regionId,
    type: model.kind,
    category: categoryOf(model.kind, p.tableName),
    bbox: [...model.bbox] as BboxMinMax,
    confidence: PARSED_REGION_DEFAULT_CONFIDENCE,
    source: "user" as const,
    csiTags: p.csi,
    data: { ...p.view, structure: model, links, engine: fresh.stamp, recipe, ops: body.ops } as unknown as ParsedRegion["data"],
    ...(textRegion ? { sourceTextRegionId: textRegion.id } : {}),
  } satisfies ParsedRegion;
  // A re-save replaces the region in place; older duplicate rows with the same id go with it.
  let placed = false;
  const nextRegions = previous
    ? regions.flatMap((r) => (r?.id !== regionId ? [r] : placed ? [] : ((placed = true), [parsedRegion])))
    : [...regions, parsedRegion];

  // 7. the committed label (machine snapshot recomputed from the re-run, never from the client)
  const accepted = regionSnapshot(parsedRegion);
  const machine = regionSnapshot({ type: fresh.model.kind, data: legacyView(fresh.model, { tableName: p.tableName }) });
  const classIdAccepted = acceptedClassId(model, body.ops);
  const machineClass = fresh.kindSuggestion?.classId ?? ("classId" in fresh.model && typeof fresh.model.classId === "string" ? fresh.model.classId : null);
  const label: ParseLabel = {
    v: 1, regionId, kind: model.kind, source: "workspace", verdict: "committed", by: userId, at,
    engine: fresh.stamp, snapshotHash: snapshotHashOf(accepted), machine, accepted,
    ...(body.ops.length ? { ops: opCounts(body.ops) } : {}),
    ...(proposal ? { proposalId: proposal.id } : {}),
    kindMachine: fresh.kindSuggestion?.kind ?? fresh.model.kind,
    classIdMachine: machineClass,
    ...(classIdAccepted ? { classIdAccepted } : {}),
    evidence: fresh.evidence,
    ...(body.secondsToAccept !== undefined ? { secondsToAccept: body.secondsToAccept } : {}),
    ...(recipe.origin === "draw" ? { missedDetection: true as const } : {}),
  };

  // 8. proposal verdict: accept WITH the accepted class (K58); text-region verdict: accept
  let proposalVerdicts: PageProposalVerdicts | null = null;
  if (proposal) {
    const classOk = classIdAccepted && /^[a-z0-9][a-z0-9-]{0,79}$/.test(classIdAccepted)
      && (proposal.target !== "schedule" || !!scheduleKind(classIdAccepted));
    const verdict = buildVerdict(proposal, { pageNumber, proposalId: proposal.id, verdict: "accept", ...(classOk ? { classId: classIdAccepted } : {}) }, userId, deps.now());
    proposalVerdicts = { ...((pi.proposalVerdicts ?? {}) as PageProposalVerdicts), [proposal.id]: { ...verdict, regionId } };
  }
  const trVerdict: TextRegionVerdict | null = trKey ? { verdict: "accept", type: trKey.type, b: trKey.b, at, by: userId } : null;

  // 9. page CSI (K50)
  const keptRegions = nextRegions.filter((r) => r?.id !== regionId);
  const replacedCsi = regions.filter((r) => r?.id === regionId).flatMap((r) => r.csiTags ?? []);
  const csiCodes = pageCsiAfterRegionChange(
    (page.csiCodes ?? []) as CsiCode[], replacedCsi, keptRegions.map((r) => r?.csiTags), p.csi,
  );

  // one UPDATE: regions (||), the label (jsonb_set), the verdicts
  let value: SQL = sql`${pageBase} || ${JSON.stringify({ parsedRegions: nextRegions, ...(proposalVerdicts ? { proposalVerdicts } : {}) })}::jsonb`;
  value = sql`jsonb_set(${value}, '{parseLabels}', ${objectKey("parseLabels")} || jsonb_build_object(${regionId}::text, ${JSON.stringify(label)}::jsonb))`;
  if (trVerdict) {
    value = sql`jsonb_set(${value}, '{textRegionVerdicts}', ${objectKey("textRegionVerdicts")} || jsonb_build_object(${body.links!.textRegionKey!}::text, ${JSON.stringify(trVerdict)}::jsonb))`;
  }
  const [written] = await tx
    .update(pages)
    .set({ pageIntelligence: value, csiCodes })
    .where(eq(pages.id, page.id))
    .returning({ pageIntelligence: pages.pageIntelligence });
  if (proposal) await mirrorProposalSummary(tx, projectId, proposal.id);

  // 10. tags: the region's projection becomes exactly this accept's mapped rows
  let tags: TagOpsResult = { tags: [], removed: [], replacedRegionIds: [], skipped: [] };
  let tagSummary: TagSummary | undefined;
  if (p.matches || previous) {
    const built = p.matches ? buildAcceptTagRows(p.matches, regionId) : { tags: [] as StoredYoloTag[], summary: undefined };
    tagSummary = built.summary;
    let retireIds: string[] = [];
    if (p.plan && previous && !hasWorkspaceLinks(previous)) {
      const [row] = await tx.select({ tags: sql<unknown>`${projects.projectIntelligence}->'yoloTags'` }).from(projects).where(eq(projects.id, projectId)).limit(1);
      retireIds = legacyTagIdsToRetire(Array.isArray(row?.tags) ? row.tags : [], p.plan);
    }
    tags = await applyTagOps(tx, capability, [{ op: "replace-for-region", regionId, tags: built.tags, ...(retireIds.length ? { retireIds } : {}) }]);
  }

  return {
    parsedRegion,
    revision,
    pageIntelligence: (written?.pageIntelligence ?? {}) as PageIntelligence,
    csiCodeCount: csiCodes.length,
    ...(tagSummary ? { tagSummary } : {}),
    tags,
  };
}

/** The commit. Throws `CommitRefusalError` (409 with a body) for stale / conflict / rebased / ops-lost / paid-expired. */
export async function commitStructure(ctx: CommitContext, deps: CommitDeps = defaultCommitDeps): Promise<CommitResponse> {
  const capability = assertProjectWritable(ctx.project);
  if (!ctx.session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const userId = ctx.session.user.dbId;
  const prepared = await prepare(ctx, deps, userId);
  const written = await withProjectWrite(capability, ctx.project.id, (tx) => write(tx, capability, ctx.project.id, userId, prepared, deps));
  let summaries: unknown = null;
  try {
    summaries = await deps.summaries(ctx.project.id, capability);
  } catch (err) {
    logger.warn("[parse-engine/commit] Summary recompute failed (non-fatal)", { error: err });
  }
  return {
    ok: true,
    regionId: written.parsedRegion.id,
    revision: written.revision,
    kind: prepared.model.kind,
    parsedRegion: written.parsedRegion,
    updatedIntelligence: serializePageWindowIntelligence(written.pageIntelligence),
    csiCodeCount: written.csiCodeCount,
    ...(written.tagSummary ? { tagSummary: written.tagSummary } : {}),
    tags: { rows: written.tags.tags, removed: written.tags.removed, replacedRegionIds: written.tags.replacedRegionIds },
    summaries,
  };
}

/** Route service: a refusal becomes a 409 carrying the standard error envelope plus its body. */
export async function postParseEngineCommit(ctx: CommitContext, deps: CommitDeps = defaultCommitDeps): Promise<CommitResponse | Response> {
  try {
    return await commitStructure(ctx, deps);
  } catch (err) {
    if (err instanceof CommitRefusalError) {
      return NextResponse.json({ error: { code: err.code, message: err.message }, ...err.body }, { status: err.status });
    }
    throw err;
  }
}
