/**
 * POST /api/projects/[id]/tags/ops — id-keyed edits of `projectIntelligence.yoloTags`
 * (table pipeline WP-2.D1; K19, K40 server side; PLAN §2.1 "tags", §2.2 "tag projection").
 *
 * The legacy save PUTs the WHOLE cached array (`PUT /api/projects/[id]`), so a second tab or user
 * overwrites the first (K19). Here every edit names its tag by `id` (or, for server-generated rows,
 * by the server key from `lib/parse-engine/tag-key.ts`), and `applyTagOps` reads `yoloTags`, applies
 * the ops and writes ONE key back — all under the project row lock — so two writers that touch
 * different tags both survive. The whole-array PUT stays for the import path (WP-2.D2).
 *
 * Ops (applied in order; an op that names a missing tag or instance is skipped and reported, never
 * an error, so a stale tab's diff cannot wedge its save lane):
 *   upsert              {tag, match?: "id" | "key"}   replace the row with that id (or, with "key",
 *                       the first row with the same server key, keeping that row's id), else append.
 *   remove              {id}
 *   replace-for-region  {regionId, tags, retireIds?}   the region's rows become exactly the incoming
 *                       tags that have ≥ 1 instance (matched by server key, ids kept); the region's
 *                       other rows — including 0-hit ones — are removed (K40). Rows of other regions
 *                       are untouched. `retireIds` names legacy (unlinked) rows the caller attributes
 *                       to this region; they are removed too.
 *   set-instance-status {tagId, instance: {id} | {pageNumber, bbox}, status}
 *   add-instance        {tagId, instance: {pageNumber, bbox, annotationId?, confidence?}} → a
 *                       "confirmed" manual hit (an existing hit at the same place is confirmed instead).
 *
 * Demo projects are refused for every role (assertProjectWritable). Lock order: project row only.
 */

import { eq, sql } from "drizzle-orm";
import { projects } from "@/lib/db/schema";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  type ProjectWriteCapability,
  type ProjectWriteTransaction,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import {
  isYoloTagRow,
  tagInstanceKey,
  type ProjectedTagInstance,
  type TagInstanceStatus,
  type YoloTagLinks,
  yoloTagServerKey,
} from "@/lib/parse-engine/tag-key";
import type { YoloTag } from "@/types";

/** A stored tag row: the unchanged `YoloTag` plus the optional PLAN §2.1 links. */
export type StoredYoloTag = YoloTag & { links?: YoloTagLinks };

type InstanceRef = { id: string } | { pageNumber: number; bbox: [number, number, number, number] };

export type TagOp =
  | { op: "upsert"; tag: StoredYoloTag; match?: "id" | "key" }
  | { op: "remove"; id: string }
  | { op: "replace-for-region"; regionId: string; tags: StoredYoloTag[]; retireIds?: string[] }
  | { op: "set-instance-status"; tagId: string; instance: InstanceRef; status: TagInstanceStatus }
  | {
      op: "add-instance";
      tagId: string;
      instance: { pageNumber: number; bbox: [number, number, number, number]; annotationId?: number; confidence?: number };
    };

export interface TagOpsResult {
  /** Rows created or changed by this call, as stored. */
  tags: StoredYoloTag[];
  /** Ids removed by this call. */
  removed: string[];
  /** Regions whose rows were replaced wholesale (a client drops its cached rows of these regions). */
  replacedRegionIds: string[];
  /** Ops that named a missing tag or instance. */
  skipped: { index: number; reason: string }[];
}

export const MAX_TAG_OPS = 2_000;
const MAX_TAGS_PER_OP = 5_000;
const MAX_ID = 300;
const STATUSES: readonly TagInstanceStatus[] = ["auto", "confirmed", "rejected"];

function invalid(message: string): never {
  throw new ApiError("VALIDATION", message);
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID) {
    invalid(`${label} must be a 1-${MAX_ID} character string`);
  }
  return value;
}

function readBbox(value: unknown, label: string): [number, number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    invalid(`${label} must be four finite numbers`);
  }
  return [value[0], value[1], value[2], value[3]];
}

function readPage(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalid(`${label} must be a positive integer`);
  }
  return value;
}

function readTag(value: unknown, label: string): StoredYoloTag {
  if (!isYoloTagRow(value)) invalid(`${label} is not a valid tag`);
  const tag = value as StoredYoloTag;
  readId(tag.id, `${label}.id`);
  return tag;
}

function readTags(value: unknown, label: string): StoredYoloTag[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_OP) {
    invalid(`${label} must be an array of at most ${MAX_TAGS_PER_OP} tags`);
  }
  return value.map((tag, i) => readTag(tag, `${label}[${i}]`));
}

function readOp(raw: unknown, i: number): TagOp {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`ops[${i}] must be an object`);
  const o = raw as Record<string, unknown>;
  const at = `ops[${i}]`;
  switch (o.op) {
    case "upsert": {
      if (o.match !== undefined && o.match !== "id" && o.match !== "key") invalid(`${at}.match must be id or key`);
      return { op: "upsert", tag: readTag(o.tag, `${at}.tag`), ...(o.match ? { match: o.match } : {}) };
    }
    case "remove":
      return { op: "remove", id: readId(o.id, `${at}.id`) };
    case "replace-for-region": {
      const retireIds = o.retireIds === undefined
        ? undefined
        : Array.isArray(o.retireIds) && o.retireIds.length <= MAX_TAGS_PER_OP
          ? o.retireIds.map((id, k) => readId(id, `${at}.retireIds[${k}]`))
          : invalid(`${at}.retireIds must be an array of ids`);
      return {
        op: "replace-for-region",
        regionId: readId(o.regionId, `${at}.regionId`),
        tags: readTags(o.tags, `${at}.tags`),
        ...(retireIds ? { retireIds } : {}),
      };
    }
    case "set-instance-status": {
      if (!STATUSES.includes(o.status as TagInstanceStatus)) invalid(`${at}.status must be auto, confirmed or rejected`);
      const inst = o.instance as Record<string, unknown> | null;
      if (!inst || typeof inst !== "object") invalid(`${at}.instance is required`);
      const ref: InstanceRef = inst.id !== undefined
        ? { id: readId(inst.id, `${at}.instance.id`) }
        : { pageNumber: readPage(inst.pageNumber, `${at}.instance.pageNumber`), bbox: readBbox(inst.bbox, `${at}.instance.bbox`) };
      return { op: "set-instance-status", tagId: readId(o.tagId, `${at}.tagId`), instance: ref, status: o.status as TagInstanceStatus };
    }
    case "add-instance": {
      const inst = o.instance as Record<string, unknown> | null;
      if (!inst || typeof inst !== "object") invalid(`${at}.instance is required`);
      const annotationId = inst.annotationId;
      const confidence = inst.confidence;
      if (annotationId !== undefined && !(typeof annotationId === "number" && Number.isFinite(annotationId))) {
        invalid(`${at}.instance.annotationId must be a finite number`);
      }
      if (confidence !== undefined && !(typeof confidence === "number" && Number.isFinite(confidence))) {
        invalid(`${at}.instance.confidence must be a finite number`);
      }
      return {
        op: "add-instance",
        tagId: readId(o.tagId, `${at}.tagId`),
        instance: {
          pageNumber: readPage(inst.pageNumber, `${at}.instance.pageNumber`),
          bbox: readBbox(inst.bbox, `${at}.instance.bbox`),
          ...(annotationId === undefined ? {} : { annotationId: annotationId as number }),
          ...(confidence === undefined ? {} : { confidence: confidence as number }),
        },
      };
    }
    default:
      return invalid(`${at}.op is not a tag op`);
  }
}

/** Shape-only validation of the request body `{ ops: TagOp[] }`. */
export function parseTagOps(body: Record<string, unknown>): TagOp[] {
  const { ops } = body;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_TAG_OPS) {
    invalid(`ops must be an array of 1-${MAX_TAG_OPS} ops`);
  }
  return ops.map(readOp);
}

function instanceMatches(inst: ProjectedTagInstance, ref: InstanceRef): boolean {
  if ("id" in ref) return inst.id === ref.id;
  return inst.pageNumber === ref.pageNumber && tagInstanceKey(inst.pageNumber, inst.bbox) === tagInstanceKey(ref.pageNumber, ref.bbox);
}

/**
 * Pure: apply `ops` to `rows` in order. Never mutates its inputs. Rows keep their array position
 * when replaced; new rows are appended.
 */
export function applyTagOpsToRows(rows: readonly StoredYoloTag[], ops: readonly TagOp[]): { rows: StoredYoloTag[] } & TagOpsResult {
  let next: StoredYoloTag[] = [...rows];
  const touched = new Map<string, StoredYoloTag>();
  const removed = new Set<string>();
  const replacedRegionIds: string[] = [];
  const skipped: TagOpsResult["skipped"] = [];

  const put = (tag: StoredYoloTag, at: number) => {
    if (at >= 0) next[at] = tag;
    else next.push(tag);
    touched.set(tag.id, tag);
    removed.delete(tag.id);
  };
  const drop = (keep: (tag: StoredYoloTag) => boolean) => {
    const kept: StoredYoloTag[] = [];
    for (const tag of next) {
      if (keep(tag)) kept.push(tag);
      else {
        removed.add(tag.id);
        touched.delete(tag.id);
      }
    }
    next = kept;
  };
  const editInstances = (index: number, tagId: string, edit: (instances: ProjectedTagInstance[]) => ProjectedTagInstance[] | null) => {
    const at = next.findIndex((tag) => tag.id === tagId);
    if (at < 0) {
      skipped.push({ index, reason: "tag not found" });
      return;
    }
    const instances = edit(next[at].instances as ProjectedTagInstance[]);
    if (!instances) {
      skipped.push({ index, reason: "instance not found" });
      return;
    }
    put({ ...next[at], instances }, at);
  };

  ops.forEach((op, index) => {
    switch (op.op) {
      case "upsert": {
        let at = next.findIndex((tag) => tag.id === op.tag.id);
        if (at < 0 && op.match === "key") {
          const key = yoloTagServerKey(op.tag);
          at = next.findIndex((tag) => yoloTagServerKey(tag) === key);
        }
        put(at >= 0 ? { ...op.tag, id: next[at].id } : op.tag, at);
        break;
      }
      case "remove": {
        if (!next.some((tag) => tag.id === op.id)) skipped.push({ index, reason: "tag not found" });
        else drop((tag) => tag.id !== op.id);
        break;
      }
      case "replace-for-region": {
        const inRegion = (tag: StoredYoloTag) => tag.links?.regionId === op.regionId;
        const prior = new Map<string, string>();
        for (const tag of next) {
          if (inRegion(tag) && !prior.has(yoloTagServerKey(tag))) prior.set(yoloTagServerKey(tag), tag.id);
        }
        const incoming = new Map<string, StoredYoloTag>();
        for (const tag of op.tags) {
          if (tag.instances.length === 0) continue;
          const linked: StoredYoloTag = { ...tag, links: { ...tag.links, regionId: op.regionId } };
          const key = yoloTagServerKey(linked);
          incoming.set(key, { ...linked, id: prior.get(key) ?? incoming.get(key)?.id ?? linked.id });
        }
        const retire = new Set(op.retireIds ?? []);
        const keepIds = new Set([...incoming.values()].map((tag) => tag.id));
        drop((tag) => {
          if (inRegion(tag)) return keepIds.has(tag.id);
          if (retire.has(tag.id) && tag.links?.regionId === undefined) return false;
          return true;
        });
        for (const tag of incoming.values()) {
          put(tag, next.findIndex((row) => row.id === tag.id));
        }
        replacedRegionIds.push(op.regionId);
        break;
      }
      case "set-instance-status": {
        editInstances(index, op.tagId, (instances) => {
          const hit = instances.findIndex((inst) => instanceMatches(inst, op.instance));
          if (hit < 0) return null;
          return instances.map((inst, k) => (k === hit ? { ...inst, status: op.status } : inst));
        });
        break;
      }
      case "add-instance": {
        editInstances(index, op.tagId, (instances) => {
          const { pageNumber, bbox } = op.instance;
          const id = tagInstanceKey(pageNumber, bbox);
          const hit = instances.findIndex((inst) => instanceMatches(inst, { pageNumber, bbox }));
          if (hit >= 0) return instances.map((inst, k) => (k === hit ? { ...inst, status: "confirmed" } : inst));
          return [
            ...instances,
            {
              pageNumber,
              annotationId: op.instance.annotationId ?? -1,
              bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
              confidence: op.instance.confidence ?? 1,
              id,
              status: "confirmed",
            },
          ];
        });
        break;
      }
    }
  });

  return {
    rows: next,
    tags: [...touched.values()],
    removed: [...removed],
    replacedRegionIds,
    skipped,
  };
}

/**
 * Transaction helper: lock the project row in the caller's transaction, read `yoloTags`, apply
 * `ops`, write the one key back with `||` (every other projectIntelligence key survives).
 *
 * The caller opens the transaction through `withProjectWrite` (the route below; from TP-3 the commit
 * and tag-map services), which already holds this lock. The row is re-locked and re-checked against
 * the capability here so a caller that forgets cannot write a demo project or a recycled project id.
 * (Not `withProjectWritesInTransaction`: its call sites are a frozen security inventory.)
 */
export async function applyTagOps(
  tx: ProjectWriteTransaction,
  capability: ProjectWriteCapability,
  ops: readonly TagOp[],
): Promise<TagOpsResult> {
  const [row] = await tx
    .select({
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
      projectIntelligence: projects.projectIntelligence,
    })
    .from(projects)
    .where(eq(projects.id, capability.projectId))
    .for("update")
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Project not found");
  if (row.isDemo) throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  if (
    row.publicId !== capability.publicId ||
    row.companyId !== capability.companyId ||
    row.lifecycleEpoch !== capability.lifecycleEpoch
  ) {
    throw new ApiError("FORBIDDEN", "Project write capability expired");
  }
  const pi = (row.projectIntelligence ?? null) as Record<string, unknown> | null;
  const current = Array.isArray(pi?.yoloTags) ? (pi.yoloTags as StoredYoloTag[]) : [];
  const { rows, ...result } = applyTagOpsToRows(current, ops);
  if (result.tags.length > 0 || result.removed.length > 0) {
    // One-key merge object, built as updateProject builds it. (yoloTagsMigrationTopology pins the
    // legacy client direct-writer literal out of production code; this is the server's own write.)
    const patch: Record<string, unknown> = { yoloTags: rows };
    await tx
      .update(projects)
      .set({
        projectIntelligence: sql`coalesce(${projects.projectIntelligence}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, capability.projectId));
  }
  return result;
}

/** Route service for `POST /api/projects/[id]/tags/ops`. */
export async function postTagOps(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
): Promise<TagOpsResult> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const ops = parseTagOps(body);
  return withProjectWrite(writeCapability, accessProject.id, (tx) => applyTagOps(tx, writeCapability, ops));
}
