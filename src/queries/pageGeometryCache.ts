"use client";

/**
 * pageGeometryCache.ts — THE SEAM (PLAN §4.2). Page-keyed vector geometry, read out-of-band.
 *
 * `ToolContext` has no `pdfDoc` and must not gain one. The precedent for reaching around it is
 * already inside the bucket controller: `readTextractForPage` — an out-of-band, page-keyed,
 * imperative read with LRU retention and a "silent miss returns undefined" convention. This is
 * that pattern for geometry, fed by `lib/pdf-document-registry.ts`.
 *
 * ── ⚠ THIS DOMAIN IS DERIVED, NOT FETCHED ───────────────────────────────────────────────
 * Every other query domain in this app is a transport. This one is a **local computation over an
 * already-open document**, so it has no URL, no signal, no retry policy and no network mode. It
 * is in react-query anyway for two concrete reasons and no others: project teardown removes it by
 * prefix along with every sibling domain, and the LRU can be enforced with the same `removeQueries`
 * mechanics the textract coordinator already uses. Do not add transport policy here.
 *
 * ── THE MISS *IS* THE FALLBACK TRIGGER ──────────────────────────────────────────────────
 * A caller that reads geometry and gets `undefined` routes to the raster path. That is PLAN §4.3's
 * auto-fallback falling out of the cache design rather than being invented, and it is why every
 * read is silent: no throw, no console noise, no partial value.
 *
 * ── ★ THE SENTINEL / EVICT ASYMMETRY (PLAN §5 phase 2) ──────────────────────────────────
 * Two failures look alike and must not be treated alike:
 *
 *   `getOperatorList()` FAILS  →  cache a `status:"unavailable"` SENTINEL.
 *       A corrupt or unsupported op stream fails the same way every time. Caching nothing means
 *       every click re-parses a document that will never parse — ~1.2 s of main-thread work per
 *       click, forever. Worse, `staleTime: Infinity` plus an absent entry is indistinguishable
 *       from "not tried yet", so routing would oscillate rather than settle. The sentinel makes
 *       the negative result a fact the router can read.
 *
 *   A later RENDER fails       →  EVICT, do not sentinel.
 *       That is a transient (a lost canvas, an aborted paint, memory pressure). Pinning a
 *       sentinel for it would permanently demote a page that would work on the next attempt.
 *
 * Stated plainly because the two paths are one line apart and the wrong choice in either
 * direction is invisible in testing: sentinel-a-transient looks like "vector never works here",
 * evict-a-permanent looks like "the viewer is slow".
 *
 * ── `points` IS DELIBERATELY NOT CACHED ─────────────────────────────────────────────────
 * MEASURED: geometry with `points` is 9.6 MB/page, without it 2.4 MB/page — 7.2 MB of endpoint
 * pairs whose only consumer is the snap grid, which ships disabled until phase 8. At 9.6 MB the
 * 4-page / 24 MiB budget holds **two** dense pages. Entries therefore carry `points: []` so they
 * stay drop-in for `vectorBucketFill`, plus a `pointsDropped: true` tripwire so the one future
 * caller that would silently get an empty snap grid has something to assert on.
 */

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { getPdfDocument } from "@/lib/pdf-document-registry";
import { MASK_DIM_DEFAULT } from "@/lib/bucket-fill-vector-limits";
import {
  extractVectorGeometry,
  type OpsTable,
  type VectorGeometry,
} from "@/lib/oneclick/oneclick";

/** 4 pages: the current sheet plus its neighbours, at the measured 2.4 MB/page. */
export const MAX_RETAINED_GEOMETRY_PAGES = 4;

/** 24 MiB. The second rail, because page weight varies by an order of magnitude across a set. */
export const MAX_RETAINED_GEOMETRY_BYTES = 24 * 1024 * 1024;

/**
 * Geometry as cached: real `VectorGeometry`, minus the endpoint list.
 *
 * It extends `VectorGeometry` rather than omitting a field so it stays assignable to
 * `vectorBucketFill`'s request without a conversion step. `pointsDropped` is the tripwire.
 */
export interface CachedPageGeometry extends VectorGeometry {
  /**
   * ⛔ ALWAYS TRUE, AND `points` IS ALWAYS EMPTY. Anything that builds a snap grid from a cached
   * entry must check this and refuse, or it will silently snap against zero endpoints — a
   * no-op that looks exactly like working code.
   */
  pointsDropped: true;
  /** Device px of the viewport the geometry was extracted at. Feeds `vectorBucketFill.imgW/imgH`. */
  viewportWidth: number;
  viewportHeight: number;
  /** The extraction scale, so a reader can tell how well the mask resolves this sheet. */
  scale: number;
  /** Page size in PDF points, for the mask-resolution note below. */
  pageWidthPt: number;
  pageHeightPt: number;
}

export type GeometryUnavailableReason =
  /** No document registered for this publicId — viewer not ready, or torn down. */
  | "no-document"
  /** The document has no such page. */
  | "no-page"
  /** `getOperatorList()` threw. Deterministic; this is the sentinel case. */
  | "oplist-failed";

export type PageGeometryEntry =
  | { status: "ok"; geometry: CachedPageGeometry }
  | { status: "unavailable"; reason: GeometryUnavailableReason };

/**
 * PLAN §4.2's **stated estimator**, not a measurement: the ported arrays carry no `byteLength`.
 *
 * `segs` is a plain `number[]`, which V8 backs with 8-byte doubles plus array overhead; 8.4 is
 * PLAN's factor for that. `meta` is a `Uint8Array` and reports its real size. `points` is not
 * counted because it is not retained. Being an estimate is the point — the rail exists to stop
 * unbounded growth, and a 5% error in the estimator moves the eviction boundary by a fraction of
 * one page.
 */
export function estimateGeometryBytes(geometry: CachedPageGeometry): number {
  return Math.round(geometry.segs.length * 8.4 + geometry.meta.byteLength);
}

/**
 * The scale at which the mask saturates for this sheet — the product's canonical extraction scale.
 *
 * ⚠ Measured in phase 0 and load-bearing: `buildMask` uses `ws = min(1, maskDim / max(imgW, imgH))`
 * and **never upscales**, burning each wall as a one-mask-pixel line. So the flood stops one mask
 * px inside the centreline and the inset in points is `2 / (mask px per pt)`. Extracting below
 * saturation reads systematically small — −2.184 / −1.095 / −0.548 / −0.416 % at 0.5 / 1 / 2 /
 * 2.451 mask px per pt. Extract once, here, at the scale that saturates the mask.
 *
 * A sheet longer than `maskDim` points therefore runs BELOW the design point no matter what (an
 * E-size sheet at mask 3000 gets 0.868 mask px/pt). That is a known ceiling, not a bug to fix here.
 */
export function canonicalExtractionScale(
  pageWidthPt: number,
  pageHeightPt: number,
  maskDim: number = MASK_DIM_DEFAULT,
): number {
  const longest = Math.max(pageWidthPt, pageHeightPt);
  if (!(longest > 0)) return 1;
  return maskDim / longest;
}

interface PageMetadata {
  lastAccess: number;
  estimatedBytes: number;
  /**
   * The pdf.js page proxy this geometry came from, held ONLY so eviction can call `cleanup()`.
   *
   * ⚠ `page.cleanup()` frees the retained operator list (MEASURED: 25.6 MB) but also discards the
   * page's display cache, costing **+1612 ms** on that page's next render. It is therefore called
   * on eviction and teardown and **never on a protected page** — which is how "never on the
   * mounted page" is enforced: the caller protects the page it is showing.
   */
  pageRef: { cleanup: () => void } | undefined;
}

interface ProjectCoordinator {
  pages: Map<number, PageMetadata>;
  protectedPages: Set<number>;
  /**
   * Bumped by `clearGeometryProject`. An extraction captures this before it awaits and refuses to
   * publish if it changed — see `ensurePageGeometry`.
   */
  generation: number;
}

interface GeometryCoordinator {
  clock: number;
  projects: Map<string, ProjectCoordinator>;
}

const coordinators = new WeakMap<QueryClient, GeometryCoordinator>();

function getCoordinator(qc: QueryClient): GeometryCoordinator {
  let coordinator = coordinators.get(qc);
  if (!coordinator) {
    coordinator = { clock: 0, projects: new Map() };
    coordinators.set(qc, coordinator);
  }
  return coordinator;
}

function projectCoordinator(qc: QueryClient, publicId: string): ProjectCoordinator {
  const coordinator = getCoordinator(qc);
  let project = coordinator.projects.get(publicId);
  if (!project) {
    project = { pages: new Map(), protectedPages: new Set(), generation: 0 };
    coordinator.projects.set(publicId, project);
  }
  return project;
}

/**
 * Publish the live working set. Protected pages are never evicted and never `cleanup()`ed.
 *
 * The caller passes the page it is displaying (and any it is prefetching); that is the whole
 * mechanism behind "never call `page.cleanup()` on the mounted page".
 */
export function setGeometryProtectedPages(
  qc: QueryClient,
  publicId: string,
  pages: Iterable<number>,
): void {
  if (!publicId) return;
  const project = projectCoordinator(qc, publicId);
  project.protectedPages = new Set([...pages].filter((p) => Number.isFinite(p)));
  pruneGeometryCache(qc, publicId);
}

function retainedTotals(project: ProjectCoordinator): { count: number; bytes: number } {
  let bytes = 0;
  for (const metadata of project.pages.values()) bytes += metadata.estimatedBytes;
  return { count: project.pages.size, bytes };
}

/**
 * Options for one page's entry.
 *
 * ⚠ `gcTime: Infinity` is load-bearing and was MISSING in the first version, which used a bare
 * `qc.setQueryData`. That inherits react-query's default **5-minute** gcTime, and this domain has
 * **no observers at all** — it is read imperatively by the controller — so `optionalRemove` deletes
 * an idle, observer-less entry five minutes after it is written. The symptom is not a crash: arm
 * the bucket tool, work on the page for six minutes, click, and the fill silently routes to raster
 * while `geometryRetentionSnapshot` still reports the page resident and still charges its bytes
 * against the 24 MiB rail. The two caches disagree and nothing says so.
 *
 * Retention here is owned by the explicit LRU and by project teardown — by a decision, not by a
 * timer. `textractCache` sets an explicit `gcTime` for the same reason; this file simply failed to
 * copy that part of the precedent.
 */
function pageGeometryQueryOptions(publicId: string, pageNumber: number) {
  return {
    queryKey: queryKeys.pageGeometry.page(publicId, pageNumber),
    staleTime: Infinity,
    gcTime: Infinity,
    // Geometry holds large typed arrays. A recursive structural-sharing walk over them would cost
    // more than the extraction, and replacement semantics are what callers expect.
    structuralSharing: false,
  };
}

/** Write an entry with this domain's retention policy attached. */
function setGeometryQueryData(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  entry: PageGeometryEntry,
): void {
  const options = qc.defaultQueryOptions(pageGeometryQueryOptions(publicId, pageNumber));
  const query = qc.getQueryCache().build(qc, options);
  // build() returns an existing query WITHOUT replacing its options, so set them explicitly —
  // otherwise a query first created by another path keeps the default 5-minute gcTime.
  query.setOptions(options);
  query.setData(entry, { manual: true });
}

/** Drop one page's query and coordinator row, releasing its op list if we hold the page. */
function removePage(qc: QueryClient, publicId: string, pageNumber: number, cleanup: boolean): void {
  const project = projectCoordinator(qc, publicId);
  const metadata = project.pages.get(pageNumber);
  project.pages.delete(pageNumber);
  qc.removeQueries({
    queryKey: queryKeys.pageGeometry.page(publicId, pageNumber),
    exact: true,
  });
  if (!cleanup || !metadata?.pageRef) return;
  try {
    metadata.pageRef.cleanup();
  } catch {
    // cleanup() is a memory optimisation, never a correctness step. A destroyed document throws
    // here and that is fine — the memory is already gone with it.
  }
}

/**
 * Enforce both rails. Protected pages are never sacrificed, so a protected working set larger
 * than the rails produces an honest temporary overage rather than evicting the page in view.
 */
export function pruneGeometryCache(qc: QueryClient, publicId: string): void {
  if (!publicId) return;
  const project = projectCoordinator(qc, publicId);

  for (;;) {
    const totals = retainedTotals(project);
    if (
      totals.count <= MAX_RETAINED_GEOMETRY_PAGES &&
      totals.bytes <= MAX_RETAINED_GEOMETRY_BYTES
    ) {
      return;
    }
    // Least-recently-used first; page number breaks ties so eviction order is deterministic and
    // a test can assert it rather than observing whichever the Map happened to yield.
    const candidates = [...project.pages.entries()].sort(
      ([pageA, a], [pageB, b]) => a.lastAccess - b.lastAccess || pageA - pageB,
    );
    const victim = candidates.find(([pageNumber]) => !project.protectedPages.has(pageNumber));
    if (!victim) return;
    removePage(qc, publicId, victim[0], true);
  }
}

function touch(qc: QueryClient, publicId: string, pageNumber: number): void {
  const coordinator = getCoordinator(qc);
  const project = projectCoordinator(qc, publicId);
  const metadata = project.pages.get(pageNumber);
  if (metadata) metadata.lastAccess = ++coordinator.clock;
}

/** Snapshot of a project's liveness, captured before an extraction awaits. */
export interface GeometryGeneration {
  publicId: string;
  generation: number;
}

/** Capture the current generation so a later publish can prove the project was never torn down. */
function captureGeneration(qc: QueryClient, publicId: string): GeometryGeneration {
  return { publicId, generation: projectCoordinator(qc, publicId).generation };
}

/**
 * Has this project been torn down (or reopened) since `token` was captured?
 *
 * ⚠ Also true when the coordinator row is GONE — `projectCoordinator` would happily RECREATE it,
 * which is exactly the resurrection this guard exists to prevent. Ask the map directly.
 */
function generationChanged(qc: QueryClient, token: GeometryGeneration): boolean {
  const project = getCoordinator(qc).projects.get(token.publicId);
  return !project || project.generation !== token.generation;
}

function publish(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  entry: PageGeometryEntry,
  pageRef: { cleanup: () => void } | undefined,
): void {
  const coordinator = getCoordinator(qc);
  const project = projectCoordinator(qc, publicId);
  setGeometryQueryData(qc, publicId, pageNumber, entry);
  project.pages.set(pageNumber, {
    lastAccess: ++coordinator.clock,
    // A sentinel costs nothing to keep and must not be able to evict a real page on size.
    estimatedBytes: entry.status === "ok" ? estimateGeometryBytes(entry.geometry) : 0,
    pageRef,
  });
  pruneGeometryCache(qc, publicId);
}

/**
 * Observer-free, synchronous read. A hit is a real LRU access.
 *
 * Returns the ENTRY, sentinel included, because "we tried and it cannot work" is information the
 * router needs and is not the same as "not tried". Callers wanting only usable geometry should
 * use `readGeometryForPage`.
 */
export function readGeometryEntry(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): PageGeometryEntry | undefined {
  if (!publicId) return undefined;
  const entry = qc.getQueryData<PageGeometryEntry>(
    queryKeys.pageGeometry.page(publicId, pageNumber),
  );
  if (!entry) return undefined;
  touch(qc, publicId, pageNumber);
  return entry;
}

/**
 * The controller's read: usable geometry, or `undefined`.
 *
 * `undefined` covers both "nothing cached" and "cached sentinel" on purpose — both route to
 * raster, and a call site that only wants to know whether it can run the vector engine should
 * not have to destructure a union to find out.
 */
export function readGeometryForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): CachedPageGeometry | undefined {
  const entry = readGeometryEntry(qc, publicId, pageNumber);
  return entry?.status === "ok" ? entry.geometry : undefined;
}

/**
 * Evict one page WITHOUT leaving a sentinel — the transient half of the asymmetry.
 *
 * Use after a render/paint failure, never after an op-list failure. The next attempt re-extracts.
 */
export function evictPageGeometry(qc: QueryClient, publicId: string, pageNumber: number): void {
  if (!publicId) return;
  removePage(qc, publicId, pageNumber, true);
}

/**
 * Return a result to the caller WITHOUT writing it to a cache the project no longer owns.
 *
 * ⚠ Deliberately does NOT call `page.cleanup()`. Once the document is destroyed, pdf.js refuses
 * both `_abortOperatorList` and `#tryCleanup` on that page, so cleanup cannot free the operator
 * list anyway — the only thing that reclaims it is dropping the reference, which is exactly what
 * abandoning does. Retaining the page in a resurrected coordinator row is what pinned ~25.6 MB
 * unreclaimably; not retaining it is the fix.
 */
function abandon(entry: PageGeometryEntry): PageGeometryEntry {
  return entry;
}

export interface EnsurePageGeometryArgs {
  publicId: string;
  pageNumber: number;
  /**
   * pdf.js's `OPS` code table, INJECTED — this module must not import `pdfjs-dist`.
   *
   * That is the vendored engine's own rule (`oneclick.ts`: *"passed in so this module never
   * imports pdfjs"*), and following it one layer up buys something concrete here: a dynamic
   * `import("pdfjs-dist")` inside the try block below would be swallowed by the same catch that
   * writes the `oplist-failed` sentinel, **permanently demoting a page for a module-resolution
   * problem that has nothing to do with its op list.** The caller always has this table — it is
   * the thing that opened the document.
   */
  ops: OpsTable;
  /** Overridable so a caller can extract for a larger mask deliberately; defaults to the pin. */
  maskDim?: number;
}

/**
 * Extract (or return cached) geometry for one page.
 *
 * Async because `getPage`/`getOperatorList` are — this is the ~1.2 s half that the whole cache
 * exists to pay once. The ~5 ms warm click is `vectorBucketFill`, which reads the result of this
 * synchronously via `readGeometryForPage`.
 */
export async function ensurePageGeometry(
  qc: QueryClient,
  args: EnsurePageGeometryArgs,
): Promise<PageGeometryEntry> {
  const { publicId, pageNumber } = args;
  if (!publicId) return { status: "unavailable", reason: "no-document" };

  const cached = readGeometryEntry(qc, publicId, pageNumber);
  if (cached) return cached;

  const doc = getPdfDocument(publicId);
  if (!doc) {
    // NOT cached. "The viewer has not finished loading" is transient by definition, and a
    // sentinel here would permanently demote every page opened during startup.
    return { status: "unavailable", reason: "no-document" };
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
    return { status: "unavailable", reason: "no-page" };
  }

  // ★ Captured BEFORE the first await. Everything below is separated from the caller by ~1.2 s of
  // parsing, which is ample time for the user to switch projects.
  const token = captureGeneration(qc, publicId);

  let page: Awaited<ReturnType<typeof doc.getPage>>;
  try {
    page = await doc.getPage(pageNumber);
  } catch {
    return { status: "unavailable", reason: "no-page" };
  }

  const base = page.getViewport({ scale: 1 });
  const scale = canonicalExtractionScale(base.width, base.height, args.maskDim ?? MASK_DIM_DEFAULT);
  const viewport = page.getViewport({ scale });

  try {
    const opList = await page.getOperatorList();
    const raw = extractVectorGeometry(opList, viewport.transform, args.ops);
    const geometry: CachedPageGeometry = {
      // `points` deliberately emptied — see the header. The tripwire travels with the value.
      points: [],
      pointsDropped: true,
      segs: raw.segs,
      meta: raw.meta,
      imageArea: raw.imageArea,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      scale,
      pageWidthPt: base.width,
      pageHeightPt: base.height,
    };
    const entry: PageGeometryEntry = { status: "ok", geometry };
    if (generationChanged(qc, token)) return abandon(entry);
    publish(qc, publicId, pageNumber, entry, page);
    return entry;
  } catch {
    // ★ THE SENTINEL HALF. A failed op list is deterministic; caching the negative result is what
    // stops every subsequent click from re-parsing a document that will never parse.
    const entry: PageGeometryEntry = { status: "unavailable", reason: "oplist-failed" };
    if (generationChanged(qc, token)) return abandon(entry);
    publish(qc, publicId, pageNumber, entry, page);
    return entry;
  }
}

/**
 * Exact domain teardown, called beside `clearTextractProject` in the project lifecycle.
 *
 * Synchronous, unlike its textract sibling: there is no in-flight transport to CANCEL, so this
 * function itself never straddles a same-id reopen the way `clearTextractProject` can (which is
 * why that one takes a liveness predicate and this one does not).
 *
 * ⚠ AN EARLIER VERSION OF THIS COMMENT WENT FURTHER AND WAS WRONG. It claimed there is "no await
 * boundary and therefore no same-id-reopen race to guard against". The teardown has none — but
 * `ensurePageGeometry` crosses TWO (`getPage`, `getOperatorList`) and used to publish afterwards
 * with no ownership check, so a project torn down mid-extraction had its coordinator row and query
 * **recreated by the very write that teardown had just removed** — and `openProject` never revisits
 * that publicId, so nothing would ever clear it again. It pinned a live `PDFPageProxy` whose
 * operator list pdf.js can no longer reclaim once the document is destroyed. Hence `generation`.
 */
export function clearGeometryProject(qc: QueryClient, publicId: string): void {
  if (!publicId) return;
  const coordinator = getCoordinator(qc);
  const project = coordinator.projects.get(publicId);
  if (project) {
    // Teardown ignores protection: the pages are going away regardless, and this is one of the
    // two moments `page.cleanup()` is correct.
    for (const pageNumber of [...project.pages.keys()]) {
      removePage(qc, publicId, pageNumber, true);
    }
    // ⚠ THE ROW IS KEPT, EMPTIED AND BUMPED — it is deliberately NOT deleted.
    //
    // My first version of this fence deleted it and bumped the counter first. That is useless
    // against the case it was written for: a SAME-ID REOPEN recreates the row at `generation: 0`,
    // which matches the stale token that also captured 0, so the fence passes and the stale
    // extraction publishes into the NEW project's cache. (Found because mutating the bump away
    // changed no test — a non-failing mutation meaning "your test is incomplete", not "this code
    // is redundant".)
    //
    // Keeping the row makes the counter monotonic across reopens, which is the whole point. The
    // cost is one small object per distinct publicId ever opened in this tab — a Map, a Set and a
    // number — against the ~25.6 MB pinned page proxy it prevents.
    project.generation += 1;
    project.pages.clear();
    project.protectedPages.clear();
  }
  qc.removeQueries({ queryKey: queryKeys.pageGeometry.all(publicId), exact: false });
}

/** Test/diagnostic view of the rails. Not used by product code. */
export function geometryRetentionSnapshot(
  qc: QueryClient,
  publicId: string,
): { pages: number[]; bytes: number } {
  const project = projectCoordinator(qc, publicId);
  return {
    pages: [...project.pages.keys()].sort((a, b) => a - b),
    bytes: retainedTotals(project).bytes,
  };
}
