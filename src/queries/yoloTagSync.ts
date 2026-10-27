// [table pipeline WP-2.D2, K05/K39/K40] Pure row algebra of the yoloTags cache facade
// (`useYoloTags.ts`): the shared merge key, the K39 "already mapped" identity, the key merge, the
// local mirror of the server's `replace-for-region`, the id diff the save lane persists as tag ops,
// and server-row adoption. No React, no Query, no I/O — the facade owns the cache and the transport.

import { type TagKeyFields, type YoloTagLinks, yoloTagServerKey } from "@/lib/parse-engine/tag-key";
import type { YoloTag } from "@/types";

/** A cached row: the unchanged `YoloTag` plus the optional PLAN §2.1 links that tag-ops rows carry. */
export type YoloTagRow = YoloTag & { links?: YoloTagLinks };

/** The tag-ops wire ops this facade sends (a subset of `TagOp` in server/services/tag-ops.ts). */
export type YoloTagOp =
  | { op: "upsert"; tag: YoloTagRow }
  | { op: "remove"; id: string }
  | { op: "replace-for-region"; regionId: string; tags: YoloTagRow[]; retireIds?: string[] };

export type RegionOp = Extract<YoloTagOp, { op: "replace-for-region" }>;

/** Legacy (unlinked, pre-TP-2) rows a region re-map takes over: same identity, one of `texts`. */
export interface LegacyRegionTags {
  source: YoloTag["source"];
  scope: YoloTag["scope"];
  yoloClass: string;
  texts: readonly string[];
}

export function regionOf(tag: YoloTag): string | undefined {
  return (tag as YoloTagRow).links?.regionId;
}

/** Client merge key: the shared server key (page-aware for page scope, region-aware when linked). */
export function makeYoloTagKey(tag: YoloTag): string {
  return yoloTagServerKey(tag as YoloTagRow);
}

/** The key the same tag had before it was linked to a region (a legacy, pre-TP-2 row). */
function unlinkedKey(tag: TagKeyFields): string {
  return yoloTagServerKey({ ...tag, links: undefined });
}

/**
 * True when a tag with this identity is already cached: the same server key, or — for a
 * region-linked probe — an unlinked legacy row with the same identity (that row is the region's
 * pre-TP-2 tag). Inline Map Tags skips only these exact identities (K39): a text mapped on another
 * sheet, region, class, scope or source no longer blocks mapping.
 */
export function isYoloTagMapped(rows: readonly YoloTag[], probe: TagKeyFields): boolean {
  const key = yoloTagServerKey(probe);
  const legacy = probe.links?.regionId ? unlinkedKey(probe) : null;
  return rows.some((row) => {
    const rowKey = makeYoloTagKey(row);
    return rowKey === key || (legacy !== null && regionOf(row) === undefined && rowKey === legacy);
  });
}

/**
 * Key merge, incoming last-wins at the first position of its key (the legacy Map semantics). A
 * region-linked incoming tag also takes over the unlinked legacy row of the same identity.
 */
export function mergeYoloTags(current: YoloTag[], incoming: YoloTag[]): YoloTag[] {
  const rows: YoloTag[] = [];
  const at = new Map<string, number>();
  const put = (key: string, tag: YoloTag) => {
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, rows.length);
      rows.push(tag);
    } else rows[index] = tag;
  };
  for (const tag of current) put(makeYoloTagKey(tag), tag);
  for (const tag of incoming) {
    const key = makeYoloTagKey(tag);
    if (!at.has(key) && regionOf(tag) !== undefined) {
      const legacyKey = unlinkedKey(tag as YoloTagRow);
      const index = at.get(legacyKey);
      if (index !== undefined && regionOf(rows[index]) === undefined) {
        at.delete(legacyKey);
        at.set(key, index);
      }
    }
    put(key, tag);
  }
  return rows;
}

export function withRegion(tag: YoloTag, regionId: string): YoloTagRow {
  return { ...tag, links: { ...(tag as YoloTagRow).links, regionId } };
}

/**
 * Local mirror of the server's `replace-for-region` (tag-ops.ts): the region's rows become exactly
 * the incoming tags with ≥ 1 hit (a prior row of the same key keeps its id); the region's other
 * rows and the named unlinked legacy rows are removed; every other row is untouched. The server
 * response is adopted afterwards, so any id it chose differently wins.
 */
export function replaceRegionRows(rows: readonly YoloTag[], op: RegionOp): YoloTag[] {
  const retire = new Set(op.retireIds ?? []);
  const prior = new Map<string, string>();
  for (const row of rows) {
    if (regionOf(row) === op.regionId && !prior.has(makeYoloTagKey(row))) prior.set(makeYoloTagKey(row), row.id);
  }
  const incoming = new Map<string, YoloTag>();
  for (const tag of op.tags) {
    if (tag.instances.length === 0) continue;
    const linked = withRegion(tag, op.regionId);
    const key = makeYoloTagKey(linked);
    incoming.set(key, { ...linked, id: prior.get(key) ?? incoming.get(key)?.id ?? linked.id });
  }
  const next: YoloTag[] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const region = regionOf(row);
    if (region === op.regionId) {
      const key = makeYoloTagKey(row);
      const replacement = incoming.get(key);
      if (replacement && replacement.id === row.id && !placed.has(key)) {
        next.push(replacement);
        placed.add(key);
      }
      continue;
    }
    if (region === undefined && retire.has(row.id)) continue;
    next.push(row);
  }
  for (const [key, tag] of incoming) if (!placed.has(key)) next.push(tag);
  return next;
}

function sameRow(a: YoloTag, b: YoloTag): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Id-keyed ops that turn `base` into `next`: an upsert per new or changed row, a remove per gone id. */
export function diffYoloTagOps(base: readonly YoloTag[], next: readonly YoloTag[]): YoloTagOp[] {
  const before = new Map<string, YoloTag>();
  for (const row of base) before.set(row.id, row);
  const ops: YoloTagOp[] = [];
  const present = new Set<string>();
  for (const row of next) {
    present.add(row.id);
    const prev = before.get(row.id);
    if (!prev || !sameRow(prev, row)) ops.push({ op: "upsert", tag: row });
  }
  for (const id of before.keys()) if (!present.has(id)) ops.push({ op: "remove", id });
  return ops;
}

/** Apply acknowledged id ops to a row list (keeps positions; appends new ids). */
export function applyIdOps(rows: readonly YoloTag[], ops: readonly YoloTagOp[]): YoloTag[] {
  let next = [...rows];
  for (const op of ops) {
    if (op.op === "upsert") {
      const index = next.findIndex((row) => row.id === op.tag.id);
      if (index >= 0) next[index] = op.tag;
      else next.push(op.tag);
    } else if (op.op === "remove") {
      next = next.filter((row) => row.id !== op.id);
    }
  }
  return next;
}

/** Server rows replace cached rows by id (new ids append); replaced regions keep only server rows. */
export function adoptRows(
  rows: readonly YoloTag[],
  serverRows: readonly YoloTag[],
  replacedRegionIds: readonly string[],
  removedIds: readonly string[],
): YoloTag[] {
  const regions = new Set(replacedRegionIds);
  const removed = new Set(removedIds);
  const incoming = new Map<string, YoloTag>();
  for (const row of serverRows) incoming.set(row.id, row);
  const next: YoloTag[] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const server = incoming.get(row.id);
    if (server) {
      if (!placed.has(row.id)) next.push(server);
      placed.add(row.id);
      continue;
    }
    const region = regionOf(row);
    if (removed.has(row.id) || (region !== undefined && regions.has(region))) continue;
    next.push(row);
  }
  for (const row of serverRows) {
    if (!placed.has(row.id)) {
      next.push(row);
      placed.add(row.id);
    }
  }
  return next;
}

/** Ids of the unlinked legacy rows a region re-map takes over (`LegacyRegionTags`). */
export function legacyRetireIds(rows: readonly YoloTag[], legacy: LegacyRegionTags | undefined): string[] {
  if (!legacy) return [];
  const keys = new Set(legacy.texts.map((tagText) =>
    yoloTagServerKey({ source: legacy.source, scope: legacy.scope, tagText, yoloClass: legacy.yoloClass })));
  return rows.filter((row) => regionOf(row) === undefined && keys.has(makeYoloTagKey(row))).map((row) => row.id);
}
