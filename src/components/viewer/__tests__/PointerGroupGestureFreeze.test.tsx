// @vitest-environment jsdom
//
// [refactor jul19 P3.2] Parent-green executable freeze for the Pointer/Group mousedown board.
// This file landed before tools/pointerGroup.ts existed. Behavior enters through the real
// AnnotationOverlay handler; the final describe now pins the translated POST extraction topology.
// The real-overlay rows remain unchanged from the parent freeze.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { EMPTY_ACTIVE_PAGE_WINDOW, type ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type {
  AnnotationGroup,
  AnnotationGroupMembership,
  ClientAnnotation,
  ClientTakeoffItem,
  KeynoteShapeData,
  PageIntelligence,
  TextractPageData,
  YoloTag,
} from "@/types";
import { TOOLS } from "../tools/registry";

const dragHarness = vi.hoisted(() => {
  type Active = { annotationId: number; operation: unknown };
  const state: {
    accepted: boolean;
    active: Active | null;
  } = { accepted: true, active: null };
  const begin = vi.fn((annotation: { id: number }, operation: unknown) => {
    if (!state.accepted) return false;
    state.active = { annotationId: annotation.id, operation };
    return true;
  });
  const finish = vi.fn(() => {
    state.active = null;
    return true;
  });
  const readActive = vi.fn(() => state.active);
  const schedule = vi.fn();
  return { state, begin, finish, readActive, schedule };
});

vi.mock("../useAnnotationDragMachine", () => ({
  useAnnotationDragMachine: () => ({
    begin: dragHarness.begin,
    finish: dragHarness.finish,
    readActive: dragHarness.readActive,
    schedule: dragHarness.schedule,
  }),
}));
vi.mock("@/lib/bucket-fill-client", () => ({
  clientBucketFill: vi.fn(),
  findPageCanvas: vi.fn(() => null),
}));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));

type DialogProps = {
  isEditing: boolean;
  name: string;
  note: string;
  csiCode: string;
  onCancel: () => void;
};
let dialogProps: DialogProps | null = null;
vi.mock("../MarkupDialog", () => ({
  default: (props: DialogProps) => {
    dialogProps = props;
    return <div data-testid="pointer-rich-markup-dialog" />;
  },
}));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "pointer-group-fixture";
const PAGE = 1;
const WIDTH = 200;
const HEIGHT = 100;

type ActiveTool = ReturnType<typeof useToolStore.getState>["activeTool"];
type TableStructure = NonNullable<
  ReturnType<typeof useParseFlowStore.getState>["tableCellStructure"]
>;

let queryClient: QueryClient;
let measureTextWidth = 40;
let measuredFonts: string[] = [];
let renderCommits = 0;
let getContextSpy: MockInstance;
const parentMouseDown = vi.fn();
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div onMouseDown={parentMouseDown}>{children}</div>
    </QueryClientProvider>
  );
}

function noopContext(): CanvasRenderingContext2D {
  const target = {
    font: "",
    measureText: () => {
      measuredFonts.push(target.font);
      return { width: measureTextWidth };
    },
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

function canvasRect(width = WIDTH, height = HEIGHT): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function annotation(
  id: number,
  name: string,
  bbox: [number, number, number, number],
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber: PAGE,
    name,
    bbox,
    note: null,
    source: "user",
    data: null,
    ...overrides,
  };
}

function areaAnnotation(id = 10, name = "Precise Area"): ClientAnnotation {
  return annotation(id, name, [0.2, 0.2, 0.5, 0.8], {
    source: "takeoff",
    data: {
      type: "area-polygon",
      takeoffItemId: 7,
      color: "#22c55e",
      vertices: [
        { x: 0.2, y: 0.2 },
        { x: 0.5, y: 0.2 },
        { x: 0.5, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
      holes: [{
        vertices: [
          { x: 0.3, y: 0.4 },
          { x: 0.4, y: 0.4 },
          { x: 0.4, y: 0.6 },
          { x: 0.3, y: 0.6 },
        ],
      }],
      areaSqUnits: 1,
      unit: "SF",
    } as ClientAnnotation["data"],
  });
}

function linearAnnotation(id = 11, name = "Precise Line"): ClientAnnotation {
  return annotation(id, name, [0.55, 0.2, 0.9, 0.8], {
    source: "takeoff",
    data: {
      type: "linear-polyline",
      takeoffItemId: 8,
      color: "#3b82f6",
      vertices: [{ x: 0.55, y: 0.5 }, { x: 0.9, y: 0.5 }],
      totalLength: 1,
      unit: "LF",
      segmentLengths: [1],
    } as ClientAnnotation["data"],
  });
}

function group(id = 31): AnnotationGroup {
  return {
    id,
    projectId: 41,
    name: `Group ${id}`,
    csiCode: null,
    notes: null,
    color: "#f97316",
    isActive: true,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
  };
}

function takeoffItem(
  id = 7,
  name = "Captured Door",
  shape = "circle",
): ClientTakeoffItem {
  return {
    id,
    projectId: 41,
    groupId: null,
    name,
    color: "#ef4444",
    shape,
    size: 10,
    unit: "EA",
    wasteFactor: 0,
    notes: null,
    createdAt: null,
    updatedAt: null,
  } as unknown as ClientTakeoffItem;
}

function yoloTag(
  id: string,
  annotationId: number,
  pageNumber = PAGE,
): YoloTag {
  return {
    id,
    name: id,
    tagText: id,
    yoloClass: "door",
    yoloModel: "fixture",
    source: "manual",
    scope: "project",
    instances: [{
      pageNumber,
      annotationId,
      bbox: [0.2, 0.2, 0.4, 0.5],
      confidence: 1,
    }],
  } as YoloTag;
}

function textract(words: TextractPageData["words"] = []): TextractPageData {
  return { lines: [], words };
}

type FixtureOptions = {
  mode?: "pointer" | "group" | "move" | "markup";
  activeTool?: ActiveTool;
  calibrationMode?: ReturnType<typeof useToolStore.getState>["calibrationMode"];
  activeTakeoffItemId?: number | null;
  annotations?: ClientAnnotation[];
  selectedIds?: number[];
  focusId?: number | null;
  groups?: AnnotationGroup[];
  memberships?: AnnotationGroupMembership[];
  takeoffItems?: ClientTakeoffItem[];
  yoloTags?: YoloTag[];
  keynotes?: KeynoteShapeData[];
  pageIntelligence?: PageIntelligence;
  textract?: TextractPageData;
  tableCellStructure?: TableStructure | null;
  showTableCellStructure?: boolean;
};

function activeWindow(options: FixtureOptions): ActivePageWindow {
  return {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: PAGE, to: PAGE },
    keynotes: options.keynotes ? { [PAGE]: options.keynotes } : {},
    pageIntelligence: options.pageIntelligence
      ? { [PAGE]: options.pageIntelligence }
      : {},
  };
}

function seedFixture(options: FixtureOptions = {}): void {
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE,
    numPages: 2,
    pageNames: { 1: "A-101", 2: "A-102" },
    mode: options.mode ?? "pointer",
    activeTool: options.activeTool ?? null,
    calibrationMode: options.calibrationMode ?? "idle",
    activeTakeoffItemId: options.activeTakeoffItemId ?? null,
    selectedAnnotationIds: new Set(options.selectedIds ?? []),
    focusAnnotationId: options.focusId ?? null,
    searchQuery: "",
    activeAnnotationFilter: null,
    activeTakeoffFilter: null,
    activeKeynoteFilter: null,
    activeYoloTagId: null,
    activeYoloTagFilter: null,
    showTextPanel: false,
    showDetections: true,
    textPanelTab: "annotations",
    showTableParsePanel: false,
    focusedParsedRegionId: null,
    tableParseTab: "all",
    tableCellStructure: options.tableCellStructure ?? null,
    showTableCellStructure: options.showTableCellStructure ?? false,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    _mousePos: null,
  });
  seedAnnotations(queryClient, options.annotations ?? []);
  seedAnnotationGroups(
    queryClient,
    options.groups ?? [],
    options.memberships ?? [],
  );
  seedTakeoff(queryClient, options.takeoffItems ?? [], []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, {
    yoloTags: options.yoloTags ?? [],
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), activeWindow(options));
  queryClient.setQueryData(
    queryKeys.textract.page(PUBLIC_ID, PAGE),
    options.textract ?? textract(),
  );
}

async function mountCanvas(width = WIDTH, height = HEIGHT): Promise<HTMLCanvasElement> {
  const { container } = render(
    <Profiler id="pointer-group-overlay" onRender={() => { renderCommits += 1; }}>
      <AnnotationOverlay width={width} height={height} cssScale={1} />
    </Profiler>,
    { wrapper },
  );
  const canvas = await waitFor(() => {
    const candidate = container.querySelector("canvas");
    if (!(candidate instanceof HTMLCanvasElement)) {
      throw new Error("Expected AnnotationOverlay canvas");
    }
    return candidate;
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect(width, height));
  return canvas;
}

type PressOptions = {
  detail?: number;
  button?: number;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

function press(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  options: PressOptions = {},
): MouseEvent {
  const event = createEvent.mouseDown(canvas, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: options.button ?? 0,
    detail: options.detail ?? 1,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
  }) as MouseEvent;
  act(() => {
    fireEvent(canvas, event);
  });
  return event;
}

function move(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
  act(() => {
    fireEvent.mouseMove(canvas, { clientX, clientY, buttons: 1 });
  });
}

function release(canvas: HTMLCanvasElement): void {
  act(() => {
    fireEvent.mouseUp(canvas);
  });
}

function installTailProbe() {
  const token = {};
  const cancelled = vi.fn();
  claimToolTailAuthority(token);
  registerToolTailCancellation(token, cancelled);
  return { token, cancelled };
}

async function expectTailInvalidated(
  probe: ReturnType<typeof installTailProbe>,
  cancellationRuns = true,
): Promise<void> {
  expect(ownsToolTailAuthority(probe.token)).toBe(false);
  await act(async () => {
    await Promise.resolve();
  });
  expect(probe.cancelled).toHaveBeenCalledTimes(cancellationRuns ? 1 : 0);
}

function selectedIds(): number[] {
  return [...useUiStore.getState().selectedAnnotationIds];
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  measureTextWidth = 40;
  measuredFonts = [];
  renderCommits = 0;
  dialogProps = null;
  parentMouseDown.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`Unexpected PointerGroup freeze request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(noopContext());
  dragHarness.state.accepted = true;
  dragHarness.state.active = null;
  dragHarness.begin.mockClear();
  dragHarness.finish.mockClear();
  dragHarness.readActive.mockClear();
  dragHarness.schedule.mockClear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Pointer/Group eligibility, event policy, and TATR priority", () => {
  it("keeps move inert after the retained common invalidation and does not stop/default", async () => {
    seedFixture({
      mode: "move",
      annotations: [annotation(1, "Move must ignore", [0.2, 0.2, 0.4, 0.6])],
      selectedIds: [99],
    });
    const canvas = await mountCanvas();
    const probe = installTailProbe();

    const event = press(canvas, 60, 40);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(selectedIds()).toEqual([99]);
    expect(useToolStore.getState()._drawing).toBe(false);
    expect(dragHarness.begin).not.toHaveBeenCalled();
    await expectTailInvalidated(probe);
  });

  it("lets a calibration-input owner swallow Pointer without entering the common prelude", async () => {
    seedFixture({
      mode: "pointer",
      activeTool: { kind: "calibration" },
      calibrationMode: "input",
      annotations: [annotation(2, "Suppressed", [0.2, 0.2, 0.4, 0.6])],
      selectedIds: [99],
    });
    const canvas = await mountCanvas();
    const probe = installTailProbe();

    const event = press(canvas, 60, 40);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(selectedIds()).toEqual([99]);
    expect(ownsToolTailAuthority(probe.token)).toBe(true);
    expect(probe.cancelled).not.toHaveBeenCalled();
  });

  it("keeps an unresolved eligible-decline takeoff owner out of Pointer", async () => {
    seedFixture({
      mode: "pointer",
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: 404,
      annotations: [annotation(3, "Decline suppresses", [0.2, 0.2, 0.4, 0.6])],
      selectedIds: [99],
    });
    const canvas = await mountCanvas();
    const probe = installTailProbe();

    const event = press(canvas, 60, 40);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(selectedIds()).toEqual([99]);
    expect(ownsToolTailAuthority(probe.token)).toBe(true);
    expect(probe.cancelled).not.toHaveBeenCalled();
  });

  it("admits a non-primary annotation press, stops it, never prevents default, and invalidates", async () => {
    const row = annotation(4, "Right button admitted", [0.2, 0.2, 0.4, 0.6]);
    seedFixture({ annotations: [row] });
    const canvas = await mountCanvas();
    const probe = installTailProbe();

    const event = press(canvas, 60, 40, { button: 2 });

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe(row.name);
    expect(dragHarness.begin).toHaveBeenCalledExactlyOnceWith(row, {
      kind: "bbox",
      resizeCorner: null,
      dragOffset: { x: 20, y: 20 },
    });
    await expectTailInvalidated(probe);
  });

  it("uses the first inclusive anisotropic TATR cell before annotations; exact detail 2 toggles", async () => {
    const behind = annotation(5, "Annotation behind cell", [0.2, 0.2, 0.5, 0.7]);
    const table: TableStructure = {
      pageNumber: PAGE,
      regionBbox: [0.2, 0.2, 0.5, 0.7],
      cells: [
        {
          bbox: [0.2, 0.5, 0.4, 0.6],
          row: 0,
          col: 0,
          rowSpan: 1,
          colSpan: 1,
          type: "body",
          confidence: 1,
          text: "FIRST CELL",
          highlighted: false,
        },
        {
          bbox: [0.2, 0.5, 0.4, 0.6],
          row: 0,
          col: 1,
          rowSpan: 1,
          colSpan: 1,
          type: "body",
          confidence: 1,
          text: "SECOND CELL",
          highlighted: false,
        },
      ],
    };
    seedFixture({
      annotations: [behind],
      tableCellStructure: table,
      showTableCellStructure: true,
    });
    const canvas = await mountCanvas();
    const firstProbe = installTailProbe();

    // x=80 is the inclusive normalized right edge (80/200=.4); y=60 is bottom (.6).
    // A width-for-height mutant computes y=.3 and misses the deliberately narrow [.5,.6] band.
    const single = press(canvas, 80, 60);
    expect(single.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("FIRST CELL");
    expect(dragHarness.begin).not.toHaveBeenCalled();
    await expectTailInvalidated(firstProbe);

    parentMouseDown.mockClear();
    const double = press(canvas, 80, 60, { detail: 2 });
    expect(double.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    const cells = useParseFlowStore.getState().tableCellStructure!.cells;
    expect(cells.map((cell) => cell.highlighted)).toEqual([true, false]);

    parentMouseDown.mockClear();
    act(() => useUiStore.getState().setSearch(""));
    const minEdge = press(canvas, 40, 50); // exact normalized min x=.2, min y=.5
    expect(minEdge.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("FIRST CELL");
  });

  it("treats TATR detail 3 as single-search, never as double-highlight", async () => {
    const table: TableStructure = {
      pageNumber: PAGE,
      regionBbox: [0.2, 0.2, 0.5, 0.7],
      cells: [{
        bbox: [0.2, 0.2, 0.4, 0.6],
        row: 2,
        col: 3,
        rowSpan: 1,
        colSpan: 1,
        type: "body",
        confidence: 1,
        text: "TRIPLE SEARCH",
        highlighted: false,
      }],
    };
    seedFixture({ tableCellStructure: table, showTableCellStructure: true });
    const canvas = await mountCanvas();

    const triple = press(canvas, 60, 40, { detail: 3 });

    expect(triple.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("TRIPLE SEARCH");
    expect(useParseFlowStore.getState().tableCellStructure!.cells[0].highlighted).toBe(false);
  });

  it("makes a first blank TATR cell terminal over later text and an overlapping annotation", async () => {
    const behind = annotation(6, "Must not fall through", [0.2, 0.2, 0.5, 0.7]);
    const cell = (text: string, col: number): TableStructure["cells"][number] => ({
      bbox: [0.2, 0.2, 0.4, 0.6],
      row: 0,
      col,
      rowSpan: 1,
      colSpan: 1,
      type: "body",
      confidence: 1,
      text,
      highlighted: false,
    });
    seedFixture({
      annotations: [behind],
      tableCellStructure: {
        pageNumber: PAGE,
        regionBbox: [0.2, 0.2, 0.5, 0.7],
        cells: [cell("", 0), cell("LATER", 1)],
      },
      showTableCellStructure: true,
    });
    const canvas = await mountCanvas();

    const event = press(canvas, 60, 40);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(dragHarness.begin).not.toHaveBeenCalled();
  });

  it.each([
    { label: "hidden", pageNumber: PAGE, shown: false },
    { label: "wrong-page", pageNumber: 2, shown: true },
  ])("lets a $label TATR structure fall through to the annotation", async ({ pageNumber, shown }) => {
    const behind = annotation(7, "Fallthrough annotation", [0.2, 0.2, 0.5, 0.7]);
    seedFixture({
      annotations: [behind],
      tableCellStructure: {
        pageNumber,
        regionBbox: [0.2, 0.2, 0.5, 0.7],
        cells: [{
          bbox: [0.2, 0.2, 0.4, 0.6],
          row: 0,
          col: 0,
          rowSpan: 1,
          colSpan: 1,
          type: "body",
          confidence: 1,
          text: "SHOULD NOT OWN",
          highlighted: false,
        }],
      },
      showTableCellStructure: shown,
    });
    const canvas = await mountCanvas();

    press(canvas, 60, 40);

    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe(behind.name);
    expect(dragHarness.begin).toHaveBeenCalledTimes(1);
  });
});

describe("Pointer/Group detail-2 annotation and fresh-cache fallbacks", () => {
  it("uses the first captured user annotation and preserves UI publication order", async () => {
    const user = annotation(20, "User First", [0.2, 0.2, 0.5, 0.7], {
      note: "note",
      data: { csiCodes: ["08 11 13"] },
    });
    const behind = annotation(21, "Other Behind", [0.2, 0.2, 0.5, 0.7], {
      source: "shape-parse",
    });
    seedFixture({ annotations: [user, behind] });
    const canvas = await mountCanvas();
    const journal: string[] = [];
    const unsubscribe = useUiStore.subscribe((next, previous) => {
      const keys = [
        "searchQuery",
        "activeAnnotationFilter",
        "activeMarkupId",
        "textPanelTab",
        "showTextPanel",
      ] as const;
      for (const key of keys) {
        if (next[key] !== previous[key]) journal.push(key);
      }
    });

    const event = press(canvas, 60, 40, { detail: 2 });
    unsubscribe();

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(journal).toEqual([
      "searchQuery",
      "activeAnnotationFilter",
      "activeMarkupId",
      "textPanelTab",
      "showTextPanel",
    ]);
    expect(useUiStore.getState()).toMatchObject({
      searchQuery: user.name,
      activeAnnotationFilter: user.name,
      activeMarkupId: user.id,
      textPanelTab: "markups",
      showTextPanel: true,
    });
    expect(dragHarness.begin).not.toHaveBeenCalled();

    parentMouseDown.mockClear();
    press(canvas, 60, 40, { detail: 2 });
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState()).toMatchObject({
      searchQuery: "",
      activeAnnotationFilter: null,
      activeMarkupId: null,
      textPanelTab: "markups",
      showTextPanel: true,
    });
  });

  it("resolves a detail-2 takeoff name from the captured item before the annotation fallback", async () => {
    const row = annotation(22, "Annotation fallback name", [0.2, 0.2, 0.5, 0.7], {
      source: "takeoff",
      data: { type: "count-marker", takeoffItemId: 7, color: "#ef4444" },
    });
    seedFixture({ annotations: [row], takeoffItems: [takeoffItem()] });
    const canvas = await mountCanvas();

    const event = press(canvas, 60, 40, { detail: 2 });

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe("Captured Door");
    expect(useUiStore.getState().activeTakeoffFilter).toBe(7);

    press(canvas, 60, 40, { detail: 2 });
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().activeTakeoffFilter).toBeNull();
  });

  it.each([
    { label: "the item is absent", takeoffItems: [] },
    { label: "the captured item name is empty", takeoffItems: [takeoffItem(404, "")] },
  ])("falls back to the annotation name when $label", async ({ takeoffItems }) => {
    const row = annotation(27, "Missing-item fallback", [0.2, 0.2, 0.5, 0.7], {
      source: "takeoff",
      data: { type: "count-marker", takeoffItemId: 404, color: "#ef4444" },
    });
    seedFixture({ annotations: [row], takeoffItems });
    const canvas = await mountCanvas();

    press(canvas, 60, 40, { detail: 2 });

    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe(row.name);
    expect(useUiStore.getState().activeTakeoffFilter).toBe(404);
  });

  it("uses the render-captured takeoff item when the cache is replaced in the press turn", async () => {
    const row = annotation(28, "Captured-item annotation", [0.2, 0.2, 0.5, 0.7], {
      source: "takeoff",
      data: { type: "count-marker", takeoffItemId: 7, color: "#ef4444" },
    });
    seedFixture({
      annotations: [row],
      takeoffItems: [takeoffItem(7, "Rendered Item")],
    });
    const canvas = await mountCanvas();
    const event = createEvent.mouseDown(canvas, {
      bubbles: true,
      cancelable: true,
      clientX: 60,
      clientY: 40,
      button: 0,
      detail: 2,
    }) as MouseEvent;

    act(() => {
      seedTakeoff(queryClient, [takeoffItem(7, "Fresh Cache Item")], []);
      canvas.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe("Rendered Item");
    expect(useUiStore.getState().activeTakeoffFilter).toBe(7);
  });

  it("keeps detail-2 linear hit shape-exclusive before using the captured takeoff item", async () => {
    const row = linearAnnotation(26, "Linear annotation fallback");
    seedFixture({
      annotations: [row],
      takeoffItems: [takeoffItem(8, "Linear Item", "linear")],
    });
    const canvas = await mountCanvas();

    // Inside stored bbox but 20px from the y=50 segment: detail-2 must not retry bbox.
    const far = press(canvas, 130, 70, { detail: 2 });
    expect(far.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().activeTakeoffFilter).toBeNull();

    parentMouseDown.mockClear();
    const near = press(canvas, 130, 50, { detail: 2 });
    expect(near.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe("Linear Item");
    expect(useUiStore.getState().activeTakeoffFilter).toBe(8);
  });

  it("uses the detail-2 generic-other annotation filter without entering drag", async () => {
    const row = annotation(23, "Other Source", [0.2, 0.2, 0.5, 0.7], {
      source: "shape-parse",
    });
    seedFixture({ annotations: [row] });
    const canvas = await mountCanvas();

    press(canvas, 60, 40, { detail: 2 });

    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe(row.name);
    expect(useUiStore.getState().activeAnnotationFilter).toBe(row.name);
    expect(dragHarness.begin).not.toHaveBeenCalled();

    press(canvas, 60, 40, { detail: 2 });
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().activeAnnotationFilter).toBeNull();
  });

  it("treats annotation detail 3 as single-select/drag rather than detail-2 filtering", async () => {
    const row = annotation(24, "Triple Select", [0.2, 0.2, 0.5, 0.7]);
    seedFixture({ annotations: [row] });
    const canvas = await mountCanvas();

    const event = press(canvas, 60, 40, { detail: 3 });

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe(row.name);
    expect(useUiStore.getState().activeAnnotationFilter).toBeNull();
    expect(useUiStore.getState().showTextPanel).toBe(false);
    expect(dragHarness.begin).toHaveBeenCalledTimes(1);
  });

  it("reads replacement PI before replacement OCR, then applies first-word LTWH Shift toggling", async () => {
    const oldIntel = {
      parsedRegions: [{
        id: "old-miss",
        type: "schedule",
        bbox: [0, 0, 0.1, 0.1],
      }],
    } as unknown as PageIntelligence;
    seedFixture({
      pageIntelligence: oldIntel,
      textract: textract([{ text: "old-miss", confidence: 99, bbox: [0, 0, 0.1, 0.1] }]),
    });
    const canvas = await mountCanvas();
    const commitsBeforeReplacement = renderCommits;
    const oldWindow = queryClient.getQueryData<ActivePageWindow>(
      queryKeys.pagesWindow.active(PUBLIC_ID),
    )!;
    const liveIntel = {
      parsedRegions: [
        { id: "live-non-schedule", type: "room", bbox: [0.3, 0.3, 0.5, 0.7] },
        { id: "live-first", type: "schedule", bbox: [0.3, 0.3, 0.5, 0.7] },
        { id: "live-second", type: "schedule", bbox: [0.3, 0.3, 0.5, 0.7] },
      ],
    } as unknown as PageIntelligence;

    act(() => {
      queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
        ...oldWindow,
        pageIntelligence: { [PAGE]: liveIntel },
      });
    });
    expect(renderCommits).toBe(commitsBeforeReplacement);

    // Both normalized bbox edges are inclusive; the ineligible overlapping room is skipped.
    const regionEvent = press(canvas, 100, 70, { detail: 2 });
    expect(regionEvent.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState()).toMatchObject({
      focusedParsedRegionId: "live-first",
      showTableParsePanel: true,
      searchQuery: "",
    });
    expect(useParseFlowStore.getState().tableParseTab).toBe("all");

    parentMouseDown.mockClear();
    press(canvas, 60, 30, { detail: 2 });
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().focusedParsedRegionId).toBe("live-first");

    parentMouseDown.mockClear();
    const currentWindow = queryClient.getQueryData<ActivePageWindow>(
      queryKeys.pagesWindow.active(PUBLIC_ID),
    )!;
    act(() => {
      queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
        ...currentWindow,
        pageIntelligence: {
          [PAGE]: {
            parsedRegions: [{ id: "new-miss", type: "schedule", bbox: [0, 0, 0.1, 0.1] }],
          } as unknown as PageIntelligence,
        },
      });
      queryClient.setQueryData(
        queryKeys.textract.page(PUBLIC_ID, PAGE),
        textract([
          { text: "Beta", confidence: 99, bbox: [0.3, 0.3, 0.2, 0.4] },
          { text: "Gamma", confidence: 99, bbox: [0.3, 0.3, 0.2, 0.4] },
        ]),
      );
      useUiStore.getState().setSearch("alpha");
    });

    // Add at the inclusive top-left edge, then remove at the inclusive bottom-right edge.
    const add = press(canvas, 60, 30, { detail: 2, shiftKey: true });
    expect(add.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchQuery).toBe("alpha Beta");

    const remove = press(canvas, 100, 70, { detail: 2, shiftKey: true });
    expect(remove.defaultPrevented).toBe(false);
    expect(useUiStore.getState().searchQuery).toBe("alpha");
    const textractObservers = queryClient.getQueryCache()
      .findAll({ queryKey: queryKeys.textract.all(PUBLIC_ID), exact: false })
      .reduce((total, query) => total + query.getObserversCount(), 0);
    expect(textractObservers).toBe(0);
  });

  it("makes a total detail-2 miss terminal without stop/clear and keeps local selection", async () => {
    const selected = annotation(25, "Selected survives miss", [0.1, 0.2, 0.3, 0.6]);
    seedFixture({
      annotations: [selected],
      selectedIds: [99],
      focusId: selected.id,
    });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    const persistentBefore = useUiStore.getState().selectedAnnotationIds;
    const probe = installTailProbe();

    const miss = press(canvas, 190, 90, { detail: 2 });

    expect(miss.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().selectedAnnotationIds).toBe(persistentBefore);
    expect(selectedIds()).toEqual([99]);
    await expectTailInvalidated(probe);

    dragHarness.state.accepted = false;
    parentMouseDown.mockClear();
    press(canvas, 20, 20); // selected tl corner: observable local-id witness
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(dragHarness.begin).toHaveBeenCalledWith(selected, {
      kind: "bbox",
      resizeCorner: "tl",
      dragOffset: { x: 0, y: 0 },
    });
  });
});

describe("Pointer/Group selected controls and rich label", () => {
  it("gives an area vertex priority over the overlapping rich-label band and stops rejection", async () => {
    const area = areaAnnotation(30, "Vertex priority");
    seedFixture({ annotations: [area], focusId: area.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    dragHarness.state.accepted = false;
    const commitsBeforePress = renderCommits;
    getContextSpy.mockClear();
    measuredFonts = [];

    // First vertex is (40,20), also the bbox min corner and label-band bottom edge.
    const event = press(canvas, 40, 20);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(dragHarness.begin).toHaveBeenCalledExactlyOnceWith(area, {
      kind: "vertex",
      vertexIndex: 0,
    });
    expect(dialogProps).toBeNull();
    expect(readSeededAnnotations(queryClient)).toEqual([area]);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(renderCommits).toBe(commitsBeforePress);
    expect(getContextSpy).not.toHaveBeenCalled();
  });

  it("gives tl bbox resize priority over the rich-label band and stops rejection", async () => {
    const box = annotation(31, "Corner priority", [0.2, 0.2, 0.5, 0.8]);
    seedFixture({ annotations: [box], focusId: box.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    dragHarness.state.accepted = false;
    const commitsBeforePress = renderCommits;
    getContextSpy.mockClear();
    measuredFonts = [];

    const event = press(canvas, 40, 20);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(dragHarness.begin).toHaveBeenCalledExactlyOnceWith(box, {
      kind: "bbox",
      resizeCorner: "tl",
      dragOffset: { x: 0, y: 0 },
    });
    expect(dialogProps).toBeNull();
    expect(readSeededAnnotations(queryClient)).toEqual([box]);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(renderCommits).toBe(commitsBeforePress);
    expect(getContextSpy).not.toHaveBeenCalled();
  });

  it("opens the rich user-pencil zone at the inclusive top edge and schedules the exact 50ms attempt", async () => {
    const box = annotation(32, "Rich Edit", [0.2, 0.3, 0.5, 0.8], {
      note: "preserved note",
      data: { csiCodes: ["09 21 16", "tail"] },
    });
    seedFixture({ annotations: [box], focusId: box.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    const timeout = vi.spyOn(globalThis, "setTimeout");
    timeout.mockClear();
    getContextSpy.mockClear();
    measuredFonts = [];

    // ax=40, ay=30, measured text=40: iconStart=88. y=12 is ay-18 exactly.
    const event = press(canvas, 88, 12);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(screen.getByTestId("pointer-rich-markup-dialog")).toBeInTheDocument();
    expect(dialogProps).toMatchObject({
      isEditing: true,
      name: box.name,
      note: box.note,
      csiCode: "09 21 16",
    });
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 50);
    expect(getContextSpy).toHaveBeenCalledWith("2d");
    expect(measuredFonts).toContain("bold 13px sans-serif");
    expect(readSeededAnnotations(queryClient)).toEqual([box]);
  });

  it.each([
    { label: "lower clamp", maxY: 0.4, y: 12, expectedFont: "bold 10px sans-serif" },
    { label: "interior formula", maxY: 0.7, y: 12, expectedFont: "bold 12px sans-serif" },
    { label: "inclusive bottom edge", maxY: 0.8, y: 30, expectedFont: "bold 13px sans-serif" },
  ])("measures the rich label with the $label font", async ({ maxY, y, expectedFont }) => {
    const box = annotation(34, `Font ${maxY}`, [0.2, 0.3, 0.5, maxY]);
    seedFixture({ annotations: [box], focusId: box.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    getContextSpy.mockClear();
    measuredFonts = [];

    press(canvas, 88, y);

    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(screen.getByTestId("pointer-rich-markup-dialog")).toBeInTheDocument();
    expect(getContextSpy).toHaveBeenCalledWith("2d");
    expect(measuredFonts[0]).toBe(expectedFont);
  });

  it("admits the rich-label band's exact left edge without claiming a non-icon press", async () => {
    const box = annotation(35, "Exact label left", [0.2, 0.3, 0.5, 0.8]);
    seedFixture({ annotations: [box], focusId: box.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    getContextSpy.mockClear();
    measuredFonts = [];

    // x=ax exactly enters the measurement band, but remains left of both icons.
    press(canvas, 40, 12);

    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    // One handler measurement plus the redraw caused by clearing local selection.
    expect(getContextSpy).toHaveBeenCalledTimes(2);
    expect(getContextSpy).toHaveBeenCalledWith("2d");
    expect(measuredFonts[0]).toBe("bold 13px sans-serif");
    expect(dialogProps).toBeNull();
    expect(readSeededAnnotations(queryClient)).toEqual([box]);
  });

  it.each([
    { label: "one pixel above", x: 88, y: 11 },
    { label: "one pixel left", x: 39, y: 12 },
  ])("keeps a press $label the rich-label band context-lazy", async ({ x, y }) => {
    const box = annotation(36, "Outside label", [0.2, 0.3, 0.5, 0.8]);
    seedFixture({ annotations: [box], focusId: box.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    getContextSpy.mockClear();
    measuredFonts = [];

    press(canvas, x, y);

    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    // Only the redraw caused by empty-canvas selection clearing may acquire a context.
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(measuredFonts).toEqual(["bold 13px sans-serif"]);
    expect(dialogProps).toBeNull();
    expect(readSeededAnnotations(queryClient)).toEqual([box]);
  });

  it("keeps one pixel below the rich-label band on the generic bbox path", async () => {
    const box = annotation(37, "Below label", [0.2, 0.3, 0.5, 0.8]);
    seedFixture({ annotations: [box], focusId: box.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    getContextSpy.mockClear();
    measuredFonts = [];

    press(canvas, 88, 31);

    expect(parentMouseDown).not.toHaveBeenCalled();
    // Only the accepted generic-selection redraw may acquire a context.
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(measuredFonts).toEqual(["bold 13px sans-serif"]);
    expect(dialogProps).toBeNull();
    expect(dragHarness.begin).toHaveBeenCalledExactlyOnceWith(box, {
      kind: "bbox",
      resizeCorner: null,
      dragOffset: { x: 48, y: 1 },
    });
  });

  it.each([
    { source: "user" as const, x: 104, label: "user after its 16px pencil zone" },
    { source: "shape-parse" as const, x: 88, label: "non-user at iconStart" },
  ])("deletes $label through the component deleteSelected composite", async ({ source, x }) => {
    const box = annotation(33, `Delete ${source}`, [0.2, 0.3, 0.5, 0.8], { source });
    seedFixture({ annotations: [box], focusId: box.id });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());

    const event = press(canvas, x, 12);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(readSeededAnnotations(queryClient)).toEqual([]);
    expect(dialogProps).toBeNull();
  });
});

describe("Pointer/Group single-click order, #10, generic bbox, and keynotes", () => {
  it("keeps overlapping area selection ahead of linear selection", async () => {
    const area = areaAnnotation(38, "Area owns overlap");
    const linear = annotation(39, "Line waits", [0.2, 0.2, 0.5, 0.8], {
      source: "takeoff",
      data: {
        type: "linear-polyline",
        takeoffItemId: 8,
        color: "#3b82f6",
        vertices: [{ x: 0.2, y: 0.5 }, { x: 0.5, y: 0.5 }],
        totalLength: 1,
        unit: "LF",
        segmentLengths: [1],
      } as ClientAnnotation["data"],
    });
    seedFixture({ annotations: [linear, area] });
    const canvas = await mountCanvas();

    // Both precise shapes contain this point. Area owns it regardless of array order.
    press(canvas, 50, 50);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(dragHarness.begin).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(readSeededAnnotations(queryClient)).toEqual([linear]);
  });

  it.each([
    {
      label: "area in Group",
      makeRow: () => areaAnnotation(40, "Area local selection"),
      mode: "group" as const,
      x: 50,
      y: 50,
      modifiers: {},
    },
    {
      label: "linear with Pointer modifier",
      makeRow: () => linearAnnotation(41, "Line local selection"),
      mode: "pointer" as const,
      x: 130,
      y: 50,
      modifiers: { shiftKey: true },
    },
  ])(
    "keeps persistent selection reference exact but observably installs local id for $label",
    async ({ makeRow, mode, x, y, modifiers }) => {
      const row = makeRow();
      seedFixture({ mode, annotations: [row], selectedIds: [99] });
      const canvas = await mountCanvas();
      const persistentBefore = useUiStore.getState().selectedAnnotationIds;

      const event = press(canvas, x, y, modifiers);

      expect(event.defaultPrevented).toBe(false);
      expect(parentMouseDown).not.toHaveBeenCalled();
      expect(useUiStore.getState().selectedAnnotationIds).toBe(persistentBefore);
      expect(selectedIds()).toEqual([99]);
      expect(dragHarness.begin).not.toHaveBeenCalled();

      // Delete depends on local selectedId. Removing exactly this row catches omission of the
      // precise loop's setSelectedId while the exact persistent Set assertion catches routing it
      // through multi-select.
      act(() => {
        fireEvent.keyDown(window, { key: "Delete" });
      });
      expect(readSeededAnnotations(queryClient)).toEqual([]);
    },
  );

  it("lets a generic Group bbox toggle persistent selection and suppresses search/drag", async () => {
    const row = annotation(42, "Generic Group toggle", [0.2, 0.2, 0.5, 0.7], {
      source: "shape-parse",
    });
    seedFixture({ mode: "group", annotations: [row], selectedIds: [99] });
    const canvas = await mountCanvas();

    const event = press(canvas, 60, 40);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(selectedIds()).toEqual([99, row.id]);
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(dragHarness.begin).not.toHaveBeenCalled();
  });

  it("uses the render-captured Pointer multi-select mode when toolAtDown has handed off to Group", async () => {
    const row = annotation(46, "Captured Pointer mode", [0.2, 0.2, 0.5, 0.7], {
      source: "shape-parse",
    });
    seedFixture({ mode: "pointer", annotations: [row], selectedIds: [99] });
    const canvas = await mountCanvas();
    const selectionJournal: number[][] = [];
    const unsubscribe = useUiStore.subscribe((next, previous) => {
      if (next.selectedAnnotationIds !== previous.selectedAnnotationIds) {
        selectionJournal.push([...next.selectedAnnotationIds]);
      }
    });
    const event = createEvent.mouseDown(canvas, {
      bubbles: true,
      cancelable: true,
      clientX: 60,
      clientY: 40,
      button: 0,
      detail: 1,
    }) as MouseEvent;

    // React batches this external-store publication until the act boundary. The handler's fresh
    // toolAtDown snapshot is Group, while its real useMultiSelectInteraction callback is still the
    // render-captured Pointer closure. Reconstructing from toolAtDown would toggle {99,row} and
    // terminate; the captured closure publishes singleton then continues to search/drag.
    act(() => {
      useToolStore.setState({ mode: "group" });
      canvas.dispatchEvent(event);
    });
    unsubscribe();

    expect(useToolStore.getState().mode).toBe("group");
    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(selectionJournal).toEqual([[row.id]]);
    expect(useUiStore.getState().searchQuery).toBe(row.name);
    expect(dragHarness.begin).toHaveBeenCalledExactlyOnceWith(row, {
      kind: "bbox",
      resizeCorner: null,
      dragOffset: { x: 20, y: 20 },
    });
  });

  it("journals singleton then captured-old-set sibling expansion before YOLO move admission", async () => {
    const hit = annotation(43, "Grouped YOLO", [0.2, 0.2, 0.4, 0.6], {
      source: "yolo",
      data: { modelName: "fixture", confidence: 0.99 },
    });
    const sibling = annotation(44, "Sibling", [0.7, 0.2, 0.9, 0.6], {
      source: "shape-parse",
    });
    seedFixture({
      annotations: [hit, sibling],
      selectedIds: [99],
      groups: [group(77)],
      memberships: [
        { annotationId: hit.id, groupId: 77 },
        { annotationId: sibling.id, groupId: 77 },
      ],
      yoloTags: [
        yoloTag("wrong-page", hit.id, 2),
        yoloTag("right-page", hit.id, PAGE),
      ],
    });
    const canvas = await mountCanvas();
    const selectionJournal: number[][] = [];
    const unsubscribe = useUiStore.subscribe((next, previous) => {
      if (next.selectedAnnotationIds !== previous.selectedAnnotationIds) {
        selectionJournal.push([...next.selectedAnnotationIds]);
      }
    });

    const event = press(canvas, 60, 40);
    unsubscribe();

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(selectionJournal).toEqual([
      [hit.id],
      [99, hit.id, sibling.id],
    ]);
    expect(useUiStore.getState()).toMatchObject({
      searchQuery: hit.name,
      activeYoloTagId: "right-page",
      activeYoloTagFilter: "right-page",
    });
    expect(dragHarness.begin).toHaveBeenCalledExactlyOnceWith(hit, {
      kind: "bbox",
      resizeCorner: null,
      dragOffset: { x: 20, y: 20 },
    });
  });

  it("selects the first inclusive keynote only after annotation paths miss", async () => {
    const first: KeynoteShapeData = {
      shape: "diamond",
      text: "K-01",
      bbox: [0.2, 0.2, 0.4, 0.6],
    };
    const second: KeynoteShapeData = {
      shape: "circle",
      text: "K-02",
      bbox: [0.2, 0.2, 0.4, 0.6],
    };
    seedFixture({ keynotes: [first, second] });
    const canvas = await mountCanvas();

    // Inclusive bottom-right edge: x=.4*200=80, y=.6*100=60.
    const event = press(canvas, 80, 60);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeKeynoteFilter).toEqual({
      shape: first.shape,
      text: first.text,
    });
    expect(useUiStore.getState().searchQuery).toBe(first.text);
    expect(dragHarness.begin).not.toHaveBeenCalled();

    parentMouseDown.mockClear();
    // Inclusive top-left edge must select the same first keynote.
    press(canvas, 40, 20);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeKeynoteFilter).toEqual({
      shape: first.shape,
      text: first.text,
    });
  });

  it("keeps an overlapping generic annotation ahead of keynote handling", async () => {
    const row = annotation(45, "Annotation owns", [0.2, 0.2, 0.4, 0.6], {
      source: "shape-parse",
    });
    const keynote: KeynoteShapeData = {
      shape: "circle",
      text: "Must wait",
      bbox: [0.2, 0.2, 0.4, 0.6],
    };
    seedFixture({ annotations: [row], keynotes: [keynote] });
    const canvas = await mountCanvas();

    press(canvas, 60, 40);

    expect(useUiStore.getState().searchQuery).toBe(row.name);
    expect(useUiStore.getState().activeKeynoteFilter).toBeNull();
    expect(dragHarness.begin).toHaveBeenCalledTimes(1);
  });
});

describe("Pointer/Group empty-canvas ownership and shared lasso settlement", () => {
  it("admits a non-primary additive Group lasso, retains local selection, and finalizes intersections", async () => {
    const local = annotation(50, "Local selection", [0.1, 0.1, 0.2, 0.3]);
    const lassoHit = annotation(51, "Lasso hit", [0.6, 0.4, 0.8, 0.8], {
      source: "shape-parse",
    });
    seedFixture({
      mode: "group",
      annotations: [local, lassoHit],
      selectedIds: [99],
      focusId: local.id,
    });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    const probe = installTailProbe();

    const down = press(canvas, 90, 35, { button: 2 });

    expect(down.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useToolStore.getState()._drawing).toBe(true);
    expect(selectedIds()).toEqual([99]);
    // The new drawing lease replaces the cancellation slot before the old queued callback runs;
    // authority loss plus the PRE one-call source pin is the exact observable here.
    await expectTailInvalidated(probe, false);

    move(canvas, 170, 90);
    release(canvas);
    expect(useToolStore.getState()._drawing).toBe(false);
    expect(selectedIds()).toEqual([99, lassoHit.id]);

    // Explicit startDeferredDrawing(pos, false) keeps local selectedId. A default/true call would
    // clear it, so this later selected-corner admission is the discriminating witness.
    dragHarness.state.accepted = false;
    dragHarness.begin.mockClear();
    parentMouseDown.mockClear();
    press(canvas, 20, 10);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(dragHarness.begin).toHaveBeenCalledExactlyOnceWith(local, {
      kind: "bbox",
      resizeCorner: "tl",
      dragOffset: { x: 0, y: 0 },
    });
  });

  it("keeps selection when Group deferred admission rejects after a synchronous mode handoff", async () => {
    const local = annotation(52, "Rejected lasso local", [0.1, 0.1, 0.2, 0.3]);
    seedFixture({
      mode: "group",
      annotations: [local],
      selectedIds: [99],
      focusId: local.id,
    });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    const persistentBefore = useUiStore.getState().selectedAnnotationIds;
    let handedOff = false;
    const unsubscribe = useToolStore.subscribe((next, previous) => {
      if (handedOff || previous._drawing || !next._drawing) return;
      handedOff = true;
      useToolStore.setState({ mode: "pointer" });
    });

    const event = press(canvas, 180, 90);
    unsubscribe();

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(handedOff).toBe(true);
    expect(useToolStore.getState()).toMatchObject({ mode: "pointer", _drawing: false });
    expect(useUiStore.getState().selectedAnnotationIds).toBe(persistentBefore);
    expect(selectedIds()).toEqual([99]);

    dragHarness.state.accepted = false;
    press(canvas, 20, 10);
    expect(dragHarness.begin).toHaveBeenCalledWith(local, {
      kind: "bbox",
      resizeCorner: "tl",
      dragOffset: { x: 0, y: 0 },
    });
  });

  it("empty Pointer clears persistent and local selection in order without stop/default", async () => {
    const local = annotation(53, "Must survive later Delete", [0.1, 0.1, 0.2, 0.3]);
    seedFixture({
      annotations: [local],
      selectedIds: [99],
      focusId: local.id,
    });
    const canvas = await mountCanvas();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    const probe = installTailProbe();

    const event = press(canvas, 190, 90);

    expect(event.defaultPrevented).toBe(false);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(selectedIds()).toEqual([]);
    await expectTailInvalidated(probe);

    // If the first local clear were omitted, Delete would remove `local`; persistent selection is
    // already empty, so its survival isolates the local-owner postcondition.
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(readSeededAnnotations(queryClient)).toEqual([local]);
  });
});

describe("Pointer/Group POST extraction topology", () => {
  const root = process.cwd();
  const aoPath = join(root, "src/components/viewer/AnnotationOverlay.tsx");
  const pointerPath = join(root, "src/components/viewer/tools/pointerGroup.ts");
  const registryPath = join(root, "src/components/viewer/tools/registry.ts");
  const typesPath = join(root, "src/components/viewer/tools/types.ts");
  const markupPath = join(root, "src/components/viewer/tools/markup.ts");
  const AO = readFileSync(aoPath, "utf8");
  const POINTER = readFileSync(pointerPath, "utf8");
  const REGISTRY = readFileSync(registryPath, "utf8");
  const TYPES = readFileSync(typesPath, "utf8");
  const MARKUP = readFileSync(markupPath, "utf8");
  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const sha256 = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const parentProvenance = Object.freeze({
    aoSha256: "d96515838b125e4d20ccca71bc5c5179f5c5f5cfb098de9c297d65d2d4eefa6e",
    sliceBytes: 15_617,
    sliceNewlines: 327,
    sliceSha256: "fd0b1e5c54a1c808e365ec34b7e15903d5c013f78ac727c69867ea7aac6c2dee",
  });

  it("retains exact parent provenance while removing the legacy AO home", () => {
    expect(POINTER).toContain(`Parent provenance: AO SHA-256 ${parentProvenance.aoSha256};`);
    expect(POINTER).toContain(
      `marker slice ${parentProvenance.sliceBytes.toLocaleString("en-US")} bytes / ` +
      `${parentProvenance.sliceNewlines} newlines / SHA-256`,
    );
    expect(POINTER).toContain(`${parentProvenance.sliceSha256}.`);
    expect(existsSync(pointerPath)).toBe(true);
    expect(AO).not.toContain("// Pointer mode (and Group mode");
    expect(AO).not.toContain("// TATR cell click:");
    expect(AO).not.toContain("// Double-click: universal annotation filter");
    expect(AO).toContain(
      "// Pointer/Group mousedown is claimed by pointerGroupController at the registry seam.",
    );
    expect(count(AO, "\n")).toBeLessThan(2_455);
    expect(Buffer.byteLength(POINTER, "utf8")).toBeGreaterThan(parentProvenance.sliceBytes);
  });

  it("pins the controller capability and exact 13-controller destination slot", () => {
    expect(REGISTRY).toContain('from "./pointerGroup"');
    expect(TOOLS.map((controller) => controller.kind)).toEqual([
      "calibration",
      "split",
      "bucketFill",
      "takeoffPolygon",
      "takeoffLinear",
      "takeoffCount",
      "keynotePick",
      "tagPick",
      "symbolSearch",
      "tagAdd",
      "parseRect",
      "pointerGroup",
      "markup",
    ]);
    expect(TOOLS).toHaveLength(13);
    expect(REGISTRY).toContain(
      "    parseRectController,\n    pointerGroupController,\n    markupController,",
    );
    expect(TYPES).toContain('| "pointerGroup"');
    expect(TYPES).toContain("readonly pointerGroup?: Readonly<{");
    const dragStart = TYPES.indexOf("  readonly annotationDrag?: Readonly<{");
    const dragEnd = TYPES.indexOf("  readonly pageAnnotations?", dragStart);
    const dragCapability = TYPES.slice(dragStart, dragEnd);
    expect(dragCapability).toContain("beginBBox:");
    expect(dragCapability).toMatch(/\bbegin:\s*\(/);
    expect(AO).toContain("begin: beginAnnotationDrag,");
    expect(AO).toContain("pointerGroup: {");
  });

  it("pins residual common invalidation and the controller's exact S1-S7 transposition", () => {
    const prelude =
      "      // Every non-null specialized owner suppresses base pointer/group/markup fallthrough.\n" +
      "      if (activeTool !== null) return;\n" +
      "      invalidateToolTailAuthority();\n\n";
    const residual = AO.indexOf(
      "      // Pointer/Group mousedown is claimed by pointerGroupController",
    );
    expect(AO.slice(residual - prelude.length, residual)).toBe(prelude);
    expect(AO.indexOf("dispatchToolMouseDown(TOOLS", 0)).toBeLessThan(residual);
    expect(count(POINTER, "invalidateToolTailAuthority();")).toBe(1);
    expect(POINTER.indexOf("invalidateToolTailAuthority();")).toBeGreaterThan(
      POINTER.indexOf("pointerGroup capabilities"),
    );

    const anchors = [
      "// TATR cell click:",
      "// Double-click: universal annotation filter",
      "// If an annotation is already selected, check corners for resize.",
      "// Check area polygons first (point-in-polygon test).",
      "// Check linear polylines (point-near-line test).",
      "// Check annotations (bbox-based) — select and start drag.",
      "// Check keynotes.",
      "// Clicked empty space — deselect, OR start a lasso in Group mode.",
    ];
    let previous = -1;
    for (const anchor of anchors) {
      const index = POINTER.indexOf(anchor);
      expect(index, anchor).toBeGreaterThan(previous);
      previous = index;
    }
    expect(POINTER).not.toContain("return false;");
  });

  it("pins exact detail, geometry, publication, stop, and empty-press source policies", () => {
    expect(count(POINTER, "event.detail === 2")).toBe(2);
    expect(count(POINTER, "event.stopPropagation();")).toBe(11);
    expect(POINTER).not.toContain("preventDefault");
    expect(POINTER).not.toMatch(/event\.button\s*[!=<]/);
    expect(count(POINTER, "pointInPolygonWithHoles(")).toBe(2);
    expect(count(POINTER, "pointNearPolyline(")).toBe(2);
    expect(count(POINTER, "pointInNormalizedBbox(")).toBe(2);
    expect(count(POINTER, "pointInHandle(")).toBe(2);
    expect(POINTER).toContain("if (!annotationDrag.begin(selectedAnnotation, {");
    expect(POINTER).toContain("dragUi.setDraggingVertex({ annId: selectedAnnotation.id, idx: index });");
    expect(POINTER).toContain("selection.setResizeCorner(key);\n              selection.setDragging(true);");
    expect(POINTER).toContain("const { handled } = multiSelect.handleAnnotationClick(ann.id, event);");
    expect(POINTER).toContain("multiSelect.expandSelectionViaGroups(ann.id);");
    expect(POINTER).toContain("deferredDrawing.start(pos, false);");
    expect(POINTER).toContain(
      "selection.setSelectedId(null);\n    multiSelect.clearSelection();\n    return true;",
    );
    expect(POINTER).toContain(
      "setTimeout(() => markupEdit.nameInputRef.current?.focus(), 50);",
    );
  });

  it("pins raw 37-entry dependencies and retains independent Markup/K12 provenance", () => {
    const callbackStart = AO.indexOf("  const handleMouseDown = useCallback(");
    const callbackEnd = AO.indexOf("\n  );", callbackStart);
    const callback = AO.slice(callbackStart, callbackEnd + "\n  );".length);
    const dependencyStart = callback.lastIndexOf("\n    [") + 1;
    const dependencyEnd = callback.indexOf("]\n  );", dependencyStart) + 2;
    const rawDependencies = callback.slice(dependencyStart, dependencyEnd);
    const members = rawDependencies
      .trim()
      .slice(1, -1)
      .split(",")
      .map((member) => member.trim())
      .filter(Boolean);
    expect(members).toHaveLength(37);
    expect(createHash("md5").update(rawDependencies).digest("hex")).toBe(
      "dada8bf65ea7834550cc1e5fc221d5ee",
    );
    expect(Buffer.byteLength(MARKUP, "utf8")).toBe(4_543);
    expect(sha256(MARKUP)).toBe(
      "b73291e6f81070d4d412eed13b329a6b2657d5986af8a3bb301aa92f4c5044d6",
    );
  });
});
