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
import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useUiStore } from "@/stores/uiStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useViewerCoreStore as useViewerStore } from "@/stores/viewerCoreStore";
import type { TextractPageData } from "@/types";

const paragraphOverlayProbe = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  renders: 0,
}));

// Keep the two OCR-reading overlays real. The other PDFPage children are unrelated canvas/tool
// domains; replacing them with inert leaves the exact internal Notes/Paragraph slots mounted while
// making this topology test deterministic in jsdom.
vi.mock("../AnnotationOverlay", () => ({ default: () => null }));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../FastManualParseOverlay", () => ({ default: () => null }));
vi.mock("../GuidedParseOverlay", () => ({ default: () => null }));
vi.mock("../KeynoteOverlay", () => ({ default: () => null }));
vi.mock("../ParagraphOverlay", () => ({
  default: (props: Record<string, unknown>) => {
    paragraphOverlayProbe.props = props;
    paragraphOverlayProbe.renders += 1;
    return null;
  },
}));
vi.mock("../ParseRegionLayer", () => ({ default: () => null }));
vi.mock("../ParsedTableCellOverlay", () => ({ default: () => null }));

import PDFPage from "../PDFPage";
import PageSidebar from "../PageSidebar";
import {
  invalidateGuidedParseOperations,
  invalidateParagraphParseOperations,
  navigateViewerPage,
  resetProjectData,
  transitionNotesParserMode,
  transitionSpecParserMode,
} from "@/stores/viewerCommands";
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
  paragraphOverlayProbe.props = null;
  paragraphOverlayProbe.renders = 0;
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
    useUiStore.setState({ activeCsiFilter: "09 29 00" });
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
  it("denies stale Paragraph callbacks after core navigation precedes passive listener cleanup", async () => {
    const notesRegion: [number, number, number, number] = [0.1, 0.2, 0.6, 0.7];
    useViewerStore.setState({ numPages: 2 });
    useParseFlowStore.setState({ notesParseRegion: notesRegion });
    expect(transitionNotesParserMode("paragraph", notesRegion)).not.toBeNull();

    render(<PDFPage pdfDoc={null} pageNumber={1} scale={1} containerWidth={900} />, { wrapper });
    await act(async () => Promise.resolve());
    const staleBegin = paragraphOverlayProbe.props?.onWorkspaceEditStart as () => unknown;
    const staleExit = paragraphOverlayProbe.props?.onExit as () => boolean;

    act(() => navigateViewerPage(2));
    expect(useViewerStore.getState().pageNumber).toBe(2);
    const before = useParseFlowStore.getState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);
    try {
      act(() => expect(staleBegin()).toBeNull());
      act(() => expect(staleExit()).toBe(false));
    } finally {
      unsubscribe();
    }

    expect(listener).not.toHaveBeenCalled();
    expect(useParseFlowStore.getState()).toBe(before);
    expect(before.paragraphWorkspaceOwner).toBe("notes");
    expect(before.notesParseRegion).toBe(notesRegion);
  });

  it("renders only the exact Paragraph owner and rejects stale peer exits without dormant commits", async () => {
    const notesRegion: [number, number, number, number] = [0.1, 0.2, 0.6, 0.7];
    const specRegion: [number, number, number, number] = [0.2, 0.3, 0.9, 0.95];
    useParseFlowStore.setState({ notesParseRegion: notesRegion, specParseRegion: specRegion });

    transitionSpecParserMode("paragraph", specRegion);
    transitionNotesParserMode("paragraph", notesRegion);

    render(<PDFPage pdfDoc={null} pageNumber={1} scale={1} containerWidth={900} />, { wrapper });
    await act(async () => Promise.resolve());

    expect(paragraphOverlayProbe.props).toMatchObject({
      active: true,
      outerBbox: notesRegion,
      regionKind: "notes-numbered",
    });
    const staleNotesExit = paragraphOverlayProbe.props?.onExit as () => boolean;
    const ownerBaseline = paragraphOverlayProbe.renders;

    const replacementSpecRegion: [number, number, number, number] = [0.25, 0.35, 0.85, 0.9];
    act(() => useParseFlowStore.setState({ specParseRegion: replacementSpecRegion }));
    expect(paragraphOverlayProbe.renders).toBe(ownerBaseline);

    act(() => {
      const started = useParseFlowStore.getState().beginParseOperation("notes");
      expect(started.status).toBe("started");
      if (started.status === "started") {
        expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
      }
    });
    expect(paragraphOverlayProbe.renders).toBe(ownerBaseline);

    act(() => {
      expect(transitionSpecParserMode("paragraph", replacementSpecRegion)).not.toBeNull();
    });
    expect(paragraphOverlayProbe.props).toMatchObject({
      active: true,
      outerBbox: replacementSpecRegion,
      regionKind: "spec-dense-columns",
    });
    act(() => expect(staleNotesExit()).toBe(false));
    expect(useParseFlowStore.getState().paragraphWorkspaceOwner).toBe("spec");

    const currentSpecExit = paragraphOverlayProbe.props?.onExit as () => boolean;
    act(() => expect(currentSpecExit()).toBe(true));
    expect(useParseFlowStore.getState()).toMatchObject({
      paragraphWorkspaceOwner: null,
      specParseRegion: null,
      notesParseRegion: notesRegion,
    });
    const inactiveBaseline = paragraphOverlayProbe.renders;
    act(() => useParseFlowStore.setState({
      paragraphBatch: [{ id: "dormant", bbox: notesRegion, lines: [], rowText: {} }],
      paragraphClipboard: { colBoundaries: [0.1, 0.5, 0.9], headers: ["Key", "Note"] },
    }));
    expect(paragraphOverlayProbe.renders).toBe(inactiveBaseline);
  });

  it("ignores non-reactive tool authority, activation, and drawing-coordinate publications", async () => {
    // Symbol activation also selects pointer mode. Hold that independent TextAnnotation input
    // constant so this witness measures only the active-tool discriminator/generation boundary.
    useToolStore.setState({ mode: "pointer" });
    let commits = 0;
    render(
      <Profiler id="pdf-page-tool-authority" onRender={() => { commits += 1; }}>
        <PDFPage pdfDoc={null} pageNumber={1} scale={1} containerWidth={900} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());
    const baseline = commits;

    // Global tail authority is deliberately non-reactive. Claiming and invalidating it must not
    // create a PDFPage subscriber edge or commit this viewer-sacred subtree.
    act(() => {
      claimToolTailAuthority({});
      invalidateToolTailAuthority();
    });
    expect(commits).toBe(baseline);

    // Tool activation belongs to the mocked canvas children. PDFPage itself must remain outside
    // both the discriminator and full activation-object subscription topology, including renewal.
    act(() => useToolStore.getState().setSymbolSearchActive(true));
    expect(commits).toBe(baseline);
    act(() => useToolStore.getState().setSymbolSearchActive(true));
    expect(commits).toBe(baseline);

    // DrawingPreviewLayer owns the reactive drawing projection. Its mocked boundary above keeps
    // this witness scoped to PDFPage, which must not subscribe to the moved Tool coordinate.
    const drawEnd = { x: 73, y: 84 };
    act(() => useToolStore.setState({ _drawEnd: drawEnd }));
    expect(useToolStore.getState()._drawEnd).toBe(drawEnd);
    expect(commits).toBe(baseline);
  });

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
    act(() => useParseFlowStore.setState({
      guidedParseOwner: "table",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.2, 0.5, 0.8],
      guidedParseCols: [0.1, 0.4, 0.7],
    }));
    const baseline = commits;

    // With an active owner, begin/finish changes its operation revision twice. Region identity is
    // the rendered gesture generation; PDFPage must not subscribe to the authority registry.
    act(() => {
      const started = useParseFlowStore.getState().beginParseOperation("table");
      expect(started.status).toBe("started");
      if (started.status === "started") {
        expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
      }
    });
    expect(commits).toBe(baseline);

    // A Guided drag publishes operation authority once at mousedown. PDFPage has no operation
    // subscription, so that exact publication must not commit this viewer-sacred subtree.
    act(() => { invalidateGuidedParseOperations(); });
    expect(commits).toBe(baseline);

    // Notes and Spec paragraph gestures revoke both owners of their shared workspace without
    // changing any PDFPage render input. The operation-only publication must stay off this tree.
    act(() => { invalidateParagraphParseOperations(); });
    expect(commits).toBe(baseline);

    // Fast Manual is Notes-owned, so its edit-start publication retains Spec while revoking Notes.
    // It is still operation-only and therefore must not commit PDFPage or its memoized slots.
    act(() => { invalidateParagraphParseOperations("spec"); });
    expect(commits).toBe(baseline);

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
