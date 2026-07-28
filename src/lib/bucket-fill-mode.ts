"use client";

/**
 * bucket-fill-mode.ts — which engine may run, and therefore whether we prefetch at all.
 *
 * PLAN §4.3: until phase 4 ships the persisted user toggle, phase 2 gets "an env/localStorage dev
 * override (also the e2e harness escape)". This is that override, and nothing more — there is no
 * store key, no UI, and no persistence beyond the raw localStorage entry a developer sets by hand.
 *
 * ── ⛔ THE DEFAULT IS `raster`, AND PHASE 2 MUST NOT CHANGE IT ───────────────────────────
 * Phase 2 ships dark. Phase 3 flips the DOGFOOD deployment to `auto` via the env var. The PUBLIC
 * default flip is phase 4 and is owner-gated, because it lands together with the persisted toggle
 * so no customer is ever default-switched without an escape hatch.
 *
 * ── ★ WHY THIS MODULE HAD TO EXIST BEFORE THE PREFETCHER ────────────────────────────────
 * The tool-armed geometry prefetcher cannot be built safely without it, and the reason is
 * measured rather than assumed.
 *
 * `e2e/viewer-perf-v2.spec.ts` brackets the bucket-fill worker with a transport-quiescence
 * barrier and asserts an EXACT zero across four counters:
 *
 *     expect(intervalDeltas, `${label} no PDF transport during bucket worker`).toEqual({
 *       browserRequestGeneration: 0, browserLifecycleGeneration: 0,
 *       upstreamRequestGeneration: 0, upstreamLifecycleGeneration: 0,
 *     });
 *
 * And `PDFViewer` loads the document with **`disableAutoFetch: true`, `disableStream: true`,
 * `rangeChunkSize: 1 MiB`** — pdf.js therefore fetches page bytes lazily, in ranges, on demand. So
 * `page.getOperatorList()` on a page whose bytes have not been fetched **will** issue range
 * requests. A geometry prefetcher firing in the bucket window is not merely *likely* to trip that
 * invariant; under this configuration it is guaranteed to, for any page not already resident.
 *
 * PLAN §3.5 offers two ways out — "abort the prefetcher when that gate is active, or re-author the
 * barrier". Both are worse than a third that falls out of the routing design:
 *
 *   - *Abort when the gate is active* needs the app to know it is under test. There is no such
 *     signal anywhere in `src/` today (checked), so it would mean adding a test-only backdoor that
 *     changes product behaviour at runtime.
 *   - *Re-authoring the barrier* weakens a real invariant. That barrier proves the fill is
 *     computed from pixels already present rather than by re-fetching the PDF — worth keeping.
 *   - **What we do instead: the prefetcher is gated on this mode.** A `raster` session never
 *     prefetches vector geometry, because there is nothing for it to feed. PLAN already requires
 *     the e2e spec to pin the dev override to `raster`, so the invariant holds **by construction**
 *     rather than by timing, and no test-only code path enters the product.
 *
 * That is why this file is not merely a flag: `shouldPrefetchGeometry` is the safety property.
 */

/** `auto` = route per page (phase 3+); `vector` = force; `raster` = today's engine, the default. */
export type BucketFillMode = "auto" | "vector" | "raster";

/** ⛔ Phase 2 and 3 ship this. Changing it is phase 4 and owner-gated. */
export const BUCKET_FILL_MODE_DEFAULT: BucketFillMode = "raster";

/**
 * Dev/e2e override key. Deliberately NOT a store key — no BP2 store is persisted today, and
 * inventing persistence here would pre-empt phase 4's decision to make the real toggle
 * localStorage-backed for a stated reason.
 */
export const BUCKET_FILL_MODE_STORAGE_KEY = "bp.bucketFillMode";

const MODES: readonly BucketFillMode[] = ["auto", "vector", "raster"];

export function isBucketFillMode(value: unknown): value is BucketFillMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * Read the build-time deployment default.
 *
 * Referenced statically because Next.js inlines `process.env.NEXT_PUBLIC_*` at build time — a
 * computed lookup like `process.env[key]` is NOT substituted and would silently read `undefined`
 * in the browser. This is phase 3's env flip surface.
 */
/** RAW, deliberately unvalidated — see `resolveBucketFillMode` for where validation happens. */
function rawEnv(): unknown {
  return process.env.NEXT_PUBLIC_BUCKET_FILL_MODE;
}

/** RAW. `typeof window` guards SSR; the catch guards browsers where storage access throws. */
function rawStorage(): unknown {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(BUCKET_FILL_MODE_STORAGE_KEY);
  } catch {
    // Safari private mode, embedded webviews and blocked third-party contexts throw outright
    // rather than returning null. A dev override that can crash the viewer would be strictly
    // worse than no override.
    return undefined;
  }
}

export interface ResolveBucketFillModeOptions {
  /**
   * Injected for tests. Typed `unknown` ON PURPOSE, and the injected values go through the SAME
   * validation as the real sources.
   *
   * ⚠ The first version of this file took `BucketFillMode` here and returned injected values
   * unchecked, so a test could only ever inject something already valid — meaning the tests
   * exercised a *different code path than production* and the malformed-input case was
   * unreachable. Caught by the test asserting a typo degrades to `raster`, which returned the
   * typo. Keep these `unknown`.
   */
  env?: unknown;
  storage?: unknown;
}

/**
 * Resolve the effective mode: **localStorage > env > `raster`**.
 *
 * localStorage outranks env on purpose — env is the *deployment* default, and the whole point of a
 * per-browser override is to let one developer (or the e2e harness) depart from it. Validation is
 * applied here, once, to whichever source supplied the value, so an unknown or malformed entry at
 * either level degrades to the safe default rather than propagating or throwing.
 */
export function resolveBucketFillMode(
  options: ResolveBucketFillModeOptions = {},
): BucketFillMode {
  const storage = "storage" in options ? options.storage : rawStorage();
  if (isBucketFillMode(storage)) return storage;
  const env = "env" in options ? options.env : rawEnv();
  if (isBucketFillMode(env)) return env;
  return BUCKET_FILL_MODE_DEFAULT;
}

/** Can the vector engine run at all in this session? `raster` means no, at any cost. */
export function vectorMayRun(mode: BucketFillMode): boolean {
  return mode !== "raster";
}

/**
 * ★ THE SAFETY PROPERTY. Should the tool-armed prefetcher extract geometry right now?
 *
 * Both conditions are load-bearing and each is doing different work:
 *
 *   `vectorMayRun(mode)` — a `raster` session must issue **zero** PDF transport for geometry,
 *      because the perf suite's bucket-window barrier asserts exactly that and the e2e spec pins
 *      this override to `raster`. See the header: with `disableAutoFetch`, extraction fetches.
 *
 *   `toolArmed` — PLAN's "a user who never arms the bucket tool pays nothing". Parsing an operator
 *      list is ~1.2 s of main-thread work and retains ~25.6 MB per page; doing it speculatively for
 *      every viewer session would be a large regression for the majority who never bucket-fill.
 *
 * Keep them together here rather than inlining the `&&` at the call site: this is the rule the
 * transport invariant depends on, and it should be one testable thing with one place to read.
 */
export function shouldPrefetchGeometry(mode: BucketFillMode, toolArmed: boolean): boolean {
  return toolArmed && vectorMayRun(mode);
}

// ── [bucketfill P3] which ENGINE produced a polygon ─────────────────────────────────────
//
// ⚠ THIS EXISTS BECAUSE A SHIPPED BRANCH WAS DEAD. `DrawingPreviewLayer` labels the preview
// `bucketFillPreview.method === "vector" ? "Vector" : "Raster"`, and PLAN recorded that badge as
// "free — the branch already ships". It does ship. It can also never fire: **no producer emits the
// string `"vector"`.** The three that exist are `client-vector` (adapter + worker #2),
// `client-raster` (legacy worker) and `server-raster` (the API fallback), so the comparison is
// always false and every fill has always been labelled "Raster".
//
// It was invisible because the label was correct for the only engine that could run. The moment
// the vector path goes live it silently mislabels every vector fill — a provenance claim that is
// wrong, on the exact feature whose selling point is knowing which engine measured your room.
//
// So the test is a PREDICATE over the real values rather than an equality against a string nobody
// produces. `method` is persisted on the annotation (phase 3) and read back by anything auditing
// the mixed-provenance window, so the same predicate has to serve both.

/** Every `method` value a bucket fill can carry. Persisted, so treat these as a wire format. */
export const BUCKET_FILL_METHODS = {
  clientVector: "client-vector",
  clientRaster: "client-raster",
  serverRaster: "server-raster",
} as const;

export type BucketFillMethod =
  (typeof BUCKET_FILL_METHODS)[keyof typeof BUCKET_FILL_METHODS];

/**
 * Did the VECTOR engine produce this polygon?
 *
 * Accepts `undefined`/unknown strings and answers `false`: rows written before `method` existed
 * mean UNKNOWN, and unknown must never be reported as vector. Erring the other way would relabel
 * history — the same reasoning that keeps `method` absent rather than defaulted on old rows.
 */
export function isVectorMethod(method: string | null | undefined): boolean {
  return method === BUCKET_FILL_METHODS.clientVector;
}
