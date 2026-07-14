"use client";

import {
  queryOptions,
  type Query,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import type { TextractPageData } from "@/types";

// [refactor jul14 P2.2⑧ C3] Live Textract Query cache/coordinator. useTextractLoader owns the
// imperative navigation transport; components receive disabled data observers through
// useTextract.ts. Keeping transport policy here makes dedupe, cancellation, retention, and publicId
// provenance one concern. The authoritative contract is P2_DESIGN/TEXTRACT_IMPL/SPEC.md.

export const MAX_RETAINED_TEXTRACT_PAGES = 12;
export const MAX_RETAINED_TEXTRACT_BYTES = 8 * 1024 * 1024;
export const TEXTRACT_GC_TIME_MS = 10 * 60 * 1000;

export type CachedTextractPage = TextractPageData | null;

/** Exact one-attempt transport. Query, rather than the browser HTTP cache, owns freshness. */
export async function fetchTextractPage(
  publicId: string,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<CachedTextractPage> {
  const response = await fetch(
    `/api/pages/textract?publicId=${encodeURIComponent(publicId)}&pageNumber=${pageNumber}`,
    { signal, cache: "no-store" },
  );

  // Legacy lazy loading treats every non-OK response as a silent miss and never attempts JSON parsing.
  if (!response.ok) return null;

  const body = (await response.json()) as
    | { textractData?: TextractPageData | null }
    | null
    | undefined;
  return body?.textractData ?? null;
}

/** Shared options for both imperative fetchQuery and disabled component observers. */
export function textractPageQueryOptions(publicId: string, pageNumber: number) {
  return queryOptions({
    queryKey: queryKeys.textract.page(publicId, pageNumber),
    queryFn: ({ signal }) => fetchTextractPage(publicId, pageNumber, signal),
    // SPEC override of the generic RECIPE: a truthy page was viewer-lifetime fresh in Zustand.
    // Project/viewer teardown and the explicit LRU, not a timer, decide when it may fetch again.
    staleTime: Infinity,
    gcTime: TEXTRACT_GC_TIME_MS,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    // One offline attempt must fail now, not pause and silently resume on reconnect.
    networkMode: "always",
    // Textract pages are large replacement payloads. Avoid a recursive JSON-sized equality walk and
    // preserve the old new-reference-on-replacement notification semantics.
    structuralSharing: false,
  });
}

interface PageMetadata {
  lastAccess: number;
  estimatedBytes: number;
  dataRef: TextractPageData;
}

interface ProjectCoordinator {
  pages: Map<number, PageMetadata>;
  protectedPages: Set<number>;
  revision: number;
  listeners: Set<() => void>;
  pruning: boolean;
  pruneScheduled: boolean;
}

interface TextractCoordinator {
  clock: number;
  projects: Map<string, ProjectCoordinator>;
  unsubscribe: () => void;
}

const coordinators = new WeakMap<QueryClient, TextractCoordinator>();

function createProjectCoordinator(): ProjectCoordinator {
  return {
    pages: new Map(),
    protectedPages: new Set(),
    revision: 0,
    listeners: new Set(),
    pruning: false,
    pruneScheduled: false,
  };
}

function projectCoordinator(
  coordinator: TextractCoordinator,
  publicId: string,
): ProjectCoordinator {
  let project = coordinator.projects.get(publicId);
  if (!project) {
    project = createProjectCoordinator();
    coordinator.projects.set(publicId, project);
  }
  return project;
}

function parseTextractPageKey(
  queryKey: readonly unknown[],
): { publicId: string; pageNumber: number } | undefined {
  if (
    queryKey.length !== 4 ||
    queryKey[0] !== "project" ||
    typeof queryKey[1] !== "string" ||
    queryKey[2] !== "textract" ||
    typeof queryKey[3] !== "number" ||
    !Number.isFinite(queryKey[3])
  ) {
    return undefined;
  }
  return { publicId: queryKey[1], pageNumber: queryKey[3] };
}

function estimatedUtf8JsonBytes(data: TextractPageData): number {
  const serialized = JSON.stringify(data);
  return new TextEncoder().encode(serialized).byteLength;
}

function notifyDataChange(project: ProjectCoordinator): void {
  project.revision += 1;
  for (const listener of project.listeners) listener();
}

/** Synchronize one exact page Query. Returns true only when retained payload visibility changed. */
function synchronizeQuery(
  coordinator: TextractCoordinator,
  query: Query,
  removed = false,
): boolean {
  const identity = parseTextractPageKey(query.queryKey);
  if (!identity) return false;

  const existingProject = coordinator.projects.get(identity.publicId);
  const data = removed ? undefined : (query.state.data as CachedTextractPage | undefined);

  if (data == null) {
    const existing = existingProject?.pages.get(identity.pageNumber);
    if (!existingProject || !existing) return false;
    existingProject.pages.delete(identity.pageNumber);
    notifyDataChange(existingProject);
    return true;
  }

  const project = projectCoordinator(coordinator, identity.publicId);
  const existing = project.pages.get(identity.pageNumber);
  if (existing?.dataRef === data) return false;

  project.pages.set(identity.pageNumber, {
    // A first publication is necessarily a first access. Replacements retain recency until their
    // semantic writer performs the required touch immediately after publication.
    lastAccess: existing?.lastAccess ?? ++coordinator.clock,
    estimatedBytes: estimatedUtf8JsonBytes(data),
    dataRef: data,
  });
  notifyDataChange(project);
  return true;
}

function getCoordinator(qc: QueryClient): TextractCoordinator {
  const existing = coordinators.get(qc);
  if (existing) return existing;

  const coordinator: TextractCoordinator = {
    clock: 0,
    projects: new Map(),
    unsubscribe: () => {},
  };
  coordinators.set(qc, coordinator);

  coordinator.unsubscribe = qc.getQueryCache().subscribe((event) => {
    handleQueryCacheEvent(qc, coordinator, event);
  });

  // A coordinator may be born after a loader/test has already populated Query. Adopt those exact
  // numeric page entries once without requiring a duplicate aggregate cache.
  for (const query of qc.getQueryCache().getAll()) synchronizeQuery(coordinator, query);

  return coordinator;
}

function handleQueryCacheEvent(
  qc: QueryClient,
  coordinator: TextractCoordinator,
  event: QueryCacheNotifyEvent,
): void {
  const identity = parseTextractPageKey(event.query.queryKey);
  if (!identity) return;

  if (event.type === "removed") {
    synchronizeQuery(coordinator, event.query, true);
    schedulePrune(qc, identity.publicId, coordinator);
    return;
  }

  const dataChanged = synchronizeQuery(coordinator, event.query);

  // Status-only updates do not notify passive data listeners. Observer release and idle settlement
  // are nevertheless opportunities to enforce an overage that was previously protected/in-flight.
  if (
    dataChanged ||
    event.type === "observerRemoved" ||
    (event.type === "updated" && event.query.state.fetchStatus === "idle")
  ) {
    schedulePrune(qc, identity.publicId, coordinator);
  }
}

function schedulePrune(
  qc: QueryClient,
  publicId: string,
  coordinator: TextractCoordinator,
): void {
  const project = projectCoordinator(coordinator, publicId);
  if (project.pruneScheduled) return;
  project.pruneScheduled = true;
  queueMicrotask(() => {
    project.pruneScheduled = false;
    pruneTextractCache(qc, publicId);
  });
}

function synchronizeProject(
  qc: QueryClient,
  coordinator: TextractCoordinator,
  publicId: string,
): ProjectCoordinator {
  const project = projectCoordinator(coordinator, publicId);
  const livePages = new Set<number>();

  for (const query of qc.getQueryCache().findAll({
    queryKey: queryKeys.textract.all(publicId),
    exact: false,
  })) {
    const identity = parseTextractPageKey(query.queryKey);
    if (!identity || identity.publicId !== publicId) continue;
    const data = query.state.data as CachedTextractPage | undefined;
    if (data != null) livePages.add(identity.pageNumber);
    synchronizeQuery(coordinator, query);
  }

  for (const pageNumber of [...project.pages.keys()]) {
    if (livePages.has(pageNumber)) continue;
    project.pages.delete(pageNumber);
    notifyDataChange(project);
  }

  return project;
}

function updateProtectedPages(
  coordinator: TextractCoordinator,
  publicId: string,
  pages: Iterable<number>,
): void {
  const project = projectCoordinator(coordinator, publicId);
  project.protectedPages = new Set(
    [...pages].filter((pageNumber) => Number.isFinite(pageNumber)),
  );
}

/**
 * Publish the controller's LIVE working set. Settlement always reads this coordinator value; an old
 * batch can therefore never re-install its obsolete N±1 protection after navigation.
 */
export function setTextractProtectedPages(
  qc: QueryClient,
  publicId: string,
  pages: Iterable<number>,
): void {
  if (!publicId) return;
  const coordinator = getCoordinator(qc);
  updateProtectedPages(coordinator, publicId, pages);
  pruneTextractCache(qc, publicId);
}

function retainedTotals(project: ProjectCoordinator): { count: number; bytes: number } {
  let bytes = 0;
  for (const metadata of project.pages.values()) bytes += metadata.estimatedBytes;
  return { count: project.pages.size, bytes };
}

/**
 * Enforce both rails centrally. This is an honest bound: observed, fetching, and live N±1 pages are
 * never sacrificed, so they may create a temporary overage until a later settlement/unmount/touch.
 */
export function pruneTextractCache(qc: QueryClient, publicId: string): void {
  if (!publicId) return;
  const coordinator = getCoordinator(qc);
  const project = synchronizeProject(qc, coordinator, publicId);
  if (project.pruning) return;

  project.pruning = true;
  try {
    while (true) {
      const totals = retainedTotals(project);
      if (
        totals.count <= MAX_RETAINED_TEXTRACT_PAGES &&
        totals.bytes <= MAX_RETAINED_TEXTRACT_BYTES
      ) {
        return;
      }

      const candidates = [...project.pages.entries()].sort(
        ([pageA, a], [pageB, b]) => a.lastAccess - b.lastAccess || pageA - pageB,
      );
      let victim: number | undefined;

      for (const [pageNumber] of candidates) {
        if (project.protectedPages.has(pageNumber)) continue;
        const query = qc.getQueryCache().find({
          queryKey: queryKeys.textract.page(publicId, pageNumber),
          exact: true,
        });
        if (!query) continue;
        if (query.getObserversCount() > 0 || query.state.fetchStatus !== "idle") continue;
        victim = pageNumber;
        break;
      }

      if (victim === undefined) return;
      qc.removeQueries({
        queryKey: queryKeys.textract.page(publicId, victim),
        exact: true,
      });
    }
  } finally {
    project.pruning = false;
  }
}

function touchTextractPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): boolean {
  const coordinator = getCoordinator(qc);
  const project = synchronizeProject(qc, coordinator, publicId);
  const metadata = project.pages.get(pageNumber);
  if (!metadata) return false;
  metadata.lastAccess = ++coordinator.clock;
  return true;
}

function configuredPageQuery(qc: QueryClient, publicId: string, pageNumber: number) {
  const options = qc.defaultQueryOptions(textractPageQueryOptions(publicId, pageNumber));
  const query = qc.getQueryCache().build(qc, options);
  // build() returns an existing query without replacing its options. Set them explicitly so a page
  // first created by a manual writer still receives this domain's gc/structural-sharing policy.
  query.setOptions(options);
  return query;
}

function retireDataLessShell(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  expectedQuery: object,
): void {
  const key = queryKeys.textract.page(publicId, pageNumber);
  const current = qc.getQueryCache().find({ queryKey: key, exact: true });

  // An obsolete rejection must never delete a newer fetch or authoritative replacement.
  if (
    current !== expectedQuery ||
    current.state.fetchStatus !== "idle" ||
    current.state.data != null
  ) {
    return;
  }

  if (current.getObserversCount() > 0) {
    // Removing an observed Query would orphan its QueryObserver from a later same-key Query. Reset it
    // to the required idle/undefined shell; GC/removal follows when the last observer leaves.
    current.reset();
  } else {
    qc.removeQueries({ queryKey: key, exact: true });
  }
}

export interface EnsureTextractPageArgs {
  publicId: string;
  pageNumber: number;
  protectedPages?: Iterable<number>;
}

/** One imperative, deduped page attempt. Null/error/cancel never remains public data. */
export async function ensureTextractPage(
  qc: QueryClient,
  args: EnsureTextractPageArgs,
): Promise<TextractPageData | undefined> {
  const { publicId, pageNumber } = args;
  if (!publicId) return undefined;

  const coordinator = getCoordinator(qc);
  // Apply captured protection only at dispatch. Settlement deliberately reads whatever newer
  // navigation has since published in the coordinator.
  if (args.protectedPages) updateProtectedPages(coordinator, publicId, args.protectedPages);

  const key = queryKeys.textract.page(publicId, pageNumber);
  const existing = qc.getQueryData<CachedTextractPage>(key);
  if (existing != null) {
    touchTextractPage(qc, publicId, pageNumber);
    pruneTextractCache(qc, publicId);
    return existing;
  }

  // A foreign/manual null seed must not become forever-fresh under staleTime:Infinity.
  const priorShell = qc.getQueryCache().find({ queryKey: key, exact: true });
  if (priorShell && priorShell.state.data === null && priorShell.state.fetchStatus === "idle") {
    retireDataLessShell(qc, publicId, pageNumber, priorShell);
  }

  const startedQuery = configuredPageQuery(qc, publicId, pageNumber);
  try {
    const result = await qc.fetchQuery(textractPageQueryOptions(publicId, pageNumber));
    if (result != null) {
      touchTextractPage(qc, publicId, pageNumber);
      pruneTextractCache(qc, publicId);
      return result;
    }
    retireDataLessShell(qc, publicId, pageNumber, startedQuery);
  } catch {
    retireDataLessShell(qc, publicId, pageNumber, startedQuery);
  }

  pruneTextractCache(qc, publicId);
  return undefined;
}

/** Observer-free invocation-time read. A successful read is a real LRU access. */
export function readTextractForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): TextractPageData | undefined {
  if (!publicId) return undefined;
  const data = qc.getQueryData<CachedTextractPage>(
    queryKeys.textract.page(publicId, pageNumber),
  );
  if (data == null) return undefined;
  touchTextractPage(qc, publicId, pageNumber);
  pruneTextractCache(qc, publicId);
  return data;
}

/** Cancel only one publicId/page GET; callers retain every sibling page/domain. */
export async function cancelTextractPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): Promise<void> {
  if (!publicId) return;
  await qc.cancelQueries(
    { queryKey: queryKeys.textract.page(publicId, pageNumber), exact: true },
    { silent: true },
  );
}

/** Authoritative rerun adoption: exact second cancel, exact replace, touch/prune, no invalidation. */
export async function replaceTextractForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  data: TextractPageData,
  protectedPages?: Iterable<number>,
  canAdopt?: () => boolean,
): Promise<void> {
  if (!publicId) return;
  const coordinator = getCoordinator(qc);
  if (protectedPages) updateProtectedPages(coordinator, publicId, protectedPages);

  await cancelTextractPage(qc, publicId, pageNumber);
  // Cancellation is an async boundary. A rerun owner can lose its project/page/unmount generation
  // while the second exact cancel settles; recheck before the authoritative write so an obsolete
  // completion cannot recreate a prefix that project teardown just removed.
  if (canAdopt && !canAdopt()) return;
  const query = configuredPageQuery(qc, publicId, pageNumber);
  query.setData(data, { manual: true });
  touchTextractPage(qc, publicId, pageNumber);
  pruneTextractCache(qc, publicId);
}

/** Exact heavy-domain teardown. Never remove the broader project prefix. */
export async function clearTextractProject(
  qc: QueryClient,
  publicId: string,
  canContinue: () => boolean = () => true,
): Promise<void> {
  if (!publicId) return;
  if (!canContinue()) return;
  const prefix = queryKeys.textract.all(publicId);
  await qc.cancelQueries({ queryKey: prefix, exact: false }, { silent: true });
  // Cancellation is an await boundary. A newer same-ID open may already have adopted its own OCR
  // payloads, so stale teardown must stop before removing or touching coordinator state.
  if (!canContinue()) return;
  qc.removeQueries({ queryKey: prefix, exact: false });
  if (!canContinue()) return;

  const coordinator = getCoordinator(qc);
  const project = projectCoordinator(coordinator, publicId);
  project.protectedPages.clear();
  synchronizeProject(qc, coordinator, publicId);
}

/** Project data-reference revision used by the one passive multi-page subscriber. */
export function getTextractProjectRevision(qc: QueryClient, publicId: string): number {
  if (!publicId) return 0;
  return projectCoordinator(getCoordinator(qc), publicId).revision;
}

/** Subscribe only to retained payload-reference additions/replacements/removals, never status. */
export function subscribeTextractProject(
  qc: QueryClient,
  publicId: string,
  listener: () => void,
): () => void {
  if (!publicId) return () => {};
  const project = projectCoordinator(getCoordinator(qc), publicId);
  project.listeners.add(listener);
  return () => project.listeners.delete(listener);
}

/** Snapshot helper for PageSidebar's bounded exception. Aggregate reads deliberately do not touch. */
export function getCachedTextractForPages(
  qc: QueryClient,
  publicId: string,
  requestedPages: ReadonlySet<number>,
): Readonly<Record<number, TextractPageData>> {
  if (!publicId || requestedPages.size === 0) return Object.freeze({});
  const project = synchronizeProject(qc, getCoordinator(qc), publicId);
  const result: Record<number, TextractPageData> = {};
  for (const [pageNumber, metadata] of project.pages) {
    if (requestedPages.has(pageNumber)) result[pageNumber] = metadata.dataRef;
  }
  return Object.freeze(result);
}

export interface TextractRetentionStats {
  retainedCount: number;
  estimatedBytes: number;
  retainedPageNumbers: readonly number[];
  protectedPageNumbers: readonly number[];
  revision: number;
}

/** Small diagnostic surface; Query remains the sole owner of heavy payloads. */
export function getTextractRetentionStats(
  qc: QueryClient,
  publicId: string,
): TextractRetentionStats {
  if (!publicId) {
    return {
      retainedCount: 0,
      estimatedBytes: 0,
      retainedPageNumbers: [],
      protectedPageNumbers: [],
      revision: 0,
    };
  }
  const project = synchronizeProject(qc, getCoordinator(qc), publicId);
  const totals = retainedTotals(project);
  return {
    retainedCount: totals.count,
    estimatedBytes: totals.bytes,
    retainedPageNumbers: [...project.pages.keys()].sort((a, b) => a - b),
    protectedPageNumbers: [...project.protectedPages].sort((a, b) => a - b),
    revision: project.revision,
  };
}
