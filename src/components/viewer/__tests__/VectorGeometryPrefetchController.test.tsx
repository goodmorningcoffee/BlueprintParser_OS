/**
 * VectorGeometryPrefetchController — the wiring between the viewer and the prefetch hook.
 *
 * The hook itself is exhaustively tested with everything injected
 * (`src/hooks/__tests__/useVectorGeometryPrefetch.test.tsx`). What is only testable HERE is that
 * the controller reads the right things from the right places — a wiring bug would be silent:
 * the tool would simply never prefetch, every click would take the raster path, and no test that
 * exercises the hook directly could notice.
 *
 * The three wires:
 *   `toolArmed`  ← the tool store, via `selectActiveToolKey` (not a whole-`activeTool` selector)
 *   `publicId`   ← the session store's identity projection
 *   `pdfDoc` / `pageNumber` ← PROPS, because PDFViewer owns them
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "pdfjs-dist";
import VectorGeometryPrefetchController from "@/components/viewer/VectorGeometryPrefetchController";
import { useToolStore } from "@/stores/toolStore";
import { useSessionStore } from "@/stores/sessionStore";
import { __resetPdfDocumentRegistry, getPdfDocument } from "@/lib/pdf-document-registry";
import * as cache from "@/queries/pageGeometryCache";

const doc = () => ({ numPages: 3 }) as unknown as PDFDocumentProxy;

let ensureSpy: ReturnType<typeof vi.spyOn>;

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  __resetPdfDocumentRegistry();
  ensureSpy = vi
    .spyOn(cache, "ensurePageGeometry")
    .mockResolvedValue({ status: "unavailable", reason: "no-document" });
  vi.spyOn(cache, "setGeometryProtectedPages").mockImplementation(() => {});
  act(() => {
    useSessionStore.setState({ publicId: "proj-1" });
    useToolStore.setState({ activeTool: null });
  });
  // Default the dev override to a mode that permits prefetching, so the tests below isolate the
  // WIRING rather than re-testing the mode gate (which the hook's own suite covers).
  window.localStorage.setItem("bp.bucketFillMode", "auto");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  act(() => {
    useToolStore.setState({ activeTool: null });
  });
});

describe("VectorGeometryPrefetchController", () => {
  it("renders nothing — it is a lifetime holder, not UI", () => {
    const { container } = render(
      <VectorGeometryPrefetchController pdfDoc={doc()} pageNumber={1} />,
      { wrapper },
    );
    expect(container.innerHTML).toBe("");
  });

  it("registers the document it is handed", async () => {
    const d = doc();
    render(<VectorGeometryPrefetchController pdfDoc={d} pageNumber={1} />, { wrapper });
    await waitFor(() => expect(getPdfDocument("proj-1")).toBe(d));
  });

  it("★ does NOT prefetch while another tool is active", async () => {
    act(() => {
      useToolStore.setState({ activeTool: { kind: "calibration" } as never });
    });
    render(<VectorGeometryPrefetchController pdfDoc={doc()} pageNumber={1} />, { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("★ prefetches the mounted page once the BUCKET FILL tool is armed", async () => {
    render(<VectorGeometryPrefetchController pdfDoc={doc()} pageNumber={2} />, { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(ensureSpy).not.toHaveBeenCalled();

    // Arming is what starts it — this is the wire that matters.
    act(() => {
      useToolStore.setState({ activeTool: { kind: "bucketFill" } as never });
    });
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    expect(ensureSpy.mock.calls[0][1]).toMatchObject({ publicId: "proj-1", pageNumber: 2 });
  });

  it("passes pdf.js OPS down, so the extractor is never called without an opcode table", async () => {
    act(() => {
      useToolStore.setState({ activeTool: { kind: "bucketFill" } as never });
    });
    render(<VectorGeometryPrefetchController pdfDoc={doc()} pageNumber={1} />, { wrapper });
    await waitFor(() => expect(ensureSpy).toHaveBeenCalledTimes(1));
    const args = ensureSpy.mock.calls[0][1] as { ops?: Record<string, number> };
    expect(args.ops).toBeTruthy();
    // A real table, not a placeholder — `constructPath` is the op the extractor switches on.
    expect(typeof args.ops!.constructPath).toBe("number");
  });

  it("does nothing before a document exists", async () => {
    act(() => {
      useToolStore.setState({ activeTool: { kind: "bucketFill" } as never });
    });
    render(<VectorGeometryPrefetchController pdfDoc={null} pageNumber={1} />, { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(getPdfDocument("proj-1")).toBeUndefined();
  });
});
