"use client";

// [refactor jul11 P2.2⑨] YOLO TAGS cache/action facade.
//
// This is a bootstrap-seeded project collection, not ordinary request/response CRUD. The server
// has no tags GET and its PUT accepts/returns no authoritative rows: it merges one whole array
// into projectIntelligence and returns only {success:true}. Consequently the correct migration is
// synchronous local cache editing plus a trailing whole-snapshot save—NOT generic optimistic
// useMutation rollback/invalidation (which would erase local work and refetch through no endpoint).
// See P2_DESIGN/YOLO_TAGS_IMPL/{RECON_CENSUS,DESIGN_BRIEF}.md.

import { useCallback } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { persistFetch } from "@/lib/client-persist";
import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";
import type { YoloTag } from "@/types";

const EMPTY_YOLO_TAGS = Object.freeze([]) as unknown as YoloTag[];
const SAVE_DELAY_MS = 500;
const SAVE_REQUEST_TIMEOUT_MS = 30_000;

type ProjectIntelligence = Record<string, unknown> | null | undefined;
type YoloTagUpdater = (rows: YoloTag[]) => YoloTag[];

interface SaveLane {
  timer: ReturnType<typeof setTimeout> | null;
  /** True once the trailing delay elapsed for the newest dirty snapshot. */
  ready: boolean;
  dirty: boolean;
  retired: boolean;
  snapshot: YoloTag[];
  /** Requests are serialized so an older full-array PUT cannot finish after a newer one. */
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
      inFlight: null,
      abortController: null,
    };
    lanes.set(publicId, lane);
  }
  return lane;
}

function maybeStartSave(qc: QueryClient, publicId: string, lane: SaveLane): void {
  if (lane.retired || lane.inFlight || !lane.ready || !lane.dirty) return;

  // Capture the exact newest immutable array reference now. Later edits replace lane.snapshot and
  // mark dirty again; they cannot mutate or overtake this request.
  const snapshot = lane.snapshot;
  lane.ready = false;
  lane.dirty = false;
  const controller = new AbortController();
  lane.abortController = controller;
  // A stalled browser/network request must not wedge this project's serialized lane forever.
  // Native fetch honors AbortSignal; the catch path below releases the lane and drains newer work.
  const requestTimeout = setTimeout(() => controller.abort(), SAVE_REQUEST_TIMEOUT_MS);

  const request = persistFetch(
    `/api/projects/${publicId}`,
    { yoloTags: snapshot },
    "PUT",
    controller.signal,
  )
    .catch((error: Error) => {
      // Preserve legacy failure-keep UX: the local cache remains edited. Unlike the old raw fetch,
      // persistFetch also turns HTTP non-OK into a useful logged error instead of silent data loss.
      console.error("[yoloTags] Save failed:", error);
    })
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
): void {
  // Demo/pre-bootstrap CRUD stays local. Do not even allocate a timer: the old timer's eventual
  // early-return was not user-observable, while avoiding it removes test/unmount lifetime leaks.
  if (!publicId || isDemo) return;

  const lane = laneFor(qc, publicId);
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
}

function writeAndSchedule(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  updater: YoloTagUpdater,
): YoloTag[] {
  const next = qc.setQueryData<YoloTag[]>(
    queryKeys.yoloTags.all(publicId),
    (old = EMPTY_YOLO_TAGS) => updater(old),
  ) ?? EMPTY_YOLO_TAGS;
  scheduleSave(qc, publicId, isDemo, next);
  return next;
}

/** Logical mapping identity. Excludes id/model/page/mapScope exactly as the legacy store did. */
export function makeYoloTagKey(tag: YoloTag): string {
  return `${tag.source}::${tag.tagText.toUpperCase()}::${tag.scope}::${tag.yoloClass}`;
}

function mergeYoloTags(current: YoloTag[], incoming: YoloTag[]): YoloTag[] {
  const merged = new Map<string, YoloTag>();
  for (const tag of current) merged.set(makeYoloTagKey(tag), tag);
  for (const tag of incoming) merged.set(makeYoloTagKey(tag), tag);
  return Array.from(merged.values());
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
 * Loader adapter: seeds the collection unconditionally and returns PI with its duplicate yoloTags
 * property removed. The returned object feeds only the narrow csiGraph Query seed; retaining the
 * nested tag array there would duplicate the collection even at that one bootstrap boundary.
 */
export function seedYoloTagsFromBootstrap(
  qc: QueryClient,
  publicId: string,
  projectIntelligence: ProjectIntelligence,
): Record<string, unknown> | null {
  // Every bootstrap publication starts a new adoption epoch—including a same-publicId reopen.
  // Async map callbacks capture the mounted epoch and cannot write after the next loader cycle.
  bumpProjectEpoch(qc, publicId);
  if (!projectIntelligence) {
    qc.setQueryData<YoloTag[]>(queryKeys.yoloTags.all(publicId), []);
    return null;
  }

  const { yoloTags: rawYoloTags, ...withoutYoloTags } = projectIntelligence;
  // The old wire type is unvalidated JSONB. Drop malformed rows/instances at this one boundary so
  // every downstream `.find/.filter` and bbox draw can rely on the declared YoloTag shape.
  const yoloTags = Array.isArray(rawYoloTags)
    ? rawYoloTags.filter(isYoloTag)
    : [];
  qc.setQueryData<YoloTag[]>(queryKeys.yoloTags.all(publicId), yoloTags);
  return withoutYoloTags;
}

/** Exact project teardown used by both loaders; never broaden this to queryKeys.project(). */
export function clearYoloTagsProject(qc: QueryClient, publicId: string): void {
  bumpProjectEpoch(qc, publicId);
  const lane = saveLanes.get(qc)?.get(publicId);
  if (lane) {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = null;
    lane.ready = false;
    lane.dirty = false;
    lane.retired = true;
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
  return writeAndSchedule(qc, publicId, isDemo, (rows) => mergeYoloTags(rows, [tag]));
}

export function addYoloTagsBulkToCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  tags: YoloTag[],
): YoloTag[] {
  if (tags.length === 0) return readYoloTags(qc, publicId);
  return writeAndSchedule(qc, publicId, isDemo, (rows) => mergeYoloTags(rows, tags));
}

export function removeYoloTagFromCache(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  id: string,
): YoloTag[] {
  return writeAndSchedule(qc, publicId, isDemo, (rows) => rows.filter((tag) => tag.id !== id));
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
  );
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
  // Preserve the legacy raw, unclamped page jump and expose that destination before the single UI
  // bundle. Calling setPage here would clamp behavior that navigateYoloTag never clamped.
  useViewerCoreStore.setState({ pageNumber: instance.pageNumber });
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
    // cannot GC. Both loaders call clearYoloTagsProject for the previous exact key, bounding the
    // cache to current ownership instead of accumulating every visited instance graph.
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
    (tags: YoloTag[]) => {
      if (stillActive()) addYoloTagsBulkToCache(qc, publicId, isDemo, tags);
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
  const tool = useViewerStore(useShallow((state) => ({
    yoloTagPickingMode: state.yoloTagPickingMode,
    setYoloTagPickingMode: state.setYoloTagPickingMode,
    tagScanResults: state.tagScanResults,
    setTagScanResults: state.setTagScanResults,
    tagAddingMode: state.tagAddingMode,
    setTagAddingMode: state.setTagAddingMode,
  })));

  return { yoloTags, ...actions, ...ui, ...tool };
}
