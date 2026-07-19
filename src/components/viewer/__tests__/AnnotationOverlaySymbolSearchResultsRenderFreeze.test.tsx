// @vitest-environment jsdom
//
// [refactor jul20 P3.3] Direct-parent executable freeze translated after the pure symbol-search
// result render extraction. The three runtime cases retain the exact parent filtering/paint
// contract; source oracles bind its single helper home and ordered AO call. The pre-existing
// result-only canvas-mount asymmetry remains intentionally out of scope.

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
import type { SymbolSearchMatch, SymbolSearchResult } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "symbol-search-results-render-freeze";
const PROJECT_DB_ID = 1_939;
const WIDTH = 200;
const HEIGHT = 100;

type StageTraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown]
  | [kind: "get", property: string];

type CanvasState = {
  dash: number[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  font: string;
};

type CanvasRecord = {
  trace: StageTraceEntry[];
  context: CanvasRenderingContext2D;
  state: () => CanvasState;
};

let queryClient: QueryClient;
let canvasRecords: WeakMap<HTMLCanvasElement, CanvasRecord>;
let stageTrace: StageTraceEntry[];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function createCanvasRecord(): CanvasRecord {
  const trace = stageTrace;
  let dash = [9, 3];
  const generatedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
  };
  const context = new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (typeof property !== "string") return undefined;
      let method = generatedMethods.get(property);
      if (!method) {
        method = (...args: unknown[]) => {
          trace.push(["call", property, ...args]);
          if (property === "setLineDash") dash = [...(args[0] as number[])];
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
  return {
    trace,
    context,
    state: () => ({
      dash: [...dash],
      fillStyle: target.fillStyle as string,
      strokeStyle: target.strokeStyle as string,
      lineWidth: target.lineWidth as number,
      globalAlpha: target.globalAlpha as number,
      font: target.font as string,
    }),
  };
}

function trackedMatch({
  name,
  id,
  pageNumber,
  bbox,
  confidences,
  forbidConfidence = false,
  forbidId = false,
  forbidBbox = false,
}: {
  name: string;
  id: string;
  pageNumber: number;
  bbox: SymbolSearchMatch["bbox"];
  confidences: number[];
  forbidConfidence?: boolean;
  forbidId?: boolean;
  forbidBbox?: boolean;
}): SymbolSearchMatch {
  let confidenceReads = 0;
  return {
    get id() {
      stageTrace.push(["get", `${name}.id`]);
      if (forbidId) throw new Error(`${name}.id must stay cold`);
      return id;
    },
    get pageNumber() {
      stageTrace.push(["get", `${name}.pageNumber`]);
      return pageNumber;
    },
    get bbox() {
      stageTrace.push(["get", `${name}.bbox`]);
      if (forbidBbox) throw new Error(`${name}.bbox must stay cold`);
      return bbox;
    },
    get confidence() {
      stageTrace.push(["get", `${name}.confidence`]);
      if (forbidConfidence) throw new Error(`${name}.confidence must stay cold`);
      const value = confidences[Math.min(confidenceReads, confidences.length - 1)];
      confidenceReads += 1;
      return value;
    },
    get method(): SymbolSearchMatch["method"] {
      throw new Error(`${name}.method must stay cold`);
    },
  };
}

function trackedResults(matches: SymbolSearchMatch[]): SymbolSearchResult {
  let trackedMatches: SymbolSearchMatch[];
  trackedMatches = new Proxy(matches, {
    get(object, property, receiver) {
      if (property !== "filter") return Reflect.get(object, property, receiver);
      stageTrace.push(["get", "matches.filter"]);
      return function (this: unknown, ...args: unknown[]): unknown {
        stageTrace.push(["call", "matches.filter", this === trackedMatches]);
        return Reflect.apply(Array.prototype.filter, this, args);
      };
    },
  });
  return {
    get templateBbox(): SymbolSearchResult["templateBbox"] {
      throw new Error("symbol render stage must not read templateBbox");
    },
    get sourcePageNumber(): SymbolSearchResult["sourcePageNumber"] {
      throw new Error("symbol render stage must not read sourcePageNumber");
    },
    get matches() {
      stageTrace.push(["get", "results.matches"]);
      return trackedMatches;
    },
    get totalMatches(): SymbolSearchResult["totalMatches"] {
      throw new Error("symbol render stage must not read totalMatches");
    },
    get pagesWithMatches(): SymbolSearchResult["pagesWithMatches"] {
      throw new Error("symbol render stage must not read pagesWithMatches");
    },
    get searchedAt(): SymbolSearchResult["searchedAt"] {
      throw new Error("symbol render stage must not read searchedAt");
    },
  };
}

function trackedDismissed(ids: string[]): Set<string> {
  const target = new Set(ids);
  let proxy: Set<string>;
  proxy = new Proxy(target, {
    get(object, property) {
      if (property !== "has") return Reflect.get(object, property, object);
      stageTrace.push(["get", "dismissed.has"]);
      return function (this: unknown, id: string): boolean {
        stageTrace.push(["call", "dismissed.has", id, this === proxy]);
        return object.has(id);
      };
    },
  });
  return proxy;
}

function lastIndexOfCall(trace: StageTraceEntry[], method: string): number {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (entry[0] === "call" && entry[1] === method) return index;
  }
  return -1;
}

async function renderLatestDraw({
  results,
  confidence = 0.75,
  dismissed = trackedDismissed([]),
}: {
  results: SymbolSearchResult | null;
  confidence?: number;
  dismissed?: Set<string>;
}): Promise<{ trace: StageTraceEntry[]; state: CanvasState }> {
  setViewerStoreStateForTest({
    symbolSearchResults: results,
    symbolSearchConfidence: confidence,
    dismissedSymbolMatches: dismissed,
    llmHighlight: results === null
      ? { pageNumber: 2, bbox: [0, 0, 0.125, 0.125] }
      : null,
  });
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
    if (results) expect(record.trace).toContainEqual(["get", "results.matches"]);
  });
  const clearIndex = lastIndexOfCall(record.trace, "clearRect");
  return { trace: record.trace.slice(clearIndex + 1), state: record.state() };
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasRecords = new WeakMap();
  stageTrace = [];
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("fetch", vi.fn((url: unknown) => {
    throw new Error(`Unexpected fetch in symbol render freeze: ${String(url)}`);
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
    symbolSearchResults: null,
    symbolSearchConfidence: 0.75,
    dismissedSymbolMatches: new Set<string>(),
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

describe("AnnotationOverlay symbol-search result render freeze", () => {
  it("filters eagerly in source order, preserves short circuits, and paints exact LTWH matches", async () => {
    const matches = [
      trackedMatch({
        name: "offpage",
        id: "offpage",
        pageNumber: 2,
        bbox: [0, 0, 1, 1],
        confidences: [1],
        forbidConfidence: true,
        forbidId: true,
        forbidBbox: true,
      }),
      trackedMatch({
        name: "coercible",
        id: "coercible",
        pageNumber: "1" as unknown as number,
        bbox: [0, 0, 1, 1],
        confidences: [1],
        forbidConfidence: true,
        forbidId: true,
        forbidBbox: true,
      }),
      trackedMatch({
        name: "below",
        id: "below",
        pageNumber: 1,
        bbox: [0, 0, 1, 1],
        confidences: [0.749],
        forbidId: true,
        forbidBbox: true,
      }),
      trackedMatch({
        name: "dismissed",
        id: "dismissed",
        pageNumber: 1,
        bbox: [0, 0, 1, 1],
        confidences: [0.75],
        forbidBbox: true,
      }),
      trackedMatch({
        name: "boundary",
        id: "boundary",
        pageNumber: 1,
        bbox: [0.125, 0.25, 0.375, 0.5],
        confidences: [0.75, 0.75],
      }),
      trackedMatch({
        name: "dynamic",
        id: "dynamic",
        pageNumber: 1,
        bbox: [0.5, 0.125, 0.25, 0.375],
        confidences: [0.751, 0.806],
      }),
    ];

    const latest = await renderLatestDraw({
      results: trackedResults(matches),
      dismissed: trackedDismissed(["dismissed"]),
    });

    expect(latest.trace).toEqual([
      ["get", "results.matches"],
      ["get", "matches.filter"],
      ["call", "matches.filter", true],
      ["get", "offpage.pageNumber"],
      ["get", "coercible.pageNumber"],
      ["get", "below.pageNumber"],
      ["get", "below.confidence"],
      ["get", "dismissed.pageNumber"],
      ["get", "dismissed.confidence"],
      ["get", "dismissed.has"],
      ["get", "dismissed.id"],
      ["call", "dismissed.has", "dismissed", true],
      ["get", "boundary.pageNumber"],
      ["get", "boundary.confidence"],
      ["get", "dismissed.has"],
      ["get", "boundary.id"],
      ["call", "dismissed.has", "boundary", true],
      ["get", "dynamic.pageNumber"],
      ["get", "dynamic.confidence"],
      ["get", "dismissed.has"],
      ["get", "dynamic.id"],
      ["call", "dismissed.has", "dynamic", true],
      ["get", "boundary.bbox"],
      ["set", "fillStyle", "rgba(34,211,238,0.15)"],
      ["call", "fillRect", 25, 25, 75, 50],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 2.5],
      ["call", "setLineDash", []],
      ["call", "strokeRect", 25, 25, 75, 50],
      ["set", "font", "bold 10px sans-serif"],
      ["set", "fillStyle", "#22d3ee"],
      ["get", "boundary.confidence"],
      ["call", "fillText", "75%", 27, 22],
      ["get", "dynamic.bbox"],
      ["set", "fillStyle", "rgba(34,211,238,0.15)"],
      ["call", "fillRect", 100, 12.5, 50, 37.5],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 2.5],
      ["call", "setLineDash", []],
      ["call", "strokeRect", 100, 12.5, 50, 37.5],
      ["set", "font", "bold 10px sans-serif"],
      ["set", "fillStyle", "#22d3ee"],
      ["get", "dynamic.confidence"],
      ["call", "fillText", "81%", 102, 9.5],
    ]);
    expect(latest.state).toEqual({
      dash: [],
      fillStyle: "#22d3ee",
      strokeStyle: "#22d3ee",
      lineWidth: 2.5,
      globalAlpha: 0.37,
      font: "bold 10px sans-serif",
    });
  });

  it("keeps a null result completely cold after the canvas clear", async () => {
    const latest = await renderLatestDraw({ results: null });
    expect(latest.trace).toEqual([]);
    expect(latest.state).toEqual({
      dash: [9, 3],
      fillStyle: "inherited-fill",
      strokeStyle: "inherited-stroke",
      lineWidth: 7,
      globalAlpha: 0.37,
      font: "italic 13px serif",
    });
  });

  it("gets an empty matches collection once while keeping canvas state cold", async () => {
    const latest = await renderLatestDraw({ results: trackedResults([]) });
    expect(latest.trace).toEqual([
      ["get", "results.matches"],
      ["get", "matches.filter"],
      ["call", "matches.filter", true],
    ]);
    expect(latest.state).toEqual({
      dash: [9, 3],
      fillStyle: "inherited-fill",
      strokeStyle: "inherited-stroke",
      lineWidth: 7,
      globalAlpha: 0.37,
      font: "italic 13px serif",
    });
  });
});

function exactSlice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error(`Missing ordered source slice: ${start} -> ${end}`);
  }
  return source.slice(from, to);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const SYMBOL_SEARCH_RESULTS = readFileSync(
  join(process.cwd(), "src/components/viewer/render/symbolSearchResults.ts"),
  "utf8",
);

function expectPostMoveOrder(source: string): void {
  const annotations = source.indexOf("  // Draw annotations");
  const symbol = source.indexOf("    // Draw symbol search results on current page");
  const symbolCall = source.indexOf("drawSymbolSearchResults(ctx, {", symbol);
  const cells = source.indexOf("    // Draw TATR cell structure overlays", symbolCall);
  const tableCellCall = source.indexOf("drawTableCellStructure(ctx, {", cells);
  const llmCall = source.indexOf("drawLlmHighlight(ctx, {", tableCellCall);
  const tableTagCall = source.indexOf("drawTableTagViews(ctx, {", llmCall);
  const areaCall = source.indexOf("drawAreaPolygons(ctx, {", tableTagCall);
  const linearCall = source.indexOf("drawLinearPolylines(ctx, {", areaCall);
  const groupCall = source.indexOf("drawGroupRings(ctx, {", linearCall);
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
    groupCall,
  );
  expect(annotations).toBeGreaterThan(-1);
  expect(symbol).toBeGreaterThan(annotations);
  expect(symbolCall).toBeGreaterThan(symbol);
  expect(cells).toBeGreaterThan(symbolCall);
  expect(tableCellCall).toBeGreaterThan(cells);
  expect(llmCall).toBeGreaterThan(tableCellCall);
  expect(tableTagCall).toBeGreaterThan(llmCall);
  expect(areaCall).toBeGreaterThan(tableTagCall);
  expect(linearCall).toBeGreaterThan(areaCall);
  expect(groupCall).toBeGreaterThan(linearCall);
  expect(dependencies).toBeGreaterThan(groupCall);
}

describe("AnnotationOverlay symbol-search result post-move topology", () => {
  it("pins the exact AO, import, earlier driver, pure call, next pure call, and dependencies", () => {
    expect(count(AO, "\n")).toBe(1_732);
    expect(Buffer.byteLength(AO, "utf8")).toBe(74_787);
    expect(sha256(AO)).toBe(
      "734e7d5ffdc2002fdd176b46b04b3bf0b0b98ae6a0839799ab279c6bfa7530f4",
    );

    const symbolImport =
      'import { drawSymbolSearchResults } from "./render/symbolSearchResults";\n';
    expect(count(AO, symbolImport)).toBe(1);
    expect(Buffer.byteLength(symbolImport, "utf8")).toBe(72);
    expect(sha256(symbolImport)).toBe(
      "2187e5902ee3c59b514cfad3b75dd45821d6c2995a20f12a5c69582e1cedf3bc",
    );

    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Draw symbol search results on current page\n",
    );
    expect(count(prefix, "\n")).toBe(91);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(3_449);
    expect(sha256(prefix)).toBe(
      "5cd1b04a9f6adc2e77c38f51a86ddba3635a13be876edf68b4613ad550df4e3a",
    );

    const symbolCall = exactSlice(
      AO,
      "    // Draw symbol search results on current page\n",
      "    // Draw TATR cell structure overlays\n",
    );
    expect(count(symbolCall, "\n")).toBe(10);
    expect(Buffer.byteLength(symbolCall, "utf8")).toBe(226);
    expect(sha256(symbolCall)).toBe(
      "8e0f5bddbe341d94763a9f1ae2115de5aa4fb64aa315d242f04877a9ae32acef",
    );
    expect(count(symbolCall, "drawSymbolSearchResults(ctx, {")).toBe(1);
    expect(symbolCall).toContain("symbolSearchResults,");
    expect(symbolCall).toContain("pageNumber,");
    expect(symbolCall).toContain("symbolSearchConfidence,");
    expect(symbolCall).toContain("dismissedSymbolMatches,");
    expect(symbolCall).toContain("width,");
    expect(symbolCall).toContain("height,");

    const tableCellCall = exactSlice(
      AO,
      "    // Draw TATR cell structure overlays\n",
      "    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)\n",
    );
    expect(count(tableCellCall, "\n")).toBe(9);
    expect(Buffer.byteLength(tableCellCall, "utf8")).toBe(185);
    expect(sha256(tableCellCall)).toBe(
      "bbf04c7d2f0a259dbba5025079669f6678690e1cbee067d9e69c06029c519616",
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

  it("keeps one ordered call, one pure helper, and biting source self-oracles", () => {
    expectPostMoveOrder(AO);
    expect(count(AO, "    // Draw symbol search results on current page\n")).toBe(1);
    expect(count(AO, 'import { drawSymbolSearchResults } from "./render/symbolSearchResults";')).toBe(1);
    expect(count(AO, "drawSymbolSearchResults(ctx, {")).toBe(1);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/symbolSearchResults.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/symbolSearchResults.test.ts",
    ))).toBe(true);
    expect(count(AO, "symbolSearchResults.matches.filter(")).toBe(0);
    expect(() => expectPostMoveOrder(
      AO.replace("drawSymbolSearchResults(ctx, {", "missingSymbolSearchResults(ctx, {"),
    )).toThrow();

    const symbolCall = exactSlice(
      AO,
      "    // Draw symbol search results on current page\n",
      "    // Draw TATR cell structure overlays\n",
    );
    const reordered = AO
      .replace(symbolCall, "")
      .replace(
        "    // Draw active table/keynote tag views",
        `${symbolCall}    // Draw active table/keynote tag views`,
      );
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(count(SYMBOL_SEARCH_RESULTS, "\n")).toBe(65);
    expect(Buffer.byteLength(SYMBOL_SEARCH_RESULTS, "utf8")).toBe(1_913);
    expect(sha256(SYMBOL_SEARCH_RESULTS)).toBe(
      "54c421a50dab6b02595c0aaf16fc1e8cee038ce3d6eddd621d6bd6dd39c2dfcf",
    );
    expect(count(SYMBOL_SEARCH_RESULTS, "symbolSearchResults.matches.filter(")).toBe(1);
    expect(count(SYMBOL_SEARCH_RESULTS, "m.pageNumber")).toBe(1);
    expect(count(SYMBOL_SEARCH_RESULTS, "m.confidence")).toBe(1);
    expect(count(SYMBOL_SEARCH_RESULTS, "match.confidence")).toBe(1);
    expect(count(SYMBOL_SEARCH_RESULTS, "dismissedSymbolMatches.has(m.id)")).toBe(1);
    expect(count(SYMBOL_SEARCH_RESULTS, "ctx.setLineDash([])")).toBe(1);
    expect(SYMBOL_SEARCH_RESULTS).not.toMatch(/@\/(stores|queries)|fetch\(|persist|from "react"/i);
  });
});
