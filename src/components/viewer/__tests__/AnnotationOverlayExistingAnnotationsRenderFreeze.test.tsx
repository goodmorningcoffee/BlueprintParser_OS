// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the remaining existing-annotation
// paint stage. It locks the mixed annotation/count-marker behavior before one ordered pure-helper
// extraction. The follow-up label-color fix shares one deterministic policy across consumers.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type {
  AreaPolygonData,
  ClientAnnotation,
  ClientTakeoffItem,
  CountMarkerData,
  SymbolSearchResult,
  TakeoffShape,
  YoloTag,
} from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "existing-annotations-render-freeze";
const PROJECT_DB_ID = 1_942;
const WIDTH = 200;
const HEIGHT = 100;
const CSS_SCALE = 2;

type StageTraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown]
  | [kind: "get", property: string];

interface CanvasState {
  readonly dash: readonly number[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: unknown;
  readonly globalAlpha: unknown;
  readonly font: unknown;
}

interface CanvasRecord {
  readonly context: CanvasRenderingContext2D;
  readonly trace: StageTraceEntry[];
  readonly state: () => CanvasState;
  readonly stackDepth: () => number;
}

let queryClient: QueryClient;
let canvasRecords: WeakMap<HTMLCanvasElement, CanvasRecord>;
let stageTrace: StageTraceEntry[];
let selectedIds: TrackedIdSet;
let hiddenItemIds: TrackedIdSet;
let boundaryState: CanvasState | null;
let boundaryStackDepth: number | null;
let latestCanvasState: (() => CanvasState) | null;
let latestStackDepth: (() => number) | null;
let markerSizeReads: number;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

class TrackedIdSet extends Set<number> {
  constructor(
    values: readonly number[],
    private readonly channel: "selection" | "hidden",
  ) {
    super(values);
  }

  override has(value: number): boolean {
    const expectedReceiver = this.channel === "selection" ? selectedIds : hiddenItemIds;
    stageTrace.push(["call", `${this.channel}.has`, value, this === expectedReceiver]);
    return super.has(value);
  }

  override *[Symbol.iterator](): SetIterator<number> {
    const expectedReceiver = this.channel === "selection" ? selectedIds : hiddenItemIds;
    for (const value of super.values()) {
      stageTrace.push(["call", `${this.channel}.iterate`, value, this === expectedReceiver]);
      yield value;
    }
  }
}

const MEASURED_WIDTHS: Readonly<Record<string, number>> = {
  "User Selected": 24,
  "Matched YOLO": 28,
  "ACTIVE TAG": 30,
  "Takeoff Selected": 33,
  "Area Selected": 27,
  "Plain User": 21,
};

function createCanvasRecord(): CanvasRecord {
  const trace = stageTrace;
  let dash = [9, 3];
  const stack: Array<{
    dash: number[];
    fillStyle: unknown;
    strokeStyle: unknown;
    lineWidth: unknown;
    globalAlpha: unknown;
    font: unknown;
  }> = [];
  const generatedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
  };
  const state = (): CanvasState => ({
    dash: [...dash],
    fillStyle: target.fillStyle,
    strokeStyle: target.strokeStyle,
    lineWidth: target.lineWidth,
    globalAlpha: target.globalAlpha,
    font: target.font,
  });
  const context = new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (typeof property !== "string") return undefined;
      if (property === "measureText") trace.push(["get", "ctx.measureText"]);
      let method = generatedMethods.get(property);
      if (!method) {
        method = (...args: unknown[]) => {
          trace.push(["call", property, ...args]);
          if (property === "save") {
            stack.push({
              dash: [...dash],
              fillStyle: target.fillStyle,
              strokeStyle: target.strokeStyle,
              lineWidth: target.lineWidth,
              globalAlpha: target.globalAlpha,
              font: target.font,
            });
          } else if (property === "restore") {
            const restored = stack.pop();
            if (!restored) throw new Error("Unbalanced canvas restore");
            dash = restored.dash;
            target.fillStyle = restored.fillStyle;
            target.strokeStyle = restored.strokeStyle;
            target.lineWidth = restored.lineWidth;
            target.globalAlpha = restored.globalAlpha;
            target.font = restored.font;
          } else if (property === "setLineDash") {
            dash = [...(args[0] as number[])];
          } else if (property === "measureText") {
            return { width: MEASURED_WIDTHS[String(args[0])] ?? 10 };
          }
          return undefined;
        };
        generatedMethods.set(property, method);
      }
      return method;
    },
    set(object, property, value, receiver) {
      if (typeof property === "string") trace.push(["set", property, value]);
      return Reflect.set(object, property, value, receiver);
    },
  }) as unknown as CanvasRenderingContext2D;
  latestCanvasState = state;
  latestStackDepth = () => stack.length;
  return { context, trace, state, stackDepth: () => stack.length };
}

function annotation(
  id: number,
  name: string,
  bbox: ClientAnnotation["bbox"],
  source: ClientAnnotation["source"],
  data: unknown = null,
): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name,
    bbox,
    note: null,
    source,
    data: data as ClientAnnotation["data"],
  };
}

function countData(
  marker: string,
  shape: TakeoffShape,
  color: string,
  itemId: number | string = "7",
): CountMarkerData {
  return {
    type: "count-marker",
    shape,
    color,
    get takeoffItemId(): number {
      stageTrace.push(["get", `${marker}.itemId`]);
      return itemId as number;
    },
  };
}

function takeoffItemFixtures(): ClientTakeoffItem[] {
  const markerSizes = [8, 0, 12, 10, -4];
  const decoy = {
    get id(): number {
      stageTrace.push(["get", "decoy.id"]);
      return 900;
    },
    name: "Decoy",
    shape: "circle",
    color: "#999999",
    size: 99,
    sortOrder: 0,
    groupId: null,
  } satisfies ClientTakeoffItem;
  const live = {
    get id(): number {
      stageTrace.push(["get", "live.id"]);
      return 7;
    },
    name: "Live marker",
    shape: "circle",
    color: "#111111",
    get size(): number {
      stageTrace.push(["get", "live.size"]);
      const value = markerSizes[markerSizeReads];
      markerSizeReads += 1;
      if (value === undefined) throw new Error("Unexpected live marker-size read");
      return value;
    },
    sortOrder: 1,
    groupId: null,
  } satisfies ClientTakeoffItem;
  const duplicate = {
    get id(): number {
      stageTrace.push(["get", "duplicate.id"]);
      return "7" as unknown as number;
    },
    name: "Normalized duplicate",
    shape: "circle",
    color: "#222222",
    get size(): number {
      stageTrace.push(["get", "duplicate.size"]);
      return 100;
    },
    sortOrder: 2,
    groupId: null,
  } satisfies ClientTakeoffItem;
  return [decoy, live, duplicate];
}

function activeTag(): YoloTag {
  type TagInstance = YoloTag["instances"][number];
  const sentinel: TagInstance = {
    pageNumber: 1,
    annotationId: -1,
    get bbox() {
      boundaryState = latestCanvasState?.() ?? null;
      boundaryStackDepth = latestStackDepth?.() ?? null;
      stageTrace.push(["get", "sentinel.bbox"]);
      return [0.9, 0.9, 0.95, 0.95] as [number, number, number, number];
    },
    confidence: 1,
    confidenceTier: "high",
  };
  return {
    id: "active",
    name: "ACTIVE TAG",
    tagText: "ACTIVE TEXT",
    yoloClass: "fixture",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    color: "#0ea5e9",
    instances: [
      {
        pageNumber: 1,
        annotationId: 301,
        bbox: [0.6, 0.1, 0.75, 0.4],
        confidence: 1,
        confidenceTier: "high",
      },
      sentinel,
    ],
  };
}

function emptySymbolResults(): SymbolSearchResult {
  return {
    templateBbox: [0, 0, 0.1, 0.1],
    sourcePageNumber: 1,
    matches: [],
    totalMatches: 0,
    pagesWithMatches: [],
    searchedAt: "2026-07-19T00:00:00.000Z",
  };
}

function lookupTrace(marker: string, initializesIndexes: boolean): StageTraceEntry[] {
  return [
    ["get", `${marker}.itemId`],
    ...(initializesIndexes ? [
      ["call", "hidden.iterate", 999, true],
      ["get", "decoy.id"],
      ["get", "live.id"],
      ["get", "duplicate.id"],
    ] as StageTraceEntry[] : []),
  ];
}

function countMarkerTrace({
  marker,
  shape,
  color,
  cx,
  cy,
  radius,
  selected,
  inheritedAlpha = 1,
  initializesIndexes = false,
}: {
  marker: string;
  shape: TakeoffShape;
  color: string;
  cx: number;
  cy: number;
  radius: number;
  selected: boolean;
  inheritedAlpha?: number;
  initializesIndexes?: boolean;
}): StageTraceEntry[] {
  const dark = {
    "#ff0000": "rgb(178, 0, 0)",
    "#00ff00": "rgb(0, 178, 0)",
    "#0000ff": "rgb(0, 0, 178)",
    "#abcdef": "rgb(119, 143, 167)",
    "#123456": "rgb(12, 36, 60)",
  }[color];
  if (!dark) throw new Error(`Missing expected dark color for ${color}`);
  const path: StageTraceEntry[] = [];
  if (shape === "circle") {
    path.push(["call", "arc", cx, cy, radius, 0, Math.PI * 2]);
  } else if (shape === "square") {
    path.push(["call", "rect", cx - radius, cy - radius, radius * 2, radius * 2]);
  } else if (shape === "diamond") {
    path.push(
      ["call", "moveTo", cx, cy - radius],
      ["call", "lineTo", cx + radius, cy],
      ["call", "lineTo", cx, cy + radius],
      ["call", "lineTo", cx - radius, cy],
      ["call", "closePath"],
    );
  } else if (shape === "triangle") {
    path.push(
      ["call", "moveTo", cx, cy - radius],
      ["call", "lineTo", cx + radius, cy + radius],
      ["call", "lineTo", cx - radius, cy + radius],
      ["call", "closePath"],
    );
  } else {
    const arm = radius * 0.35;
    path.push(
      ["call", "moveTo", cx - arm, cy - radius],
      ["call", "lineTo", cx + arm, cy - radius],
      ["call", "lineTo", cx + arm, cy - arm],
      ["call", "lineTo", cx + radius, cy - arm],
      ["call", "lineTo", cx + radius, cy + arm],
      ["call", "lineTo", cx + arm, cy + arm],
      ["call", "lineTo", cx + arm, cy + radius],
      ["call", "lineTo", cx - arm, cy + radius],
      ["call", "lineTo", cx - arm, cy + arm],
      ["call", "lineTo", cx - radius, cy + arm],
      ["call", "lineTo", cx - radius, cy - arm],
      ["call", "lineTo", cx - arm, cy - arm],
      ["call", "closePath"],
    );
  }
  return [
    ...lookupTrace(marker, initializesIndexes),
    ["call", "selection.has", Number(marker.slice(1)), true],
    ["get", "live.size"],
    ["call", "save"],
    ["set", "fillStyle", color],
    ["set", "strokeStyle", dark],
    ["set", "lineWidth", selected ? 3 : 1.5],
    ["call", "beginPath"],
    ...path,
    ["set", "globalAlpha", inheritedAlpha * 0.8],
    ["call", "fill"],
    ["set", "globalAlpha", inheritedAlpha],
    ["call", "stroke"],
    ...(selected ? [
      ["set", "strokeStyle", "#ffffff"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "arc", cx, cy, radius + 2, 0, Math.PI * 2],
      ["call", "stroke"],
    ] as StageTraceEntry[] : []),
    ["call", "restore"],
  ];
}

function boxPaintTrace({
  id,
  name,
  color,
  x,
  y,
  width,
  height,
  fontSize,
  textWidth,
  selected,
  user,
}: {
  id: number;
  name: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  textWidth: number;
  selected: boolean;
  user: boolean;
}): StageTraceEntry[] {
  const extraWidth = selected ? (user ? 36 : 20) : 6;
  const trace: StageTraceEntry[] = [
    ["set", "globalAlpha", 0.25],
    ["set", "strokeStyle", color],
    ["call", "selection.has", id, true],
    ["set", "lineWidth", selected ? 3 : 2],
    ["call", "strokeRect", x, y, width, height],
    ["set", "fillStyle", `${color}15`],
    ["call", "fillRect", x, y, width, height],
    ["set", "font", `bold ${fontSize}px sans-serif`],
    ["get", "ctx.measureText"],
    ["call", "measureText", name],
    ["call", "selection.has", id, true],
    ["set", "fillStyle", "rgba(0,0,0,0.75)"],
    ["call", "fillRect", x, y - fontSize - 4, textWidth + extraWidth, fontSize + 4],
    ["set", "fillStyle", color],
    ["call", "fillText", name, x + 3, y - 4],
  ];
  if (selected) {
    let iconX = x + textWidth + 8;
    if (user) {
      trace.push(
        ["set", "fillStyle", "#60a5fa"],
        ["set", "font", `${fontSize}px sans-serif`],
        ["call", "fillText", "\u270E", iconX, y - 4],
      );
      iconX += 16;
    }
    trace.push(
      ["set", "fillStyle", "#ff4444"],
      ["set", "font", `bold ${fontSize}px sans-serif`],
      ["call", "fillText", "x", iconX, y - 4],
      ["set", "fillStyle", color],
      ["call", "fillRect", x - 3, y - 3, 6, 6],
      ["call", "fillRect", x + width - 3, y - 3, 6, 6],
      ["call", "fillRect", x - 3, y + height - 3, 6, 6],
      ["call", "fillRect", x + width - 3, y + height - 3, 6, 6],
    );
  }
  trace.push(["set", "globalAlpha", 1]);
  return trace;
}

function activeMatchTrace(): StageTraceEntry[] {
  return [
    ["set", "fillStyle", "#ff00ff40"],
    ["call", "fillRect", 120, 10, 30.000000000000004, 30.000000000000004],
    ["set", "strokeStyle", "#0ea5e9"],
    ["set", "lineWidth", 3],
    ["call", "strokeRect", 120, 10, 30.000000000000004, 30.000000000000004],
    ["set", "font", "bold 10px sans-serif"],
    ["get", "ctx.measureText"],
    ["call", "measureText", "Matched YOLO"],
    ["call", "selection.has", 301, true],
    ["set", "fillStyle", "rgba(0,0,0,0.75)"],
    ["call", "fillRect", 120, -4, 34, 14],
    ["set", "fillStyle", "#aaffc3"],
    ["call", "fillText", "Matched YOLO", 123, 6],
    ["set", "globalAlpha", 1],
    ["set", "font", "bold 11px sans-serif"],
    ["get", "ctx.measureText"],
    ["call", "measureText", "ACTIVE TAG"],
    ["set", "fillStyle", "#0ea5e9dd"],
    ["call", "fillRect", 120, 41, 36, 14],
    ["set", "fillStyle", "#000"],
    ["call", "fillText", "ACTIVE TAG", 123, 52],
    ["set", "globalAlpha", 1],
  ];
}

function selectedAreaTrace(): StageTraceEntry[] {
  return [
    ["set", "globalAlpha", 0.25],
    ["set", "font", "bold 10px sans-serif"],
    ["get", "ctx.measureText"],
    ["call", "measureText", "Area Selected"],
    ["call", "selection.has", 203, true],
    ["set", "fillStyle", "rgba(0,0,0,0.75)"],
    ["call", "fillRect", 60, 46, 47, 14],
    ["set", "fillStyle", "#000080"],
    ["call", "fillText", "Area Selected", 63, 56],
    ["set", "fillStyle", "#ff4444"],
    ["set", "font", "bold 10px sans-serif"],
    ["call", "fillText", "x", 95, 56],
    ["set", "globalAlpha", 1],
  ];
}

function lastIndexOfCall(trace: StageTraceEntry[], method: string): number {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (entry[0] === "call" && entry[1] === method) return index;
  }
  return -1;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasRecords = new WeakMap();
  stageTrace = [];
  selectedIds = new TrackedIdSet([105, 201, 202, 203], "selection");
  hiddenItemIds = new TrackedIdSet([999], "hidden");
  boundaryState = null;
  boundaryStackDepth = null;
  latestCanvasState = null;
  latestStackDepth = null;
  markerSizeReads = 0;
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("fetch", vi.fn((url: unknown) => {
    throw new Error(`Unexpected fetch in existing-annotation render freeze: ${String(url)}`);
  }));
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
    mode: "pointer",
    tempPanMode: false,
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    _mousePos: null,
    selectedAnnotationIds: selectedIds,
    hiddenAnnotationIds: new Set<number>(),
    hiddenTakeoffItemIds: hiddenItemIds,
    activeYoloTagId: "active",
    yoloTagVisibility: {},
    activeTableTagViews: {},
    llmHighlight: null,
    showDetections: true,
    tableCellStructure: null,
    showTableCellStructure: false,
    symbolSearchResults: emptySymbolResults(),
  });

  const areaData: AreaPolygonData = {
    type: "area-polygon",
    takeoffItemId: 88,
    color: "#f97316",
    vertices: [{ x: 0.3, y: 0.6 }, { x: 0.5, y: 0.6 }, { x: 0.4, y: 0.9 }],
    areaSqUnits: 0,
    unit: "SF",
  };
  seedAnnotations(queryClient, [
    annotation(101, "CIRCLE", [-0.1, 0.1, 0.1, 0.3], "takeoff", countData("m101", "circle", "#ff0000")),
    annotation(201, "User Selected", [0.1, 0.1, 0.3, 0.6], "user"),
    annotation(102, "HIDDEN", [0.2, 0.2, 0.3, 0.3], "takeoff", countData("m102", "square", "#fedcba", "999")),
    annotation(103, "SQUARE", [0.4, 0.1, 0.5, 0.3], "takeoff", countData("m103", "square", "#00ff00")),
    annotation(301, "Matched YOLO", [0.6, 0.1, 0.75, 0.4], "yolo", { confidence: 0.99 }),
    annotation(104, "DIAMOND", [0.1, 0.6, 0.3, 0.8], "takeoff", countData("m104", "diamond", "#0000ff")),
    annotation(302, "Skipped YOLO", [0.01, 0.01, 0.02, 0.02], "yolo", { confidence: 0.99 }),
    annotation(202, "Takeoff Selected", [0.8, 0.8, 0.7, 0.6], "takeoff", { type: "other" }),
    annotation(106, "TRIANGLE", [0.5, 0.5, 0.7, 0.7], "takeoff", countData("m106", "triangle", "#abcdef")),
    annotation(203, "Area Selected", [0.3, 0.6, 0.5, 0.9], "takeoff", areaData),
    annotation(105, "CROSS", [0.8, 0.2, 1, 0.4], "takeoff", countData("m105", "cross", "#123456")),
    annotation(204, "Plain User", [0.05, 0.75, 0.2, 0.85], "user"),
  ]);
  seedAnnotationGroups(queryClient, [], []);
  seedTakeoff(queryClient, takeoffItemFixtures(), []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [activeTag()] });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: 1, to: 2 },
  });
  stageTrace.length = 0;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay existing-annotation render freeze", () => {
  it("keeps mixed source order, lazy normalized count lookup, selection, active/symbol behavior, geometry, and leakage", async () => {
    const getQueryDataSpy = vi.spyOn(queryClient, "getQueryData");
    const { container } = render(
      <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={CSS_SCALE} />,
      { wrapper },
    );
    const canvas = await waitFor(() => {
      const candidate = container.querySelector("canvas");
      if (!(candidate instanceof HTMLCanvasElement)) {
        throw new Error("Expected AnnotationOverlay canvas");
      }
      return candidate;
    });
    const record = canvasRecords.get(canvas);
    if (!record) throw new Error("Expected AnnotationOverlay to acquire a 2D context");

    await waitFor(() => expect(boundaryState).not.toBeNull());
    const clearIndex = lastIndexOfCall(record.trace, "clearRect");
    expect(clearIndex).toBeGreaterThan(-1);
    const latest = record.trace.slice(clearIndex + 1);
    const boundaryIndex = latest.findIndex((entry) =>
      entry[0] === "get" && entry[1] === "sentinel.bbox"
    );
    expect(boundaryIndex).toBeGreaterThan(-1);
    const existingStage = latest.slice(0, boundaryIndex);

    expect(existingStage).toEqual([
      ...countMarkerTrace({ marker: "m101", shape: "circle", color: "#ff0000", cx: 0, cy: 20, radius: 4, selected: false, inheritedAlpha: 0.37, initializesIndexes: true }),
      ...boxPaintTrace({ id: 201, name: "User Selected", color: "#f58231", x: 20, y: 10, width: 40, height: 50, fontSize: 13, textWidth: 24, selected: true, user: true }),
      ["get", "m102.itemId"],
      ...countMarkerTrace({ marker: "m103", shape: "square", color: "#00ff00", cx: 90, cy: 20, radius: 5, selected: false }),
      ...activeMatchTrace(),
      ...countMarkerTrace({ marker: "m104", shape: "diamond", color: "#0000ff", cx: 40, cy: 70, radius: 6, selected: false }),
      ...boxPaintTrace({ id: 202, name: "Takeoff Selected", color: "#f032e6", x: 160, y: 80, width: -20.000000000000018, height: -20.000000000000007, fontSize: 10, textWidth: 33, selected: true, user: false }),
      ...countMarkerTrace({ marker: "m106", shape: "triangle", color: "#abcdef", cx: 120, cy: 60, radius: 5, selected: false }),
      ...selectedAreaTrace(),
      ...countMarkerTrace({ marker: "m105", shape: "cross", color: "#123456", cx: 180, cy: 30.000000000000004, radius: -2, selected: true }),
      ...boxPaintTrace({ id: 204, name: "Plain User", color: "#aaffc3", x: 10, y: 75, width: 30.000000000000004, height: 9.999999999999998, fontSize: 10, textWidth: 21, selected: false, user: true }),
    ]);
    const takeoffItemsKey = queryKeys.takeoff.items(PUBLIC_ID);
    expect(getQueryDataSpy.mock.calls.filter(([key]) =>
      JSON.stringify(key) === JSON.stringify(takeoffItemsKey)
    )).toHaveLength(1);
    expect(markerSizeReads).toBe(5);
    expect(existingStage.filter((entry) => entry[0] === "call" && entry[1] === "hidden.iterate")).toEqual([
      ["call", "hidden.iterate", 999, true],
    ]);
    expect(existingStage.filter((entry) =>
      entry[0] === "get" && ["decoy.id", "live.id", "duplicate.id"].includes(entry[1])
    )).toEqual([
      ["get", "decoy.id"],
      ["get", "live.id"],
      ["get", "duplicate.id"],
    ]);
    expect(existingStage.filter((entry) => entry[0] === "get" && entry[1] === "live.size")).toHaveLength(5);
    expect(existingStage).not.toContainEqual(["get", "duplicate.size"]);
    expect(existingStage).not.toContainEqual(["call", "selection.has", 102, true]);
    expect(boundaryStackDepth).toBe(0);
    expect(boundaryState).toEqual({
      dash: [9, 3],
      fillStyle: "#aaffc3",
      strokeStyle: "#aaffc3",
      lineWidth: 2,
      globalAlpha: 1,
      font: "bold 10px sans-serif",
    });
    expect(existingStage.filter((entry) => entry[0] === "call" && entry[1] === "save")).toHaveLength(5);
    expect(existingStage.filter((entry) => entry[0] === "call" && entry[1] === "restore")).toHaveLength(5);
    expect(existingStage.some((entry) => entry[0] === "call" && entry[1] === "rect" && entry[2] === 15)).toBe(false);

    expect(latest.slice(boundaryIndex, boundaryIndex + 13)).toEqual([
      ["get", "sentinel.bbox"],
      ["set", "fillStyle", "#ff00ff40"],
      ["call", "fillRect", 180, 90, 9.999999999999986, 4.999999999999993],
      ["set", "strokeStyle", "#0ea5e9"],
      ["set", "lineWidth", 3],
      ["call", "strokeRect", 180, 90, 9.999999999999986, 4.999999999999993],
      ["set", "font", "bold 11px sans-serif"],
      ["get", "ctx.measureText"],
      ["call", "measureText", "ACTIVE TAG"],
      ["set", "fillStyle", "#0ea5e9dd"],
      ["call", "fillRect", 180, 96, 36, 14],
      ["set", "fillStyle", "#000"],
      ["call", "fillText", "ACTIVE TAG", 183, 107],
    ]);
    expect(record.stackDepth()).toBe(0);
  });

  it("dims ordinary rows for a strict non-null symbol sentinel without an active tag", async () => {
    setViewerStoreStateForTest({ activeYoloTagId: null });
    const { container } = render(
      <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={CSS_SCALE} />,
      { wrapper },
    );
    const canvas = await waitFor(() => {
      const candidate = container.querySelector("canvas");
      if (!(candidate instanceof HTMLCanvasElement)) {
        throw new Error("Expected AnnotationOverlay canvas");
      }
      return candidate;
    });
    const record = canvasRecords.get(canvas);
    if (!record) throw new Error("Expected AnnotationOverlay to acquire a 2D context");

    await waitFor(() => expect(record.trace).toContainEqual([
      "call",
      "selection.has",
      201,
      true,
    ]));
    const clearIndex = lastIndexOfCall(record.trace, "clearRect");
    expect(clearIndex).toBeGreaterThan(-1);
    const latest = record.trace.slice(clearIndex + 1);
    const ordinaryStroke = latest.findIndex((entry) =>
      entry[0] === "set" && entry[1] === "strokeStyle" && entry[2] === "#f58231"
    );
    expect(ordinaryStroke).toBeGreaterThan(0);
    expect(latest[ordinaryStroke - 1]).toEqual(["set", "globalAlpha", 0.25]);
  });
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function exactSlice(source: string, start: string, end: string): string {
  expect(count(source, start)).toBe(1);
  expect(count(source, end)).toBe(1);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const EXISTING_ANNOTATIONS = readFileSync(
  join(process.cwd(), "src/components/viewer/render/existingAnnotations.ts"),
  "utf8",
);
const LABEL_COLOR_POLICY = readFileSync(
  join(process.cwd(), "src/lib/annotation-label-color.ts"),
  "utf8",
);
const DARK_COLOR_START = "function darkenOpaqueHexColor(color: string): string {\n";
const RENDER_ID_KEY_START = "function renderIdKey(id: unknown): string {\n";
const COUNT_START = "function drawCountMarker(\n";
const HELPER_RENDER_HEADER = "/**\n * Draw existing count markers or bbox/label annotations in source-row order.\n";
const EXISTING_HEADER = "    // Draw existing annotations\n";
const ACTIVE_HEADER =
  "    // ─── Draw free-floating active tag instances (annotationId = -1, not in annotation loop) ───\n";
const VISIBLE_HEADER =
  "    // ─── Draw visible tag instances (not the active tag) ───\n";

function expectPostMoveOrder(source: string): void {
  const precompute = source.indexOf("    // ─── YOLO Tag highlighting: compute which annotations");
  const existing = source.indexOf(EXISTING_HEADER, precompute);
  const existingCall = source.indexOf("drawExistingAnnotations(ctx, {", existing);
  const active = source.indexOf(ACTIVE_HEADER, existingCall);
  const activeCall = source.indexOf("drawActiveTagInstances(ctx, {", active);
  const visible = source.indexOf(VISIBLE_HEADER, activeCall);
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
    visible,
  );
  expect(precompute).toBeGreaterThan(-1);
  expect(existing).toBeGreaterThan(precompute);
  expect(existingCall).toBeGreaterThan(existing);
  expect(active).toBeGreaterThan(existingCall);
  expect(activeCall).toBeGreaterThan(active);
  expect(visible).toBeGreaterThan(activeCall);
  expect(dependencies).toBeGreaterThan(visible);
}

describe("AnnotationOverlay existing-annotation post-move topology", () => {
  it("pins AO, shared label policy, helper import/body, ordered call, and dependencies", () => {
    expect(count(AO, "\n")).toBe(1_571);
    expect(Buffer.byteLength(AO, "utf8")).toBe(67_479);
    expect(sha256(AO)).toBe(
      "a24444efebcd341a89b2f54afc74f465f1e8ce0126a1c27ee33af0e34ad9c3b4",
    );

    const helperImport =
      'import { drawExistingAnnotations } from "./render/existingAnnotations";\n';
    expect(count(AO, helperImport)).toBe(1);
    expect(Buffer.byteLength(helperImport, "utf8")).toBe(72);
    expect(sha256(helperImport)).toBe(
      "d7e86e808d0b09a887cf53677600b2929b9dfe846697af373e622275697d4621",
    );

    const labelPolicyImport =
      'import { annotationLabelColor as labelColor } from "@/lib/annotation-label-color";\n';
    expect(count(AO, labelPolicyImport)).toBe(1);
    expect(count(LABEL_COLOR_POLICY, "\n")).toBe(9);
    expect(Buffer.byteLength(LABEL_COLOR_POLICY, "utf8")).toBe(288);
    expect(sha256(LABEL_COLOR_POLICY)).toBe(
      "5d0932d56d74e94209b15526e179e1f6f1dba50c3664b65c9f3c5b2a16f607ac",
    );

    const darkColor = exactSlice(EXISTING_ANNOTATIONS, DARK_COLOR_START, RENDER_ID_KEY_START);
    expect(count(darkColor, "\n")).toBe(11);
    expect(Buffer.byteLength(darkColor, "utf8")).toBe(467);
    expect(sha256(darkColor)).toBe(
      "72d670e3dafd5cf8590a242d4f14b53ada6a28930e03f4df31ff3f99a0bb9ec2",
    );

    const renderIdKey = exactSlice(EXISTING_ANNOTATIONS, RENDER_ID_KEY_START, COUNT_START);
    expect(count(renderIdKey, "\n")).toBe(4);
    expect(Buffer.byteLength(renderIdKey, "utf8")).toBe(68);
    expect(sha256(renderIdKey)).toBe(
      "a242de00784f250e4485f7c35442225b312d5e9c4408b7a3aaf7303998ce4f0f",
    );
    expect(renderIdKey).toBe(
      "function renderIdKey(id: unknown): string {\n  return String(id);\n}\n\n",
    );

    const countMarker = exactSlice(EXISTING_ANNOTATIONS, COUNT_START, HELPER_RENDER_HEADER);
    expect(count(countMarker, "\n")).toBe(75);
    expect(Buffer.byteLength(countMarker, "utf8")).toBe(2_098);
    expect(sha256(countMarker)).toBe(
      "4593e70f0730f3be3c21d8f1ff35adb2767615e097424542ed210c9e2a3765aa",
    );

    const activeSupport = exactSlice(
      AO,
      "    // ─── YOLO Tag highlighting: compute which annotations are tag instances on this page ───\n",
      "    // Visible tags: collect all visible tag instances on this page (only if explicitly toggled on)\n",
    );
    expect(count(activeSupport, "\n")).toBe(9);
    expect(Buffer.byteLength(activeSupport, "utf8")).toBe(454);
    expect(sha256(activeSupport)).toBe(
      "9e237853c2caf5d5acc74b0fba073e8747f790908ee8bef2c9887ed7bc8d9918",
    );

    const stage = exactSlice(AO, EXISTING_HEADER, ACTIVE_HEADER);
    expect(count(stage, "\n")).toBe(16);
    expect(Buffer.byteLength(stage, "utf8")).toBe(417);
    expect(sha256(stage)).toBe(
      "2422f753908674c7df08da0eda338df772b825cffceceea815cc1b98750ad80c",
    );

    expect(count(EXISTING_ANNOTATIONS, "\n")).toBe(278);
    expect(Buffer.byteLength(EXISTING_ANNOTATIONS, "utf8")).toBe(10_166);
    expect(sha256(EXISTING_ANNOTATIONS)).toBe(
      "81e940c35a5331fb04bf4589a47ac8a17d3057bd9574b1bef2b89faf2cbb5abf",
    );

    const dependencies = exactSlice(
      AO,
      "  }, [pageAnnotations, width, height, selectedId",
      "\n\n  const getPos",
    );
    expect(Buffer.byteLength(dependencies, "utf8")).toBe(292);
    expect(sha256(dependencies)).toBe(
      "d202ed55c17f2ca65dcd43c3d4bb01b2588776589fa4ff415688f5b10b93d948",
    );
    expect(dependencies).toContain("hiddenTakeoffItemIds");
    expect(dependencies).not.toContain("takeoffItems");
  });

  it("keeps the five shapes, lazy bridge/normalized first-wins lookup, selection order, and biting stage order", () => {
    expectPostMoveOrder(AO);
    const countMarker = exactSlice(EXISTING_ANNOTATIONS, COUNT_START, HELPER_RENDER_HEADER);
    const stage = exactSlice(AO, EXISTING_HEADER, ACTIVE_HEADER);

    expect(AO).not.toMatch(/labelColorMap|function labelColor\(|TWENTY_COLORS/);
    expect(LABEL_COLOR_POLICY).toContain(
      "TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length]",
    );
    expect(count(AO, COUNT_START.trim())).toBe(0);
    expect(count(EXISTING_ANNOTATIONS, COUNT_START.trim())).toBe(1);
    expect(count(EXISTING_ANNOTATIONS, DARK_COLOR_START.trim())).toBe(1);
    expect(count(EXISTING_ANNOTATIONS, RENDER_ID_KEY_START.trim())).toBe(1);
    expect(EXISTING_ANNOTATIONS).not.toContain("export function renderIdKey");
    expect(count(stage, "drawExistingAnnotations(ctx, {")).toBe(1);
    expect(stage).toContain("annotations: pageAnnotations,");
    expect(stage).toContain("selection: multiSelect,");
    expect(stage).toContain("activeTagAnnotationIds: activeTagAnnIds,");
    expect(stage).toContain("getLabelColor: labelColor,");
    expect(stage).toContain("getTakeoffItems: () => readTakeoffItems(qc, publicId),");
    expect(count(EXISTING_ANNOTATIONS, "for (const ann of annotations)")).toBe(1);
    expect(count(EXISTING_ANNOTATIONS, "drawCountMarker(ctx, ann, width, height")).toBe(1);
    expect(count(EXISTING_ANNOTATIONS, "const color = getLabelColor(ann.name);")).toBe(1);
    expect(count(EXISTING_ANNOTATIONS, "getTakeoffItems()")).toBe(1);
    expect(count(EXISTING_ANNOTATIONS, "renderIdKey(")).toBe(4);
    expect(EXISTING_ANNOTATIONS).toContain("ctx.fillStyle = data.color;");
    expect(EXISTING_ANNOTATIONS).toContain("ctx.strokeStyle = darkenOpaqueHexColor(data.color);");
    expect(EXISTING_ANNOTATIONS).toContain("ctx.globalAlpha = inheritedGlobalAlpha * 0.8;");
    expect(EXISTING_ANNOTATIONS).not.toContain('data.color + "cc"');
    expect(EXISTING_ANNOTATIONS).toContain("const itemKey = renderIdKey(itemId);");
    expect(EXISTING_ANNOTATIONS).toContain("for (const hiddenId of hiddenTakeoffItemIds)");
    expect(EXISTING_ANNOTATIONS).toContain("keys.add(renderIdKey(hiddenId));");
    expect(EXISTING_ANNOTATIONS).toContain("if (hiddenTakeoffItemKeys.has(itemKey)) continue;");
    expect(EXISTING_ANNOTATIONS).toContain("const index = new Map<string, TakeoffItemRenderData>();");
    expect(EXISTING_ANNOTATIONS).toContain("for (const takeoffItem of getTakeoffItems())");
    expect(EXISTING_ANNOTATIONS).toContain("const key = renderIdKey(takeoffItem.id);");
    expect(EXISTING_ANNOTATIONS).toContain("if (!index.has(key)) index.set(key, takeoffItem);");
    expect(EXISTING_ANNOTATIONS).toContain("const item = takeoffItemsById.get(itemKey);");
    expect(EXISTING_ANNOTATIONS).not.toContain("hiddenTakeoffItemIds.has(");
    expect(EXISTING_ANNOTATIONS).not.toContain(".find((t)");
    expect(EXISTING_ANNOTATIONS).toContain("ann.id === selectedId || selection.isSelected(ann.id)");
    expect(EXISTING_ANNOTATIONS).toContain("const [minX, minY, maxX, maxY] = ann.bbox;");
    expect(EXISTING_ANNOTATIONS).toContain("const w = (maxX - minX) * width;");
    expect(EXISTING_ANNOTATIONS).toContain("activeTag && ann.source === \"yolo\" && !isTagMatch");
    expect(EXISTING_ANNOTATIONS).toContain("symbolSearchResults !== null");
    expect(EXISTING_ANNOTATIONS).toContain("if (!isAreaPolygon)");
    expect(EXISTING_ANNOTATIONS).toContain('const isUserSource = ann.source === "user";');
    for (const shape of ["circle", "square", "diamond", "triangle", "cross"]) {
      expect(count(countMarker, `case "${shape}"`)).toBe(1);
    }
    expect(count(countMarker, "ctx.save();")).toBe(1);
    expect(count(countMarker, "ctx.restore();")).toBe(1);
    expect(count(countMarker, "const r = (markerSize || 10) / (cssScale || 1);")).toBe(1);

    expect(EXISTING_ANNOTATIONS).not.toMatch(
      /@\/(stores|queries)|fetch\(|persist|from "react"|labelColorMap/i,
    );
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/existingAnnotations.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/existingAnnotations.test.ts",
    ))).toBe(true);

    expect(() => expectPostMoveOrder(
      AO.replace("drawExistingAnnotations(ctx, {", "missingExistingAnnotations(ctx, {"),
    )).toThrow();
    const reordered = AO
      .replace(stage, "")
      .replace(VISIBLE_HEADER, `${stage}${VISIBLE_HEADER}`);
    expect(() => expectPostMoveOrder(reordered)).toThrow();
  });
});
