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
    project = { pages: new Map(), protectedPages: new Set() };
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

function publish(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  entry: PageGeometryEntry,
  pageRef: { cleanup: () => void } | undefined,
): void {
  const coordinator = getCoordinator(qc);
  const project = projectCoordinator(qc, publicId);
  qc.setQueryData(queryKeys.pageGeometry.page(publicId, pageNumber), entry);
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
    publish(qc, publicId, pageNumber, entry, page);
    return entry;
  } catch {
    // ★ THE SENTINEL HALF. A failed op list is deterministic; caching the negative result is what
    // stops every subsequent click from re-parsing a document that will never parse.
    const entry: PageGeometryEntry = { status: "unavailable", reason: "oplist-failed" };
    publish(qc, publicId, pageNumber, entry, page);
    return entry;
  }
}

/**
 * Exact domain teardown, called beside `clearTextractProject` in the project lifecycle.
 *
 * Synchronous, unlike its textract sibling: this domain has no in-flight transport to cancel, so
 * there is no await boundary and therefore no same-id-reopen race to guard against.
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
    coordinator.projects.delete(publicId);
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
