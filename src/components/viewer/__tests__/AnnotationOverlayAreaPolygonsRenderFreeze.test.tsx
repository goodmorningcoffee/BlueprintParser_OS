// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the completed area-polygon paint
// stage. This test is born against the real inline AnnotationOverlay driver; the extraction may
// translate only the explicitly parent-source topology assertions at the bottom.

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
import type { AreaPolygonData, ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "area-polygons-render-freeze";
const PROJECT_DB_ID = 1_935;
const WIDTH = 200;
const HEIGHT = 100;
const MULTI_SELECTED_ID = 707;
const LOCAL_SELECTED_ID = 703;

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

function areaData(
  takeoffItemId: number,
  color: string,
  vertices: { x: number; y: number }[],
  areaSqUnits: number,
  unit: AreaPolygonData["unit"],
  holes?: AreaPolygonData["holes"],
) {
  return {
    type: "area-polygon",
    takeoffItemId,
    color,
    vertices,
    ...(holes === undefined ? {} : { holes }),
    areaSqUnits,
    unit,
  } satisfies AreaPolygonData;
}

function annotation(
  id: number,
  data: ClientAnnotation["data"],
  source: ClientAnnotation["source"] = "takeoff",
): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name: `Area ${id}`,
    bbox: [0.01, 0.02, 0.08, 0.09],
    note: null,
    source,
    data,
  };
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
    throw new Error(`Unexpected fetch in area render freeze: ${String(url)}`);
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

  const renderable = areaData(
    21,
    "#0ea5e9",
    [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.2, y: 0.3 }],
    4,
    "SF",
  );
  seedAnnotations(queryClient, [
    annotation(713, { ...renderable, takeoffItemId: 99 }),
    annotation(711, renderable, "user"),
    annotation(709, { ...renderable, type: "not-area" }),
    annotation(715, {
      type: "area-polygon",
      takeoffItemId: 23,
      color: "#84cc16",
      areaSqUnits: 0,
      unit: "SF",
    }),
    annotation(717, areaData(
      25,
      "#eab308",
      [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }],
      0,
      "SF",
    )),
    annotation(MULTI_SELECTED_ID, areaData(
      17,
      "#f97316",
      [
        { x: 0.1, y: 0.2 },
        { x: 0.4, y: 0.1 },
        { x: 0.5, y: 0.6 },
        { x: 0.2, y: 0.8 },
      ],
      0,
      "SF",
      [
        {
          vertices: [
            { x: 0.2, y: 0.3 },
            { x: 0.3, y: 0.25 },
            { x: 0.32, y: 0.45 },
          ],
        },
        { vertices: [{ x: 0.12, y: 0.22 }, { x: 0.14, y: 0.24 }] },
      ],
    )),
    annotation(701, areaData(
      19,
      "#0ea5e9",
      [{ x: 0.15, y: 0.55 }, { x: 0.35, y: 0.55 }, { x: 0.25, y: 0.85 }],
      0.5,
      "SI",
    )),
    annotation(LOCAL_SELECTED_ID, areaData(
      18,
      "#a855f7",
      [{ x: 0.5, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.65, y: 0.8 }],
      12.25,
      "SM",
      [],
    )),
  ]);

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

describe("AnnotationOverlay completed area-polygon render freeze", () => {
  it("keeps filters, holes, selection asymmetry, geometry, labels, state envelopes, and order", async () => {
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
        latestDraw[index + 1]?.[1] === "fillStyle" &&
        latestDraw[index + 1]?.[2] === "#a855f740"
      )).toBe(true);
    });

    const clearIndex = lastIndexOfCall(record.trace, "clearRect");
    expect(clearIndex).toBeGreaterThan(-1);
    const latestDraw = record.trace.slice(clearIndex + 1);
    expect(latestDraw.filter((entry) =>
      entry[0] === "call" && entry[1] === "save"
    )).toHaveLength(3);
    const firstAreaSave = latestDraw.findIndex((entry, index) =>
      entry[0] === "call" &&
      entry[1] === "save" &&
      latestDraw[index + 1]?.[0] === "set" &&
      latestDraw[index + 1]?.[1] === "fillStyle" &&
      latestDraw[index + 1]?.[2] === "#f9731640"
    );
    expect(firstAreaSave).toBeGreaterThan(-1);

    expect(latestDraw.slice(firstAreaSave)).toEqual([
      ["call", "save"],
      ["set", "fillStyle", "#f9731640"],
      ["call", "beginPath"],
      ["call", "moveTo", 20, 20],
      ["call", "lineTo", 80, 10],
      ["call", "lineTo", 100, 60],
      ["call", "lineTo", 40, 80],
      ["call", "closePath"],
      ["call", "moveTo", 40, 30],
      ["call", "lineTo", 60, 25],
      ["call", "lineTo", 64, 45],
      ["call", "closePath"],
      ["call", "fill", "evenodd"],
      ["set", "strokeStyle", "#f97316"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "moveTo", 20, 20],
      ["call", "lineTo", 80, 10],
      ["call", "lineTo", 100, 60],
      ["call", "lineTo", 40, 80],
      ["call", "closePath"],
      ["call", "stroke"],
      ["call", "beginPath"],
      ["call", "moveTo", 40, 30],
      ["call", "lineTo", 60, 25],
      ["call", "lineTo", 64, 45],
      ["call", "closePath"],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 20, 20, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 80, 10, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 100, 60, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 40, 80, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "-- SF"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 41, 35.50000000000001, 38, 16],
      ["set", "fillStyle", "#f97316"],
      ["call", "fillText", "-- SF", 45, 47.50000000000001],
      ["call", "restore"],
      ["call", "save"],
      ["set", "fillStyle", "#0ea5e940"],
      ["call", "beginPath"],
      ["call", "moveTo", 30, 55.00000000000001],
      ["call", "lineTo", 70, 55.00000000000001],
      ["call", "lineTo", 50, 85],
      ["call", "closePath"],
      ["call", "fill", "evenodd"],
      ["set", "strokeStyle", "#0ea5e9"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "moveTo", 30, 55.00000000000001],
      ["call", "lineTo", 70, 55.00000000000001],
      ["call", "lineTo", 50, 85],
      ["call", "closePath"],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "0.5 SI"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 28, 58, 44, 16],
      ["set", "fillStyle", "#0ea5e9"],
      ["call", "fillText", "0.5 SI", 32, 70],
      ["call", "restore"],
      ["call", "save"],
      ["set", "fillStyle", "#a855f740"],
      ["call", "beginPath"],
      ["call", "moveTo", 100, 20],
      ["call", "lineTo", 160, 20],
      ["call", "lineTo", 130, 80],
      ["call", "closePath"],
      ["call", "fill", "evenodd"],
      ["set", "strokeStyle", "#a855f7"],
      ["set", "lineWidth", 3],
      ["call", "beginPath"],
      ["call", "moveTo", 100, 20],
      ["call", "lineTo", 160, 20],
      ["call", "lineTo", 130, 80],
      ["call", "closePath"],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 100, 20, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 160, 20, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 130, 80, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "12.3 SM"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 105, 33.00000000000001, 50, 16],
      ["set", "fillStyle", "#a855f7"],
      ["call", "fillText", "12.3 SM", 109, 45.00000000000001],
      ["call", "restore"],
    ]);
    expect(record.stackDepth()).toBe(0);
  });
});

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const AREA_POLYGONS = readFileSync(
  join(process.cwd(), "src/components/viewer/render/areaPolygons.ts"),
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
  const symbol = source.indexOf("    // Draw symbol search results", annotations);
  const symbolCall = source.indexOf("drawSymbolSearchResults(ctx, {", symbol);
  const cells = source.indexOf("    // Draw TATR cell structure overlays", symbolCall);
  const tableCellCall = source.indexOf("drawTableCellStructure(ctx, {", cells);
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
  expect(symbol).toBeGreaterThan(annotations);
  expect(symbolCall).toBeGreaterThan(symbol);
  expect(cells).toBeGreaterThan(symbolCall);
  expect(tableCellCall).toBeGreaterThan(cells);
  expect(llm).toBeGreaterThan(tableCellCall);
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

describe("AnnotationOverlay area-polygon post-move topology", () => {
  it("binds the exact earlier driver, pure call, later handoffs, and dependencies", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Draw completed area polygons\n",
    );
    expect(count(prefix, "\n")).toBe(244);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(10_018);
    expect(sha256(prefix)).toBe(
      "6bc6af7ddf7262cde4672d392cf31fe0dcfbad86d649da738e395106602df2f1",
    );

    const areaCall = exactSlice(
      AO,
      "    // Draw completed area polygons\n",
      "    // Draw completed linear polylines\n",
    );
    expect(count(areaCall, "\n")).toBe(10);
    expect(Buffer.byteLength(areaCall, "utf8")).toBe(212);
    expect(sha256(areaCall)).toBe(
      "ff9a020a5000bb1777ef679c41dd4d6fb3eac8ed2af2b86a0e1f0a57e1039519",
    );
    expect(count(areaCall, "drawAreaPolygons(ctx, {")).toBe(1);
    expect(areaCall).toContain("selection: multiSelect,");
    expect(areaCall).not.toContain("for (const ann of pageAnnotations)");

    const linearCall = exactSlice(
      AO,
      "    // Draw completed linear polylines\n",
      "    // Group-membership outlines",
    );
    expect(Buffer.byteLength(linearCall, "utf8")).toBe(218);
    expect(sha256(linearCall)).toBe(
      "878185b695eaf095f8e0f223995889f1fce7482f816bc21cd4f8e0a7bc9e19ff",
    );

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

  it("keeps one ordered call, one pure module, and biting source self-oracles", () => {
    expectPostMoveOrder(AO);
    expect(count(AO, "    // Draw completed area polygons\n")).toBe(1);
    expect(count(
      AO,
      'import { drawAreaPolygons } from "./render/areaPolygons";',
    )).toBe(1);
    expect(count(AO, "drawAreaPolygons(ctx, {")).toBe(1);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/areaPolygons.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/areaPolygons.test.ts",
    ))).toBe(true);
    expect(() => expectPostMoveOrder(
      AO.replace("drawAreaPolygons(ctx, {", "missingAreaPolygons(ctx, {"),
    )).toThrow();

    const areaCall = exactSlice(
      AO,
      "    // Draw completed area polygons\n",
      "    // Draw completed linear polylines\n",
    );
    const reordered = AO
      .replace(areaCall, "")
      .replace(
        "    // Group-membership outlines",
        `${areaCall}    // Group-membership outlines`,
      );
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(Buffer.byteLength(AREA_POLYGONS, "utf8")).toBe(4_098);
    expect(count(AREA_POLYGONS, "\n")).toBe(114);
    expect(sha256(AREA_POLYGONS)).toBe(
      "3f1d469bbd10d709485a920d7b7f1138a0ef3b21f34e6012b5ed400a08685ab0",
    );
    expect(count(
      AREA_POLYGONS,
      'import { polygonCentroid } from "@/lib/areaCalc";',
    )).toBe(1);
    expect(count(
      AREA_POLYGONS,
      'import type { AreaPolygonData, ClientAnnotation } from "@/types";',
    )).toBe(1);
    for (const forbidden of [
      "react", "useToolStore", "useUiStore", "useQueryClient", "fetch(",
      "persistFetch", "AnnotationOverlay", "drawLinearPolylines", "drawGroupRings",
      "setLineDash(", "as any", ".bbox",
    ]) {
      expect(AREA_POLYGONS).not.toContain(forbidden);
    }
  });
});
