// @vitest-environment jsdom

// [refactor jul11 P2.2⑧ C3 closer] Real-consumer render/retention witnesses.
//
// The facade tests prove Query mechanics in isolation. These tests deliberately mount the product
// surfaces that make the memory bound visible: PageSidebar's legacy CSI fallback and PDFPage's four
// exact-page OCR observers. A wrong page argument, an N-page observer fan-out, or hoisting either
// PDFPage slot back to a whole-map subscription must fail here even if the generic hook stays green.

import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ensureTextractPage,
  replaceTextractForPage,
} from "@/queries/textractCache";
import { queryKeys } from "@/queries/queryKeys";
import { useViewerStore } from "@/stores/viewerStore";
import type { TextractPageData } from "@/types";

// Keep the two OCR-reading overlays real. The other PDFPage children are unrelated canvas/tool
// domains; replacing them with inert leaves the exact internal Notes/Paragraph slots mounted while
// making this topology test deterministic in jsdom.
vi.mock("../AnnotationOverlay", () => ({ default: () => null }));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../FastManualParseOverlay", () => ({ default: () => null }));
vi.mock("../GuidedParseOverlay", () => ({ default: () => null }));
vi.mock("../KeynoteOverlay", () => ({ default: () => null }));
vi.mock("../ParagraphOverlay", () => ({ default: () => null }));
vi.mock("../ParseRegionLayer", () => ({ default: () => null }));
vi.mock("../ParsedTableCellOverlay", () => ({ default: () => null }));

import PDFPage from "../PDFPage";
import PageSidebar from "../PageSidebar";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function pageData(label: string): TextractPageData {
  return {
    lines: [],
    words: [
      { text: label, confidence: 99, bbox: [0.1, 0.1, 0.1, 0.04] },
    ],
  };
}

function phrasePage(): TextractPageData {
  return {
    lines: [],
    words: [
      { text: "gypsum", confidence: 99, bbox: [0.1, 0.1, 0.1, 0.04] },
      { text: "board", confidence: 99, bbox: [0.21, 0.1, 0.1, 0.04] },
    ],
  };
}

function okJson(body: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function textractQueries(publicId = "P") {
  return qc.getQueryCache().findAll({
    queryKey: queryKeys.textract.all(publicId),
    exact: false,
  });
}

function csiBadge(container: HTMLElement): HTMLElement | undefined {
  const page = container.querySelector<HTMLElement>('[data-page-num="1"]');
  if (!page) return undefined;
  return [...page.querySelectorAll<HTMLElement>("span")].find(
    (node) => node.textContent === "2",
  );
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  qc = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({
    publicId: "P",
    isDemo: false,
    pageNumber: 1,
    numPages: 1,
    pageNames: { 1: "A-1" },
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected fetch in Textract consumer topology: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("I6 PageSidebar bounded legacy CSI fallback", () => {
  it("shows only retained OCR, loses the badge on LRU eviction, and regains it only after revisit", async () => {
    useViewerStore.setState({ activeCsiFilter: "09 29 00" });
    qc.setQueryData(queryKeys.pagesWindow.active("P"), {
      loadedRange: { from: 1, to: 1 },
      keynotes: {},
      csiCodes: {
        1: [
          {
            code: "09 29 00",
            description: "gypsum board",
            trade: "Drywall",
            division: "09",
            // `triggers` intentionally omitted: this is the pre-trigger fallback path whose count
            // is allowed to disappear when its heavyweight OCR page leaves the bounded cache.
          },
        ],
      },
      textAnnotations: {},
      pageIntelligence: {},
    });
    await replaceTextractForPage(qc, "P", 1, phrasePage());

    const { container } = render(<PageSidebar pdfDoc={null} />, { wrapper });
    await waitFor(() => expect(csiBadge(container)).toBeDefined());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(textractQueries().every((query) => query.getObserversCount() === 0)).toBe(true);

    // Page 1 is the oldest of thirteen idle payloads. The 12-page rail must remove the exact Query,
    // and PageSidebar's passive retained-map subscription must remove the fallback badge with it.
    await act(async () => {
      for (let page = 2; page <= 13; page += 1) {
        await replaceTextractForPage(qc, "P", page, pageData(`page-${page}`));
      }
    });
    await waitFor(() => expect(csiBadge(container)).toBeUndefined());
    expect(
      qc.getQueryCache().find({
        queryKey: queryKeys.textract.page("P", 1),
        exact: true,
      }),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(textractQueries().every((query) => query.getObserversCount() === 0)).toBe(true);

    // Navigation/controller revisit is the only recovery path. The passive sidebar itself never
    // fetches or manufactures a page observer.
    fetchMock.mockResolvedValueOnce(okJson({ textractData: phrasePage() }));
    await act(async () => {
      await ensureTextractPage(qc, { publicId: "P", pageNumber: 1 });
    });
    await waitFor(() => expect(csiBadge(container)).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(textractQueries().every((query) => query.getObserversCount() === 0)).toBe(true);
  });
});

describe("I7 PDFPage exact-page render topology", () => {
  it("mounts four current-page observers, ignores adjacent publication, and reacts to current data", async () => {
    useViewerStore.setState({ pageNumber: 7, numPages: 20 });
    let commits = 0;

    render(
      <Profiler id="pdf-page" onRender={() => { commits += 1; }}>
        <PDFPage pdfDoc={null} pageNumber={7} scale={1} containerWidth={900} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());

    const current = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("P", 7),
      exact: true,
    });
    expect(current?.getObserversCount()).toBe(4); // Search + text-annotation + Notes + Paragraph.
    const baseline = commits;

    await act(async () => {
      await replaceTextractForPage(qc, "P", 8, pageData("adjacent"));
      await Promise.resolve();
    });
    expect(commits).toBe(baseline);
    expect(
      qc.getQueryCache().find({
        queryKey: queryKeys.textract.page("P", 8),
        exact: true,
      })?.getObserversCount(),
    ).toBe(0);

    await act(async () => {
      await replaceTextractForPage(qc, "P", 7, pageData("current"));
    });
    await waitFor(() => expect(commits).toBeGreaterThan(baseline));
  });
});
