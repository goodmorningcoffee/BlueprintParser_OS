// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the TATR table-cell structure paint
// stage. The existing gate suite owns canvas reachability; this suite freezes the complete inline
// branch/style/getter contract before a pure render-helper extraction.

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
import type { ParseFlowState } from "@/stores/parseFlowStore";
import type { LlmHighlight } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "table-cell-structure-render-freeze";
const PROJECT_DB_ID = 1_938;
const WIDTH = 200;
const HEIGHT = 100;

type TableCellStructure = NonNullable<ParseFlowState["tableCellStructure"]>;
type TableCell = TableCellStructure["cells"][number];

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
  const target: Record<PropertyKey, unknown> = {};
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

function trackedCell({
  name,
  bbox,
  highlighted,
  type,
}: {
  name: string;
  bbox: TableCell["bbox"];
  highlighted: boolean;
  type: TableCell["type"];
}): TableCell {
  return {
    get bbox() {
      stageTrace.push(["get", `${name}.bbox`]);
      return bbox;
    },
    row: 0,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    get type() {
      stageTrace.push(["get", `${name}.type`]);
      return type;
    },
    confidence: 1,
    text: name,
    get highlighted() {
      stageTrace.push(["get", `${name}.highlighted`]);
      return highlighted;
    },
  };
}

function trackedStructure({
  pageNumber,
  cells,
  forbidCells = false,
}: {
  pageNumber: number;
  cells: TableCell[];
  forbidCells?: boolean;
}): TableCellStructure {
  return {
    get pageNumber() {
      stageTrace.push(["get", "structure.pageNumber"]);
      return pageNumber;
    },
    get regionBbox(): TableCellStructure["regionBbox"] {
      throw new Error("TATR render stage must not read regionBbox");
    },
    get cells() {
      stageTrace.push(["get", "structure.cells"]);
      if (forbidCells) throw new Error("Ineligible TATR cells must stay cold");
      return cells;
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

async function renderLatestDraw({
  structure,
  visible,
  keepEffectLive = false,
}: {
  structure: TableCellStructure;
  visible: boolean;
  keepEffectLive?: boolean;
}): Promise<StageTraceEntry[]> {
  const offPageHighlight: LlmHighlight | null = keepEffectLive
    ? { pageNumber: 2, bbox: [0, 0, 0.125, 0.125] }
    : null;
  setViewerStoreStateForTest({
    tableCellStructure: structure,
    showTableCellStructure: visible,
    llmHighlight: offPageHighlight,
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
    expect(record.trace).toContainEqual(["get", "structure.pageNumber"]);
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
    throw new Error(`Unexpected fetch in TATR render freeze: ${String(url)}`);
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

describe("AnnotationOverlay TATR table-cell structure render freeze", () => {
  it("keeps structure/cell getter order, all style branches, MIN/MAX geometry, and leakage", async () => {
    const cells = [
      trackedCell({
        name: "highlighted",
        bbox: [0.125, 0.125, 0.375, 0.375],
        highlighted: true,
        type: "data",
      }),
      trackedCell({
        name: "column",
        bbox: [0.5, 0.125, 0.75, 0.375],
        highlighted: false,
        type: "column-header",
      }),
      trackedCell({
        name: "row",
        bbox: [0.125, 0.5, 0.375, 0.75],
        highlighted: false,
        type: "row-header",
      }),
      trackedCell({
        name: "data",
        bbox: [0.5, 0.5, 0.875, 0.875],
        highlighted: false,
        type: "data",
      }),
    ];
    const latestDraw = await renderLatestDraw({
      structure: trackedStructure({ pageNumber: 1, cells }),
      visible: true,
    });

    expect(latestDraw).toEqual([
      ["get", "structure.pageNumber"],
      ["get", "structure.pageNumber"],
      ["get", "structure.cells"],
      ["get", "highlighted.bbox"],
      ["get", "highlighted.highlighted"],
      ["set", "fillStyle", "rgba(34,211,238,0.25)"],
      ["call", "fillRect", 25, 12.5, 50, 25],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 2.5],
      ["call", "strokeRect", 25, 12.5, 50, 25],
      ["get", "column.bbox"],
      ["get", "column.highlighted"],
      ["get", "column.type"],
      ["set", "fillStyle", "rgba(168,85,247,0.15)"],
      ["call", "fillRect", 100, 12.5, 50, 25],
      ["set", "strokeStyle", "rgba(168,85,247,0.7)"],
      ["set", "lineWidth", 1.25],
      ["call", "strokeRect", 100, 12.5, 50, 25],
      ["get", "row.bbox"],
      ["get", "row.highlighted"],
      ["get", "row.type"],
      ["get", "row.type"],
      ["set", "fillStyle", "rgba(168,85,247,0.15)"],
      ["call", "fillRect", 25, 50, 50, 25],
      ["set", "strokeStyle", "rgba(168,85,247,0.7)"],
      ["set", "lineWidth", 1.25],
      ["call", "strokeRect", 25, 50, 50, 25],
      ["get", "data.bbox"],
      ["get", "data.highlighted"],
      ["get", "data.type"],
      ["get", "data.type"],
      ["set", "fillStyle", "rgba(34,211,238,0.05)"],
      ["call", "fillRect", 100, 50, 75, 37.5],
      ["set", "strokeStyle", "rgba(34,211,238,0.7)"],
      ["set", "lineWidth", 1],
      ["call", "strokeRect", 100, 50, 75, 37.5],
    ]);
  });

  it.each([
    { label: "hidden same-page", pageNumber: 1, visible: false },
    { label: "visible other-page", pageNumber: 2, visible: true },
  ])("keeps cells and all canvas writes cold for a $label structure", async ({
    pageNumber,
    visible,
  }) => {
    const latestDraw = await renderLatestDraw({
      structure: trackedStructure({ pageNumber, cells: [], forbidCells: true }),
      visible,
      keepEffectLive: true,
    });

    expect(latestDraw).toEqual([
      ["get", "structure.pageNumber"],
    ]);
  });
});

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const TABLE_CELL_STRUCTURE = readFileSync(
  join(process.cwd(), "src/components/viewer/render/tableCellStructure.ts"),
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
  const symbolCall = source.indexOf("drawSymbolSearchResults(ctx, {", symbol);
  const cells = source.indexOf("    // Draw TATR cell structure overlays", symbolCall);
  const tableCellCall = source.indexOf("drawTableCellStructure(ctx, {", cells);
  const llm = source.indexOf("    // Draw LLM tool use highlight");
  const llmCall = source.indexOf("drawLlmHighlight(ctx, {", llm);
  const tableTagCall = source.indexOf("drawTableTagViews(ctx, {", llmCall);
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
  expect(symbolCall).toBeGreaterThan(symbol);
  expect(cells).toBeGreaterThan(symbolCall);
  expect(tableCellCall).toBeGreaterThan(cells);
  expect(llm).toBeGreaterThan(tableCellCall);
  expect(llmCall).toBeGreaterThan(llm);
  expect(tableTagCall).toBeGreaterThan(llmCall);
  expect(areaCall).toBeGreaterThan(tableTagCall);
  expect(linearCall).toBeGreaterThan(areaCall);
  expect(groupCall).toBeGreaterThan(linearCall);
  expect(preview).toBeGreaterThan(groupCall);
  expect(dependencies).toBeGreaterThan(preview);
}

describe("AnnotationOverlay TATR table-cell structure post-move topology", () => {
  it("pins the exact earlier driver, pure call, next pure call, and dependencies", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Draw TATR cell structure overlays\n",
    );
    expect(count(prefix, "\n")).toBe(199);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(8_568);
    expect(sha256(prefix)).toBe(
      "626930ac18a13d009ec049d990d187dac166432fe0940c593061c9ad22579bdc",
    );

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
    expect(count(tableCellCall, "drawTableCellStructure(ctx, {")).toBe(1);
    expect(tableCellCall).toContain("tableCellStructure,");
    expect(tableCellCall).toContain("showTableCellStructure,");

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
    expect(count(AO, "    // Draw TATR cell structure overlays\n")).toBe(1);
    expect(count(AO, 'import { drawTableCellStructure } from "./render/tableCellStructure";')).toBe(1);
    expect(count(AO, "drawTableCellStructure(ctx, {")).toBe(1);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/tableCellStructure.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/tableCellStructure.test.ts",
    ))).toBe(true);
    expect(count(AO, "tableCellStructure.pageNumber === pageNumber")).toBe(0);
    expect(() => expectPostMoveOrder(
      AO.replace("drawTableCellStructure(ctx, {", "missingTableCellStructure(ctx, {"),
    )).toThrow();

    const tableCellCall = exactSlice(
      AO,
      "    // Draw TATR cell structure overlays\n",
      "    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)\n",
    );
    const reordered = AO
      .replace(tableCellCall, "")
      .replace(
        "    // Draw active table/keynote tag views",
        `${tableCellCall}    // Draw active table/keynote tag views`,
      );
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(Buffer.byteLength(TABLE_CELL_STRUCTURE, "utf8")).toBe(2_446);
    expect(count(TABLE_CELL_STRUCTURE, "\n")).toBe(69);
    expect(sha256(TABLE_CELL_STRUCTURE)).toBe(
      "1f416ce4abf20d4c7010ffd095a4c2644dfdf2ae72e4de24566314c08cb1f4e9",
    );
    expect(count(TABLE_CELL_STRUCTURE, "tableCellStructure.pageNumber")).toBe(1);
    expect(count(TABLE_CELL_STRUCTURE, "for (const cell of tableCellStructure.cells)")).toBe(1);
    expect(count(TABLE_CELL_STRUCTURE, "cell.highlighted")).toBe(1);
    expect(count(TABLE_CELL_STRUCTURE, "cell.type")).toBe(2);
    expect(count(TABLE_CELL_STRUCTURE, "ctx.fillRect(")).toBe(3);
    expect(count(TABLE_CELL_STRUCTURE, "ctx.strokeRect(")).toBe(1);
    expect(TABLE_CELL_STRUCTURE).not.toMatch(/@\/(stores|queries)|fetch\(|persist/i);
  });
});
