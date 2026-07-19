// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the completed linear-polyline paint
// stage. It was born against the real inline AnnotationOverlay driver; the extraction keeps the
// behavioral trace intact and translates only the source-topology section.

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
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type {
  AnnotationGroup,
  AnnotationGroupMembership,
  ClientAnnotation,
  LinearPolylineData,
} from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "linear-polylines-render-freeze";
const PROJECT_DB_ID = 1_934;
const WIDTH = 200;
const HEIGHT = 100;
const MULTI_SELECTED_ID = 607;
const LOCAL_SELECTED_ID = 603;

type CanvasTraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown];

type CanvasRecord = {
  trace: CanvasTraceEntry[];
  context: CanvasRenderingContext2D;
  stackDepth: () => number;
};

let queryClient: QueryClient;
let canvasRecords: WeakMap<HTMLCanvasElement, CanvasRecord>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function linearData(
  takeoffItemId: number,
  color: string,
  vertices: { x: number; y: number }[],
  totalLength: number,
  unit: string,
) {
  return {
    type: "linear-polyline",
    takeoffItemId,
    color,
    vertices,
    totalLength,
    unit,
    segmentLengths: [],
  } satisfies LinearPolylineData;
}

function createCanvasRecord(): CanvasRecord {
  const trace: CanvasTraceEntry[] = [];
  let stackDepth = 0;
  const generatedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    measureText: (text: string) => {
      trace.push(["call", "measureText", text]);
      return { width: text.length * 6 };
    },
    save: () => {
      trace.push(["call", "save"]);
      stackDepth += 1;
    },
    restore: () => {
      trace.push(["call", "restore"]);
      if (stackDepth > 0) stackDepth -= 1;
    },
  };
  const context = new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (typeof property !== "string") return undefined;
      let method = generatedMethods.get(property);
      if (!method) {
        method = (...args: unknown[]) => {
          trace.push(["call", property, ...args]);
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
  return { trace, context, stackDepth: () => stackDepth };
}

function lastIndexOfCall(trace: CanvasTraceEntry[], method: string): number {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (entry[0] === "call" && entry[1] === method) return index;
  }
  return -1;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasRecords = new WeakMap();
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("fetch", vi.fn((url: unknown) => {
    throw new Error(`Unexpected fetch in linear render freeze: ${String(url)}`);
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
    focusAnnotationId: LOCAL_SELECTED_ID,
    selectedAnnotationIds: new Set([MULTI_SELECTED_ID]),
    hiddenAnnotationIds: new Set<number>(),
    hiddenTakeoffItemIds: new Set([99]),
    activeTableTagViews: {},
    llmHighlight: null,
    showDetections: false,
    tableCellStructure: null,
    showTableCellStructure: false,
  });

  const annotations: ClientAnnotation[] = [
    {
      id: 613,
      pageNumber: 1,
      name: "Hidden linear",
      bbox: [0.1, 0.1, 0.2, 0.2],
      note: null,
      source: "takeoff",
      data: linearData(99, "#ef4444", [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], 3, "LF"),
    },
    {
      id: MULTI_SELECTED_ID,
      pageNumber: 1,
      name: "Multi-selected linear",
      bbox: [0.125, 0.25, 0.375, 0.75],
      note: null,
      source: "takeoff",
      data: linearData(
        18,
        "#f97316",
        [{ x: 0.125, y: 0.25 }, { x: 0.375, y: 0.75 }],
        0,
        "m",
      ),
    },
    {
      id: 609,
      pageNumber: 1,
      name: "Wrong source",
      bbox: [0.2, 0.2, 0.3, 0.3],
      note: null,
      source: "user",
      data: linearData(19, "#84cc16", [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], 4, "LF"),
    },
    {
      id: 611,
      pageNumber: 1,
      name: "One vertex",
      bbox: [0.3, 0.3, 0.4, 0.4],
      note: null,
      source: "takeoff",
      data: linearData(20, "#eab308", [{ x: 0.3, y: 0.3 }], 0, "LF"),
    },
    {
      id: 605,
      pageNumber: 1,
      name: "Wrong type",
      bbox: [0.4, 0.4, 0.5, 0.5],
      note: null,
      source: "takeoff",
      data: {
        ...linearData(
          22,
          "#84cc16",
          [{ x: 0.4, y: 0.4 }, { x: 0.45, y: 0.45 }],
          5,
          "LF",
        ),
        type: "not-linear",
      },
    },
    {
      id: 601,
      pageNumber: 1,
      name: "Unselected linear",
      bbox: [0.25, 0.125, 0.5, 0.375],
      note: null,
      source: "takeoff",
      data: linearData(
        21,
        "#0ea5e9",
        [{ x: 0.25, y: 0.125 }, { x: 0.5, y: 0.375 }],
        2,
        "ft",
      ),
    },
    {
      id: LOCAL_SELECTED_ID,
      pageNumber: 1,
      name: "Locally selected linear",
      bbox: [0.45, 0.2, 0.95, 0.9],
      note: null,
      source: "takeoff",
      data: linearData(
        17,
        "#a855f7",
        [{ x: 0.5, y: 0.25 }, { x: 0.75, y: 0.5 }, { x: 0.875, y: 0.75 }],
        12.25,
        "LF",
      ),
    },
  ];
  seedAnnotations(queryClient, annotations);

  const group: AnnotationGroup = {
    id: 3,
    projectId: PROJECT_DB_ID,
    name: "Linear order sentinel",
    csiCode: null,
    notes: null,
    color: "#22d3ee",
    isActive: true,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
  };
  const membership: AnnotationGroupMembership = {
    annotationId: MULTI_SELECTED_ID,
    groupId: group.id,
  };
  seedAnnotationGroups(queryClient, [group], [membership]);
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

describe("AnnotationOverlay completed linear-polyline render freeze", () => {
  it("keeps filters, selection modes, geometry, labels, state envelopes, and final-stage order", async () => {
    const { container } = render(
      <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={1} />,
      { wrapper },
    );
    await waitFor(() => {
      expect(document.querySelector("canvas")).not.toBeNull();
      expect(container.querySelectorAll("canvas")).toHaveLength(1);
    });

    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("Expected AnnotationOverlay canvas");
    const record = canvasRecords.get(canvas);
    if (!record) throw new Error("Expected AnnotationOverlay to acquire a 2D context");

    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    await waitFor(() => {
      const clearIndex = lastIndexOfCall(record.trace, "clearRect");
      const latestDraw = record.trace.slice(clearIndex + 1);
      expect(latestDraw.some((entry, index) =>
        entry[0] === "call" &&
        entry[1] === "save" &&
        latestDraw[index + 1]?.[0] === "set" &&
        latestDraw[index + 1]?.[1] === "strokeStyle" &&
        latestDraw[index + 1]?.[2] === "#a855f7" &&
        latestDraw[index + 2]?.[0] === "set" &&
        latestDraw[index + 2]?.[1] === "lineWidth" &&
        latestDraw[index + 2]?.[2] === 3
      )).toBe(true);
    });

    const clearIndex = lastIndexOfCall(record.trace, "clearRect");
    expect(clearIndex).toBeGreaterThan(-1);
    const latestDraw = record.trace.slice(clearIndex + 1);
    const firstSave = latestDraw.findIndex((entry) =>
      entry[0] === "call" && entry[1] === "save"
    );
    const finalSave = lastIndexOfCall(latestDraw, "save");
    expect(firstSave).toBeGreaterThan(-1);
    expect(finalSave).toBeGreaterThan(firstSave);

    const expectedLinearTrace: CanvasTraceEntry[] = [
      ["call", "save"],
      ["set", "strokeStyle", "#f97316"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "moveTo", 25, 25],
      ["call", "lineTo", 75, 75],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 25, 25, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 75, 75, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "-- m"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 81, 68, 32, 16],
      ["set", "fillStyle", "#f97316"],
      ["call", "fillText", "-- m", 85, 80],
      ["call", "restore"],
      ["call", "save"],
      ["set", "strokeStyle", "#0ea5e9"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "moveTo", 50, 12.5],
      ["call", "lineTo", 100, 37.5],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "2 ft"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 106, 30.5, 32, 16],
      ["set", "fillStyle", "#0ea5e9"],
      ["call", "fillText", "2 ft", 110, 42.5],
      ["call", "restore"],
      ["call", "save"],
      ["set", "strokeStyle", "#a855f7"],
      ["set", "lineWidth", 3],
      ["call", "beginPath"],
      ["call", "moveTo", 100, 25],
      ["call", "lineTo", 150, 50],
      ["call", "lineTo", 175, 75],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 100, 25, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 150, 50, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 175, 75, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "12.3 LF"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 181, 68, 50, 16],
      ["set", "fillStyle", "#a855f7"],
      ["call", "fillText", "12.3 LF", 185, 80],
      ["call", "restore"],
    ];
    expect(latestDraw.slice(firstSave, finalSave)).toEqual(expectedLinearTrace);

    expect(latestDraw.slice(finalSave)).toEqual([
      ["call", "save"],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 1.5],
      ["call", "setLineDash", [4, 2]],
      ["call", "strokeRect", 23, 23, 54, 54],
      ["call", "restore"],
    ]);
    expect(latestDraw).not.toContainEqual(["call", "closePath"]);
    expect(record.stackDepth()).toBe(0);
  });
});

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const LINEAR_POLYLINES = readFileSync(
  join(process.cwd(), "src/components/viewer/render/linearPolylines.ts"),
  "utf8",
);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function exactSlice(source: string, startAnchor: string, endAnchor: string): string {
  expect(count(source, startAnchor)).toBe(1);
  expect(count(source, endAnchor)).toBe(1);
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectPostMoveOrder(source: string): void {
  const annotations = source.indexOf("    // Draw existing annotations");
  const llm = source.indexOf("    // Draw LLM tool use highlight");
  const llmCall = source.indexOf("drawLlmHighlight(ctx, {", llm);
  const tableTags = source.indexOf("    // Draw active table/keynote tag views");
  const tableTagCall = source.indexOf("drawTableTagViews(ctx, {", tableTags);
  const area = source.indexOf("    // Draw completed area polygons");
  const areaCall = source.indexOf("drawAreaPolygons(ctx, {", area);
  const linear = source.indexOf("    // Draw completed linear polylines");
  const linearCall = source.indexOf("drawLinearPolylines(ctx, {", linear);
  const groups = source.indexOf("    // Group-membership outlines");
  const groupCall = source.indexOf("drawGroupRings(ctx, {", groups);
  const preview = source.indexOf(
    "    // Calibration + polygon preview — rendered by DrawingPreviewLayer",
  );
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
  );
  expect(annotations).toBeGreaterThan(-1);
  expect(llm).toBeGreaterThan(annotations);
  expect(llmCall).toBeGreaterThan(llm);
  expect(tableTags).toBeGreaterThan(llmCall);
  expect(tableTagCall).toBeGreaterThan(tableTags);
  expect(area).toBeGreaterThan(tableTagCall);
  expect(areaCall).toBeGreaterThan(area);
  expect(linear).toBeGreaterThan(areaCall);
  expect(linearCall).toBeGreaterThan(linear);
  expect(groups).toBeGreaterThan(linearCall);
  expect(groupCall).toBeGreaterThan(groups);
  expect(preview).toBeGreaterThan(groupCall);
  expect(dependencies).toBeGreaterThan(preview);
}

describe("AnnotationOverlay linear-polyline post-move topology", () => {
  it("binds the exact earlier driver, pure call, group handoff, and dependencies", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Draw completed linear polylines",
    );
    expect(count(prefix, "\n")).toBe(310);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(12_996);
    expect(sha256(prefix)).toBe(
      "4ec181d3a755160e8a614645e03d86d249a17ca1a43d4520ad998a07f652803c",
    );

    const linearCall = exactSlice(
      AO,
      "    // Draw completed linear polylines\n",
      "    // Group-membership outlines",
    );
    expect(count(linearCall, "\n")).toBe(10);
    expect(Buffer.byteLength(linearCall, "utf8")).toBe(218);
    expect(sha256(linearCall)).toBe(
      "878185b695eaf095f8e0f223995889f1fce7482f816bc21cd4f8e0a7bc9e19ff",
    );
    expect(count(linearCall, "drawLinearPolylines(ctx, {")).toBe(1);
    expect(linearCall).toContain("selection: multiSelect,");
    expect(linearCall).not.toContain("for (const ann of pageAnnotations)");

    const groupCall = exactSlice(
      AO,
      "    // Group-membership outlines",
      "    // Calibration + polygon preview",
    );
    expect(Buffer.byteLength(groupCall, "utf8")).toBe(238);
    expect(sha256(groupCall)).toBe(
      "a5d9158ff7e19f312880177fc7eed7be16d57e7054ee0a364340e674f6a4d652",
    );

    const dependencyLine = exactSlice(
      AO,
      "  }, [pageAnnotations, width, height, selectedId",
      "\n\n  const getPos",
    );
    expect(Buffer.byteLength(dependencyLine, "utf8")).toBe(292);
    expect(sha256(dependencyLine)).toBe(
      "d202ed55c17f2ca65dcd43c3d4bb01b2588776589fa4ff415688f5b10b93d948",
    );
  });

  it("keeps one ordered call, one pure type-only module, and biting self-oracles", () => {
    expectPostMoveOrder(AO);
    expect(count(
      AO,
      'import { drawLinearPolylines } from "./render/linearPolylines";',
    )).toBe(1);
    expect(count(AO, "drawLinearPolylines(ctx, {")).toBe(1);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/linearPolylines.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/linearPolylines.test.ts",
    ))).toBe(true);
    expect(() => expectPostMoveOrder(
      AO.replace("drawLinearPolylines(ctx, {", "missingLinearPolylines(ctx, {"),
    )).toThrow();

    const linearCall = exactSlice(
      AO,
      "    // Draw completed linear polylines\n",
      "    // Group-membership outlines",
    );
    const reordered = AO
      .replace(linearCall, "")
      .replace(
        "    // Calibration + polygon preview",
        `${linearCall}    // Calibration + polygon preview`,
      );
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(Buffer.byteLength(LINEAR_POLYLINES, "utf8")).toBe(2_571);
    expect(count(LINEAR_POLYLINES, "\n")).toBe(77);
    expect(sha256(LINEAR_POLYLINES)).toBe(
      "b5cc2e37f36c10df7e171ca46edae5dbbbb9978557edad6d0ea7785d57ff8ed4",
    );
    expect(count(
      LINEAR_POLYLINES,
      'import type { ClientAnnotation, LinearPolylineData } from "@/types";',
    )).toBe(1);
    for (const forbidden of [
      "react", "useToolStore", "useUiStore", "useQueryClient", "fetch(",
      "persistFetch", "AnnotationOverlay", "setLineDash(", "closePath(",
    ]) {
      expect(LINEAR_POLYLINES).not.toContain(forbidden);
    }
  });
});
