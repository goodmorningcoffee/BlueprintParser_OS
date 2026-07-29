"use client";

/**
 * bucket-fill-perf.ts — the phase-2 dev console table, and nothing else.
 *
 * PLAN §5 phase 2's gate: *"**[OWNER]** dev-browser console table of msParse/msWalk/msMask/msFlood
 * on the VA plan in Chrome — the in-situ check of the node numbers (the one open term is paint
 * cost, ±2×)"*, and §9 U1 names that table as the instrument that resolves the single quantity node
 * cannot bound. Running it is the owner's half; **emitting it is this file**, and until now nothing
 * emitted it — `msParse`/`msWalk`/`msMask`/`msFlood` appeared nowhere in `src/`, and
 * `performance.now()` occurred zero times in the whole of `src/`. The gate named an artifact that
 * did not exist.
 *
 * ── WHAT IT MEASURES, AND WHY THESE FOUR ────────────────────────────────────────────────
 *   msParse  pdf.js `page.getOperatorList()`          — the expensive, once-per-page half
 *   msWalk   `extractVectorGeometry()`                — our walk of that op list
 *   msMask   `buildMask()` inside worker #2           — paid on the FIRST click of a page
 *   msFlood  `floodRegion()` inside worker #2         — the per-click cost, the "warm click"
 *
 * The first two happen on the main thread in `pageGeometryCache`; the second two happen inside
 * worker #2 and travel back on its responses. Nothing here reaches into either — both sides push,
 * this module only joins and prints.
 *
 * ── ★ WHY msMask IS ON THE CLICK PATH, WHICH IS NOT OBVIOUS ─────────────────────────────
 * `bucket-fill-client.ts` **awaits `ensureVectorMask` before `vectorClientFill`**, and
 * `ensureVectorMask` has NO timeout — only the fill does (`VECTOR_FILL_TIMEOUT_MS = 1500`, and its
 * own comment scopes that budget to the ~32 ms warm click). So the first click on every page pays
 * the mask build, unbounded, and a table that showed only `msFlood` would report a warm click while
 * the user waited on a cold one. Measured in node on the local corpus: up to 674 ms for
 * mask+flood together on a 1,039,247-segment sheet. That is the number this table exists to check
 * in Chrome.
 *
 * ── ⛔ DEV ONLY, AND DARK BY DEFAULT ────────────────────────────────────────────────────
 * Two independent gates, both of which must pass before a single timer runs:
 *   1. `process.env.NODE_ENV === "development"` — not production, and deliberately not `test`
 *      either: a future vector-path unit test must not be able to acquire console.table noise;
 *   2. the bucket-fill mode is not `raster` — a raster session has no vector stage to measure, and
 *      the mode default is `raster` (phase 4 owns changing that).
 * With either gate closed, `perfEnabled()` is false and every record/emit call in THIS module
 * returns immediately — no map write, no console output — and the main-thread clock reads in
 * `pageGeometryCache` are skipped entirely because that call site checks `perfEnabled()` first.
 *
 * ⚠ ONE THING IS *NOT* GATED, AND SAYING SO IS THE POINT: worker #2 times `buildMask`/`floodRegion`
 * UNCONDITIONALLY and returns the numbers on every response, production included. Gating there
 * would require the worker to know the mode, costing it the pure-function-over-explicit-state
 * property its own header depends on. The measured price is ~6 clock reads and ~24 bytes of
 * structured-clone payload per fill. What is dev-gated is the PRINTING, which is this file.
 *
 * Nothing about product behaviour changes either way: this module is write-only from the product's
 * point of view, and both of its call sites wrap it in their own try/catch so that even a throw in
 * here cannot alter a fill's outcome.
 *
 * ⚠ CANON: every number here is a MILLISECOND. Nothing in this file touches area, scale or units.
 */

import { BUCKET_FILL_MODE_DEFAULT, vectorMayRun, type BucketFillMode } from "@/lib/bucket-fill-mode";

/**
 * Per-page parse/walk, keyed `publicId|pageNumber`. Written once per geometry acquisition.
 *
 * Bounded: a dogfooding session can open hundreds of pages, and an unbounded module-level Map in a
 * long-lived viewer is a leak however small each entry is. Oldest-first eviction, because the
 * interesting row is always the page just clicked.
 */
const geometryTimings = new Map<string, { msParse: number; msWalk: number }>();
/** Enough to cover any page a dogfooder revisits; small enough that the map can never matter. */
const MAX_TRACKED_PAGES = 64;
/** Per-mask build, keyed by the worker's own mask cache key. Written once per page. */
const maskTimings = new Map<string, number>();

const geometryKey = (publicId: string, pageNumber: number) => `${publicId}|${pageNumber}`;

/**
 * The live mode, pushed in by the caller rather than read here.
 *
 * `resolveBucketFillMode` needs `localStorage` and the build-time env, and reading it from a module
 * that may be imported by a worker or during SSR is how a "dev-only" helper acquires a real
 * behaviour. The client already resolves the mode for routing; it hands it over.
 */
let currentMode: BucketFillMode = BUCKET_FILL_MODE_DEFAULT;

export function setBucketFillPerfMode(mode: BucketFillMode): void {
  currentMode = mode;
}

/** Both gates. Everything in this module is a no-op unless this is true. */
export function perfEnabled(): boolean {
  return process.env.NODE_ENV === "development" && vectorMayRun(currentMode);
}

export function recordGeometryTiming(
  publicId: string,
  pageNumber: number,
  timings: { msParse: number; msWalk: number },
): void {
  if (!perfEnabled()) return;
  geometryTimings.set(geometryKey(publicId, pageNumber), timings);
  evictOldest(geometryTimings);
}

/** Map insertion order is iteration order, so the first key is the oldest. */
function evictOldest(map: Map<string, unknown>): void {
  while (map.size > MAX_TRACKED_PAGES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export function recordMaskTiming(key: string, msMask: number): void {
  if (!perfEnabled()) return;
  maskTimings.set(key, msMask);
  // A fill that never reports (a timeout, a torn-down page) would otherwise orphan its entry.
  evictOldest(maskTimings);
}

export interface BucketFillPerfRow {
  publicId: string;
  pageNumber: number;
  /** The worker's mask cache key — how the mask timing is found again. */
  key: string;
  /** Undefined when the stage did not run — the table prints `—`, never a misleading 0.00. */
  msFlood?: number;
  msTrace?: number;
  segCount?: number;
  /** `ok`, or the refusal code / failure that ended this click. Slow failures matter most. */
  status: string;
}

/**
 * Emit one row of the table.
 *
 * `console.table` rather than a formatted string on purpose: the owner is comparing four numbers
 * against a constants file, and a table sorts, aligns and survives copy-paste into a note. One row
 * per click, printed as it happens — a buffered table would hide the very thing being looked for,
 * which is the FIRST click on a page being slower than the rest.
 */
export function reportBucketFill(row: BucketFillPerfRow): void {
  if (!perfEnabled()) return;
  const geo = geometryTimings.get(geometryKey(row.publicId, row.pageNumber));
  const msMask = maskTimings.get(row.key);
  const msParse = geo?.msParse;
  const msWalk = geo?.msWalk;
  const clickPath = (msMask ?? 0) + (row.msFlood ?? 0) + (row.msTrace ?? 0);

  console.table([
    {
      page: row.pageNumber,
      status: row.status,
      segs: row.segCount ?? "—",
      msParse: fmt(msParse),
      msWalk: fmt(msWalk),
      msMask: fmt(msMask),
      msFlood: fmt(row.msFlood),
      msTrace: fmt(row.msTrace),
      "click-path ms": fmt(clickPath),
    },
  ]);
  if (msMask !== undefined) {
    // Said once per page, where it is actionable: this is the click that paid for the mask.
    console.info(
      `[bucket-fill perf] p${row.pageNumber}: this click paid the ${fmt(msMask)} ms mask build ` +
        `(ensureVectorMask is awaited on the click path and has no timeout). Later clicks on this ` +
        `page reuse it.`,
    );
    maskTimings.delete(row.key);
  }
}

/** Two decimals, and `—` for a stage that did not run rather than a misleading 0. */
function fmt(ms: number | undefined): string {
  return ms === undefined ? "—" : ms.toFixed(2);
}

/** Test/teardown seam. Nothing in the product calls this. */
export function __resetBucketFillPerf(): void {
  geometryTimings.clear();
  maskTimings.clear();
  currentMode = BUCKET_FILL_MODE_DEFAULT;
}
