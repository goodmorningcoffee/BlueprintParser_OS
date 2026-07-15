// @vitest-environment jsdom

// [refactor jul13 P2.3 AT0] Real component witnesses for two legacy activation-order bugs.
// These tests deliberately enter through the production panel buttons and canvas event handler:
// a store-only assertion would miss the pointer branch that used to swallow tag-add drawing.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { YoloTag } from "@/types";
import DetectionPanel from "../DetectionPanel";
import SymbolSearchPanel from "../SymbolSearchPanel";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "activation-fixture";
const TAG_ID = "tag-fixture";

const tag: YoloTag = {
  id: TAG_ID,
  name: "T-101",
  tagText: "T-101",
  yoloClass: "Door",
  yoloModel: "Fixture Model",
  source: "manual",
  scope: "project",
  instances: [],
};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function noopContext(): CanvasRenderingContext2D {
  const target = { measureText: () => ({ width: 0 }) };
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

function canvasRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 1,
    pageNames: { 1: "A-101" },
    mode: "move",
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
  seedAnnotations(queryClient, []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [tag] });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("panel-to-canvas specialized activation", () => {
  it("keeps Symbol Start active after choosing its base pointer mode", async () => {
    render(<SymbolSearchPanel pdfDoc={null} embedded />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Start — Draw Template" }));

    await waitFor(() => {
      expect(useToolStore.getState().activeTool).toEqual({ kind: "symbolTemplate" });
      expect(screen.getByText(/Crosshair active/)).toBeInTheDocument();
    });
  });

  it("routes Add Missing through tag drawing before the base pointer branch", async () => {
    const { container } = render(
      <>
        <DetectionPanel embedded lockedTab="tags" />
        <AnnotationOverlay width={100} height={100} cssScale={1} />
      </>,
      { wrapper },
    );

    const tagRow = screen.getByText("T-101").parentElement;
    if (!tagRow) throw new Error("Expected production tag row");
    fireEvent.click(within(tagRow).getByRole("button", { name: "▶" }));
    fireEvent.click(await screen.findByRole("button", { name: "+ Add Missing" }));

    expect(useToolStore.getState()).toMatchObject({
      mode: "pointer",
      activeTool: { kind: "tagAdd", tagId: TAG_ID },
    });

    const canvas = await waitFor(() => {
      const candidate = container.querySelector("canvas");
      if (!(candidate instanceof HTMLCanvasElement)) {
        throw new Error("Expected AnnotationOverlay canvas after tag activation");
      }
      return candidate;
    });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    const drawingPublications = { drawing: 0, start: 0, end: 0 };
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state._drawing !== previous._drawing) drawingPublications.drawing += 1;
      if (state._drawStart !== previous._drawStart) drawingPublications.start += 1;
      if (state._drawEnd !== previous._drawEnd) drawingPublications.end += 1;
    });
    act(() => {
      fireEvent.mouseDown(canvas, { clientX: 10, clientY: 20, button: 0 });
    });
    unsubscribe();

    expect(useToolStore.getState()._drawing).toBe(true);
    expect(useToolStore.getState()._drawStart).toEqual({ x: 10, y: 20 });
    expect(useToolStore.getState()._drawEnd).toEqual({ x: 10, y: 20 });
    expect(drawingPublications).toEqual({ drawing: 1, start: 1, end: 1 });
  });

  it("rejects a buffered Symbol done message after the processing Cancel intent", async () => {
    let settleFirstRead: ((value: { done: boolean; value?: Uint8Array }) => void) | undefined;
    const firstRead = new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
      settleFirstRead = resolve;
    });
    const reader = {
      read: vi.fn()
        .mockReturnValueOnce(firstRead)
        .mockResolvedValueOnce({ done: true, value: undefined }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,fixture");
    const pdfDoc = {
      getPage: async () => ({
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: Promise.resolve() }),
      }),
    } as unknown as PDFDocumentProxy;
    useToolStore.setState({
      symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4],
      symbolSearchSourcePage: 1,
    });
    render(<SymbolSearchPanel pdfDoc={pdfDoc} />, { wrapper });

    await screen.findByAltText("Search template");
    fireEvent.click(screen.getByRole("button", { name: "Run Search" }));
    await waitFor(() => expect(useToolStore.getState().symbolSearchLoading).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(useToolStore.getState()).toMatchObject({
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
    });

    await act(async () => {
      settleFirstRead?.({
        done: false,
        value: new TextEncoder().encode(`${JSON.stringify({
          type: "done",
          templateBbox: [0.1, 0.2, 0.3, 0.4],
          sourcePageNumber: 1,
          totalMatches: 1,
          pagesWithMatches: [1],
          matches: [{ id: "stale" }],
          searchedAt: "after-cancel",
        })}\n`),
      });
      await firstRead;
      await Promise.resolve();
    });

    expect(useToolStore.getState()).toMatchObject({
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
      symbolSearchError: null,
    });
  });
});
