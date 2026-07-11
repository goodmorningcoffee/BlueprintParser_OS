// @vitest-environment jsdom

// [refactor jul11 P2.2⑧ C3 closer] Invocation-time Textract consumer witnesses.
//
// These handlers intentionally do not subscribe to OCR: users can leave a tool open while a rerun
// replaces the page, then click before React's scheduled cache notification. The click must read the
// new Query value synchronously. Observer-count assertions make the sacred AnnotationOverlay and
// GuidedParseTab render topology explicit; KeynotePanel is allowed exactly its one separate normal
// (render-captured) page observer and no second observer for the guided action.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import { queryKeys } from "@/queries/queryKeys";
import { useUiStore } from "@/stores/uiStore";
import { useViewerStore } from "@/stores/viewerStore";
import type { TextractPageData } from "@/types";

vi.mock("@/lib/ocr-grid-detect", () => ({
  extractCellsFromGrid: vi.fn(),
}));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";
import GuidedParseTab from "../GuidedParseTab";
import KeynotePanel from "../KeynotePanel";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const extractMock = vi.mocked(extractCellsFromGrid);
const fetchMock = vi.fn();
let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function pageData(label: string): TextractPageData {
  return {
    lines: [],
    words: [
      { text: label, confidence: 99, bbox: [0.4, 0.4, 0.2, 0.2] },
    ],
  };
}

function seedTextract(value: TextractPageData) {
  qc.setQueryData(queryKeys.textract.page("P", 1), value);
}

function totalTextractObservers(): number {
  return qc.getQueryCache()
    .findAll({ queryKey: queryKeys.textract.all("P"), exact: false })
    .reduce((total, query) => total + query.getObserversCount(), 0);
}

function noopContext(): CanvasRenderingContext2D {
  const target = {
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => {};
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  qc = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({
    publicId: "P",
    projectId: 41,
    isDemo: true,
    pageNumber: 1,
    numPages: 1,
    mode: "pointer",
  });
  qc.setQueryData(queryKeys.annotations.all("P"), []);
  qc.setQueryData(queryKeys.pagesWindow.active("P"), {
    loadedRange: { from: 1, to: 1 },
    keynotes: {},
    csiCodes: {},
    textAnnotations: {},
    pageIntelligence: {},
  });

  extractMock.mockReset();
  extractMock.mockReturnValue({
    headers: ["Key", "Description"],
    rows: [{ Key: "K1", Description: "live" }],
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected fetch in Textract action-reader freeze: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("I8 live action readers", () => {
  it("AnnotationOverlay mounts zero observers and double-click OCR fallback sees a same-tick replacement", () => {
    seedTextract(pageData("captured-old"));
    const { container } = render(
      <AnnotationOverlay width={100} height={100} cssScale={1} />,
      { wrapper },
    );
    expect(totalTextractObservers()).toBe(0);

    const canvas = container.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });

    // No observer means no render can occur between this synchronous publication and the event.
    // The handler must bridge into Query at invocation time to see `live-word`.
    seedTextract(pageData("live-word"));
    fireEvent.mouseDown(canvas, { clientX: 50, clientY: 50, detail: 2 });
    expect(useUiStore.getState().searchQuery).toBe("live-word");
    expect(totalTextractObservers()).toBe(0);
  });

  it("GuidedParseTab mounts zero observers and Parse Grid consumes the same-tick live words", async () => {
    seedTextract(pageData("captured-old"));
    useViewerStore.setState({
      tableParseRegion: [0, 0, 1, 1],
      guidedParseActive: false,
      guidedParseRows: [],
      guidedParseCols: [],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        proposedRows: [0, 0.5, 1],
        proposedCols: [0, 0.5, 1],
        rowCount: 2,
        colCount: 2,
        confidence: 1,
      }),
    } as unknown as Response);
    const never = new Promise<void>(() => {});
    const detectCsiAndPersist = vi.fn(() => never);

    render(
      <GuidedParseTab
        detectCsiAndPersist={detectCsiAndPersist}
        yoloInTableRegion={[]}
        tagYoloClass={null}
        setTagYoloClass={vi.fn()}
        handleMapTags={vi.fn()}
        tagMappingDone={false}
        tagMappingCount={0}
        setTagMappingDone={vi.fn()}
        mapTagsStrictness="balanced"
        setMapTagsStrictness={vi.fn()}
        drawingNumberPrefixes={[]}
        setDrawingNumberPrefixes={vi.fn()}
        availablePrefixes={[]}
        lastDropCounts={null}
      />,
      { wrapper },
    );
    const parse = await screen.findByRole("button", { name: "Parse Grid" });
    expect(totalTextractObservers()).toBe(0);

    extractMock.mockClear();
    // The publication and native click share one act callback / JavaScript turn. A captured observer
    // value cannot update between them; the imperative bridge can and does see the replacement.
    act(() => {
      seedTextract(pageData("live-guided"));
      (parse as HTMLButtonElement).click();
    });
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(extractMock.mock.calls[0][0][0].text).toBe("live-guided");
    expect(totalTextractObservers()).toBe(0);
  });

  it("Keynote guided parse adds no observer beyond its one normal-page observer and reads live", async () => {
    seedTextract(pageData("captured-old"));
    useViewerStore.setState({
      keynoteParseTab: "guided",
      keynoteParseStep: "idle",
      guidedParseActive: true,
      guidedParseRegion: [0, 0, 1, 1],
      guidedParseRows: [0, 0.5, 1],
      guidedParseCols: [0, 0.5, 1],
    });
    // The guided handler calls CSI detection only after extracting cells. Keep that request pending
    // so the assertion horizon contains no unrelated persistence or map-tags work.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    render(<KeynotePanel embedded />, { wrapper });
    const parse = await screen.findByRole("button", { name: "Parse Keynotes" });
    const current = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("P", 1),
      exact: true,
    });
    expect(current?.getObserversCount()).toBe(1);
    expect(totalTextractObservers()).toBe(1);

    extractMock.mockClear();
    act(() => {
      seedTextract(pageData("live-keynote"));
      (parse as HTMLButtonElement).click();
    });
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(extractMock.mock.calls[0][0][0].text).toBe("live-keynote");
    expect(totalTextractObservers()).toBe(1);

    // The scheduled normal-observer update may now render, but it must never create a second Query
    // observer for the guided handler.
    await waitFor(() => expect(totalTextractObservers()).toBe(1));
  });
});
