"use client";

// [refactor jul11 P2.2⑨] YOLO TAGS cache/action facade.
//
// This is a bootstrap-seeded project collection, not ordinary request/response CRUD. The server
// has no tags GET, so edits stay synchronous local cache writes followed by a trailing debounced
// save—NOT generic optimistic useMutation rollback/invalidation (which would erase local work and
// refetch through no endpoint). See P2_DESIGN/YOLO_TAGS_IMPL/{RECON_CENSUS,DESIGN_BRIEF}.md.
//
// [table pipeline WP-2.D2, K05/K19/K39/K40] Transport. The trailing save no longer PUTs the whole
// array (a second tab or user overwrote the first, K19). It diffs the newest snapshot against the
// rows the server last acknowledged, by tag `id`, and POSTs those id-keyed ops to
// `/api/projects/[id]/tags/ops` (WP-2.D1), where they are applied under the project row lock.
// A table re-map queues one `replace-for-region` op instead, so tags that now have 0 hits are
// cleared for that region only (K40). The merge key is the shared server key from
// `lib/parse-engine/tag-key.ts`: page-aware for page-scoped tags (sheet B's keynote "3" no longer
// replaces sheet A's, K05) and region-aware for region-linked tags. The whole-array
// `{ yoloTags: snapshot }` PUT stays here, owned by this facade alone: it is the import transport,
// and the fallback when the ops route refuses a body as malformed (400/413) or a diff is too large,
// so nothing the legacy PUT persisted can stop persisting.

import { useCallback } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { apiErrorMessage, persistFetch, persistFetchResult } from "@/lib/client-persist";
import { selectActiveTagId, selectActiveToolKey } from "@/lib/active-tool-state";
import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import { navigateViewerPageUnclamped } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import type { YoloTag } from "@/types";
import {
  adoptRows,
  applyIdOps,
  diffYoloTagOps,
  legacyRetireIds,
  type LegacyRegionTags,
  mergeYoloTags,
  regionOf,
  regionRowsOutsideScope,
  type RegionOp,
  replaceRegionRows,
  withRegion,
  type YoloTagOp,
  type YoloTagRow,
} from "@/queries/yoloTagSync";

export {
  diffYoloTagOps,
  isYoloTagMapped,
  type LegacyRegionTags,
  makeYoloTagKey,
  type YoloTagOp,
  type YoloTagRow,
} from "@/queries/yoloTagSync";

const EMPTY_YOLO_TAGS = Object.freeze([]) as unknown as YoloTag[];
const SAVE_DELAY_MS = 500;
const SAVE_REQUEST_TIMEOUT_MS = 30_000;
/** Server cap (`MAX_TAG_OPS`, server/services/tag-ops.ts). A larger diff goes as one whole-array PUT. */
const MAX_OPS_PER_REQUEST = 2_000;

type ProjectIntelligence = Record<string, unknown> | null | undefined;
type YoloTagUpdater = (rows: YoloTag[]) => YoloTag[];

/** `POST …/tags/ops` response (`TagOpsResult`). */
interface TagOpsResponse {
  tags?: YoloTagRow[];
  removed?: string[];
  replacedRegionIds?: string[];
}

interface SaveLane {
  timer: ReturnType<typeof setTimeout> | null;
  /** True once the trailing delay elapsed for the newest dirty snapshot. */
  ready: boolean;
  dirty: boolean;
  retired: boolean;
  snapshot: YoloTag[];
  /**
   * The rows the server last acknowledged (bootstrap, a successful save, adopted server rows); the
   * id diff runs against it. Null until the first edit captures the pre-edit cache.
   */
  baseline: YoloTag[] | null;
  /** Region replacements for the next request, sent before the id diff. */
  regionOps: RegionOp[];
  /** The next request is the whole-array PUT (import, or the fallback). */
  wholeArray: boolean;
  /** Bumped by exact cleanup so a retired request's completion cannot touch a reopened lane. */
  generation: number;
  /** Requests are serialized so an older save cannot finish after a newer one. */
  inFlight: Promise<void> | null;
  abortController: AbortController | null;
}

// QueryClient is the lifetime boundary: tests, HMR roots, and independent app roots cannot cancel
// or serialize one another's writes. The nested map fixes the legacy global-timer A↔B collision.
const saveLanes = new WeakMap<QueryClient, Map<string, SaveLane>>();
const projectEpochs = new WeakMap<QueryClient, Map<string, number>>();

function epochMapFor(qc: QueryClient): Map<string, number> {
  let epochs = projectEpochs.get(qc);
  if (!epochs) {
    epochs = new Map();
    projectEpochs.set(qc, epochs);
  }
  return epochs;
}

function currentProjectEpoch(qc: QueryClient, publicId: string): number {
  return epochMapFor(qc).get(publicId) ?? 0;
}

function bumpProjectEpoch(qc: QueryClient, publicId: string): number {
  const epochs = epochMapFor(qc);
  const next = (epochs.get(publicId) ?? 0) + 1;
  epochs.set(publicId, next);
  return next;
}

function lanesFor(qc: QueryClient): Map<string, SaveLane> {
  let lanes = saveLanes.get(qc);
  if (!lanes) {
    lanes = new Map();
    saveLanes.set(qc, lanes);
  }
  return lanes;
}

function laneFor(qc: QueryClient, publicId: string): SaveLane {
  const lanes = lanesFor(qc);
  let lane = lanes.get(publicId);
  if (!lane) {
    lane = {
      timer: null,
      ready: false,
      dirty: false,
      retired: false,
      snapshot: EMPTY_YOLO_TAGS,
      baseline: null,
      regionOps: [],
      wholeArray: false,
      generation: 0,
      inFlight: null,
      abortController: null,
    };
    lanes.set(publicId, lane);
  }
  return lane;
}

/** Adopt server rows into the cache, the acknowledged baseline and any pending snapshot, never
 *  marking the lane dirty (the server already holds them). */
function adoptIntoProject(
  qc: QueryClient,
  publicId: string,
  serverRows: readonly YoloTag[],
  replacedRegionIds: readonly string[],
  removedIds: readonly string[],
): void {
  const key = queryKeys.yoloTags.all(publicId);
  const current = qc.getQueryData<YoloTag[]>(key);
  if (current === undefined) return; // closed project: never resurrect its cache entry
  const next = adoptRows(current, serverRows, replacedRegionIds, removedIds);
  qc.setQueryData<YoloTag[]>(key, next);
  const lane = saveLanes.get(qc)?.get(publicId);
  if (!lane || lane.retired) return;
  if (lane.baseline) lane.baseline = adoptRows(lane.baseline, serverRows, replacedRegionIds, removedIds);
  if (lane.dirty) lane.snapshot = next;
}

function saveFailed(error: unknown): void {
  // Preserve legacy failure-keep UX: the local cache remains edited, and the next edit's save
  // re-sends everything the server has not acknowledged.
  console.error("[yoloTags] Save failed:", error);
}

/** Body shapes the ops route refuses as malformed; the whole-array PUT is retried instead. */
function isRefusedBody(status: number): boolean {
  return status === 400 || status === 413;
}

function sendSave(
  lane: SaveLane,
  publicId: string,
  qc: QueryClient,
  signal: AbortSignal,
): Promise<void> {
  // Capture the exact newest immutable array reference now. Later edits replace lane.snapshot and
  // mark dirty again; they cannot mutate or overtake this request.
  const snapshot = lane.snapshot;
  const generation = lane.generation;
  const current = () => lane.generation === generation && !lane.retired;
  const regionOps = lane.regionOps;
  lane.regionOps = [];
  const base = regionOps.reduce(replaceRegionRows, lane.baseline ?? EMPTY_YOLO_TAGS);
  const idOps = lane.wholeArray ? [] : diffYoloTagOps(base, snapshot);
  const ops: YoloTagOp[] = [...regionOps, ...idOps];

  if (lane.wholeArray || ops.length > MAX_OPS_PER_REQUEST) {
    lane.wholeArray = false;
    return persistFetch(`/api/projects/${publicId}`, { yoloTags: snapshot }, "PUT", signal)
      .then(() => {
        if (current()) lane.baseline = snapshot;
      })
      .catch((error: Error) => {
        if (current()) lane.wholeArray = true;
        saveFailed(error);
      });
  }
  if (ops.length === 0) return Promise.resolve();

  return persistFetchResult<TagOpsResponse>(`/api/projects/${publicId}/tags/ops`, { ops }, "POST", signal)
    .then((result) => {
      if (!current()) return;
      if (result.ok) {
        lane.baseline = applyIdOps(lane.baseline ?? EMPTY_YOLO_TAGS, idOps);
        if (regionOps.length > 0) {
          const replaced = result.body?.replacedRegionIds ?? [];
          const regionRows = (result.body?.tags ?? []).filter((row) => {
            const region = regionOf(row);
            return region !== undefined && replaced.includes(region);
          });
          adoptIntoProject(qc, publicId, regionRows, replaced, result.body?.removed ?? []);
        }
        return;
      }
      if (isRefusedBody(result.status)) {
        // The cache already holds every edit (region replacements included), so the whole array
        // carries them; send it next instead of re-sending a body the route refuses forever.
        lane.wholeArray = true;
        lane.snapshot = qc.getQueryData<YoloTag[]>(queryKeys.yoloTags.all(publicId)) ?? lane.snapshot;
        lane.dirty = true;
        lane.ready = true;
      } else {
        lane.regionOps = [...regionOps, ...lane.regionOps];
      }
      saveFailed(new Error(apiErrorMessage(result.body) ?? `Save failed (${result.status})`));
    })
    .catch((error: Error) => {
      if (current()) lane.regionOps = [...regionOps, ...lane.regionOps];
      saveFailed(error);
    });
}

function maybeStartSave(qc: QueryClient, publicId: string, lane: SaveLane): void {
  if (lane.retired || lane.inFlight || !lane.ready || !lane.dirty) return;

  lane.ready = false;
  lane.dirty = false;
  const controller = new AbortController();
  lane.abortController = controller;
  // A stalled browser/network request must not wedge this project's serialized lane forever.
  // Native fetch honors AbortSignal; the failure path releases the lane and drains newer work.
  const requestTimeout = setTimeout(() => controller.abort(), SAVE_REQUEST_TIMEOUT_MS);

  const request = sendSave(lane, publicId, qc, controller.signal)
    .then(() => undefined)
    .finally(() => clearTimeout(requestTimeout));

  lane.inFlight = request;
  void request.then(() => {
    if (lane.inFlight !== request) return;
    lane.inFlight = null;
    if (lane.abortController === controller) lane.abortController = null;

    if (lane.retired && !lane.dirty) {
      lanesFor(qc).delete(publicId);
      return;
    }
    // If a newer snapshot's 500ms delay expired while this request was in flight, send it now.
    // If its timer is still running, that timer remains the owner of the next drain.
    maybeStartSave(qc, publicId, lane);
  });
}

function scheduleSave(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  snapshot: YoloTag[],
  previous: YoloTag[],
): SaveLane | null {
  // Demo/pre-bootstrap CRUD stays local. Do not even allocate a timer: the old timer's eventual
  // early-return was not user-observable, while avoiding it removes test/unmount lifetime leaks.
  if (!publicId || isDemo) return null;

  const lane = laneFor(qc, publicId);
  // The first edit after bootstrap/cleanup diffs against the rows the cache held before it.
  if (lane.baseline === null) lane.baseline = previous;
  lane.retired = false;
  lane.snapshot = snapshot;
  lane.dirty = true;
  lane.ready = false;
  if (lane.timer) clearTimeout(lane.timer);
  lane.timer = setTimeout(() => {
    lane.timer = null;
    lane.ready = true;
    maybeStartSave(qc, publicId, lane);
  }, SAVE_DELAY_MS);
  return lane;
}

function writeAndSchedule(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  updater: YoloTagUpdater,
): { next: YoloTag[]; lane: SaveLane | null } {
  let previous = EMPTY_YOLO_TAGS;
  const next = qc.setQueryData<YoloTag[]>(
    queryKeys.yoloTags.all(publicId),
    (old = EMPTY_YOLO_TAGS) => {
      previous = old;
      return updater(old);
    },
  ) ?? EMPTY_YOLO_TAGS;
  return { next, lane: scheduleSave(qc, publicId, isDemo, next, previous) };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isYoloTag(value: unknown): value is YoloTag {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.tagText !== "string" ||
    typeof row.yoloClass !== "string" ||
    typeof row.yoloModel !== "string" ||
    !(["keynote", "schedule", "manual"] as unknown[]).includes(row.source) ||
    !(["page", "project"] as unknown[]).includes(row.scope) ||
    !Array.isArray(row.instances)
  ) {
    return false;
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
      instance.bbox.every(isFiniteNumber)
    );
  });
}

/** Same-tick handler/library bridge; cache publications are immediately visible here. */
export function readYoloTags(qc: QueryClient, publicId: string): YoloTag[] {
  return qc.getQueryData<YoloTag[]>(queryKeys.yoloTags.all(publicId)) ?? EMPTY_YOLO_TAGS;
}

/**
 * Project-open adapter: seeds the collection unconditionally and returns PI with duplicate yoloTags
 * property removed. The returned object feeds only the narrow csiGraph Query seed; retaining the
 * nested tag array there would duplicate the collection even at that one bootstrap boundary.
 */
export function seedYoloTagsFromBootstrap(
  qc: QueryClient,
  publicId: string,
  projectIntelligence: ProjectIntelligence,
): Record<string, unknown> | null {
  // Every bootstrap publication starts a new adoption epoch—including a same-publicId reopen.
  // Async map callbacks capture the mounted epoch and cannot write after the next lifecycle open.
  bumpProjectEpoch(qc, publicId);
  if (!projectIntelligence) {
    adoptBootstrapBaseline(qc, publicId, qc.setQueryData<YoloTag[]>(queryKeys.yoloTags.all(publicId), []));
    return null;
  }

  const { yoloTags: rawYoloTags, ...withoutYoloTags } = projectIntelligence;
  // The old wire type is unvalidated JSONB. Drop malformed rows/instances at this one boundary so
  // every downstream `.find/.filter` and bbox draw can rely on the declared YoloTag shape.
  const yoloTags = Array.isArray(rawYoloTags)
    ? rawYoloTags.filter(isYoloTag)
    : [];
  adoptBootstrapBaseline(qc, publicId, qc.setQueryData<YoloTag[]>(queryKeys.yoloTags.all(publicId), yoloTags));
  return withoutYoloTags;
}

/** Bootstrap rows are what the server holds; a clean lane diffs its next edit against them. A lane
 *  with unsent edits keeps its own baseline, so those edits still go out (as the legacy PUT did). */
function adoptBootstrapBaseline(qc: QueryClient, publicId: string, rows: YoloTag[] | undefined): void {
  const lane = saveLanes.get(qc)?.get(publicId);
  if (lane && !lane.dirty && lane.regionOps.length === 0 && !lane.wholeArray) lane.baseline = rows ?? null;
}

/** Exact teardown owned by openProject; never broaden this to queryKeys.project(). */
export function clearYoloTagsProject(qc: QueryClient, publicId: string): void {
  bumpProjectEpoch(qc, publicId);
  const lane = saveLanes.get(qc)?.get(publicId);
  if (lane) {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = null;
    lane.ready = false;
    lane.dirty = false;
    lane.retired = true;
    // Nothing unsent survives cleanup; a reopen captures a fresh baseline at its first edit.
    lane.baseline = null;
    lane.regionOps = [];
    lane.wholeArray = false;
    lane.generation += 1;
    // Best-effort retirement of a dispatched save. An HTTP request already processed server-side
    // cannot be recalled, but abort prevents a hung/slow response from owning this lane forever.
    lane.abortController?.abort();
    if (!lane.inFlight) saveLanes.get(qc)?.delete(publicId);
  }
  qc.removeQueries({ queryKey: queryKeys.yoloTags.all(publicId), exact: true });
}

export function addYoloTagToCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  tag: YoloTag,
): YoloTag[] {
  return writeAndSchedule(qc, publicId, isDemo, (rows) => mergeYoloTags(rows, [tag])).next;
}

/**
 * Bulk add (map results, scan accepts). With `links.regionId` every tag is stamped with that region,
 * so the merge key is region-aware: two schedules that both number a row "1" keep two tags.
 */
export function addYoloTagsBulkToCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  tags: YoloTag[],
  links?: { regionId?: string },
): YoloTag[] {
  if (tags.length === 0) return readYoloTags(qc, publicId);
  const regionId = links?.regionId;
  const stamped = regionId ? tags.map((tag) => withRegion(tag, regionId)) : tags;
  return writeAndSchedule(qc, publicId, isDemo, (rows) => mergeYoloTags(rows, stamped)).next;
}

/**
 * Re-map of one region (K40): its rows become exactly `tags` (those with ≥ 1 hit), so a tag that
 * now has 0 hits is cleared for that region only; rows of other regions are untouched. `legacy`
 * names the unlinked pre-TP-2 rows this region takes over (same identity, one of its texts); they
 * are retired. Persists as one `replace-for-region` op; the server's rows are adopted on success.
 */
export function replaceRegionYoloTagsInCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  regionId: string,
  tags: YoloTag[],
  legacy?: LegacyRegionTags,
): YoloTag[] {
  const queued: RegionOp[] = [];
  const { next, lane } = writeAndSchedule(qc, publicId, isDemo, (rows) => {
    const retireIds = legacyRetireIds(rows, legacy);
    // A scoped re-map keeps the region's rows of other classes/columns (MED-1): carry them through.
    const carried = legacy ? regionRowsOutsideScope(rows, regionId, legacy) : [];
    const op: RegionOp = {
      op: "replace-for-region",
      regionId,
      tags: [...carried, ...tags].map((tag) => withRegion(tag, regionId)),
      ...(retireIds.length > 0 ? { retireIds } : {}),
    };
    queued.push(op);
    return replaceRegionRows(rows, op);
  });
  if (lane) lane.regionOps.push(...queued);
  return next;
}

/**
 * Import transport: replace the whole collection and persist it as ONE whole-array PUT (the only
 * caller of that endpoint besides the malformed-body fallback). Edits made before it is sent ride
 * in the same array.
 */
export function importYoloTagsToCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  rows: YoloTag[],
): YoloTag[] {
  const { next, lane } = writeAndSchedule(qc, publicId, isDemo, () => [...rows]);
  if (lane) {
    lane.regionOps = [];
    lane.wholeArray = true;
  }
  return next;
}

/**
 * Server rows (a tag-ops, commit or tag-map response) into the cache without marking the save lane
 * dirty: rows replace cached rows by id (new ids append), each replaced region keeps only the server's
 * rows, and `removedIds` leave. The acknowledged baseline moves with it, so no echo op is sent.
 */
export function adoptServerYoloTags(
  qc: QueryClient,
  publicId: string,
  rows: readonly YoloTag[],
  replacedRegionIds: readonly string[],
  removedIds: readonly string[] = [],
): YoloTag[] {
  adoptIntoProject(qc, publicId, rows, replacedRegionIds, removedIds);
  return readYoloTags(qc, publicId);
}

export function removeYoloTagFromCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  id: string,
): YoloTag[] {
  return writeAndSchedule(qc, publicId, isDemo, (rows) => rows.filter((tag) => tag.id !== id)).next;
}

export function updateYoloTagInCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  id: string,
  updates: Partial<YoloTag>,
): YoloTag[] {
  // Deliberately do not re-dedupe after an identity-field edit; the legacy update action didn't.
  return writeAndSchedule(qc, publicId, isDemo, (rows) =>
    rows.map((tag) => (tag.id === id ? { ...tag, ...updates } : tag)),
  ).next;
}

/** Data-dependent UI action that migrates with the collection; Zustand retains only its outputs. */
export function navigateYoloTag(
  qc: QueryClient,
  publicId: string,
  tagId: string,
  index: number,
): void {
  const tag = readYoloTags(qc, publicId).find((row) => row.id === tagId);
  if (!tag) return;

  if (tag.instances.length === 0) {
    useUiStore.getState().setYoloBrowseState({
      tagBrowseId: tagId,
      tagBrowseIndex: 0,
      activeYoloTagId: tagId,
      llmHighlight: null,
    });
    return;
  }

  const nextIndex = ((index % tag.instances.length) + tag.instances.length) % tag.instances.length;
  const instance = tag.instances[nextIndex];
  // Preserve the legacy raw, unclamped page jump while revoking every page-relative Parse owner
  // before exposing the destination. The ordinary setPage path would clamp this legacy behavior.
  navigateViewerPageUnclamped(instance.pageNumber);
  useUiStore.getState().setYoloBrowseState({
    tagBrowseId: tagId,
    tagBrowseIndex: nextIndex,
    activeYoloTagId: tagId,
    llmHighlight: {
      pageNumber: instance.pageNumber,
      bbox: instance.bbox,
      label: `${tag.tagText} — ${nextIndex + 1} of ${tag.instances.length}`,
    },
  });
}

function useRowsQuery<T = YoloTag[]>(select?: (rows: YoloTag[]) => T): T {
  const publicId = useSessionStore((state) => state.publicId);
  const { data } = useQuery<YoloTag[], Error, T>({
    queryKey: queryKeys.yoloTags.all(publicId),
    queryFn: (): YoloTag[] => {
      throw new Error("yoloTags is bootstrap-seeded (no client GET); queryFn must never run");
    },
    enabled: false,
    initialData: EMPTY_YOLO_TAGS,
    staleTime: Infinity,
    // Correctness + memory are paired: there is no recovery GET, so the active project's entry
    // cannot GC. openProject clears the previous exact key, bounding cache ownership instead of
    // accumulating every visited instance graph.
    gcTime: Infinity,
    ...(select ? { select } : {}),
  });
  return data as T;
}

/** Whole collection observer for legitimate management/list consumers. */
export function useYoloTagRows(): YoloTag[] {
  return useRowsQuery();
}

/** One-tag observer for sidebar/browse surfaces; unrelated tag edits do not re-render it. */
export function useYoloTagById(id: string | null): YoloTag | null {
  const select = useCallback(
    (rows: YoloTag[]) => (id ? rows.find((tag) => tag.id === id) ?? null : null),
    [id],
  );
  return useRowsQuery(select);
}

/**
 * Canvas projection: retain global tag ordering/metadata but only current-page instances. This
 * preserves AnnotationOverlay's last-tag-wins text index while structural sharing suppresses a
 * redraw when only another page's instance payload changes.
 */
export function useYoloTagsForPage(pageNumber: number): YoloTag[] {
  const select = useCallback(
    (rows: YoloTag[]) =>
      rows.map((tag) => ({
        ...tag,
        instances: tag.instances.filter((instance) => instance.pageNumber === pageNumber),
      })),
    [pageNumber],
  );
  return useRowsQuery(select);
}

export interface YoloTagCatalogRow {
  id: string;
  tagText: string;
  source: YoloTag["source"];
  pageNumber?: number;
  hasInstances: boolean;
}

/** Parsed-cell overlay projection; instance coordinate/count edits cannot repaint its hit regions. */
export function useYoloTagCatalog(): YoloTagCatalogRow[] {
  const select = useCallback(
    (rows: YoloTag[]) =>
      rows.map(({ id, tagText, source, pageNumber, instances }) => ({
        id,
        tagText,
        source,
        pageNumber,
        hasInstances: instances.length > 0,
      })),
    [],
  );
  return useRowsQuery(select);
}

/** CRUD callbacks only. This hook intentionally creates ZERO Query observers. */
export function useYoloTagActions() {
  const qc = useQueryClient();
  const publicId = useSessionStore((state) => state.publicId);
  const isDemo = useSessionStore((state) => state.isDemo);
  const projectEpoch = currentProjectEpoch(qc, publicId);

  // Captured-key callbacks isolate every awaited map-tags producer. A stale component cannot
  // publish project A's late response into project B's active cache after navigation.
  const stillActive = useCallback(
    () => {
      const live = useSessionStore.getState();
      return live.publicId === publicId &&
        live.isDemo === isDemo &&
        currentProjectEpoch(qc, publicId) === projectEpoch;
    },
    [qc, publicId, isDemo, projectEpoch],
  );
  const addYoloTag = useCallback(
    (tag: YoloTag) => {
      if (stillActive()) addYoloTagToCache(qc, publicId, isDemo, tag);
    },
    [qc, publicId, isDemo, stillActive],
  );
  const addYoloTagsBulk = useCallback(
    (tags: YoloTag[], links?: { regionId?: string }): boolean => {
      if (!stillActive()) return false;
      addYoloTagsBulkToCache(qc, publicId, isDemo, tags, links);
      return true;
    },
    [qc, publicId, isDemo, stillActive],
  );
  const replaceRegionYoloTags = useCallback(
    (regionId: string, tags: YoloTag[], legacy?: LegacyRegionTags): boolean => {
      if (!stillActive()) return false;
      replaceRegionYoloTagsInCache(qc, publicId, isDemo, regionId, tags, legacy);
      return true;
    },
    [qc, publicId, isDemo, stillActive],
  );
  const removeYoloTag = useCallback(
    (id: string) => {
      if (stillActive()) removeYoloTagFromCache(qc, publicId, isDemo, id);
    },
    [qc, publicId, isDemo, stillActive],
  );
  const updateYoloTag = useCallback(
    (id: string, updates: Partial<YoloTag>) => {
      if (stillActive()) updateYoloTagInCache(qc, publicId, isDemo, id, updates);
    },
    [qc, publicId, isDemo, stillActive],
  );
  const tagBrowseNavigate = useCallback(
    (tagId: string, index: number) => {
      if (stillActive()) navigateYoloTag(qc, publicId, tagId, index);
    },
    [qc, publicId, stillActive],
  );

  return {
    addYoloTag,
    addYoloTagsBulk,
    replaceRegionYoloTags,
    removeYoloTag,
    updateYoloTag,
    tagBrowseNavigate,
  };
}

/** Compatibility facade for the three hybrid collection + UI consumers. */
export function useYoloTags() {
  const yoloTags = useYoloTagRows();
  const actions = useYoloTagActions();
  const ui = useUiStore(useShallow((state) => ({
    activeYoloTagId: state.activeYoloTagId,
    setActiveYoloTagId: state.setActiveYoloTagId,
    yoloTagVisibility: state.yoloTagVisibility,
    setYoloTagVisibility: state.setYoloTagVisibility,
    setYoloTagFilter: state.setYoloTagFilter,
  })));
  const tool = useToolStore(useShallow((state) => ({
    yoloTagPickingMode: selectActiveToolKey(state) === "tagPick",
    setYoloTagPickingMode: state.setYoloTagPickingMode,
    tagScanResults: state.tagScanResults,
    setTagScanResults: state.setTagScanResults,
    tagAddingMode: selectActiveTagId(state),
    setTagAddingMode: state.setTagAddingMode,
  })));

  return { yoloTags, ...actions, ...ui, ...tool };
}
