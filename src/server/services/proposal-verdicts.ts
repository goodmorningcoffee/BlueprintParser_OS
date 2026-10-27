/**
 * POST / DELETE /api/projects/[id]/proposals/verdict — one user label on one stored classifier proposal
 * (plan: gitignore/projects/classifier_builder/PLAN.md, contract: lib/classifier-engine/types.ts).
 *
 * The verdict is written to `pageIntelligence.proposalVerdicts[proposalId]` (user-owned; the generic
 * PATCH /api/pages/intelligence cannot write it) and mirrored onto the matching
 * `projectIntelligence.proposals` item so the panel list shows it without a page fetch.
 *
 * The client names the proposal; the SERVER reads the stored proposal and snapshots its features,
 * classId and recipe version — a client never supplies features, so a refit cannot be poisoned by a
 * forged feature vector. Demo projects are refused for every role (assertProjectWritable).
 *
 * [TP-2 WP-2.F, K58] `{verdict:"accept", via:"parse", regionId}` is posted by the SAVE of a parse that started
 * from "Parse this table" (no verdict is recorded before parsing any more). The server takes the STORED
 * classId, writes only when the proposal has no verdict yet, and only when the named saved region exists on
 * that page and overlaps the proposal (IoU ≥ .5). Otherwise nothing is written (a forged id is ignored).
 */

import { and, eq, sql } from "drizzle-orm";
import { pages, projects } from "@/lib/db/schema";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  type ProjectWriteTransaction,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import type {
  ClassifierProposal,
  PageProposalVerdicts,
  ProjectProposalSummary,
  ProposalVerdict,
  VerdictKind,
} from "@/lib/classifier-engine/types";
import { scheduleKind } from "@/lib/classifier-engine/vocabulary";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";

const VERDICTS: readonly VerdictKind[] = ["accept", "reject", "rename"];
const CLASS_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface VerdictInput {
  pageNumber: number;
  proposalId: string;
  verdict: VerdictKind;
  classId?: string;
  name?: string;
  via?: "parse";
  regionId?: string;
}

function invalid(message: string): never {
  throw new ApiError("VALIDATION", message);
}

function readTarget(body: Record<string, unknown>): { pageNumber: number; proposalId: string } {
  const { pageNumber, proposalId } = body;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) {
    invalid("pageNumber must be a positive integer");
  }
  if (typeof proposalId !== "string" || proposalId.length === 0 || proposalId.length > 300) {
    invalid("proposalId is required");
  }
  return { pageNumber, proposalId };
}

/** Shape-only validation; whether classId fits the proposal is checked against the stored proposal. */
export function parseVerdictInput(body: Record<string, unknown>): VerdictInput {
  const target = readTarget(body);
  const verdict = body.verdict as VerdictKind;
  if (!VERDICTS.includes(verdict)) invalid("verdict must be accept, reject or rename");
  const { classId, name } = body;
  if (classId !== undefined && (typeof classId !== "string" || !CLASS_ID.test(classId))) {
    invalid("classId must be a kind id");
  }
  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0 || name.length > 120)) {
    invalid("name must be 1-120 characters");
  }
  if (verdict === "rename" && classId === undefined) invalid("rename requires classId");
  if (verdict === "reject" && (classId !== undefined || name !== undefined)) {
    invalid("reject takes no classId or name");
  }
  if (name !== undefined && classId === undefined) invalid("name requires classId");
  if (body.via !== undefined) {
    const { regionId } = body;
    if (body.via !== "parse" || verdict !== "accept" || classId !== undefined || name !== undefined) {
      invalid("via parse is an accept with no classId or name");
    }
    if (typeof regionId !== "string" || regionId.length === 0 || regionId.length > 300) invalid("via parse requires regionId");
    return { ...target, verdict, via: "parse", regionId };
  }
  return {
    ...target,
    verdict,
    ...(classId === undefined ? {} : { classId: classId as string }),
    ...(name === undefined ? {} : { name: (name as string).trim() }),
  };
}

const iou = (a: readonly number[], b: readonly number[]): number => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy;
  return union > 0 ? (ix * iy) / union : 0;
};

/**
 * The input a save-time accept (via "parse") is recorded with, or null when it must be ignored: the proposal
 * already has a verdict, or the named region is not a saved region of this page overlapping the proposal.
 * The class is the STORED one (dropped when it is no longer a schedule kind).
 */
export function parseAcceptInput(
  pageIntelligence: Record<string, unknown>,
  proposal: ClassifierProposal,
  input: VerdictInput,
): VerdictInput | null {
  const existing = (pageIntelligence.proposalVerdicts ?? {}) as PageProposalVerdicts;
  if (existing && typeof existing === "object" && Object.prototype.hasOwnProperty.call(existing, proposal.id)) return null;
  const regions = Array.isArray(pageIntelligence.parsedRegions) ? pageIntelligence.parsedRegions : [];
  const region = regions.find((r: { id?: unknown } | null) => r && r.id === input.regionId);
  const box = parsedRegionMinMax(region);
  if (!box || !Array.isArray(proposal.bbox) || iou(box, proposal.bbox) < 0.5) return null;
  const stored = proposal.classId ?? undefined;
  const classId = stored && (proposal.target !== "schedule" || scheduleKind(stored)) && CLASS_ID.test(stored) ? stored : undefined;
  return { ...input, ...(classId ? { classId } : {}) };
}

/** The stored proposal with this id, or null. Tolerates a missing or malformed computed block. */
export function findStoredProposal(
  pageIntelligence: Record<string, unknown> | null | undefined,
  proposalId: string,
): ClassifierProposal | null {
  const block = pageIntelligence?.classifierProposals as { proposals?: unknown } | undefined;
  if (!block || !Array.isArray(block.proposals)) return null;
  const hit = (block.proposals as ClassifierProposal[]).find((p) => p && p.id === proposalId);
  return hit ?? null;
}

function snapshotFeatures(features: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!features || typeof features !== "object") return out;
  for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Build the stored verdict from the SERVER's copy of the proposal. */
export function buildVerdict(
  proposal: ClassifierProposal,
  input: VerdictInput,
  userId: number,
  at: Date,
): ProposalVerdict {
  if (input.classId !== undefined && proposal.target === "schedule" && !scheduleKind(input.classId)) {
    invalid("classId is not a schedule kind");
  }
  return {
    proposalId: proposal.id,
    recipeId: proposal.recipeId,
    recipeVersion: proposal.recipeVersion,
    verdict: input.verdict,
    ...(input.classId === undefined ? {} : { classId: input.classId }),
    ...(input.name === undefined ? {} : { name: input.name }),
    features: snapshotFeatures(proposal.features),
    proposedClassId: proposal.classId ?? null,
    userId,
    at: at.toISOString(),
    ...(input.via === "parse" ? { via: "parse" as const, regionId: input.regionId } : {}),
  };
}

/** Copy of the summary with one item's verdict set (or cleared). Null when nothing changes. */
export function patchSummaryVerdict(
  summary: unknown,
  proposalId: string,
  verdict: VerdictKind | undefined,
): ProjectProposalSummary | null {
  const s = summary as ProjectProposalSummary | null | undefined;
  if (!s || !Array.isArray(s.items)) return null;
  let changed = false;
  const items = s.items.map((item) => {
    if (item.id !== proposalId || item.verdict === verdict) return item;
    changed = true;
    const { verdict: _drop, ...rest } = item;
    return verdict === undefined ? rest : { ...rest, verdict };
  });
  return changed ? { ...s, items } : null;
}

type WriteTx = ProjectWriteTransaction;

async function lockPage(tx: WriteTx, projectId: number, pageNumber: number) {
  const [row] = await tx
    .select({ id: pages.id, pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)))
    .for("update")
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Page not found");
  return row;
}

async function writeVerdicts(tx: WriteTx, pageId: number, verdicts: PageProposalVerdicts): Promise<void> {
  await tx
    .update(pages)
    .set({
      pageIntelligence: sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb) || ${JSON.stringify({ proposalVerdicts: verdicts })}::jsonb`,
    })
    .where(eq(pages.id, pageId));
}

/** Mirror the verdict onto projectIntelligence.proposals (merging ONE key; other writers' keys survive). */
async function mirrorOnSummary(
  tx: WriteTx,
  projectId: number,
  proposalId: string,
  verdict: VerdictKind | undefined,
): Promise<void> {
  const [row] = await tx
    .select({ projectIntelligence: projects.projectIntelligence })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update")
    .limit(1);
  const pi = (row?.projectIntelligence ?? null) as Record<string, unknown> | null;
  const next = patchSummaryVerdict(pi?.proposals, proposalId, verdict);
  if (!next) return;
  await tx
    .update(projects)
    .set({
      projectIntelligence: sql`coalesce(${projects.projectIntelligence}, '{}'::jsonb) || ${JSON.stringify({ proposals: next })}::jsonb`,
    })
    .where(eq(projects.id, projectId));
}

export async function recordProposalVerdict(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
): Promise<{ verdict: ProposalVerdict | null }> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const parsed = parseVerdictInput(body);
  return withProjectWrite(writeCapability, accessProject.id, async (tx) => {
    const page = await lockPage(tx, accessProject.id, parsed.pageNumber);
    const pi = (page.pageIntelligence ?? {}) as Record<string, unknown>;
    const proposal = findStoredProposal(pi, parsed.proposalId);
    if (!proposal && parsed.via === "parse") return { verdict: null }; // a forged / stale id is ignored
    if (!proposal) throw new ApiError("NOT_FOUND", "Proposal not found");
    const input = parsed.via === "parse" ? parseAcceptInput(pi, proposal, parsed) : parsed;
    if (!input) return { verdict: null };
    const verdict = buildVerdict(proposal, input, session.user.dbId, new Date());
    const existing = (pi.proposalVerdicts ?? {}) as PageProposalVerdicts;
    await writeVerdicts(tx, page.id, { ...existing, [proposal.id]: verdict });
    await mirrorOnSummary(tx, accessProject.id, proposal.id, verdict.verdict);
    return { verdict };
  });
}

/** Undo. Works even when the proposal itself is gone (the label is user-owned). Idempotent. */
export async function deleteProposalVerdict(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
): Promise<{ removed: boolean }> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const { pageNumber, proposalId } = readTarget(body);
  return withProjectWrite(writeCapability, accessProject.id, async (tx) => {
    const page = await lockPage(tx, accessProject.id, pageNumber);
    const pi = (page.pageIntelligence ?? {}) as Record<string, unknown>;
    const existing = (pi.proposalVerdicts ?? {}) as PageProposalVerdicts;
    if (!Object.prototype.hasOwnProperty.call(existing, proposalId)) return { removed: false };
    const { [proposalId]: _removed, ...rest } = existing;
    await writeVerdicts(tx, page.id, rest);
    await mirrorOnSummary(tx, accessProject.id, proposalId, undefined);
    return { removed: true };
  });
}
