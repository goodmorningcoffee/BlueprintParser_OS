// @vitest-environment node
/**
 * pageGeometryCache + pdf-document-registry — THE SEAM (PLAN §4.2).
 *
 * Two halves, deliberately:
 *
 *   1. **A real PDF through the real extractor.** Built in-test with pdf-lib and loaded with
 *      pdf.js, so the wiring — registry → getPage → viewport → getOperatorList →
 *      extractVectorGeometry → cached entry — is exercised end to end rather than mocked into
 *      agreement with itself. The generated fixture corpus under `test/fixtures/` is gitignored,
 *      so a suite depending on it would pass locally and fail on a fresh clone.
 *
 *   2. **A controlled fake document** for the retention rails, the sentinel/evict asymmetry, and
 *      `page.cleanup()`. These need a page whose segment count and cleanup calls the test owns;
 *      a real document can demonstrate none of them precisely.
 *
 * The behaviours that matter here are the ones that fail SILENTLY in production: a sentinel
 * written for a transient reason permanently demotes a page to raster, an evicted-instead-of-
 * sentinelled op-list failure re-parses a broken document on every click, and a `cleanup()` on the
 * mounted page costs 1.6 s on its next render with nothing to show for it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PDFDocument, rgb } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  registerPdfDocument,
  getPdfDocument,
  unregisterPdfDocument,
  registeredPdfDocumentCount,
  __resetPdfDocumentRegistry,
} from "@/lib/pdf-document-registry";
import {
  ensurePageGeometry,
  readGeometryForPage,
  readGeometryEntry,
  evictPageGeometry,
  clearGeometryProject,
  setGeometryProtectedPages,
  geometryRetentionSnapshot,
  canonicalExtractionScale,
  estimateGeometryBytes,
  MAX_RETAINED_GEOMETRY_PAGES,
  MAX_RETAINED_GEOMETRY_BYTES,
  type CachedPageGeometry,
} from "@/queries/pageGeometryCache";
import { queryKeys } from "@/queries/queryKeys";
import { MASK_DIM_DEFAULT } from "@/lib/bucket-fill-vector-limits";

const PAGE_W = 600;
const PAGE_H = 400;

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  __resetPdfDocumentRegistry();
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 1. THE REGISTRY
// ────────────────────────────────────────────────────────────────────────────────────────

/** Minimal stand-in. Cast through `unknown` — a real proxy cannot be constructed in a test. */
function fakeDoc(numPages: number, tag = "doc"): PDFDocumentProxy {
  return { numPages, __tag: tag } as unknown as PDFDocumentProxy;
}

describe("pdf-document-registry", () => {
  it("registers, reads back, and reports a miss as undefined rather than throwing", () => {
    const doc = fakeDoc(3);
    expect(getPdfDocument("A")).toBeUndefined(); // a miss is ordinary — it routes to raster
    registerPdfDocument("A", doc);
    expect(getPdfDocument("A")).toBe(doc);
    expect(getPdfDocument("B")).toBeUndefined();
  });

  it("ignores an empty publicId on every entry point", () => {
    registerPdfDocument("", fakeDoc(1));
    expect(registeredPdfDocumentCount()).toBe(0);
    expect(getPdfDocument("")).toBeUndefined();
    expect(() => unregisterPdfDocument("")).not.toThrow();
  });

  it("lets a reopen replace the entry", () => {
    const first = fakeDoc(2, "first");
    const second = fakeDoc(9, "second");
    registerPdfDocument("A", first);
    registerPdfDocument("A", second);
    expect(getPdfDocument("A")).toBe(second);
    expect(registeredPdfDocumentCount()).toBe(1);
  });

  it("★ guards the same-id reopen race: a stale teardown cannot unregister the live document", () => {
    // The failure this prevents: project A unmounts, its cleanup runs LATE — after a same-id
    // reopen has already registered a new document — and an unguarded delete silently routes
    // every subsequent click to raster with no error anywhere.
    const oldDoc = fakeDoc(2, "old");
    const newDoc = fakeDoc(2, "new");
    registerPdfDocument("A", oldDoc);
    registerPdfDocument("A", newDoc);

    unregisterPdfDocument("A", oldDoc); // stale teardown, arriving after the reopen
    expect(getPdfDocument("A")).toBe(newDoc);

    unregisterPdfDocument("A", newDoc); // the real one
    expect(getPdfDocument("A")).toBeUndefined();
  });

  it("unregisters unconditionally when no expectation is passed", () => {
    registerPdfDocument("A", fakeDoc(1));
    unregisterPdfDocument("A");
    expect(getPdfDocument("A")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 2. A REAL PDF, THROUGH THE REAL EXTRACTOR
// ────────────────────────────────────────────────────────────────────────────────────────

async function makeRoomPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const black = rgb(0, 0, 0);
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 2, color: black });
  line(100, 100, 300, 100);
  line(300, 100, 300, 250);
  line(300, 250, 100, 250);
  line(100, 250, 100, 100);
  return doc.save();
}

describe("ensurePageGeometry — a real document end to end", () => {
  it("extracts, drops points, and records the frame it was extracted at", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = await makeRoomPdf();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
      .promise;
    try {
      const qc = newClient();
      registerPdfDocument("P", doc as unknown as PDFDocumentProxy);

      const entry = await ensurePageGeometry(qc, { publicId: "P", pageNumber: 1, ops: pdfjs.OPS });
      expect(entry.status).toBe("ok");
      const geo = readGeometryForPage(qc, "P", 1);
      expect(geo).toBeDefined();

      // Real linework came back — four strokes, so the extractor genuinely ran.
      expect(geo!.segs.length).toBeGreaterThan(0);
      expect(geo!.meta.byteLength).toBeGreaterThan(0);

      // ⛔ The tripwire: points are dropped, and the value says so.
      expect(geo!.points).toEqual([]);
      expect(geo!.pointsDropped).toBe(true);

      // The frame the geometry belongs to must travel with it — `vectorBucketFill` needs
      // imgW/imgH, and geometry extracted at one scale is meaningless against another.
      expect(geo!.pageWidthPt).toBeCloseTo(PAGE_W, 3);
      expect(geo!.pageHeightPt).toBeCloseTo(PAGE_H, 3);
      expect(geo!.scale).toBeCloseTo(MASK_DIM_DEFAULT / PAGE_W, 6);
      expect(geo!.viewportWidth).toBeCloseTo(PAGE_W * geo!.scale, 3);
      expect(geo!.viewportHeight).toBeCloseTo(PAGE_H * geo!.scale, 3);
    } finally {
      await doc.destroy();
    }
  });

  it("returns the cached entry on a second call instead of re-extracting", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = await makeRoomPdf();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
      .promise;
    try {
      const qc = newClient();
      registerPdfDocument("P", doc as unknown as PDFDocumentProxy);
      const a = await ensurePageGeometry(qc, { publicId: "P", pageNumber: 1, ops: pdfjs.OPS });
      const b = await ensurePageGeometry(qc, { publicId: "P", pageNumber: 1, ops: pdfjs.OPS });
      // Same object identity: the ~1.2 s parse happened once. That is the cache's entire job.
      expect(a.status).toBe("ok");
      expect(b).toBe(a);
    } finally {
      await doc.destroy();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 3. THE RAILS, THE ASYMMETRY, AND cleanup()
// ────────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THESE CODES MUST BE DISTINCT AND MUST MATCH WHAT THE FAKE EMITS.
 *
 * The first version of this stub passed `args[0] = [1]` as the path-op list — a code matching
 * none of `OPS.moveTo`/`lineTo`/`curveTo`, so `extractVectorGeometry` walked the op and emitted
 * **zero segments**. Every fake-backed assertion below still passed, and the byte-rail test was
 * measuring nothing at all. `SEGMENTS_PER_PAGE` and the `segs.length` assertion exist so that
 * cannot recur silently.
 */
const OPS_STUB = {
  constructPath: 91,
  save: 10,
  restore: 11,
  moveTo: 13,
  lineTo: 14,
  stroke: 20,
};

/** `segs.push(x1,y1,x2,y2)` + one meta byte per segment ⇒ 4·8.4 + 1 = 34.6 estimated bytes. */
const ESTIMATED_BYTES_PER_SEGMENT = 4 * 8.4 + 1;

interface FakePage {
  cleanup: ReturnType<typeof vi.fn>;
  getOperatorList: ReturnType<typeof vi.fn>;
  getViewport: (o: { scale: number }) => { width: number; height: number; transform: number[] };
}

/**
 * A document whose pages return a controllable number of path segments.
 *
 * `segCount` drives the byte estimator, so a test can put a page over the 24 MiB rail without
 * building a 24 MiB PDF.
 */
function controllableDoc(opts: {
  numPages: number;
  segsPerPage?: number;
  failOplistOn?: Set<number>;
}) {
  const pages = new Map<number, FakePage>();
  const doc = {
    numPages: opts.numPages,
    getPage: vi.fn(async (n: number) => {
      let page = pages.get(n);
      if (!page) {
        page = {
          cleanup: vi.fn(),
          getOperatorList: vi.fn(async () => {
            if (opts.failOplistOn?.has(n)) throw new Error("corrupt op stream");
            // One `constructPath`: a moveTo followed by N lineTo, which is exactly N segments.
            // args[0] is the path-OP-CODE list and args[1] the flat coordinate list — the real
            // pdf.js encoding, read out of the extractor rather than invented.
            const segments = opts.segsPerPage ?? 8;
            const pathOps: number[] = [OPS_STUB.moveTo];
            const coords: number[] = [0, 0];
            for (let i = 1; i <= segments; i++) {
              pathOps.push(OPS_STUB.lineTo);
              coords.push(i, i % 7);
            }
            return {
              fnArray: [OPS_STUB.constructPath, OPS_STUB.stroke],
              argsArray: [[pathOps, coords, null], null],
            };
          }),
          getViewport: ({ scale }: { scale: number }) => ({
            width: PAGE_W * scale,
            height: PAGE_H * scale,
            transform: [scale, 0, 0, -scale, 0, PAGE_H * scale],
          }),
        };
        pages.set(n, page);
      }
      return page;
    }),
  };
  return { doc: doc as unknown as PDFDocumentProxy, pages };
}

async function fill(qc: QueryClient, publicId: string, page: number, segs = 8) {
  return ensurePageGeometry(qc, { publicId, pageNumber: page, ops: OPS_STUB });
}

describe("pageGeometryCache — the sentinel / evict asymmetry", () => {
  it("★ CACHES a sentinel when getOperatorList fails, so a broken page is parsed once", async () => {
    const { doc, pages } = controllableDoc({ numPages: 3, failOplistOn: new Set([2]) });
    registerPdfDocument("P", doc);
    const qc = newClient();

    const first = await fill(qc, "P", 2);
    expect(first).toEqual({ status: "unavailable", reason: "oplist-failed" });

    const second = await fill(qc, "P", 2);
    expect(second).toEqual({ status: "unavailable", reason: "oplist-failed" });

    // The whole point: the second call did NOT re-parse. Without the sentinel this is ~1.2 s of
    // main-thread work on every click, forever, on a document that will never parse.
    expect((await pages.get(2)!.getOperatorList).mock.calls.length).toBe(1);

    // And the router sees "no usable geometry" without having to destructure the union.
    expect(readGeometryForPage(qc, "P", 2)).toBeUndefined();
    expect(readGeometryEntry(qc, "P", 2)).toEqual({
      status: "unavailable",
      reason: "oplist-failed",
    });
  });

  it("★ does NOT cache a sentinel when the document is merely absent", async () => {
    // "The viewer has not finished loading" is transient by definition. A sentinel here would
    // permanently demote every page opened during startup — the exact inverse failure.
    const qc = newClient();
    const absent = await fill(qc, "P", 1);
    expect(absent).toEqual({ status: "unavailable", reason: "no-document" });
    expect(qc.getQueryData(queryKeys.pageGeometry.page("P", 1))).toBeUndefined();

    // Once the document arrives, the very next call succeeds — nothing was pinned against it.
    const { doc } = controllableDoc({ numPages: 2 });
    registerPdfDocument("P", doc);
    expect((await fill(qc, "P", 1)).status).toBe("ok");
  });

  it("evictPageGeometry leaves NO sentinel, so the next attempt re-extracts", async () => {
    const { doc, pages } = controllableDoc({ numPages: 2 });
    registerPdfDocument("P", doc);
    const qc = newClient();

    await fill(qc, "P", 1);
    expect(readGeometryForPage(qc, "P", 1)).toBeDefined();

    evictPageGeometry(qc, "P", 1); // the transient half — a failed render, not a failed parse
    expect(qc.getQueryData(queryKeys.pageGeometry.page("P", 1))).toBeUndefined();
    expect(readGeometryForPage(qc, "P", 1)).toBeUndefined();

    await fill(qc, "P", 1);
    expect(readGeometryForPage(qc, "P", 1)).toBeDefined();
    expect(pages.get(1)!.getOperatorList.mock.calls.length).toBe(2); // re-extracted, as intended
  });

  it("refuses a page number the document does not have, without caching it", async () => {
    const { doc } = controllableDoc({ numPages: 2 });
    registerPdfDocument("P", doc);
    const qc = newClient();
    for (const bad of [0, 3, 1.5, Number.NaN]) {
      expect(await fill(qc, "P", bad)).toEqual({ status: "unavailable", reason: "no-page" });
    }
  });
});

describe("pageGeometryCache — retention rails", () => {
  it("holds at most MAX_RETAINED_GEOMETRY_PAGES, evicting least-recently-used first", async () => {
    const { doc } = controllableDoc({ numPages: 10 });
    registerPdfDocument("P", doc);
    const qc = newClient();

    for (let p = 1; p <= MAX_RETAINED_GEOMETRY_PAGES; p++) await fill(qc, "P", p);
    expect(geometryRetentionSnapshot(qc, "P").pages).toEqual([1, 2, 3, 4]);

    // Touch page 1 so page 2 becomes the least-recently-used.
    readGeometryForPage(qc, "P", 1);
    await fill(qc, "P", 5);

    const snap = geometryRetentionSnapshot(qc, "P");
    expect(snap.pages).toHaveLength(MAX_RETAINED_GEOMETRY_PAGES);
    expect(snap.pages).toEqual([1, 3, 4, 5]);
    expect(readGeometryForPage(qc, "P", 2)).toBeUndefined();
  });

  it("evicts on the BYTE rail even when the page count is legal", async () => {
    // Two rails exist because page weight varies by an order of magnitude across one drawing set;
    // a 4-page count rail alone would let four dense sheets blow the budget.
    //
    // Sized so TWO pages fit and a THIRD does not — the count rail (4) is never the cause here,
    // which is what makes this a byte-rail test rather than a restatement of the one above.
    const segsPerPage = Math.floor(MAX_RETAINED_GEOMETRY_BYTES / ESTIMATED_BYTES_PER_SEGMENT / 2.5);
    const { doc } = controllableDoc({ numPages: 6, segsPerPage });
    registerPdfDocument("P", doc);
    const qc = newClient();

    const first = await fill(qc, "P", 1);
    expect(first.status).toBe("ok");
    // Guard against the vacuum the first version of this test fell into: if the fake emits no
    // segments the estimator returns ~0 and nothing below can ever fire.
    const geo = readGeometryForPage(qc, "P", 1)!;
    expect(geo.segs.length).toBe(segsPerPage * 4);
    expect(geo.meta.byteLength).toBe(segsPerPage);
    expect(estimateGeometryBytes(geo)).toBeGreaterThan(MAX_RETAINED_GEOMETRY_BYTES / 3);

    await fill(qc, "P", 2);
    expect(geometryRetentionSnapshot(qc, "P").pages).toEqual([1, 2]);

    await fill(qc, "P", 3);
    const snap = geometryRetentionSnapshot(qc, "P");
    expect(snap.pages.length).toBe(2); // evicted on bytes, with the count rail at 4 untouched
    expect(snap.pages).toEqual([2, 3]); // page 1 was least recently used
    expect(snap.bytes).toBeLessThanOrEqual(MAX_RETAINED_GEOMETRY_BYTES);
  });

  it("★ never evicts a protected page, and never calls cleanup() on it", async () => {
    // This is how "page.cleanup() never on the mounted page" is enforced. cleanup() frees the
    // 25.6 MB op list but ALSO discards the display cache — measured at +1612 ms on that page's
    // next render. On the sheet the user is looking at, that is a pure loss.
    const { doc, pages } = controllableDoc({ numPages: 10 });
    registerPdfDocument("P", doc);
    const qc = newClient();

    for (let p = 1; p <= 4; p++) await fill(qc, "P", p);
    setGeometryProtectedPages(qc, "P", [1]); // page 1 is mounted
    readGeometryForPage(qc, "P", 4); // make 1 the LRU candidate on recency

    await fill(qc, "P", 5);
    await fill(qc, "P", 6);

    const snap = geometryRetentionSnapshot(qc, "P");
    expect(snap.pages).toContain(1);
    expect(pages.get(1)!.cleanup).not.toHaveBeenCalled();
    // ...while an unprotected evictee did get its op list released.
    expect(pages.get(2)!.cleanup).toHaveBeenCalledTimes(1);
  });

  it("accepts an honest overage rather than evicting the working set", async () => {
    const { doc } = controllableDoc({ numPages: 10 });
    registerPdfDocument("P", doc);
    const qc = newClient();
    // Protection must be published BEFORE the pages land — otherwise the rail evicts them on the
    // way in and "protect all six" only ever protects the four that survived. (That is what the
    // first version of this test did, and it passed for the wrong reason: exactly 4.)
    setGeometryProtectedPages(qc, "P", [1, 2, 3, 4, 5, 6]);
    for (let p = 1; p <= 6; p++) await fill(qc, "P", p);

    // Every retained page is protected, so the rail cannot be met. Overshooting is the correct
    // behaviour; evicting the page in view to satisfy a number is not.
    expect(geometryRetentionSnapshot(qc, "P").pages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(geometryRetentionSnapshot(qc, "P").pages.length).toBeGreaterThan(
      MAX_RETAINED_GEOMETRY_PAGES,
    );

    // ...and the overage drains the moment the working set shrinks, rather than being permanent.
    // It drains to the RAIL (4), not to the protected set: protection is a floor on what may not
    // be evicted, never a ceiling on what may be kept. Dropping to [6] here would be
    // over-eviction — throwing away three pages that fit and would have to be re-parsed.
    setGeometryProtectedPages(qc, "P", [6]);
    expect(geometryRetentionSnapshot(qc, "P").pages).toEqual([3, 4, 5, 6]);
  });
});

describe("pageGeometryCache — teardown", () => {
  it("clears one project's pages and cleans up their op lists, leaving siblings alone", async () => {
    const a = controllableDoc({ numPages: 4 });
    const qc = newClient();

    registerPdfDocument("A", a.doc);
    await fill(qc, "A", 1);
    await fill(qc, "A", 2);
    const bPages = new Map<number, FakePage>();
    // Second project, same QueryClient — the realistic shape after a project switch.
    const b = controllableDoc({ numPages: 4 });
    registerPdfDocument("B", b.doc);
    await fill(qc, "B", 1);
    b.pages.forEach((v, k) => bPages.set(k, v));

    clearGeometryProject(qc, "A");

    expect(geometryRetentionSnapshot(qc, "A").pages).toEqual([]);
    expect(qc.getQueryData(queryKeys.pageGeometry.page("A", 1))).toBeUndefined();
    // Teardown IGNORES protection — the pages are going away regardless, and this is one of the
    // exactly two moments cleanup() is correct.
    expect(a.pages.get(1)!.cleanup).toHaveBeenCalledTimes(1);
    expect(a.pages.get(2)!.cleanup).toHaveBeenCalledTimes(1);

    expect(geometryRetentionSnapshot(qc, "B").pages).toEqual([1]);
    expect(bPages.get(1)!.cleanup).not.toHaveBeenCalled();
  });

  it("tears down even when a page proxy's cleanup throws", async () => {
    // A destroyed document throws from cleanup(). That must not strand the rest of teardown —
    // cleanup is a memory optimisation, never a correctness step.
    const { doc, pages } = controllableDoc({ numPages: 3 });
    registerPdfDocument("P", doc);
    const qc = newClient();
    await fill(qc, "P", 1);
    await fill(qc, "P", 2);
    pages.get(1)!.cleanup.mockImplementation(() => {
      throw new Error("document destroyed");
    });

    expect(() => clearGeometryProject(qc, "P")).not.toThrow();
    expect(geometryRetentionSnapshot(qc, "P").pages).toEqual([]);
    expect(pages.get(2)!.cleanup).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on an unknown project and on an empty publicId", () => {
    const qc = newClient();
    expect(() => clearGeometryProject(qc, "nope")).not.toThrow();
    expect(() => clearGeometryProject(qc, "")).not.toThrow();
  });
});

describe("pure helpers", () => {
  it("canonicalExtractionScale saturates the mask on the LONG side", () => {
    expect(canonicalExtractionScale(600, 400, 3000)).toBeCloseTo(5, 9);
    expect(canonicalExtractionScale(400, 600, 3000)).toBeCloseTo(5, 9);
    // An E-size sheet (3456 x 2592 pt) cannot saturate a 3000 mask: below one mask px per point,
    // which is where the engine's 21 mask-pixel constants stop being calibrated for it.
    expect(canonicalExtractionScale(3456, 2592, 3000)).toBeLessThan(1);
    // Degenerate input must not produce NaN/Infinity and silently poison a viewport.
    expect(canonicalExtractionScale(0, 0, 3000)).toBe(1);
  });

  it("estimateGeometryBytes counts segs and meta, and ignores the dropped points", () => {
    const geo = {
      points: [],
      pointsDropped: true,
      segs: new Array(1000).fill(0),
      meta: new Uint8Array(250),
      imageArea: 0,
      viewportWidth: 1,
      viewportHeight: 1,
      scale: 1,
      pageWidthPt: 1,
      pageHeightPt: 1,
    } satisfies CachedPageGeometry;
    expect(estimateGeometryBytes(geo)).toBe(Math.round(1000 * 8.4 + 250));
  });
});
