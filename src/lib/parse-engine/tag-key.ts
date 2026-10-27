// [table pipeline WP-2.D1, K05/K19/K40] The one tag identity, shared by the server tag-ops service
// and (from WP-2.D2) the client yoloTags cache.
//
// Client-safe (E-8): this module imports nothing. The tag shapes below are STRUCTURAL copies of
// `YoloTag` (types/index.ts, unchanged) and `ScoredMatch` (tag-mapping/types.ts) — the purity test
// forbids importing either — and `YoloTagLinks` / `TagInstanceV1` are the PLAN §2.1 contract
// types. When `parse-engine/types.ts` (WP-2.E) lands, the integrator may switch the two contract
// types to `import type … from "./types"`; the shapes are identical.
//
// Why a new key: the legacy cache key `source::TAGTEXT::scope::yoloClass` has no page and no
// region, so sheet B's keynote "3" replaced sheet A's (K05) and two schedules that both number
// their rows "1" shared one tag. The server key adds the page (page scope only) and the region.

/** Optional links on a stored YoloTag (PLAN §2.1). A legend tag is source "keynote" | "schedule"
 *  with `kind: "legend"`; `YoloTag.source` is NOT widened (C2-M9). */
export interface YoloTagLinks {
  key?: string;
  regionId?: string;
  rowId?: string;
  kind?: "legend" | "keynote" | "schedule" | "notes";
}

export type TagInstanceStatus = "auto" | "confirmed" | "rejected";

/** PLAN §2.1 tag-map instance (stored in `PJ.tagMaps` from TP-4). */
export interface TagInstanceV1 {
  id: string;
  page: number;
  b: [number, number, number, number];
  anchor: {
    annotationId?: number;
    cls?: string;
    src: "yolo" | "classical" | "text" | "template" | "manual";
  };
  score: number;
  tier: "high" | "medium" | "low";
  status: TagInstanceStatus;
}

/** A `YoloTag.instances` entry: the `ScoredMatch` fields plus the optional review fields the
 *  tag-ops service writes (`id`, `status`). Readers that ignore them keep working. */
export interface ProjectedTagInstance {
  pageNumber: number;
  annotationId: number;
  bbox: [number, number, number, number];
  confidence: number;
  score?: number;
  confidenceTier?: "high" | "medium" | "low";
  id?: string;
  status?: TagInstanceStatus;
}

/** The fields the key reads (a `YoloTag` with optional `links` satisfies it). */
export interface TagKeyFields {
  source: string;
  scope: string;
  pageNumber?: number;
  tagText: string;
  yoloClass?: string;
  links?: YoloTagLinks;
}

/**
 * Server key (PLAN §2.1):
 * `${source}|${scope}|${scope === "page" ? pageNumber : "*"}|${regionId ?? "*"}|${TAGTEXT}|${yoloClass ?? ""}`.
 * A page-scoped tag with no page number keys as "*" (never the string "undefined").
 */
export function yoloTagServerKey(tag: TagKeyFields): string {
  const page = tag.scope === "page" && typeof tag.pageNumber === "number" ? String(tag.pageNumber) : "*";
  const region = tag.links?.regionId ?? "*";
  return `${tag.source}|${tag.scope}|${page}|${region}|${tag.tagText.toUpperCase()}|${tag.yoloClass ?? ""}`;
}

/** Instance identity on a page: the page plus the bbox quantised to 1e-4 (sub-pixel jitter in
 *  re-serialised floats never splits one hit into two). */
export function tagInstanceKey(pageNumber: number, bbox: readonly number[]): string {
  return `i:${pageNumber}:${bbox.map((v) => Math.round(v * 10_000)).join(",")}`;
}

/** `TagInstanceV1 → YoloTag.instances[i]` (PLAN §2.1). `annotationId` falls back to -1 so the
 *  client `isYoloTag` guard (finite annotationId) keeps the row (C1-M2). */
export function projectTagInstance(inst: TagInstanceV1): ProjectedTagInstance {
  return {
    pageNumber: inst.page,
    annotationId: inst.anchor.annotationId ?? -1,
    bbox: [inst.b[0], inst.b[1], inst.b[2], inst.b[3]],
    confidence: inst.score,
    score: inst.score,
    confidenceTier: inst.tier,
    id: inst.id,
    status: inst.status,
  };
}

const SOURCES: readonly unknown[] = ["keynote", "schedule", "manual"];
const SCOPES: readonly unknown[] = ["page", "project"];
const STATUSES: readonly unknown[] = ["auto", "confirmed", "rejected"];
const LINK_KINDS: readonly unknown[] = ["legend", "keynote", "schedule", "notes"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

/**
 * The client bootstrap guard (`useYoloTags.ts` `isYoloTag`), restated here so the server refuses
 * exactly the rows the viewer would drop. It additionally checks the optional fields this module
 * adds (`links`, instance `id`/`status`) when present. Kept in lockstep by `tag-key.test.ts`.
 */
export function isYoloTagRow(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.tagText !== "string" ||
    typeof row.yoloClass !== "string" ||
    typeof row.yoloModel !== "string" ||
    !SOURCES.includes(row.source) ||
    !SCOPES.includes(row.scope) ||
    !Array.isArray(row.instances)
  ) {
    return false;
  }
  if (row.links !== undefined) {
    const links = row.links as Record<string, unknown> | null;
    if (!links || typeof links !== "object" || Array.isArray(links)) return false;
    if (
      !isOptionalString(links.key, 2_000) ||
      !isOptionalString(links.regionId, 300) ||
      !isOptionalString(links.rowId, 300) ||
      (links.kind !== undefined && !LINK_KINDS.includes(links.kind))
    ) {
      return false;
    }
  }
  return row.instances.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const instance = candidate as Record<string, unknown>;
    return (
      isFiniteNumber(instance.pageNumber) &&
      isFiniteNumber(instance.annotationId) &&
      isFiniteNumber(instance.confidence) &&
      Array.isArray(instance.bbox) &&
      instance.bbox.length === 4 &&
      instance.bbox.every(isFiniteNumber) &&
      isOptionalString(instance.id, 300) &&
      (instance.status === undefined || STATUSES.includes(instance.status))
    );
  });
}
