// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the final group-membership ring paint
// stage. It was born against the real inline AnnotationOverlay driver before render/groupRings.ts
// existed; the pure extraction keeps the behavioral trace intact and translates only the explicitly
// parent-source topology describe at the bottom.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
  AnnotationGroup,
  AnnotationGroupMembership,
  ClientAnnotation,
  LinearPolylineData,
} from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "group-rings-render-freeze";
const PROJECT_DB_ID = 1_933;
const WIDTH = 200;
const HEIGHT = 100;

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

function group(
  id: number,
  color: string,
  isActive: boolean,
): AnnotationGroup {
  return {
    id,
    projectId: PROJECT_DB_ID,
    name: `Group ${id}`,
    csiCode: null,
    notes: null,
    color,
    isActive,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
  };
}

function membership(
  annotationId: number,
  groupId: number,
): AnnotationGroupMembership {
  return { annotationId, groupId };
}

function createCanvasRecord(): CanvasRecord {
  const trace: CanvasTraceEntry[] = [];
  const state = new Map<string, unknown>();
  const stack: Map<string, unknown>[] = [];
  const generatedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    measureText: (text: string) => {
      trace.push(["call", "measureText", text]);
      return { width: 0 };
    },
    save: () => {
      trace.push(["call", "save"]);
      stack.push(new Map(state));
    },
    restore: () => {
      trace.push(["call", "restore"]);
      const restored = stack.pop();
      if (!restored) return;
      state.clear();
      for (const [property, value] of restored) state.set(property, value);
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
      if (typeof property === "string") {
        trace.push(["set", property, value]);
        state.set(property, value);
      }
      return Reflect.set(object, property, value, receiver);
    },
  }) as unknown as CanvasRenderingContext2D;
  return { trace, context, stackDepth: () => stack.length };
}

function lastIndexOfCall(
  trace: CanvasTraceEntry[],
  method: string,
): number {
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
    throw new Error(`Unexpected fetch in group-rings render freeze: ${String(url)}`);
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
    selectedAnnotationIds: new Set<number>(),
    hiddenAnnotationIds: new Set<number>(),
    activeTableTagViews: {},
    llmHighlight: null,
    showDetections: false,
    tableCellStructure: null,
    showTableCellStructure: false,
  });

  const annotations: ClientAnnotation[] = [
    {
      id: 101,
      pageNumber: 1,
      name: "Grouped box",
      bbox: [0.125, 0.25, 0.375, 0.75],
      note: null,
      source: "user",
      data: null,
    },
    {
      id: 102,
      pageNumber: 1,
      name: "Inactive group box",
      bbox: [0.25, 0.125, 0.5, 0.375],
      note: null,
      source: "user",
      data: null,
    },
    {
      id: 103,
      pageNumber: 1,
      name: "Grouped linear",
      bbox: [0.5, 0.25, 0.875, 0.75],
      note: null,
      source: "takeoff",
      data: {
        type: "linear-polyline",
        takeoffItemId: 17,
        color: "#a855f7",
        vertices: [
          { x: 0.5, y: 0.25 },
          { x: 0.875, y: 0.75 },
        ],
        totalLength: 12,
        unit: "LF",
        segmentLengths: [12],
      } satisfies LinearPolylineData,
    },
  ];
  seedAnnotations(queryClient, annotations);
  seedAnnotationGroups(
    queryClient,
    [
      group(1, "#ef4444", true),
      group(2, "#22c55e", false),
      group(3, "#22d3ee", true),
    ],
    [membership(101, 1), membership(102, 2), membership(103, 3)],
  );
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

describe("AnnotationOverlay group-membership ring render freeze", () => {
  it("keeps the final ring pass ordered, min/max projected, and state-isolated per colored row", () => {
    const { container } = render(
      <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={1} />,
      { wrapper },
    );
    const canvases = [...container.querySelectorAll("canvas")];
    expect(canvases).toHaveLength(1);
    const record = canvasRecords.get(canvases[0]);
    if (!record) throw new Error("Expected AnnotationOverlay to acquire a 2D context");

    const clearIndex = lastIndexOfCall(record.trace, "clearRect");
    expect(clearIndex).toBeGreaterThan(-1);
    const latestDraw = record.trace.slice(clearIndex + 1);
    const expectedRingSuffix: CanvasTraceEntry[] = [
      ["call", "save"],
      ["set", "strokeStyle", "#ef4444"],
      ["set", "lineWidth", 1.5],
      ["call", "setLineDash", [4, 2]],
      ["call", "strokeRect", 23, 23, 54, 54],
      ["call", "restore"],
      ["call", "save"],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 1.5],
      ["call", "setLineDash", [4, 2]],
      ["call", "strokeRect", 98, 23, 79, 54],
      ["call", "restore"],
    ];

    expect(latestDraw.slice(-expectedRingSuffix.length)).toEqual(expectedRingSuffix);
    expect(latestDraw).not.toContainEqual([
      "call", "strokeRect", 48, 10.5, 54, 29,
    ]);
    const polylineLabel = latestDraw.findIndex((entry) =>
      entry[0] === "call" &&
      entry[1] === "fillText" &&
      entry[2] === "12 LF" &&
      entry[3] === 185 &&
      entry[4] === 80
    );
    expect(polylineLabel).toBeGreaterThan(-1);
    expect(polylineLabel).toBeLessThan(latestDraw.length - expectedRingSuffix.length);
    expect(record.stackDepth()).toBe(0);
  });
});

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const GROUP_RINGS = readFileSync(
  join(process.cwd(), "src/components/viewer/render/groupRings.ts"),
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
  const annotation = source.indexOf("    // Draw existing annotations");
  const symbol = source.indexOf("    // Draw symbol search results", annotation);
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
  const rings = source.indexOf("    // Group-membership outlines");
  const call = source.indexOf("drawGroupRings(ctx, {", rings);
  const preview = source.indexOf(
    "    // Calibration + polygon preview — rendered by DrawingPreviewLayer",
  );
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
  );
  expect(annotation).toBeGreaterThan(-1);
  expect(symbol).toBeGreaterThan(annotation);
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
  expect(rings).toBeGreaterThan(linearCall);
  expect(call).toBeGreaterThan(rings);
  expect(preview).toBeGreaterThan(call);
  expect(dependencies).toBeGreaterThan(preview);
}

describe("AnnotationOverlay group-ring post-move topology", () => {
  it("binds the untouched pre-linear driver, both pure calls, and dependency line", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Draw completed linear polylines",
    );
    expect(count(prefix, "\n")).toBe(236);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(9_331);
    expect(sha256(prefix)).toBe(
      "71b30178505626a5b4a29b414cde99a377de638201971a4df8c07d4c2252f555",
    );

    const linearCall = exactSlice(
      AO,
      "    // Draw completed linear polylines",
      "    // Group-membership outlines",
    );
    expect(count(linearCall, "\n")).toBe(10);
    expect(Buffer.byteLength(linearCall, "utf8")).toBe(218);
    expect(sha256(linearCall)).toBe(
      "878185b695eaf095f8e0f223995889f1fce7482f816bc21cd4f8e0a7bc9e19ff",
    );

    const groupCall = exactSlice(
      AO,
      "    // Group-membership outlines",
      "    // Calibration + polygon preview",
    );
    expect(count(groupCall, "\n")).toBe(8);
    expect(Buffer.byteLength(groupCall, "utf8")).toBe(238);
    expect(sha256(groupCall)).toBe(
      "a5d9158ff7e19f312880177fc7eed7be16d57e7054ee0a364340e674f6a4d652",
    );
    expect(count(groupCall, "drawGroupRings(ctx, {")).toBe(1);
    expect(groupCall).not.toContain("for (const ann of pageAnnotations)");
    expect(groupCall).not.toContain("getGroupOutlineColor(ann.id)");

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

  it("keeps one final call, one pure type-only module, and a non-vacuous order oracle", () => {
    expectPostMoveOrder(AO);
    expect(count(AO, 'import { drawGroupRings } from "./render/groupRings";')).toBe(1);
    expect(count(AO, "drawGroupRings(ctx, {")).toBe(1);
    expect(() => expectPostMoveOrder(
      AO.replace("drawGroupRings(ctx, {", "missingGroupRings(ctx, {"),
    )).toThrow();
    const groupStage = exactSlice(
      AO,
      "    // Group-membership outlines",
      "    // Calibration + polygon preview",
    );
    const reordered = AO
      .replace(groupStage, "")
      .replace(
        "    // Draw completed linear polylines",
        `${groupStage}    // Draw completed linear polylines`,
      );
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(Buffer.byteLength(GROUP_RINGS, "utf8")).toBe(1_430);
    expect(count(GROUP_RINGS, "\n")).toBe(44);
    expect(sha256(GROUP_RINGS)).toBe(
      "7b930be83dad0c217cdd9411cc07fcac8e2ade49360514887b8fbefaef93bd14",
    );
    expect(count(GROUP_RINGS, 'import type { ClientAnnotation } from "@/types";')).toBe(1);
    for (const forbidden of [
      "react", "useToolStore", "useUiStore", "useQueryClient", "fetch(",
      "persistFetch", "AnnotationOverlay",
    ]) {
      expect(GROUP_RINGS).not.toContain(forbidden);
    }
  });
});
