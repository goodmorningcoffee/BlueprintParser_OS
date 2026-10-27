/**
 * GET / POST / DELETE /api/projects/[id]/parse-labels — the verdict bar's ✓ / ✗ on a saved parsed region
 * (table pipeline TP-2 WP-2.F; PLAN §2.1 `ParseLabel`, §2.2 "labels", §6.5; C3-m4, K58).
 *
 * Storage: `pageIntelligence.parseLabels[regionId]`, user-owned. Only this route writes it (SQL `jsonb_set`
 * under the page row lock, inside `withProjectWrite`, so lock order is project row → page row). The generic
 * intelligence PATCH pins it, the page window omits it, and a page that carries labels is human work for the
 * duplicate-page hide.
 *
 * The client names a region and a verdict, nothing else. The SERVER reads the stored region and computes the
 * label's `machine` snapshot and `snapshotHash`, and links the proposal whose `accept` was posted by this
 * region's save (`proposalVerdicts[*].regionId`, K58). A forged snapshot, hash or proposal id is ignored.
 *
 * "corrected" is never written by a client. It is inferred on read (rule 2 forbids a promote-response hook):
 * a ✓/✗ label whose snapshot no longer matches the region's current snapshot reads back as `corrected`, the
 * stored snapshot being the machine output and the current region the truth (`effectiveParseLabel`).
 *
 * Demo projects are refused for every method: writes by `assertProjectWritable`; the read explicitly
 * (labels carry user ids).
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import type { PageProposalVerdicts } from "@/lib/classifier-engine/types";
import type { ParseLabel, StructureKind, StructureSnapshot } from "@/lib/parse-engine/types";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  type ProjectWriteTransaction,
  withProjectWrite,
} from "@/server/api/project-write-capability";

/** The verdicts a client may post. `corrected` is inferred, `committed` belongs to the TP-3 workspace. */
export type ParseVerdictBarVerdict = "correct" | "wrong";
const BAR_VERDICTS: readonly ParseVerdictBarVerdict[] = ["correct", "wrong"];
const KINDS: readonly StructureKind[] = ["schedule", "keynote", "legend", "notes", "spec"];
const MAX_ID = 300;

/** The slim read: one entry per saved region of the page that has a label. */
export interface ParseLabelSlim {
  verdict: ParseLabel["verdict"];
  at: string;
  /** Only on an inferred `corrected`: the verdict the user gave before the region was edited. */
  was?: ParseLabel["verdict"];
}

interface StoredRegion {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}

function invalid(message: string): never {
  throw new ApiError("VALIDATION", message);
}

function readTarget(body: Record<string, unknown>): { pageNumber: number; regionId: string } {
  const { pageNumber, regionId } = body;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) {
    invalid("pageNumber must be a positive integer");
  }
  if (typeof regionId !== "string" || regionId.length === 0 || regionId.length > MAX_ID) {
    invalid("regionId is required");
  }
  return { pageNumber, regionId };
}

/** Shape-only validation of a POST body. Any other field (a snapshot, a hash, a proposal id) is ignored. */
export function parseLabelInput(body: Record<string, unknown>): {
  pageNumber: number;
  regionId: string;
  verdict: ParseVerdictBarVerdict;
} {
  const target = readTarget(body);
  const verdict = body.verdict as ParseVerdictBarVerdict;
  if (!BAR_VERDICTS.includes(verdict)) invalid("verdict must be correct or wrong");
  return { ...target, verdict };
}

// ── the server snapshot ─────────────────────────────────────────────────────────────────────────────

/** JSON with sorted object keys, so equal content hashes equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const cellHash = (value: unknown) => sha1(typeof value === "string" ? value : value == null ? "" : String(value)).slice(0, 12);
const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : String(v ?? ""))) : [];

export function regionKind(region: StoredRegion): StructureKind {
  return KINDS.includes(region.type as StructureKind) ? (region.type as StructureKind) : "schedule";
}

/**
 * The structure snapshot of a saved region's LEGACY data (the only shape TP-2 regions have). Cells are hashed,
 * never stored as text. Grids (schedules, Stage-3 notes) hash the header row then every row by header; keynote,
 * legend and spec lists hash their pairs in order; legacy notes hash their note texts.
 */
export function regionSnapshot(region: StoredRegion): StructureSnapshot {
  const kind = regionKind(region);
  const data = (region.data && typeof region.data === "object" ? region.data : {}) as Record<string, unknown>;
  const base = { kind, rowY: numbers(data.rowBoundaries), colX: numbers(data.colBoundaries) };
  const headers = strings(data.headers);
  if (headers.length > 0 || Array.isArray(data.rows)) {
    const rows = records(data.rows);
    const tagCol = typeof data.tagColumn === "string" ? headers.indexOf(data.tagColumn) : -1;
    return {
      ...base,
      headerRows: headers.length > 0 ? 1 : 0,
      ...(tagCol >= 0 ? { tagCol } : {}),
      cellHash: [...headers, ...rows.flatMap((row) => headers.map((h) => row[h]))].map(cellHash),
    };
  }
  const pairs = (list: unknown, a: string, b: string) => records(list).flatMap((r) => [r[a], r[b]]);
  if (Array.isArray(data.keynotes)) return { ...base, headerRows: 0, tagCol: 0, cellHash: pairs(data.keynotes, "key", "description").map(cellHash) };
  if (Array.isArray(data.symbols)) return { ...base, headerRows: 0, tagCol: 0, cellHash: pairs(data.symbols, "yoloClass", "description").map(cellHash) };
  if (Array.isArray(data.sections)) return { ...base, headerRows: 0, cellHash: pairs(data.sections, "sectionHeader", "body").map(cellHash) };
  if (Array.isArray(data.notes)) {
    return { ...base, headerRows: 0, cellHash: data.notes.map((n) => (n && typeof n === "object" ? canonicalJson(n) : n)).map(cellHash) };
  }
  return { ...base, headerRows: 0, cellHash: [] };
}

export function snapshotHashOf(snapshot: StructureSnapshot): string {
  return sha1(canonicalJson(snapshot));
}

/**
 * The label as it reads now (C3-m4): a ✓/✗ whose region changed since the verdict is `corrected`, with the
 * stored snapshot as the machine output and the current one as accepted truth. Pure; also for exporters.
 */
export function effectiveParseLabel(label: ParseLabel, region: StoredRegion | null): ParseLabel & { was?: ParseLabel["verdict"] } {
  if (!region || (label.verdict !== "correct" && label.verdict !== "wrong")) return label;
  const current = regionSnapshot(region);
  if (snapshotHashOf(current) === label.snapshotHash) return label;
  return { ...label, verdict: "corrected", was: label.verdict, accepted: current };
}

function isLabel(value: unknown): value is ParseLabel {
  const v = value as ParseLabel | null;
  return !!v && typeof v === "object" && typeof v.verdict === "string" && typeof v.snapshotHash === "string" && typeof v.at === "string";
}

/** The page's stored labels (tolerates a missing or malformed key). */
export function storedParseLabels(pageIntelligence: unknown): Record<string, ParseLabel> {
  const raw = (pageIntelligence as { parseLabels?: unknown } | null)?.parseLabels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => isLabel(v))) as Record<string, ParseLabel>;
}

function regionsOf(pageIntelligence: unknown): StoredRegion[] {
  return records((pageIntelligence as { parsedRegions?: unknown } | null)?.parsedRegions) as StoredRegion[];
}

/** `{ regionId → {verdict, at, was?} }` for the page's saved regions that carry a label. */
export function slimParseLabels(pageIntelligence: unknown): Record<string, ParseLabelSlim> {
  const labels = storedParseLabels(pageIntelligence);
  const out: Record<string, ParseLabelSlim> = {};
  for (const region of regionsOf(pageIntelligence)) {
    if (typeof region.id !== "string" || !Object.prototype.hasOwnProperty.call(labels, region.id)) continue;
    const eff = effectiveParseLabel(labels[region.id], region);
    out[region.id] = { verdict: eff.verdict, at: eff.at, ...(eff.was ? { was: eff.was } : {}) };
  }
  return out;
}

/** The proposal whose save-time `accept` named this region (K58), if any. */
function linkedProposalId(pageIntelligence: Record<string, unknown>, regionId: string): string | undefined {
  const verdicts = (pageIntelligence.proposalVerdicts ?? {}) as PageProposalVerdicts;
  if (!verdicts || typeof verdicts !== "object") return undefined;
  for (const v of Object.values(verdicts)) {
    if (v && typeof v === "object" && v.regionId === regionId && typeof v.proposalId === "string") return v.proposalId;
  }
  return undefined;
}

/** Build the stored label from the SERVER's copy of the region. */
export function buildParseLabel(
  pageIntelligence: Record<string, unknown>,
  region: StoredRegion & { id: string },
  verdict: ParseVerdictBarVerdict,
  userId: number,
  at: Date,
): ParseLabel {
  const machine = regionSnapshot(region);
  const proposalId = linkedProposalId(pageIntelligence, region.id);
  return {
    v: 1,
    regionId: region.id,
    kind: machine.kind,
    source: "verdict-bar",
    verdict,
    by: userId,
    at: at.toISOString(),
    snapshotHash: snapshotHashOf(machine),
    machine,
    ...(proposalId ? { proposalId } : {}),
  };
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────────

export async function getParseLabels(
  project: ProjectAccessRow,
  query: { page: number },
): Promise<{ page: number; labels: Record<string, ParseLabelSlim> }> {
  if (project.isDemo) throw new ApiError("FORBIDDEN", "Demo projects have no parse labels");
  const [row] = await db
    .select({
      regions: sql<unknown>`${pages.pageIntelligence}->'parsedRegions'`,
      labels: sql<unknown>`${pages.pageIntelligence}->'parseLabels'`,
    })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, query.page)))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Page not found");
  return { page: query.page, labels: slimParseLabels({ parsedRegions: row.regions, parseLabels: row.labels }) };
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

/** Merge ONE label into `parseLabels` in SQL, so a concurrent writer's other keys survive. */
async function writeLabel(tx: WriteTx, pageId: number, label: ParseLabel): Promise<void> {
  const pi = sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb)`;
  const current = sql`case when jsonb_typeof(${pi}->'parseLabels') = 'object' then ${pi}->'parseLabels' else '{}'::jsonb end`;
  await tx
    .update(pages)
    .set({
      pageIntelligence: sql`jsonb_set(${pi}, '{parseLabels}', ${current} || jsonb_build_object(${label.regionId}::text, ${JSON.stringify(label)}::jsonb))`,
    })
    .where(eq(pages.id, pageId));
}

export async function recordParseLabel(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
): Promise<{ regionId: string; label: ParseLabelSlim }> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const input = parseLabelInput(body);
  return withProjectWrite(writeCapability, accessProject.id, async (tx) => {
    const page = await lockPage(tx, accessProject.id, input.pageNumber);
    const pi = (page.pageIntelligence ?? {}) as Record<string, unknown>;
    const region = regionsOf(pi).find((r) => r.id === input.regionId);
    if (!region) throw new ApiError("NOT_FOUND", "Parsed region not found");
    const label = buildParseLabel(pi, region as StoredRegion & { id: string }, input.verdict, session.user.dbId, new Date());
    await writeLabel(tx, page.id, label);
    return { regionId: label.regionId, label: { verdict: label.verdict, at: label.at } };
  });
}

/** Undo. Works even when the region is gone (the label is user-owned). Idempotent. */
export async function deleteParseLabel(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
): Promise<{ removed: boolean }> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const { pageNumber, regionId } = readTarget(body);
  return withProjectWrite(writeCapability, accessProject.id, async (tx) => {
    const page = await lockPage(tx, accessProject.id, pageNumber);
    const raw = (page.pageIntelligence as { parseLabels?: unknown } | null)?.parseLabels;
    if (!raw || typeof raw !== "object" || !Object.prototype.hasOwnProperty.call(raw, regionId)) return { removed: false };
    await tx
      .update(pages)
      .set({ pageIntelligence: sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb) #- array['parseLabels', ${regionId}::text]` })
      .where(eq(pages.id, page.id));
    return { removed: true };
  });
}
