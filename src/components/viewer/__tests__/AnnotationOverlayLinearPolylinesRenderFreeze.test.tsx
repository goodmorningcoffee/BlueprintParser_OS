// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the completed linear-polyline paint
// stage. This mounts the real AnnotationOverlay driver before render/linearPolylines.ts exists.
// The production move must retain this trace and may translate only the source-topology section.

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

function expectParentOrder(source: string): void {
  const annotations = source.indexOf("    // Draw existing annotations");
  const area = source.indexOf("    // Draw completed area polygons");
  const linear = source.indexOf("    // Draw completed linear polylines");
  const groups = source.indexOf("    // Group-membership outlines");
  const groupCall = source.indexOf("drawGroupRings(ctx, {", groups);
  const preview = source.indexOf(
    "    // Calibration + polygon preview — rendered by DrawingPreviewLayer",
  );
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
  );
  expect(annotations).toBeGreaterThan(-1);
  expect(area).toBeGreaterThan(annotations);
  expect(linear).toBeGreaterThan(area);
  expect(groups).toBeGreaterThan(linear);
  expect(groupCall).toBeGreaterThan(groups);
  expect(preview).toBeGreaterThan(groupCall);
  expect(dependencies).toBeGreaterThan(preview);
}

describe("AnnotationOverlay linear-polyline direct-parent topology", () => {
  it("binds the exact earlier driver, linear slice, group handoff, and dependencies", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Draw completed linear polylines",
    );
    expect(count(prefix, "\n")).toBe(430);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(18_704);
    expect(sha256(prefix)).toBe(
      "d7e777e5dbaf2c183548354bf7e52e93d842b3b454eee848cc9fe6eb550fa52b",
    );

    const linear = exactSlice(
      AO,
      "    // Draw completed linear polylines\n",
      "    // Group-membership outlines",
    );
    expect(count(linear, "\n")).toBe(47);
    expect(Buffer.byteLength(linear, "utf8")).toBe(1_840);
    expect(sha256(linear)).toBe(
      "161ef4b571ef78b34b4e91ba5392e457daab77fa212074168d6068451e0d68f8",
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

  it("keeps the inline stage between area and groups with no future module present", () => {
    expectParentOrder(AO);
    expect(count(AO, 'from "./render/linearPolylines"')).toBe(0);
    expect(count(AO, "drawLinearPolylines(")).toBe(0);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/linearPolylines.ts",
    ))).toBe(false);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/linearPolylines.test.ts",
    ))).toBe(false);

    const linear = exactSlice(
      AO,
      "    // Draw completed linear polylines\n",
      "    // Group-membership outlines",
    );
    const reordered = AO
      .replace(linear, "")
      .replace(
        "    // Calibration + polygon preview",
        `${linear}    // Calibration + polygon preview`,
      );
    expect(() => expectParentOrder(reordered)).toThrow();
  });
});
