/**
 * useVectorGeometryPrefetch — the tool-armed geometry prefetcher.
 *
 * The property that carries the most weight here is a NEGATIVE one: in a `raster` session this
 * hook must issue **zero** geometry extraction, because `e2e/viewer-perf-v2.spec.ts` brackets the
 * bucket worker and asserts an exact zero across four PDF-transport counters, `PDFViewer` loads
 * the document with `disableAutoFetch: true` and 1 MiB ranges (so extraction fetches bytes), and
 * PLAN pins the e2e override to `raster`. If that ever regresses, the perf suite goes red for a
 * reason that looks like a performance problem and isn't.
 *
 * Everything is injected — the hook reads no store — so these tests drive the real logic rather
 * than a mock of it. `ensurePageGeometry` is spied on because the alternative is standing up a
 * real pdf.js document per case; the calls it receives are asserted precisely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useVectorGeometryPrefetch } from "@/hooks/useVectorGeometryPrefetch";
import {
  getPdfDocument,
  __resetPdfDocumentRegistry,
} from "@/lib/pdf-document-registry";
import * as cache from "@/queries/pageGeometryCache";

const OPS = { constructPath: 91, moveTo: 13, lineTo: 14 };

function fakeDoc(tag = "doc"): PDFDocumentProxy {
  return { numPages: 5, __tag: tag } as unknown as PDFDocumentProxy;
}

let ensureSpy: ReturnType<typeof vi.spyOn>;
let protectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetPdfDocumentRegistry();
  ensureSpy = vi
    .spyOn(cache, "ensurePageGeometry")
    .mockResolvedValue({ status: "unavailable", reason: "no-document" });
  protectSpy = vi.spyOn(cache, "setGeometryProtectedPages").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseArgs = (over: Partial<Parameters<typeof useVectorGeometryPrefetch>[0]> = {}) => ({
  queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  publicId: "P",
  pageNumber: 1,
  pdfDoc: fakeDoc(),
  toolArmed: true,
  ops: OPS,
  modeOverride: "auto" as const,
  ...over,
});

describe("★ the raster session prefetches NOTHING — the transport-barrier property", () => {
  it("does not extract in raster mode even with the tool armed", async () => {
    const args = baseArgs({ modeOverride: "raster" });
    renderHook(() => useVectorGeometryPrefetch(args));
    // Give any async effect a chance to run before asserting the negative.
    await new Promise((r) => setTimeout(r, 0));
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("still registers the document in raster mode — registration is not extraction", () => {
    // The routing layer needs the handle whether or not this session prefetches, and a Map.set
    // issues no transport. Conflating the two would make raster sessions unroutable.
    const doc = fakeDoc("raster-doc");
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ modeOverride: "raster", pdfDoc: doc })));
    expect(getPdfDocument("P")).toBe(doc);
  });

  it("still protects the mounted page in raster mode", () => {
    // Geometry may be cached from before the mode changed. Gating protection on the mode would
    // leave a real page eligible for page.cleanup() — 25.6 MB freed at a cost of +1612 ms on that
    // page's next render, on the sheet the user is looking at.
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ modeOverride: "raster" })));
    expect(protectSpy).toHaveBeenCalledWith(expect.anything(), "P", [1]);
  });
});

describe("prefetching when it should", () => {
  it("extracts the mounted page when armed in auto mode", async () => {
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ pageNumber: 3 })));
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    expect(ensureSpy).toHaveBeenCalledWith(expect.anything(), {
      publicId: "P",
      pageNumber: 3,
      ops: OPS,
    });
  });

  it("extracts in vector mode too", async () => {
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ modeOverride: "vector" })));
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
  });

  it("does NOT extract while the tool is unarmed — a user who never arms it pays nothing", async () => {
    const { rerender } = renderHook(
      (p: Parameters<typeof useVectorGeometryPrefetch>[0]) => useVectorGeometryPrefetch(p),
      { initialProps: baseArgs({ toolArmed: false }) },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(ensureSpy).not.toHaveBeenCalled();

    // ...and starts the moment it IS armed, without a remount.
    rerender(baseArgs({ toolArmed: true }));
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
  });

  it("waits for the document, then fires — arming before the PDF loads is the normal order", async () => {
    const { rerender } = renderHook(
      (p: Parameters<typeof useVectorGeometryPrefetch>[0]) => useVectorGeometryPrefetch(p),
      { initialProps: baseArgs({ pdfDoc: null }) },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(ensureSpy).not.toHaveBeenCalled();

    rerender(baseArgs({ pdfDoc: fakeDoc() }));
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
  });

  it("does nothing without a publicId or without OPS", async () => {
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ publicId: null })));
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ ops: null })));
    await new Promise((r) => setTimeout(r, 0));
    expect(ensureSpy).not.toHaveBeenCalled();
  });
});

describe("de-duplication and page changes", () => {
  it("attempts each page exactly once, however many times it re-renders", async () => {
    const args = baseArgs();
    const { rerender } = renderHook(
      (p: Parameters<typeof useVectorGeometryPrefetch>[0]) => useVectorGeometryPrefetch(p),
      { initialProps: args },
    );
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) rerender({ ...args });
    await new Promise((r) => setTimeout(r, 0));
    // The cache is idempotent anyway, but re-entering the effect would still re-await a promise
    // per render on a hot path.
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("prefetches the NEW page when the viewer navigates", async () => {
    const args = baseArgs({ pageNumber: 1 });
    const { rerender } = renderHook(
      (p: Parameters<typeof useVectorGeometryPrefetch>[0]) => useVectorGeometryPrefetch(p),
      { initialProps: args },
    );
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    rerender({ ...args, pageNumber: 2 });
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(2));
    expect(ensureSpy.mock.calls[1][1]).toMatchObject({ pageNumber: 2 });
    // ...and protection follows the mounted page, so page 1 becomes evictable and page 2 does not.
    expect(protectSpy).toHaveBeenCalledWith(expect.anything(), "P", [2]);
  });

  it("keys de-duplication by project as well as page", async () => {
    const args = baseArgs({ publicId: "A", pageNumber: 1 });
    const { rerender } = renderHook(
      (p: Parameters<typeof useVectorGeometryPrefetch>[0]) => useVectorGeometryPrefetch(p),
      { initialProps: args },
    );
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    // Same page number, different project — must NOT be treated as already attempted.
    rerender({ ...args, publicId: "B" });
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(2));
    expect(ensureSpy.mock.calls[1][1]).toMatchObject({ publicId: "B", pageNumber: 1 });
  });
});

describe("lifetime and failure", () => {
  it("re-asserts protection after the entry lands, so it cannot be evicted on arrival", async () => {
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ pageNumber: 4 })));
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    // Publishing runs pruneGeometryCache; on a cache already at its rail the page just extracted
    // could be the eviction candidate. Extract-then-immediately-drop is the one outcome worth a
    // line to prevent, so protection is asserted a second time AFTER the await.
    await waitFor(() =>
      expect(
        protectSpy.mock.calls.filter(
          (call: unknown[]) => call[1] === "P" && (call[2] as number[])[0] === 4,
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("does not touch the cache after unmount", async () => {
    type Entry = Awaited<ReturnType<typeof cache.ensurePageGeometry>>;
    let release: (v: Entry) => void = () => {};
    ensureSpy.mockImplementation(
      () => new Promise<Entry>((resolve) => { release = resolve; }),
    );
    const { unmount } = renderHook(() => useVectorGeometryPrefetch(baseArgs({ pageNumber: 7 })));
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    const before = protectSpy.mock.calls.length;
    unmount();
    release({ status: "unavailable", reason: "no-document" });
    await new Promise((r) => setTimeout(r, 0));
    // The parse itself is not abortable; what must not happen is a post-unmount cache write.
    expect(protectSpy.mock.calls.length).toBe(before);
  });

  it("★ swallows a throw rather than letting a prefetch break the viewer", async () => {
    ensureSpy.mockRejectedValue(new Error("unforeseen"));
    const onError = vi.fn();
    const prior = process.listeners("unhandledRejection");
    process.on("unhandledRejection", onError);
    try {
      renderHook(() => useVectorGeometryPrefetch(baseArgs()));
      await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(onError).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onError);
      expect(process.listeners("unhandledRejection")).toEqual(prior);
    }
  });

  it("unregisters the document on unmount, guarded against a same-id reopen", () => {
    const first = fakeDoc("first");
    const { unmount } = renderHook(() =>
      useVectorGeometryPrefetch(baseArgs({ pdfDoc: first })),
    );
    expect(getPdfDocument("P")).toBe(first);

    // A reopen registers a NEW document before the old viewer's cleanup runs.
    const second = fakeDoc("second");
    renderHook(() => useVectorGeometryPrefetch(baseArgs({ pdfDoc: second })));
    expect(getPdfDocument("P")).toBe(second);

    unmount(); // stale teardown
    expect(getPdfDocument("P")).toBe(second); // survives — the guard held
  });
});
