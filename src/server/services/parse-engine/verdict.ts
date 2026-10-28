/**
 * Workspace verdicts (table pipeline TP-3 WP-3.F; PLAN §2.1 `TextRegionVerdict`, §2.2 "notes/spec card
 * verdicts", §3.2 routes, §3.3 path E; K30, C2-M12).
 *
 *   GET    /api/projects/[id]/parse-engine/verdicts?page=N → `{ page, verdicts: {key → {verdict,type,b,at}} }`
 *   POST   /api/projects/[id]/parse-engine/verdict          (`WorkspaceVerdictRequest`, types-items.ts)
 *            text region: `{ pageNumber, textRegion: { type, bbox }, verdict: "reject" }`, or the inbox item
 *                         `{ pageNumber, itemId: "tr:<type>:<box>", origin: "text-region", bbox, verdict: "reject" }`
 *            proposal:    `{ pageNumber, proposalId, verdict, classId?, name? }` (delegated, see below)
 *   DELETE /api/projects/[id]/parse-engine/verdict  `{ pageNumber, key | itemId }` | `{ pageNumber, proposalId }` (Undo)
 *
 * Text regions: `pageIntelligence.textRegionVerdicts[key]`, user-owned and content-keyed
 * (`tr:${type}:${q2(bbox)}`, MinMax). The client names a region by type + box; the SERVER finds the stored
 * `TextRegion` of that type at IoU ≥ .7 and records ITS box, so a forged box cannot invent a verdict for a
 * region that does not exist. Written with SQL `||` on the one key under the page row lock (rule 8); older
 * verdicts that match the same region are replaced (verify LOW-4). A text region takes only `reject` here:
 * it is accepted by committing its parse (WP-3.G), so a bare accept cannot hide a classic card while the
 * inbox still lists the block (verify LOW-1).
 *
 * Proposals: delegated to the classifier verdict service (`applyProposalVerdict`, the same validation,
 * server snapshot, summary mirror and inbox-slice refresh as `POST …/proposals/verdict`), inside THIS
 * transaction. A text region that FOLDS into the proposal's item (`foldedTextRegions`, the items service's
 * rule 3) is the same block: a reject is mirrored onto it as a content-keyed text-region verdict, so the
 * classic card leaves too (C2-M12; verify MED-2).
 *
 * Undo clears every decision on the block: the proposal verdict, the content-keyed verdicts matching the
 * text region (or the folded ones), and a classic positional reject of it while the IoU check holds (the
 * inbox showed it rejected because of that reject, so an Undo that left it would be a no-op).
 *
 * The page's inbox slice is refreshed in the same `withProjectWrite` (`refreshInboxSlice`), so the project
 * row is locked first and the page row second (rule 11).
 *
 * Demo projects are refused for every method: writes by `assertProjectWritable`, the read explicitly
 * (verdicts carry user ids). The GET returns the slim shape without user ids.
 */

import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import { deriveInboxForPage, foldedTextRegions, legacyRejectHolds, type InboxEntry } from "@/lib/parse-engine/inbox-derive";
import {
  iouMinMax,
  matchingTextRegionVerdictKeys,
  storedTextRegionVerdicts,
  TEXT_REGION_VERDICT_IOU,
  textRegionInboxKind,
  textRegionKey,
  textRegionMinMax,
  type TextRegionLike,
} from "@/lib/parse-engine/text-region-verdicts";
import type { BboxMinMax, InboxSlim, TextRegionVerdict } from "@/lib/parse-engine/types";
import type { TextRegionVerdictSlim, TextRegionVerdictsResponse, WorkspaceVerdictResponse } from "@/lib/parse-engine/types-items";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  type ProjectWriteTransaction,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import {
  applyProposalVerdict,
  parseVerdictInput,
  refreshInboxSlice,
  removeProposalVerdict,
} from "@/server/services/proposal-verdicts";
import { readInboxSliceState } from "./inbox-slice";

const MAX_KEY = 300;
/** An inbox text-region item id: `tr:<type>:<box>` (`textRegionKey`). */
const TEXT_ITEM_ID = /^tr:([^:]{1,64}):[^:]+$/;

function invalid(message: string): never {
  throw new ApiError("VALIDATION", message);
}

function readPage(body: Record<string, unknown>): number {
  const { pageNumber } = body;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) invalid("pageNumber must be a positive integer");
  return pageNumber;
}

function readBox(value: unknown): BboxMinMax {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === "number" && Number.isFinite(v))) {
    invalid("bbox must be four numbers");
  }
  const [x0, y0, x1, y1] = value as number[];
  if (!(x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1 && x1 > x0 && y1 > y0)) invalid("bbox must be a normalised MinMax box");
  return [x0, y0, x1, y1];
}

export interface TextRegionVerdictInput {
  pageNumber: number;
  type: string;
  b: BboxMinMax;
  verdict: "reject";
}

/**
 * Shape-only validation of a text-region verdict body (the region itself is matched under the lock). The
 * region is named by `textRegion: {type, bbox}`, or by the inbox item (`itemId` carries the type, `bbox` the box).
 */
export function parseTextRegionVerdictInput(body: Record<string, unknown>): TextRegionVerdictInput {
  const pageNumber = readPage(body);
  const verdict = body.verdict;
  if (verdict !== "reject" && verdict !== "accept") invalid("verdict must be reject or accept");
  if (verdict === "accept") invalid("a text region is accepted by committing its parse, not by a verdict");
  const tr = body.textRegion as { type?: unknown; bbox?: unknown } | undefined;
  if (tr !== undefined) {
    if (!tr || typeof tr !== "object") invalid("textRegion must be an object");
    if (typeof tr.type !== "string" || tr.type.length === 0 || tr.type.length > 64) invalid("textRegion.type is required");
    return { pageNumber, type: tr.type, b: readBox(tr.bbox), verdict };
  }
  const { itemId, origin } = body;
  if (origin !== undefined && origin !== "text-region") invalid("only proposals and text regions take a verdict");
  const m = typeof itemId === "string" && itemId.length <= MAX_KEY ? TEXT_ITEM_ID.exec(itemId) : null;
  if (!m) invalid("textRegion or a text-region itemId is required");
  return { pageNumber, type: m[1], b: readBox(body.bbox), verdict };
}

/**
 * The stored text region the client means: same type, an inbox kind, best IoU ≥ .7 with the posted box
 * (ties by content key). Null when there is none.
 */
export function matchStoredTextRegion(pageIntelligence: unknown, type: string, b: BboxMinMax): { key: string; b: BboxMinMax } | null {
  const regions = (pageIntelligence as { textRegions?: unknown } | null)?.textRegions;
  let best: { key: string; b: BboxMinMax; iou: number } | null = null;
  for (const tr of Array.isArray(regions) ? (regions as TextRegionLike[]) : []) {
    if (!tr || tr.type !== type || !textRegionInboxKind(tr)) continue;
    const box = textRegionMinMax(tr);
    if (!box) continue;
    const iou = iouMinMax(box, b);
    const key = textRegionKey(type, box);
    if (iou >= TEXT_REGION_VERDICT_IOU && (!best || iou > best.iou || (iou === best.iou && key < best.key))) best = { key, b: box, iou };
  }
  return best ? { key: best.key, b: best.b } : null;
}

const slim = (v: TextRegionVerdict): TextRegionVerdictSlim => ({ verdict: v.verdict, type: v.type, b: v.b, at: v.at });

/** `{ key → slim verdict }` for one page (pure; also used by tests). */
export function slimTextRegionVerdicts(pageIntelligence: unknown): Record<string, TextRegionVerdictSlim> {
  return Object.fromEntries(Object.entries(storedTextRegionVerdicts(pageIntelligence)).map(([k, v]) => [k, slim(v)]));
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────────

export async function getTextRegionVerdicts(project: ProjectAccessRow, query: { page: number }): Promise<TextRegionVerdictsResponse> {
  if (project.isDemo) throw new ApiError("FORBIDDEN", "Demo projects have no workspace verdicts");
  const [row] = await db
    .select({ verdicts: sql<unknown>`${pages.pageIntelligence}->'textRegionVerdicts'` })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, query.page)))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Page not found");
  return { page: query.page, verdicts: slimTextRegionVerdicts({ textRegionVerdicts: row.verdicts }) };
}

type WriteTx = ProjectWriteTransaction;
type PI = Record<string, unknown>;

async function lockPage(tx: WriteTx, projectId: number, pageNumber: number) {
  const [row] = await tx
    .select({ id: pages.id, pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)))
    .for("update")
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Page not found");
  return { id: row.id, pi: (row.pageIntelligence ?? {}) as PI };
}

const textKeys = (keys: readonly string[]) => sql`array[${sql.join(keys.map((k) => sql`${k}::text`), sql`, `)}]`;
const pageBase = sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb)`;
const storedVerdictsExpr = sql`case when jsonb_typeof(${pageBase}->'textRegionVerdicts') = 'object' then ${pageBase}->'textRegionVerdicts' else '{}'::jsonb end`;

/**
 * One SQL write of the page's verdict keys under the page row lock: drop `remove`, then add `add` (`||` on the one
 * key, so every other key survives). `rejectedTextRegionIds`, when given, is replaced by the array computed
 * from the locked row. Returns the page intelligence as written.
 */
async function writeTextVerdicts(
  tx: WriteTx,
  page: { id: number; pi: PI },
  change: { remove?: readonly string[]; add?: Readonly<Record<string, TextRegionVerdict>>; rejectedTextRegionIds?: string[] },
): Promise<PI> {
  const remove = change.remove ?? [];
  const add = change.add ?? {};
  let verdicts: SQL = storedVerdictsExpr;
  if (remove.length) verdicts = sql`(${verdicts} - ${textKeys(remove)})`;
  if (Object.keys(add).length) verdicts = sql`(${verdicts} || ${JSON.stringify(add)}::jsonb)`;
  let value: SQL = remove.length || Object.keys(add).length ? sql`jsonb_set(${pageBase}, '{textRegionVerdicts}', ${verdicts})` : pageBase;
  if (change.rejectedTextRegionIds) value = sql`jsonb_set(${value}, '{rejectedTextRegionIds}', ${JSON.stringify(change.rejectedTextRegionIds)}::jsonb)`;
  await tx.update(pages).set({ pageIntelligence: value }).where(eq(pages.id, page.id));
  const stored = storedTextRegionVerdicts(page.pi);
  for (const k of remove) delete stored[k];
  return {
    ...page.pi,
    textRegionVerdicts: { ...stored, ...add },
    ...(change.rejectedTextRegionIds ? { rejectedTextRegionIds: change.rejectedTextRegionIds } : {}),
  };
}

/** The page's derived entries as they are now (the stored slice supplies the legacy-reject bindings). */
async function currentEntries(tx: WriteTx, projectId: number, pageNumber: number, pi: PI): Promise<{ entries: InboxEntry[]; prev: InboxSlim[] | null }> {
  const { prev } = await readInboxSliceState(tx, projectId, pageNumber);
  return { entries: deriveInboxForPage({ page: pageNumber, pageIntelligence: pi, prev }), prev };
}

/**
 * Clear every decision on `targets` (Undo): the stored verdicts matching each region, `extraKeys`, and a classic
 * positional reject while its IoU check holds. Null when there is nothing to clear.
 */
async function undecideTextRegions(
  tx: WriteTx,
  page: { id: number; pi: PI },
  prev: readonly InboxSlim[] | null,
  targets: readonly InboxEntry[],
  extraKeys: readonly string[] = [],
): Promise<{ removedKeys: string[]; liftedIds: string[]; pi: PI } | null> {
  const stored = storedTextRegionVerdicts(page.pi);
  const removed = new Set(extraKeys.filter((k) => Object.prototype.hasOwnProperty.call(stored, k)));
  const legacy = Array.isArray(page.pi.rejectedTextRegionIds) ? page.pi.rejectedTextRegionIds.filter((x): x is string => typeof x === "string") : [];
  const lifted = new Set<string>();
  for (const t of targets) {
    if (t.regionType) for (const k of matchingTextRegionVerdictKeys(stored, t.regionType, t.b)) removed.add(k);
    if (t.legacyId && legacy.includes(t.legacyId) && legacyRejectHolds(t.legacyId, t.b, prev)) lifted.add(t.legacyId);
  }
  if (removed.size === 0 && lifted.size === 0) return null;
  const pi = await writeTextVerdicts(tx, page, {
    remove: [...removed].sort(),
    ...(lifted.size ? { rejectedTextRegionIds: legacy.filter((id) => !lifted.has(id)) } : {}),
  });
  return { removedKeys: [...removed].sort(), liftedIds: [...lifted].sort(), pi };
}

const isProposalBody = (body: Record<string, unknown>) => body.proposalId !== undefined;

export async function recordWorkspaceVerdict(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
): Promise<WorkspaceVerdictResponse> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const projectId = accessProject.id;
  const userId = session.user.dbId;
  if (isProposalBody(body)) {
    const parsed = parseVerdictInput(body);
    if (parsed.via !== undefined) invalid("via parse is posted by the parse save, not the workspace");
    return withProjectWrite(writeCapability, projectId, async (tx) => {
      const out = await applyProposalVerdict(tx, projectId, userId, parsed); // refreshes the slice (MED-1)
      if (out.verdict?.verdict !== "reject") return { proposalVerdict: out.verdict, inboxRefreshed: out.inboxRefreshed };
      // MED-2: the item hosts the text regions that fold into it; they are the same block.
      const page = await lockPage(tx, projectId, out.pageNumber);
      const { entries } = await currentEntries(tx, projectId, out.pageNumber, page.pi);
      const folded = foldedTextRegions(entries, parsed.proposalId).filter((e) => e.regionType && e.state !== "rejected");
      if (folded.length === 0) return { proposalVerdict: out.verdict, inboxRefreshed: out.inboxRefreshed, folded: [] };
      const stored = storedTextRegionVerdicts(page.pi);
      const at = new Date().toISOString();
      const add: Record<string, TextRegionVerdict> = {};
      const remove = new Set<string>();
      for (const e of folded) {
        add[e.id] = { verdict: "reject", type: e.regionType!, b: e.b, at, by: userId };
        for (const k of matchingTextRegionVerdictKeys(stored, e.regionType!, e.b)) if (k !== e.id) remove.add(k);
      }
      const pi = await writeTextVerdicts(tx, page, { remove: [...remove].sort(), add });
      const inboxRefreshed = await refreshInboxSlice(tx, projectId, out.pageNumber, pi);
      return { proposalVerdict: out.verdict, inboxRefreshed, folded: Object.keys(add).sort() };
    });
  }
  const input = parseTextRegionVerdictInput(body);
  return withProjectWrite(writeCapability, projectId, async (tx) => {
    const page = await lockPage(tx, projectId, input.pageNumber);
    const match = matchStoredTextRegion(page.pi, input.type, input.b);
    if (!match) throw new ApiError("NOT_FOUND", "Text region not found");
    const verdict: TextRegionVerdict = { verdict: input.verdict, type: input.type, b: match.b, at: new Date().toISOString(), by: userId };
    // One verdict per region: older keys that match this region (a re-minted key after a re-OCR wobble) go (LOW-4).
    const remove = matchingTextRegionVerdictKeys(storedTextRegionVerdicts(page.pi), input.type, match.b).filter((k) => k !== match.key);
    const pi = await writeTextVerdicts(tx, page, { remove, add: { [match.key]: verdict } });
    const inboxRefreshed = await refreshInboxSlice(tx, projectId, input.pageNumber, pi);
    return { key: match.key, verdict: slim(verdict), inboxRefreshed };
  });
}

/** Undo. Works even when the text region or the proposal is gone (verdicts are user-owned). Idempotent. */
export async function deleteWorkspaceVerdict(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
): Promise<WorkspaceVerdictResponse> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const projectId = accessProject.id;
  const pageNumber = readPage(body);
  const { proposalId } = body;
  if (proposalId !== undefined) {
    if (typeof proposalId !== "string" || proposalId.length === 0 || proposalId.length > MAX_KEY) invalid("proposalId is required");
    return withProjectWrite(writeCapability, projectId, async (tx) => {
      const out = await removeProposalVerdict(tx, projectId, pageNumber, proposalId); // refreshes the slice (MED-1)
      const page = await lockPage(tx, projectId, pageNumber);
      const { entries, prev } = await currentEntries(tx, projectId, pageNumber, page.pi);
      const cleared = await undecideTextRegions(tx, page, prev, foldedTextRegions(entries, proposalId));
      if (!cleared) return { removed: out.removed, inboxRefreshed: out.inboxRefreshed, folded: [] };
      const inboxRefreshed = await refreshInboxSlice(tx, projectId, pageNumber, cleared.pi);
      return { removed: true, inboxRefreshed, folded: cleared.removedKeys };
    });
  }
  const key = body.key ?? body.itemId;
  if (typeof key !== "string" || !key.startsWith("tr:") || key.length > MAX_KEY) invalid("key must be a text-region verdict key");
  return withProjectWrite(writeCapability, projectId, async (tx) => {
    const page = await lockPage(tx, projectId, pageNumber);
    const { entries, prev } = await currentEntries(tx, projectId, pageNumber, page.pi);
    const target = entries.filter((e) => e.origin === "text-region" && e.id === key);
    const cleared = await undecideTextRegions(tx, page, prev, target, [key]);
    if (!cleared) return { key, removed: false, inboxRefreshed: false };
    const inboxRefreshed = await refreshInboxSlice(tx, projectId, pageNumber, cleared.pi);
    return { key, removed: true, inboxRefreshed };
  });
}
