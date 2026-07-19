// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the LLM tool-use highlight paint
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
import type { LlmHighlight } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "llm-highlight-render-freeze";
const PROJECT_DB_ID = 1_937;
const WIDTH = 200;
const HEIGHT = 100;
const BBOX: LlmHighlight["bbox"] = [0.125, 0.25, 0.625, 0.75];

type StageTraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown]
  | [kind: "get", property: string];

type CanvasRecord = {
  trace: StageTraceEntry[];
  context: CanvasRenderingContext2D;
};

let queryClient: QueryClient;
let canvasRecords: WeakMap<HTMLCanvasElement, CanvasRecord>;
let stageTrace: StageTraceEntry[];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function createCanvasRecord(): CanvasRecord {
  const trace = stageTrace;
  const generatedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    measureText: (text: string) => {
      trace.push(["call", "measureText", text]);
      return {
        get width() {
          trace.push(["get", "metrics.width"]);
          return 31.75;
        },
      };
    },
  };
  const context = new Proxy(target, {
    get(object, property, receiver) {
      if (property === "measureText") trace.push(["get", "ctx.measureText"]);
      if (property === "fillText") trace.push(["get", "ctx.fillText"]);
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

function trackedHighlight({
  pageNumber,
  labels,
  forbidBody = false,
}: {
  pageNumber: number;
  labels: readonly string[];
  forbidBody?: boolean;
}): LlmHighlight {
  let labelRead = 0;
  return {
    get pageNumber() {
      stageTrace.push(["get", "highlight.pageNumber"]);
      return pageNumber;
    },
    get bbox() {
      stageTrace.push(["get", "highlight.bbox"]);
      if (forbidBody) throw new Error("Off-page highlight bbox must stay cold");
      return BBOX;
    },
    get label() {
      stageTrace.push(["get", "highlight.label"]);
      if (forbidBody) throw new Error("Off-page highlight label must stay cold");
      const label = labels[labelRead % labels.length];
      labelRead += 1;
      return label;
    },
  };
}

function lastIndexOfCall(trace: StageTraceEntry[], method: string): number {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (entry[0] === "call" && entry[1] === method) return index;
  }
  return -1;
}

async function renderLatestDraw(highlight: LlmHighlight): Promise<StageTraceEntry[]> {
  setViewerStoreStateForTest({ llmHighlight: highlight });
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
    expect(lastIndexOfCall(record.trace, "clearRect")).toBeGreaterThan(-1);
    expect(record.trace).toContainEqual(["get", "highlight.pageNumber"]);
  });
  const clearIndex = lastIndexOfCall(record.trace, "clearRect");
  return record.trace.slice(clearIndex + 1);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasRecords = new WeakMap();
  stageTrace = [];
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("fetch", vi.fn((url: unknown) => {
    throw new Error(`Unexpected fetch in LLM highlight render freeze: ${String(url)}`);
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
    hiddenTakeoffItemIds: new Set<number>(),
    activeYoloTagId: null,
    yoloTagVisibility: {},
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

describe("AnnotationOverlay LLM highlight render freeze", () => {
  it("keeps page/bbox/label getter timing, MIN/MAX geometry, dash reset, and label paint", async () => {
    const latestDraw = await renderLatestDraw(trackedHighlight({
      pageNumber: 1,
      labels: ["gate", "MEASURE", "PAINT"],
    }));

    expect(latestDraw).toEqual([
      ["get", "highlight.pageNumber"],
      ["get", "highlight.bbox"],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 3],
      ["call", "setLineDash", [8, 4]],
      ["call", "strokeRect", 25, 25, 100, 50],
      ["call", "setLineDash", []],
      ["set", "fillStyle", "#22d3ee20"],
      ["call", "fillRect", 25, 25, 100, 50],
      ["get", "highlight.label"],
      ["set", "font", "bold 12px sans-serif"],
      ["get", "ctx.measureText"],
      ["get", "highlight.label"],
      ["call", "measureText", "MEASURE"],
      ["get", "metrics.width"],
      ["set", "fillStyle", "#22d3eedd"],
      ["call", "fillRect", 25, 7, 39.75, 16],
      ["set", "fillStyle", "#000"],
      ["get", "ctx.fillText"],
      ["get", "highlight.label"],
      ["call", "fillText", "PAINT", 29, 20],
    ]);
  });

  it("keeps a falsey label to one read and skips every label canvas operation", async () => {
    const latestDraw = await renderLatestDraw(trackedHighlight({
      pageNumber: 1,
      labels: [""],
    }));

    expect(latestDraw).toEqual([
      ["get", "highlight.pageNumber"],
      ["get", "highlight.bbox"],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 3],
      ["call", "setLineDash", [8, 4]],
      ["call", "strokeRect", 25, 25, 100, 50],
      ["call", "setLineDash", []],
      ["set", "fillStyle", "#22d3ee20"],
      ["call", "fillRect", 25, 25, 100, 50],
      ["get", "highlight.label"],
    ]);
  });

  it("keeps an off-page highlight body and every canvas write cold", async () => {
    const latestDraw = await renderLatestDraw(trackedHighlight({
      pageNumber: 2,
      labels: [],
      forbidBody: true,
    }));

    expect(latestDraw).toEqual([
      ["get", "highlight.pageNumber"],
    ]);
  });
});

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const LLM_HIGHLIGHT = readFileSync(
  join(process.cwd(), "src/components/viewer/render/llmHighlight.ts"),
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
  const symbol = source.indexOf("    // Draw symbol search results");
  const cells = source.indexOf("    // Draw TATR cell structure overlays");
  const tableCellCall = source.indexOf("drawTableCellStructure(ctx, {", cells);
  const llm = source.indexOf("    // Draw LLM tool use highlight");
  const llmCall = source.indexOf("drawLlmHighlight(ctx, {", llm);
  const tableTags = source.indexOf("    // Draw active table/keynote tag views");
  const tableTagCall = source.indexOf("drawTableTagViews(ctx, {", tableTags);
  const areaCall = source.indexOf("drawAreaPolygons(ctx, {", tableTagCall);
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
  expect(tableCellCall).toBeGreaterThan(cells);
  expect(llm).toBeGreaterThan(tableCellCall);
  expect(llmCall).toBeGreaterThan(llm);
  expect(tableTags).toBeGreaterThan(llmCall);
  expect(tableTagCall).toBeGreaterThan(tableTags);
  expect(areaCall).toBeGreaterThan(tableTagCall);
  expect(linearCall).toBeGreaterThan(areaCall);
  expect(groupCall).toBeGreaterThan(linearCall);
  expect(preview).toBeGreaterThan(groupCall);
  expect(dependencies).toBeGreaterThan(preview);
}

describe("AnnotationOverlay LLM highlight post-move topology", () => {
  it("pins the exact earlier driver, pure call, next pure call, and dependencies", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)\n",
    );
    expect(count(prefix, "\n")).toBe(255);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(10_955);
    expect(sha256(prefix)).toBe(
      "674f552be143a2c3c9060872a4016c589158515745b118444673457b99966518",
    );

    const llmCall = exactSlice(
      AO,
      "    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)\n",
      "    // Draw active table/keynote tag views\n",
    );
    expect(count(llmCall, "\n")).toBe(8);
    expect(Buffer.byteLength(llmCall, "utf8")).toBe(169);
    expect(sha256(llmCall)).toBe(
      "3d5f59330e3bde3c1adcf6a57a69669a2959d09e8e2d759daf461da3769c0686",
    );
    expect(count(llmCall, "drawLlmHighlight(ctx, {")).toBe(1);
    expect(llmCall).toContain("llmHighlight,");
    expect(llmCall).toContain("pageNumber,");

    const tableTagCall = exactSlice(
      AO,
      "    // Draw active table/keynote tag views\n",
      "    // Draw completed area polygons\n",
    );
    expect(count(tableTagCall, "\n")).toBe(10);
    expect(Buffer.byteLength(tableTagCall, "utf8")).toBe(197);
    expect(sha256(tableTagCall)).toBe(
      "9d795296d3f2b132067b9842f592d528eb63ac4064125e69c60ae364a87ec538",
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
    expect(count(AO, "    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)\n")).toBe(1);
    expect(count(AO, 'import { drawLlmHighlight } from "./render/llmHighlight";')).toBe(1);
    expect(count(AO, "drawLlmHighlight(ctx, {")).toBe(1);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/llmHighlight.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/llmHighlight.test.ts",
    ))).toBe(true);
    expect(count(AO, "llmHighlight.pageNumber === pageNumber")).toBe(0);
    expect(() => expectPostMoveOrder(
      AO.replace("drawLlmHighlight(ctx, {", "missingLlmHighlight(ctx, {"),
    )).toThrow();

    const llmCall = exactSlice(
      AO,
      "    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)\n",
      "    // Draw active table/keynote tag views\n",
    );
    const reordered = AO
      .replace(llmCall, "")
      .replace(
        "    // Draw completed area polygons",
        `${llmCall}    // Draw completed area polygons`,
      );
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(Buffer.byteLength(LLM_HIGHLIGHT, "utf8")).toBe(1_432);
    expect(count(LLM_HIGHLIGHT, "\n")).toBe(48);
    expect(sha256(LLM_HIGHLIGHT)).toBe(
      "31d320f2f4d2d8f5bf1849db04a4b25d5c3f699917321f172c643eb8aa7ac7ae",
    );
    expect(count(LLM_HIGHLIGHT, "llmHighlight.pageNumber")).toBe(1);
    expect(count(LLM_HIGHLIGHT, "llmHighlight.bbox")).toBe(1);
    expect(count(LLM_HIGHLIGHT, "llmHighlight.label")).toBe(3);
    expect(count(LLM_HIGHLIGHT, "ctx.setLineDash(")).toBe(2);
    expect(LLM_HIGHLIGHT).not.toMatch(/@\/(stores|queries)|fetch\(|persist/i);
  });
});
