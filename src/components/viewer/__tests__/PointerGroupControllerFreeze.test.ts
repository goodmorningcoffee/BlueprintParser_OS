// @vitest-environment jsdom
// Direct post-lift contract for the Pointer/Group mousedown controller. The real-overlay parent
// net remains the integration oracle; this file exposes capability timing, raw candidate inputs,
// local mirror publications, literal claims, and source topology that React cannot observe.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MouseEvent as ReactMouseEvent } from "react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedTakeoff } from "@/test/seed-takeoff";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type {
  ClientAnnotation,
  ClientTakeoffItem,
  KeynoteShapeData,
  PageIntelligence,
  TextractPageData,
  YoloTag,
} from "@/types";

import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import { pointerGroupController } from "../tools/pointerGroup";
import { TOOLS } from "../tools/registry";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

const PUBLIC_ID = "pointer-group-direct";
const PAGE = 1;

function annotation(
  id: number,
  name = `Annotation ${id}`,
  bbox: [number, number, number, number] = [0.2, 0.2, 0.5, 0.7],
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

function areaAnnotation(id = 10): ClientAnnotation {
  return annotation(id, "Area", [0.2, 0.2, 0.5, 0.8], {
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
      holes: [],
      areaSqUnits: 1,
      unit: "SF",
    } as ClientAnnotation["data"],
  });
}

function linearAnnotation(id = 11): ClientAnnotation {
  return annotation(id, "Linear", [0.55, 0.2, 0.9, 0.8], {
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

function takeoffItem(id = 7, name = "Rendered Item"): ClientTakeoffItem {
  return {
    id,
    projectId: 41,
    groupId: null,
    name,
    color: "#ef4444",
    shape: "circle",
    size: 10,
    unit: "EA",
    wasteFactor: 0,
    notes: null,
    createdAt: null,
    updatedAt: null,
  } as unknown as ClientTakeoffItem;
}

function yoloTag(id: string, annotationId: number, pageNumber: number): YoloTag {
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
      bbox: [0.2, 0.2, 0.5, 0.7],
      confidence: 1,
    }],
  } as YoloTag;
}

function toolSnapshot(mode: "pointer" | "group" | "move" | "markup" = "pointer") {
  return { ...useToolStore.getState(), mode, activeTool: null };
}

function mouseEvent(detail = 1, shiftKey = false) {
  const stopPropagation = vi.fn();
  return {
    detail,
    shiftKey,
    metaKey: false,
    ctrlKey: false,
    button: 0,
    stopPropagation,
  } as unknown as ReactMouseEvent & { stopPropagation: typeof stopPropagation };
}

type FixtureOptions = {
  mode?: "pointer" | "group";
  position?: { x: number; y: number };
  annotations?: ClientAnnotation[];
  selectedId?: number | null;
  handled?: boolean;
  beginResult?: boolean;
  yoloTags?: YoloTag[];
  pageKeynotes?: KeynoteShapeData[];
  tableCellStructure?: ToolContext["pointerGroup"] extends infer Pointer
    ? Pointer extends { tableCellStructure: infer Table } ? Table : never
    : never;
  showTableCellStructure?: boolean;
  takeoffItems?: ClientTakeoffItem[];
};

function fixture(options: FixtureOptions = {}) {
  const trace: string[] = [];
  const position = options.position ?? { x: 190, y: 90 };
  const toolAtDown = toolSnapshot(options.mode ?? "pointer");
  const press: ToolPressSnapshot = {
    toolAtDown,
    position,
    publicId: PUBLIC_ID,
    pageNumber: PAGE,
  };
  const selection = {
    selectedId: options.selectedId ?? null,
    setSelectedId: vi.fn((id: number | null) => trace.push(`selected:${String(id)}`)),
    setResizeCorner: vi.fn((corner: string | null) => trace.push(`resize:${String(corner)}`)),
    setDragging: vi.fn((dragging: boolean) => trace.push(`dragging:${String(dragging)}`)),
    deleteSelected: vi.fn(() => trace.push("delete")),
  };
  const annotationDrag = {
    begin: vi.fn(() => {
      trace.push("begin");
      return options.beginResult ?? true;
    }),
    beginBBox: vi.fn(() => true),
  };
  const deferredDrawing = {
    start: vi.fn(() => {
      trace.push("deferred");
      return false;
    }),
  };
  const ui = {
    setSearch: vi.fn((value: string) => trace.push(`search:${value}`)),
    setAnnotationFilter: vi.fn((value: string | null) => trace.push(`annotationFilter:${String(value)}`)),
    setTakeoffFilter: vi.fn((value: number | null) => trace.push(`takeoffFilter:${String(value)}`)),
    setKeynoteFilter: vi.fn(() => trace.push("keynoteFilter")),
    setActiveYoloTagId: vi.fn((value: string | null) => trace.push(`activeTag:${String(value)}`)),
    setYoloTagFilter: vi.fn((value: string | null) => trace.push(`tagFilter:${String(value)}`)),
  };
  const multiSelect = {
    handleAnnotationClick: vi.fn(() => {
      trace.push("multiSelect");
      return { handled: options.handled ?? false };
    }),
    expandSelectionViaGroups: vi.fn(() => trace.push("expand")),
    clearSelection: vi.fn(() => trace.push("clearSelection")),
  };
  const dragUi = {
    setDraggingVertex: vi.fn((handle: { annId: number; idx: number } | null) =>
      trace.push(`vertex:${handle ? `${handle.annId}:${handle.idx}` : "null"}`)),
    setDragOffset: vi.fn((offset: { x: number; y: number }) =>
      trace.push(`offset:${offset.x}:${offset.y}`)),
  };
  const markupEdit = {
    canvasRef: { current: null },
    nameInputRef: { current: null },
    setPendingMarkup: vi.fn(),
    setMarkupName: vi.fn(),
    setMarkupNote: vi.fn(),
    setMarkupCsi: vi.fn(),
    setEditingAnnotationId: vi.fn(),
  };
  const pointerGroup: NonNullable<ToolContext["pointerGroup"]> = {
    queryClient,
    tableCellStructure: options.tableCellStructure ?? null,
    showTableCellStructure: options.showTableCellStructure ?? false,
    toggleCellHighlight: vi.fn(),
    pageKeynotes: options.pageKeynotes ?? [],
    yoloTags: options.yoloTags ?? [],
    multiSelect,
    ui,
    dragUi,
    markupEdit,
  };
  const canAdoptProjectLifecycle = vi.fn(() => true);
  const context: ToolContext = {
    press,
    page: { publicId: PUBLIC_ID, number: PAGE, width: 200, height: 100 },
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle,
    selection,
    annotationDrag,
    pageAnnotations: options.annotations ?? [],
    deferredDrawing,
    takeoffItems: options.takeoffItems ?? [],
    pointerGroup,
  };
  return {
    context,
    selection,
    annotationDrag,
    deferredDrawing,
    pointerGroup,
    multiSelect,
    ui,
    dragUi,
    trace,
  };
}

let queryClient: QueryClient;

beforeEach(() => {
  invalidateToolTailAuthority();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE,
    numPages: 1,
    pageNames: { [PAGE]: "A-101" },
    mode: "pointer",
    activeTool: null,
    searchQuery: "",
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: PAGE, to: PAGE },
  });
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
    lines: [],
    words: [],
  } satisfies TextractPageData);
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("pointerGroup controller identity and capability timing", () => {
  it("is frozen, mousedown-only, and matches exactly null-owner Pointer/Group", () => {
    expect(Object.isFrozen(pointerGroupController)).toBe(true);
    expect(Object.keys(pointerGroupController).sort()).toEqual([
      "kind",
      "matches",
      "onMouseDown",
      "wantsEvents",
    ]);
    for (const mode of ["pointer", "group"] as const) {
      const state = toolSnapshot(mode);
      const press = fixture({ mode }).context.press;
      expect(pointerGroupController.matches(press)).toBe(true);
      expect(pointerGroupController.wantsEvents(state)).toBe(true);
      expect(pointerGroupController.matches({
        ...press,
        toolAtDown: { ...press.toolAtDown, activeTool: { kind: "bucketFill" } },
      })).toBe(false);
      expect(pointerGroupController.wantsEvents({
        ...state,
        activeTool: { kind: "bucketFill" },
      })).toBe(false);
    }
    const move = toolSnapshot("move");
    expect(pointerGroupController.matches({
      ...fixture().context.press,
      toolAtDown: move,
    })).toBe(false);
    expect(pointerGroupController.wantsEvents(move)).toBe(false);
    const markup = toolSnapshot("markup");
    expect(pointerGroupController.matches({
      ...fixture().context.press,
      toolAtDown: markup,
    })).toBe(false);
    expect(pointerGroupController.wantsEvents(markup)).toBe(false);
  });

  it.each(["selection", "pageAnnotations", "pointerGroup"] as const)(
    "fails loudly for missing entry capability %s before invalidation",
    (missing) => {
      const { context } = fixture();
      const token = {};
      claimToolTailAuthority(token);
      const broken = { ...context, [missing]: undefined };

      expect(() => pointerGroupController.onMouseDown(mouseEvent(), broken)).toThrow(
        "pointerGroup controller requires the selection/pageAnnotations/pointerGroup capabilities",
      );
      expect(ownsToolTailAuthority(token)).toBe(true);
    },
  );

  it("claims empty Pointer, invalidates once, and clears local before captured persistent selection", () => {
    const { context, trace } = fixture();
    const token = {};
    claimToolTailAuthority(token);
    const lean = {
      ...context,
      annotationDrag: undefined,
      deferredDrawing: undefined,
      takeoffItems: undefined,
    };
    const event = mouseEvent();

    expect(pointerGroupController.onMouseDown(event, lean)).toBe(true);
    expect(ownsToolTailAuthority(token)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(trace).toEqual(["selected:null", "clearSelection"]);
  });

  it("requires deferredDrawing only on empty Group and ignores its rejection", () => {
    const { context, deferredDrawing, trace } = fixture({ mode: "group" });
    const event = mouseEvent();
    expect(() => pointerGroupController.onMouseDown(event, {
      ...context,
      annotationDrag: undefined,
      deferredDrawing: undefined,
      takeoffItems: undefined,
    })).toThrow("pointerGroup empty Group requires the deferredDrawing capability");

    expect(pointerGroupController.onMouseDown(event, {
      ...context,
      annotationDrag: undefined,
      takeoffItems: undefined,
    })).toBe(true);
    expect(deferredDrawing.start).toHaveBeenCalledWith({ x: 190, y: 90 }, false);
    expect(trace).toEqual(["deferred"]);
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("keeps takeoffItems path-local to an actual detail-2 takeoff hit", () => {
    const other = annotation(20, "Other", [0.2, 0.2, 0.5, 0.7], { source: "shape-parse" });
    const generic = fixture({ annotations: [other], position: { x: 60, y: 40 } });
    expect(pointerGroupController.onMouseDown(mouseEvent(2), {
      ...generic.context,
      takeoffItems: undefined,
    })).toBe(true);

    const takeoff = annotation(21, "Fallback", [0.2, 0.2, 0.5, 0.7], {
      source: "takeoff",
      data: { type: "count-marker", takeoffItemId: 7 },
    });
    const missing = fixture({ annotations: [takeoff], position: { x: 60, y: 40 } });
    expect(() => pointerGroupController.onMouseDown(mouseEvent(2), {
      ...missing.context,
      takeoffItems: undefined,
    })).toThrow("pointerGroup takeoff detail-2 requires the takeoffItems capability");
  });

  it("does not require annotationDrag after a handled generic multi-select hit", () => {
    const row = annotation(22);
    const { context, multiSelect, selection } = fixture({
      annotations: [row],
      position: { x: 60, y: 40 },
      handled: true,
    });
    expect(pointerGroupController.onMouseDown(mouseEvent(), {
      ...context,
      annotationDrag: undefined,
    })).toBe(true);
    expect(multiSelect.handleAnnotationClick).toHaveBeenCalledWith(row.id, expect.anything());
    expect(selection.setSelectedId).not.toHaveBeenCalled();
  });

  it.each(["vertex", "corner", "generic"] as const)(
    "requires annotationDrag only when an actual %s admission is reached",
    (kind) => {
      const row = kind === "vertex" ? areaAnnotation() : annotation(23);
      const { context, selection } = fixture({
        annotations: [row],
        selectedId: kind === "generic" ? null : row.id,
        position: kind === "generic" ? { x: 60, y: 40 } : { x: 40, y: 20 },
      });
      const event = mouseEvent();
      const token = {};
      claimToolTailAuthority(token);
      expect(() => pointerGroupController.onMouseDown(event, {
        ...context,
        annotationDrag: undefined,
      })).toThrow(`pointerGroup ${kind === "corner" ? "corner resize" : `${kind} drag`} requires the annotationDrag capability`);
      expect(ownsToolTailAuthority(token)).toBe(false);
      if (kind === "generic") {
        expect(event.stopPropagation).toHaveBeenCalledTimes(1);
        expect(selection.setSelectedId).toHaveBeenCalledWith(row.id);
      } else {
        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(selection.setSelectedId).not.toHaveBeenCalled();
      }
    },
  );

  it("claims a blank TATR hit and total detail-2 miss without stop or late capabilities", () => {
    const table = {
      pageNumber: PAGE,
      cells: [{ row: 1, col: 2, text: "", bbox: [0.2, 0.2, 0.4, 0.6] }],
    } as NonNullable<NonNullable<ToolContext["pointerGroup"]>["tableCellStructure"]>;
    const tableFixture = fixture({
      position: { x: 60, y: 40 },
      tableCellStructure: table,
      showTableCellStructure: true,
    });
    const tableEvent = mouseEvent();
    expect(pointerGroupController.onMouseDown(tableEvent, {
      ...tableFixture.context,
      annotationDrag: undefined,
      deferredDrawing: undefined,
      takeoffItems: undefined,
    })).toBe(true);
    expect(tableEvent.stopPropagation).not.toHaveBeenCalled();
    expect(tableFixture.ui.setSearch).not.toHaveBeenCalled();

    const toggleFixture = fixture({
      position: { x: 60, y: 40 },
      tableCellStructure: table,
      showTableCellStructure: true,
    });
    const toggleEvent = mouseEvent(2);
    expect(pointerGroupController.onMouseDown(toggleEvent, toggleFixture.context)).toBe(true);
    expect(toggleFixture.pointerGroup.toggleCellHighlight).toHaveBeenCalledWith(1, 2);
    expect(toggleEvent.stopPropagation).not.toHaveBeenCalled();

    const missFixture = fixture({ position: { x: 190, y: 90 } });
    const missEvent = mouseEvent(2);
    expect(pointerGroupController.onMouseDown(missEvent, {
      ...missFixture.context,
      annotationDrag: undefined,
      deferredDrawing: undefined,
      takeoffItems: undefined,
    })).toBe(true);
    expect(missEvent.stopPropagation).not.toHaveBeenCalled();
  });
});

describe("pointerGroup direct mirrors, raw provenance, and timing", () => {
  it("publishes successful area-vertex mirrors after exact admission", () => {
    const area = areaAnnotation();
    const { context, annotationDrag, dragUi, selection, trace } = fixture({
      annotations: [area],
      selectedId: area.id,
      position: { x: 40, y: 20 },
    });
    expect(pointerGroupController.onMouseDown(mouseEvent(), context)).toBe(true);
    expect(annotationDrag.begin).toHaveBeenCalledWith(area, {
      kind: "vertex",
      vertexIndex: 0,
    });
    expect(dragUi.setDraggingVertex).toHaveBeenCalledWith({ annId: area.id, idx: 0 });
    expect(selection.setDragging).toHaveBeenCalledWith(true);
    expect(trace).toEqual(["begin", `vertex:${area.id}:0`, "dragging:true"]);
  });

  it("publishes successful corner mirrors after exact admission", () => {
    const row = annotation(30);
    const { context, annotationDrag, selection, trace } = fixture({
      annotations: [row],
      selectedId: row.id,
      position: { x: 40, y: 20 },
    });
    expect(pointerGroupController.onMouseDown(mouseEvent(), context)).toBe(true);
    expect(annotationDrag.begin).toHaveBeenCalledWith(row, {
      kind: "bbox",
      resizeCorner: "tl",
      dragOffset: { x: 0, y: 0 },
    });
    expect(selection.setResizeCorner).toHaveBeenCalledWith("tl");
    expect(selection.setDragging).toHaveBeenCalledWith(true);
    expect(trace).toEqual(["begin", "resize:tl", "dragging:true"]);
  });

  it("publishes successful generic drag mirrors in legacy order", () => {
    const row = annotation(31);
    const { context, annotationDrag, dragUi, selection, trace } = fixture({
      annotations: [row],
      position: { x: 60, y: 40 },
    });
    expect(pointerGroupController.onMouseDown(mouseEvent(), context)).toBe(true);
    expect(annotationDrag.begin).toHaveBeenCalledWith(row, {
      kind: "bbox",
      resizeCorner: null,
      dragOffset: { x: 20, y: 20 },
    });
    expect(selection.setDragging).toHaveBeenCalledWith(true);
    expect(selection.setResizeCorner).toHaveBeenCalledWith(null);
    expect(dragUi.setDragOffset).toHaveBeenCalledWith({ x: 20, y: 20 });
    expect(trace).toEqual([
      "multiSelect",
      "expand",
      `selected:${row.id}`,
      `search:${row.name}`,
      "begin",
      "dragging:true",
      "resize:null",
      "offset:20:20",
    ]);
  });

  it.each(["vertex", "corner", "generic"] as const)(
    "keeps rejected %s admission terminal without success mirrors",
    (kind) => {
      const row = kind === "vertex" ? areaAnnotation(32) : annotation(33);
      const { context, selection, dragUi } = fixture({
        annotations: [row],
        selectedId: kind === "generic" ? null : row.id,
        position: kind === "generic" ? { x: 60, y: 40 } : { x: 40, y: 20 },
        beginResult: false,
      });
      expect(pointerGroupController.onMouseDown(mouseEvent(), context)).toBe(true);
      expect(selection.setDragging).not.toHaveBeenCalled();
      expect(selection.setResizeCorner).not.toHaveBeenCalled();
      expect(dragUi.setDraggingVertex).not.toHaveBeenCalled();
      expect(dragUi.setDragOffset).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "area", make: () => areaAnnotation(34), position: { x: 50, y: 50 } },
    { label: "linear", make: () => linearAnnotation(35), position: { x: 130, y: 50 } },
  ])("keeps precise $label #10 selection local and outside multi-select/drag", ({ make, position }) => {
    const row = make();
    const { context, selection, multiSelect, annotationDrag, ui } = fixture({
      mode: "group",
      annotations: [row],
      position,
    });
    const event = mouseEvent();
    expect(pointerGroupController.onMouseDown(event, context)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(selection.setSelectedId).toHaveBeenCalledExactlyOnceWith(row.id);
    expect(multiSelect.handleAnnotationClick).not.toHaveBeenCalled();
    expect(annotationDrag.begin).not.toHaveBeenCalled();
    expect(ui.setSearch).not.toHaveBeenCalled();
  });

  it("claims rich pencil/delete zones with handler-time canvas measurement", () => {
    const row = annotation(36, "Rich", [0.2, 0.3, 0.5, 0.8]);
    const canvas = document.createElement("canvas");
    const canvasContext = {
      font: "",
      measureText: vi.fn(() => ({ width: 40 })),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getContext").mockReturnValue(canvasContext);
    const edit = fixture({
      annotations: [row],
      selectedId: row.id,
      position: { x: 88, y: 12 },
    });
    (edit.pointerGroup.markupEdit.canvasRef as { current: HTMLCanvasElement | null }).current = canvas;
    const editEvent = mouseEvent();
    expect(pointerGroupController.onMouseDown(editEvent, edit.context)).toBe(true);
    expect(editEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(edit.pointerGroup.markupEdit.setPendingMarkup).toHaveBeenCalledWith(row.bbox);
    expect(edit.pointerGroup.markupEdit.setEditingAnnotationId).toHaveBeenCalledWith(row.id);
    expect(edit.selection.deleteSelected).not.toHaveBeenCalled();

    const remove = fixture({
      annotations: [row],
      selectedId: row.id,
      position: { x: 104, y: 12 },
    });
    (remove.pointerGroup.markupEdit.canvasRef as { current: HTMLCanvasElement | null }).current = canvas;
    const deleteEvent = mouseEvent();
    expect(pointerGroupController.onMouseDown(deleteEvent, remove.context)).toBe(true);
    expect(deleteEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(remove.selection.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it("claims the first inclusive keynote hit with filter-before-search", () => {
    const first = { shape: "diamond", text: "K-01", bbox: [0.2, 0.2, 0.4, 0.6] } as KeynoteShapeData;
    const second = { shape: "circle", text: "K-02", bbox: [0.2, 0.2, 0.4, 0.6] } as KeynoteShapeData;
    const { context, ui, trace } = fixture({
      position: { x: 40, y: 20 },
      pageKeynotes: [first, second],
    });
    const event = mouseEvent();
    expect(pointerGroupController.onMouseDown(event, context)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ui.setKeynoteFilter).toHaveBeenCalledExactlyOnceWith({
      shape: first.shape,
      text: first.text,
    });
    expect(ui.setSearch).toHaveBeenCalledExactlyOnceWith(first.text);
    expect(trace.slice(-2)).toEqual(["keynoteFilter", `search:${first.text}`]);
  });

  it("skips wrong-page YOLO provenance and selects the first eligible captured tag", () => {
    const row = annotation(40, "YOLO", [0.2, 0.2, 0.5, 0.7], { source: "yolo" });
    const tags = [
      {
        ...yoloTag("split-conjunct-trap", row.id, 2),
        instances: [
          { pageNumber: 2, annotationId: row.id, bbox: row.bbox, confidence: 1 },
          { pageNumber: PAGE, annotationId: 999, bbox: row.bbox, confidence: 1 },
        ],
      } as YoloTag,
      yoloTag("first-current", row.id, PAGE),
      yoloTag("second-current", row.id, PAGE),
    ];
    const { context, ui } = fixture({
      annotations: [row],
      position: { x: 60, y: 40 },
      yoloTags: tags,
    });
    expect(pointerGroupController.onMouseDown(mouseEvent(), context)).toBe(true);
    expect(ui.setActiveYoloTagId).toHaveBeenCalledExactlyOnceWith("first-current");
    expect(ui.setYoloTagFilter).toHaveBeenCalledExactlyOnceWith("first-current");
  });

  it("uses the captured takeoff item instead of a replacement cache row", () => {
    const row = annotation(41, "Fallback", [0.2, 0.2, 0.5, 0.7], {
      source: "takeoff",
      data: { type: "count-marker", takeoffItemId: 7 },
    });
    const { context, ui } = fixture({
      annotations: [row],
      position: { x: 60, y: 40 },
      takeoffItems: [takeoffItem(7, "Rendered Item")],
    });
    seedTakeoff(queryClient, [takeoffItem(7, "Fresh Cache Item")], []);

    expect(pointerGroupController.onMouseDown(mouseEvent(2), context)).toBe(true);
    expect(ui.setSearch).toHaveBeenCalledWith("Rendered Item");
    expect(ui.setTakeoffFilter).toHaveBeenCalledWith(7);
  });

  it("reads handler-time PI and Textract replacements through the dedicated query client", () => {
    const regionFixture = fixture({ position: { x: 60, y: 30 } });
    queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
      ...EMPTY_ACTIVE_PAGE_WINDOW,
      loadedRange: { from: PAGE, to: PAGE },
      pageIntelligence: {
        [PAGE]: {
          parsedRegions: [{ id: "fresh-region", type: "schedule", bbox: [0.3, 0.3, 0.5, 0.7] }],
        } as unknown as PageIntelligence,
      },
    });
    expect(pointerGroupController.onMouseDown(mouseEvent(2), regionFixture.context)).toBe(true);
    expect(useUiStore.getState().focusedParsedRegionId).toBe("fresh-region");

    const ocrFixture = fixture({ position: { x: 60, y: 30 } });
    queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
      ...EMPTY_ACTIVE_PAGE_WINDOW,
      loadedRange: { from: PAGE, to: PAGE },
    });
    queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
      lines: [],
      words: [{ text: "Beta", confidence: 99, bbox: [0.3, 0.3, 0.2, 0.4] }],
    } satisfies TextractPageData);
    useUiStore.setState({ searchQuery: "alpha" });
    expect(pointerGroupController.onMouseDown(mouseEvent(2, true), ocrFixture.context)).toBe(true);
    expect(ocrFixture.ui.setSearch).toHaveBeenCalledWith("alpha Beta");
  });
});

describe("pointerGroup post-lift source topology", () => {
  const AO = readFileSync("src/components/viewer/AnnotationOverlay.tsx", "utf8");
  const POINTER = readFileSync("src/components/viewer/tools/pointerGroup.ts", "utf8");
  const MARKUP = readFileSync("src/components/viewer/tools/markup.ts", "utf8");
  const TYPES = readFileSync("src/components/viewer/tools/types.ts", "utf8");
  const count = (source: string, needle: string): number =>
    source.split(needle).length - 1;

  it("keeps the sole mousedown home, exact registry slot, and forbidden axes absent", () => {
    expect(AO).not.toContain("// Pointer mode (and Group mode");
    expect(AO).not.toContain('from "./hitTest"');
    expect(AO).not.toContain("readPageIntelligence");
    expect(AO).not.toContain("readTextractForPage");
    expect(AO).not.toContain("focusParsedTableRegionInCatalog");
    expect(count(POINTER, "readPageIntelligence")).toBe(2);
    expect(count(POINTER, "readTextractForPage")).toBe(2);
    expect(count(POINTER, "focusParsedTableRegionInCatalog")).toBe(2);
    expect(POINTER).toContain('kind: "pointerGroup"');
    expect(POINTER).not.toContain("preventDefault");
    expect(POINTER).not.toContain("return false;");
    expect(POINTER).not.toMatch(/\bon(?:MouseMove|MouseUp|DblClick|Key|PageChange)\s*:/);
    expect(POINTER).not.toMatch(/queryClient\.(?:setQueryData|setQueriesData|invalidateQueries|fetchQuery|ensureQueryData)/);
    expect(POINTER).not.toContain("useToolStore((");
    expect(TOOLS.map((controller) => controller.kind).slice(-3)).toEqual([
      "parseRect",
      "pointerGroup",
      "markup",
    ]);
    expect(TOOLS).toHaveLength(13);
    expect(TYPES).toContain("readonly pointerGroup?: Readonly<{");
  });

  it("pins the S1-S7 return transposition and retains every shared owner in AO", () => {
    const sections = [
      ["S1", "// TATR cell click:", "// Double-click: universal annotation filter", 1],
      ["S2", "// Double-click: universal annotation filter", "// If an annotation is already selected", 14],
      ["S3", "// If an annotation is already selected", "// Check area polygons first", 6],
      ["S4 area", "// Check area polygons first", "// Check linear polylines", 1],
      ["S4 linear", "// Check linear polylines", "// Check annotations (bbox-based)", 1],
      ["S4 bbox", "// Check annotations (bbox-based)", "// Check keynotes.", 8],
      ["S5", "// Check keynotes.", "// Clicked empty space", 2],
      ["S6/S7", "// Clicked empty space", "  },\n} satisfies ToolController", 2],
    ] as const;
    let previous = -1;
    for (const [label, startAnchor, endAnchor, expectedReturns] of sections) {
      const start = POINTER.indexOf(startAnchor);
      const end = POINTER.indexOf(endAnchor, start + startAnchor.length);
      expect(start, `${label} start`).toBeGreaterThan(previous);
      expect(end, `${label} end`).toBeGreaterThan(start);
      expect(count(POINTER.slice(start, end), "return true;"), label).toBe(expectedReturns);
      previous = start;
    }
    expect(count(POINTER, "return true;")).toBe(35);
    expect(count(POINTER, "event.stopPropagation();")).toBe(11);
    expect(POINTER).not.toContain("return false;");
    expect(POINTER).not.toMatch(/return;\s*$/m);

    for (const owner of [
      "const handleMouseMove = useCallback(",
      "const handleMouseUp = useCallback(",
      "function handleMouseLeave()",
      "multiSelect.finalizeLasso(pageAnnotations, bbox)",
      "const handleDoubleClick = useCallback(",
      "const saveMarkup = useCallback(",
      "<MarkupDialog",
    ]) {
      expect(AO, owner).toContain(owner);
      expect(POINTER, owner).not.toContain(owner);
    }
  });

  it("preserves dependency bytes, K12 provenance, and the measured AO ceiling", () => {
    const callbackStart = AO.indexOf("  const handleMouseDown = useCallback(");
    const callbackEnd = AO.indexOf("\n  );", callbackStart);
    const callback = AO.slice(callbackStart, callbackEnd + "\n  );".length);
    const dependencyStart = callback.lastIndexOf("\n    [") + 1;
    const dependencyEnd = callback.indexOf("]\n  );", dependencyStart) + 2;
    const raw = callback.slice(dependencyStart, dependencyEnd);
    const members = raw.trim().slice(1, -1).split(",").map((value) => value.trim()).filter(Boolean);

    expect(members).toHaveLength(37);
    expect(createHash("md5").update(raw).digest("hex")).toBe(
      "dada8bf65ea7834550cc1e5fc221d5ee",
    );
    expect(POINTER).toContain(
      "d96515838b125e4d20ccca71bc5c5179f5c5f5cfb098de9c297d65d2d4eefa6e",
    );
    expect(POINTER).toContain(
      "fd0b1e5c54a1c808e365ec34b7e15903d5c013f78ac727c69867ea7aac6c2dee",
    );
    expect(Buffer.byteLength(MARKUP, "utf8")).toBe(4_543);
    expect(createHash("sha256").update(MARKUP).digest("hex")).toBe(
      "b73291e6f81070d4d412eed13b329a6b2657d5986af8a3bb301aa92f4c5044d6",
    );
    expect(AO.split("\n").length - 1).toBe(1_924);
  });
});
