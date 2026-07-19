// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the table/keynote tag-view paint
// stage. It is born against the real inline AnnotationOverlay driver; extraction may translate
// only the explicitly parent-source topology assertions at the bottom.

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
import type { TableTagView } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ScoredMatch } from "@/lib/tag-mapping/types";
import type { YoloTag } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "table-tag-views-render-freeze";
const PROJECT_DB_ID = 1_936;
const WIDTH = 200;
const HEIGHT = 100;

type CanvasTraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown];

type CanvasRecord = {
  trace: CanvasTraceEntry[];
  context: CanvasRenderingContext2D;
};

let queryClient: QueryClient;
let canvasRecords: WeakMap<HTMLCanvasElement, CanvasRecord>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function instance(
  pageNumber: number,
  bbox: ScoredMatch["bbox"],
): ScoredMatch {
  return {
    pageNumber,
    annotationId: -1,
    bbox,
    confidence: 1,
  };
}

function tag(
  id: string,
  tagText: string,
  source: YoloTag["source"],
  instances: ScoredMatch[],
): YoloTag {
  return {
    id,
    name: tagText,
    tagText,
    yoloClass: "",
    yoloModel: "",
    source,
    scope: "project",
    instances,
  };
}

function view(
  regionId: string,
  pageNum: number,
  bbox: TableTagView["bbox"],
  tagTexts: string[],
  source: TableTagView["source"],
): TableTagView {
  return { regionId, pageNum, bbox, tagTexts, source };
}

function createCanvasRecord(): CanvasRecord {
  const trace: CanvasTraceEntry[] = [];
  const generatedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    measureText: (text: string) => {
      trace.push(["call", "measureText", text]);
      return { width: text.length * 6 };
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
  return { trace, context };
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
    throw new Error(`Unexpected fetch in table-tag render freeze: ${String(url)}`);
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

  const activeTableTagViews: Record<string, TableTagView> = {
    "region-off-page": view(
      "region-off-page",
      2,
      [0.05, 0.05, 0.15, 0.15],
      ["A-1"],
      "schedule",
    ),
    "region-on-page": view(
      "region-on-page",
      1,
      [0.5, 0.125, 0.875, 0.5],
      ["missing", "B-2", "B-2"],
      "keynote",
    ),
    "region-only": view(
      "region-only",
      1,
      [0.125, 0.625, 0.375, 0.875],
      [],
      "schedule",
    ),
  };

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
    hiddenTakeoffItemIds: new Set<number>(),
    activeYoloTagId: null,
    yoloTagVisibility: { "tag-a": false, "tag-b": false },
    activeTableTagViews,
    llmHighlight: null,
    showDetections: false,
    tableCellStructure: null,
    showTableCellStructure: false,
  });

  seedAnnotations(queryClient, []);
  seedAnnotationGroups(queryClient, [], []);
  seedTakeoff(queryClient, [], []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, {
    yoloTags: [
      tag("tag-a", "A-1", "schedule", [
        instance(1, [0.125, 0.25, 0.375, 0.5]),
        instance(2, [0.9, 0.9, 0.95, 0.95]),
        instance(1, [0.5, 0.125, 0.75, 0.375]),
      ]),
      tag("tag-b", "B-2", "keynote", [
        instance(1, [0.25, 0.5, 0.5, 0.75]),
      ]),
    ],
  });
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

describe("AnnotationOverlay table/keynote tag-view render freeze", () => {
  it("keeps view/tag/instance order, page gating, map skips, padding, geometry, and labels", async () => {
    const { container } = render(
      <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={1} />,
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

    await waitFor(() => {
      const clearIndex = lastIndexOfCall(record.trace, "clearRect");
      const latestDraw = record.trace.slice(clearIndex + 1);
      expect(latestDraw).toContainEqual(["call", "strokeRect", 25, 62.5, 50, 25]);
    });

    const clearIndex = lastIndexOfCall(record.trace, "clearRect");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(record.trace.slice(clearIndex + 1)).toEqual([
      ["set", "fillStyle", "#ff00ff25"],
      ["set", "strokeStyle", "#ff00ff"],
      ["set", "lineWidth", 1.5],
      ["call", "fillRect", 22, 22, 56, 31],
      ["call", "strokeRect", 22, 22, 56, 31],
      ["set", "font", "bold 9px sans-serif"],
      ["call", "measureText", "A-1"],
      ["set", "fillStyle", "#ff00ffcc"],
      ["call", "fillRect", 22, 54, 24, 12],
      ["set", "fillStyle", "#fff"],
      ["call", "fillText", "A-1", 25, 63],
      ["set", "fillStyle", "#ff00ff25"],
      ["set", "strokeStyle", "#ff00ff"],
      ["set", "lineWidth", 1.5],
      ["call", "fillRect", 97, 9.5, 56, 31],
      ["call", "strokeRect", 97, 9.5, 56, 31],
      ["set", "font", "bold 9px sans-serif"],
      ["call", "measureText", "A-1"],
      ["set", "fillStyle", "#ff00ffcc"],
      ["call", "fillRect", 97, 41.5, 24, 12],
      ["set", "fillStyle", "#fff"],
      ["call", "fillText", "A-1", 100, 50.5],
      ["set", "fillStyle", "rgba(59, 130, 246, 0.08)"],
      ["set", "strokeStyle", "rgba(59, 130, 246, 0.3)"],
      ["set", "lineWidth", 1.5],
      ["call", "fillRect", 100, 12.5, 75, 37.5],
      ["call", "strokeRect", 100, 12.5, 75, 37.5],
      ["set", "fillStyle", "#ff00ff25"],
      ["set", "strokeStyle", "#ff00ff"],
      ["set", "lineWidth", 1.5],
      ["call", "fillRect", 47, 47, 56, 31],
      ["call", "strokeRect", 47, 47, 56, 31],
      ["set", "font", "bold 9px sans-serif"],
      ["call", "measureText", "B-2"],
      ["set", "fillStyle", "#ff00ffcc"],
      ["call", "fillRect", 47, 79, 24, 12],
      ["set", "fillStyle", "#fff"],
      ["call", "fillText", "B-2", 50, 88],
      ["set", "fillStyle", "#ff00ff25"],
      ["set", "strokeStyle", "#ff00ff"],
      ["set", "lineWidth", 1.5],
      ["call", "fillRect", 47, 47, 56, 31],
      ["call", "strokeRect", 47, 47, 56, 31],
      ["set", "font", "bold 9px sans-serif"],
      ["call", "measureText", "B-2"],
      ["set", "fillStyle", "#ff00ffcc"],
      ["call", "fillRect", 47, 79, 24, 12],
      ["set", "fillStyle", "#fff"],
      ["call", "fillText", "B-2", 50, 88],
      ["set", "fillStyle", "rgba(59, 130, 246, 0.08)"],
      ["set", "strokeStyle", "rgba(59, 130, 246, 0.3)"],
      ["set", "lineWidth", 1.5],
      ["call", "fillRect", 25, 62.5, 50, 25],
      ["call", "strokeRect", 25, 62.5, 50, 25],
    ]);
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
  const symbol = source.indexOf("    // Draw symbol search results");
  const cells = source.indexOf("    // Draw TATR cell structure overlays");
  const llm = source.indexOf("    // Draw LLM tool use highlight");
  const tableTags = source.indexOf("    // ─── Table/Keynote tag views");
  const viewLoop = source.indexOf("for (const view of Object.values(tableTagViews))", tableTags);
  const area = source.indexOf("    // Draw completed area polygons");
  const areaCall = source.indexOf("drawAreaPolygons(ctx, {", area);
  const linearCall = source.indexOf("drawLinearPolylines(ctx, {", areaCall);
  const groupCall = source.indexOf("drawGroupRings(ctx, {", linearCall);
  const preview = source.indexOf(
    "    // Calibration + polygon preview — rendered by DrawingPreviewLayer",
  );
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
  );
  expect(annotations).toBeGreaterThan(-1);
  expect(symbol).toBeGreaterThan(annotations);
  expect(cells).toBeGreaterThan(symbol);
  expect(llm).toBeGreaterThan(cells);
  expect(tableTags).toBeGreaterThan(llm);
  expect(viewLoop).toBeGreaterThan(tableTags);
  expect(area).toBeGreaterThan(viewLoop);
  expect(areaCall).toBeGreaterThan(area);
  expect(linearCall).toBeGreaterThan(areaCall);
  expect(groupCall).toBeGreaterThan(linearCall);
  expect(preview).toBeGreaterThan(groupCall);
  expect(dependencies).toBeGreaterThan(preview);
}

describe("AnnotationOverlay table/keynote tag-view direct-parent topology", () => {
  it("pins the exact earlier driver, inline stage, downstream calls, and dependencies", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // ─── Table/Keynote tag views (eye icon toggle) ───\n",
    );
    expect(count(prefix, "\n")).toBe(304);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(13_292);
    expect(sha256(prefix)).toBe(
      "b8d274313dc83cbc96fd85917a9352f9a25b6aab42b38d2df17f1f9d8239e918",
    );

    const tableTagStage = exactSlice(
      AO,
      "    // ─── Table/Keynote tag views (eye icon toggle) ───\n",
      "    // Draw completed area polygons\n",
    );
    expect(count(tableTagStage, "\n")).toBe(43);
    expect(Buffer.byteLength(tableTagStage, "utf8")).toBe(2_003);
    expect(sha256(tableTagStage)).toBe(
      "961904701eb78aa1cd019418b1ec28ee907ea3fa830fb7c563a4c155169011f1",
    );
    expect(count(tableTagStage, "Object.keys(activeTableTagViews)")).toBe(1);
    expect(count(tableTagStage, "Object.values(tableTagViews)")).toBe(1);
    expect(count(tableTagStage, "tagTextIndex.get(")).toBe(1);
    expect(count(tableTagStage, "pageTagInstances.get(")).toBe(1);

    const areaCall = exactSlice(
      AO,
      "    // Draw completed area polygons\n",
      "    // Draw completed linear polylines\n",
    );
    expect(Buffer.byteLength(areaCall, "utf8")).toBe(212);
    expect(sha256(areaCall)).toBe(
      "ff9a020a5000bb1777ef679c41dd4d6fb3eac8ed2af2b86a0e1f0a57e1039519",
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

  it("keeps one ordered inline stage, no future helper, and biting source self-oracles", () => {
    expectParentOrder(AO);
    expect(count(AO, "    // ─── Table/Keynote tag views (eye icon toggle) ───\n")).toBe(1);
    expect(count(AO, 'import { drawTableTagViews } from "./render/tableTagViews";')).toBe(0);
    expect(count(AO, "drawTableTagViews(ctx, {")).toBe(0);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/tableTagViews.ts",
    ))).toBe(false);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/tableTagViews.test.ts",
    ))).toBe(false);
    expect(() => expectParentOrder(
      AO.replace(
        "for (const view of Object.values(tableTagViews))",
        "for (const view of Object.values(missingTableTagViews))",
      ),
    )).toThrow();

    const tableTagStage = exactSlice(
      AO,
      "    // ─── Table/Keynote tag views (eye icon toggle) ───\n",
      "    // Draw completed area polygons\n",
    );
    const reordered = AO
      .replace(tableTagStage, "")
      .replace(
        "    // Draw completed linear polylines",
        `${tableTagStage}    // Draw completed linear polylines`,
      );
    expect(() => expectParentOrder(reordered)).toThrow();
  });
});
