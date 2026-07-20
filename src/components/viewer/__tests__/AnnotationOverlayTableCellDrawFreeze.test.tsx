// @vitest-environment jsdom
//
// [refactor jul18 P3 draw #5] Behavioral witnesses for the page-aware TATR canvas gates.
// The real DrawingPreviewLayer remains mounted so this suite freezes the complete two-canvas
// fragment reached by a table-cell-only render, not a mocked AnnotationOverlay boundary.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import type { ParseFlowState } from "@/stores/parseFlowStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "tatr-draw-gate-project";
const PROJECT_DB_ID = 1_801;
const WIDTH = 200;
const HEIGHT = 100;
const DPR = 2;

const STRUCTURE: NonNullable<ParseFlowState["tableCellStructure"]> = {
  pageNumber: 1,
  regionBbox: [0, 0, 1, 1],
  cells: [{
    bbox: [0.5, 0.5, 0.75, 0.75],
    row: 0,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    type: "data",
    confidence: 0.99,
    text: "Door",
    highlighted: false,
  }],
};

type CanvasCall = [method: string, ...args: unknown[]];
type CanvasRecord = {
  calls: CanvasCall[];
  context: CanvasRenderingContext2D;
};

let queryClient: QueryClient;
let canvasRecords: WeakMap<HTMLCanvasElement, CanvasRecord>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function createCanvasRecord(): CanvasRecord {
  const calls: CanvasCall[] = [];
  const generatedMethods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    measureText: (text: string) => {
      calls.push(["measureText", text]);
      return { width: 0 };
    },
  };
  const context = new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      let method = generatedMethods.get(property);
      if (!method) {
        method = (...args: unknown[]) => {
          if (typeof property === "string") calls.push([property, ...args]);
        };
        generatedMethods.set(property, method);
      }
      return method;
    },
    set(object, property, value, receiver) {
      return Reflect.set(object, property, value, receiver);
    },
  }) as unknown as CanvasRenderingContext2D;
  return { calls, context };
}

function renderOverlay(): {
  annotationCanvas: HTMLCanvasElement;
  annotationCalls: CanvasCall[];
  previewCanvas: HTMLCanvasElement;
  previewCalls: CanvasCall[];
} {
  const { container } = render(
    <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={1} />,
    { wrapper },
  );
  const canvases = [...container.querySelectorAll("canvas")];
  expect(canvases).toHaveLength(2);
  const [annotationCanvas, previewCanvas] = canvases;
  const annotationRecord = canvasRecords.get(annotationCanvas);
  const previewRecord = canvasRecords.get(previewCanvas);
  if (!annotationRecord || !previewRecord) {
    throw new Error("Expected both overlay canvases to acquire a 2D context");
  }
  return {
    annotationCanvas,
    annotationCalls: annotationRecord.calls,
    previewCanvas,
    previewCalls: previewRecord.calls,
  };
}

function expectCanvasSetup(canvas: HTMLCanvasElement): void {
  expect(canvas.width).toBe(WIDTH * DPR);
  expect(canvas.height).toBe(HEIGHT * DPR);
}

const SETUP_AND_CLEAR: CanvasCall[] = [
  ["setTransform", DPR, 0, 0, DPR, 0, 0],
  ["clearRect", 0, 0, WIDTH, HEIGHT],
];

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasRecords = new WeakMap();
  vi.stubGlobal("devicePixelRatio", DPR);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== "2d") return null;
      let record = canvasRecords.get(this);
      if (!record) {
        record = createCanvasRecord();
        canvasRecords.set(this, record);
      }
      return record.context;
    } as typeof HTMLCanvasElement.prototype.getContext,
  );

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 2,
    mode: "move",
    tempPanMode: false,
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    _mousePos: null,
    polygonDrawingMode: "idle",
    polygonVertices: [],
    selectedAnnotationIds: new Set<number>(),
    hiddenAnnotationIds: new Set<number>(),
    activeTableTagViews: {},
    llmHighlight: null,
    showDetections: false,
    tableCellStructure: null,
    showTableCellStructure: false,
  });
  seedAnnotations(queryClient, []);
  seedAnnotationGroups(queryClient, [], []);
  seedTakeoff(queryClient, [], []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: 1, to: 2 },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay table-cell-only draw reachability", () => {
  it.each(["move", "pointer"] as const)(
    "mounts both canvases and paints a visible same-page structure in %s mode",
    (mode) => {
      setViewerStoreStateForTest({
        mode,
        tableCellStructure: STRUCTURE,
        showTableCellStructure: true,
      });

      const result = renderOverlay();
      expectCanvasSetup(result.annotationCanvas);
      expectCanvasSetup(result.previewCanvas);
      expect(result.annotationCanvas.style.pointerEvents).toBe(
        mode === "pointer" ? "auto" : "none",
      );
      expect(result.previewCanvas.style.pointerEvents).toBe("none");
      expect(result.annotationCalls).toEqual([
        ...SETUP_AND_CLEAR,
        ["fillRect", 100, 50, 50, 25],
        ["strokeRect", 100, 50, 50, 25],
      ]);
      expect(result.previewCalls).toEqual(SETUP_AND_CLEAR);
    },
  );

  it("keeps the registry-eligible canvas mounted while temp pan suppresses its pointer events", () => {
    setViewerStoreStateForTest({
      mode: "pointer",
      tempPanMode: true,
    });

    const result = renderOverlay();
    expectCanvasSetup(result.annotationCanvas);
    expectCanvasSetup(result.previewCanvas);
    expect(result.annotationCanvas.style.pointerEvents).toBe("none");
    expect(result.previewCanvas.style.pointerEvents).toBe("none");
    expect(result.annotationCalls).toEqual(SETUP_AND_CLEAR);
    expect(result.previewCalls).toEqual(SETUP_AND_CLEAR);
  });

  it.each([
    { label: "hidden same-page", pageNumber: 1, visible: false },
    { label: "visible other-page", pageNumber: 2, visible: true },
  ])("does not mount for a $label structure in move mode", ({ pageNumber, visible }) => {
    setViewerStoreStateForTest({
      tableCellStructure: { ...STRUCTURE, pageNumber },
      showTableCellStructure: visible,
    });

    const { container } = render(
      <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={1} />,
      { wrapper },
    );
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("takes the ordinary early exit for an other-page structure in pointer mode", () => {
    const ownKeys = vi.fn(() => [] as ArrayLike<string | symbol>);
    useUiStore.setState({
      activeTableTagViews: new Proxy({}, { ownKeys }),
    });
    setViewerStoreStateForTest({
      mode: "pointer",
      tableCellStructure: { ...STRUCTURE, pageNumber: 2 },
      showTableCellStructure: true,
    });

    const result = renderOverlay();
    expect(ownKeys).toHaveBeenCalledTimes(1);
    expect(result.annotationCalls).toEqual(SETUP_AND_CLEAR);
    expect(result.previewCalls).toEqual(SETUP_AND_CLEAR);
  });

  it("keeps the existing annotation pass ordered before the table-cell pass", () => {
    const annotation: ClientAnnotation = {
      id: 1,
      pageNumber: 1,
      name: "Fixture box",
      bbox: [0.125, 0.25, 0.375, 0.5],
      note: null,
      source: "user",
      data: null,
    };
    seedAnnotations(queryClient, [annotation]);
    setViewerStoreStateForTest({
      tableCellStructure: STRUCTURE,
      showTableCellStructure: true,
    });

    const result = renderOverlay();
    expect(result.annotationCalls).toEqual([
      ...SETUP_AND_CLEAR,
      ["strokeRect", 25, 25, 50, 25],
      ["fillRect", 25, 25, 50, 25],
      ["measureText", "Fixture box"],
      ["fillRect", 25, 11, 6, 14],
      ["fillText", "Fixture box", 28, 21],
      ["fillRect", 100, 50, 50, 25],
      ["strokeRect", 100, 50, 50, 25],
    ]);
    expect(result.previewCalls).toEqual(SETUP_AND_CLEAR);
  });
});
