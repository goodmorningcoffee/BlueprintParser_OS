// @vitest-environment jsdom
//
// [refactor jul19 P3.3] Direct-parent executable freeze for the free-floating active YOLO-tag
// instance paint stage. It locks the inline lookup/filter/geometry/label contract before a pure
// render-helper extraction.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { YoloTag } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "active-tag-instances-render-freeze";
const PROJECT_DB_ID = 1_941;
const WIDTH = 200;
const HEIGHT = 100;

type TagInstance = YoloTag["instances"][number];

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
}

let queryClient: QueryClient;
let canvasRecords: WeakMap<HTMLCanvasElement, CanvasRecord>;
let stageTrace: StageTraceEntry[];
let measurementWidths: number[];

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
      if (property === "measureText") trace.push(["get", "ctx.measureText"]);
      let method = generatedMethods.get(property);
      if (!method) {
        method = (...args: unknown[]) => {
          trace.push(["call", property, ...args]);
          if (property === "setLineDash") {
            dash = [...(args[0] as number[])];
          }
          if (property === "measureText") {
            const width = measurementWidths.shift();
            if (width === undefined) throw new Error("Unexpected measureText call");
            return { width };
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
  return {
    context,
    trace,
    state: () => ({
      dash: [...dash],
      fillStyle: target.fillStyle,
      strokeStyle: target.strokeStyle,
      lineWidth: target.lineWidth,
      globalAlpha: target.globalAlpha,
      font: target.font,
    }),
  };
}

function trackedInstance({
  name,
  annotationId,
  bbox,
  forbidAnnotationId = false,
  forbidBbox = false,
}: {
  name: string;
  annotationId: number | string;
  bbox: TagInstance["bbox"];
  forbidAnnotationId?: boolean;
  forbidBbox?: boolean;
}): TagInstance {
  return {
    pageNumber: 1,
    get annotationId(): number {
      stageTrace.push(["get", `${name}.annotationId`]);
      if (forbidAnnotationId) throw new Error(`${name}.annotationId must stay cold`);
      return annotationId as number;
    },
    get bbox() {
      stageTrace.push(["get", `${name}.bbox`]);
      if (forbidBbox) throw new Error(`${name}.bbox must stay cold`);
      return bbox;
    },
    get confidence(): number {
      throw new Error(`${name}.confidence must stay cold`);
    },
    get confidenceTier(): "high" {
      throw new Error(`${name}.confidenceTier must stay cold`);
    },
  };
}

function tag({
  id,
  name,
  tagText = name,
  color,
  instances,
}: {
  id: string;
  name: string;
  tagText?: string;
  color?: string;
  instances: TagInstance[];
}): YoloTag {
  return {
    id,
    name,
    tagText,
    yoloClass: "fixture",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    color,
    instances,
  };
}

function publishTags(tags: YoloTag[]): void {
  // Publish directly: one strictness fixture deliberately carries runtime annotationId "-1".
  // The production bootstrap validator correctly rejects that malformed transport value, while
  // this render boundary must remain strict if legacy/runtime data reaches the cache.
  queryClient.setQueryData<YoloTag[]>(queryKeys.yoloTags.all(PUBLIC_ID), tags);
}

function lastIndexOfCall(trace: StageTraceEntry[], method: string): number {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (entry[0] === "call" && entry[1] === method) return index;
  }
  return -1;
}

async function renderLatestDraw(expectedStrokeCount = 0): Promise<{
  trace: StageTraceEntry[];
  state: CanvasState;
}> {
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
    const strokes = record.trace.filter((entry) =>
      entry[0] === "call" && entry[1] === "strokeRect"
    );
    expect(strokes).toHaveLength(expectedStrokeCount);
  });
  const clearIndex = lastIndexOfCall(record.trace, "clearRect");
  return { trace: record.trace.slice(clearIndex + 1), state: record.state() };
}

function activePaintTrace({
  color,
  label,
  textWidth,
  x,
  y,
  width,
  height,
}: {
  color: string;
  label: string;
  textWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): StageTraceEntry[] {
  return [
    ["set", "fillStyle", "#ff00ff40"],
    ["call", "fillRect", x, y, width, height],
    ["set", "strokeStyle", color],
    ["set", "lineWidth", 3],
    ["call", "strokeRect", x, y, width, height],
    ["set", "font", "bold 11px sans-serif"],
    ["get", "ctx.measureText"],
    ["call", "measureText", label],
    ["set", "fillStyle", `${color}dd`],
    ["call", "fillRect", x, y + height + 1, textWidth + 6, 14],
    ["set", "fillStyle", "#000"],
    ["call", "fillText", label, x + 3, y + height + 12],
  ];
}

const INHERITED_STATE: CanvasState = {
  dash: [9, 3],
  fillStyle: "inherited-fill",
  strokeStyle: "inherited-stroke",
  lineWidth: 7,
  globalAlpha: 0.37,
  font: "italic 13px serif",
};

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasRecords = new WeakMap();
  stageTrace = [];
  measurementWidths = [];
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("fetch", vi.fn((url: unknown) => {
    throw new Error(`Unexpected fetch in active-tag render freeze: ${String(url)}`);
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
  });

  seedAnnotations(queryClient, []);
  seedAnnotationGroups(queryClient, [], []);
  seedTakeoff(queryClient, [], []);
  publishTags([]);
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

describe("AnnotationOverlay active free-floating tag-instance render freeze", () => {
  it("keeps first-tag metadata, last-nonempty duplicate instances, strict -1 admission, order, geometry, labels, and leakage", async () => {
    const shadowed = trackedInstance({
      name: "shadowed-first-row",
      annotationId: -1,
      bbox: [0.01, 0.02, 0.03, 0.04],
      forbidAnnotationId: true,
      forbidBbox: true,
    });
    const rejectedNegative = trackedInstance({
      name: "rejected-negative",
      annotationId: -2,
      bbox: [0.9, 0.9, 0.95, 0.95],
      forbidBbox: true,
    });
    const acceptedFirst = trackedInstance({
      name: "accepted-first",
      annotationId: -1,
      bbox: [0.75, 0.125, 0.875, 0.5],
    });
    const rejectedString = trackedInstance({
      name: "rejected-string",
      annotationId: "-1",
      bbox: [0.8, 0.8, 0.9, 0.9],
      forbidBbox: true,
    });
    const acceptedSecond = trackedInstance({
      name: "accepted-second",
      annotationId: -1,
      bbox: [0.125, 0.75, 0.375, 0.875],
    });

    publishTags([
      tag({
        id: "duplicate-active",
        name: "FIRST METADATA",
        tagText: "FIRST TEXT",
        color: "#2468ac",
        instances: [shadowed],
      }),
      tag({
        id: "duplicate-active",
        name: "LAST METADATA",
        tagText: "LAST TEXT",
        color: "#f97316",
        instances: [rejectedNegative, acceptedFirst, rejectedString, acceptedSecond],
      }),
    ]);
    setViewerStoreStateForTest({
      activeYoloTagId: "duplicate-active",
      yoloTagVisibility: new Proxy({}, {
        get() {
          throw new Error("active tag must suppress visible-tag visibility reads");
        },
      }),
    });
    measurementWidths = [31.5, 47.25];

    const latest = await renderLatestDraw(2);

    expect(latest.trace).toEqual([
      ["get", "rejected-negative.annotationId"],
      ["get", "accepted-first.annotationId"],
      ["get", "rejected-string.annotationId"],
      ["get", "accepted-second.annotationId"],
      ["get", "rejected-negative.annotationId"],
      ["get", "accepted-first.annotationId"],
      ["get", "accepted-first.bbox"],
      ...activePaintTrace({
        color: "#2468ac",
        label: "FIRST METADATA",
        textWidth: 31.5,
        x: 150,
        y: 12.5,
        width: 25,
        height: 37.5,
      }),
      ["get", "rejected-string.annotationId"],
      ["get", "accepted-second.annotationId"],
      ["get", "accepted-second.bbox"],
      ...activePaintTrace({
        color: "#2468ac",
        label: "FIRST METADATA",
        textWidth: 47.25,
        x: 25,
        y: 75,
        width: 50,
        height: 12.5,
      }),
    ]);
    expect(measurementWidths).toEqual([]);
    expect(latest.state).toEqual({
      dash: [9, 3],
      fillStyle: "#000",
      strokeStyle: "#2468ac",
      lineWidth: 3,
      globalAlpha: 0.37,
      font: "bold 11px sans-serif",
    });
    expect(latest.trace.some((entry) =>
      entry[0] === "call" && (entry[1] === "save" || entry[1] === "restore")
    )).toBe(false);
    expect(latest.trace.some((entry) =>
      entry[0] === "call" && entry[1] === "setLineDash"
    )).toBe(false);
    expect(latest.trace.some((entry) =>
      entry[0] === "set" && entry[1] === "globalAlpha"
    )).toBe(false);
  });

  it("resolves empty active color/name through cyan and tagText for every label operation", async () => {
    publishTags([tag({
      id: "fallback-active",
      name: "",
      tagText: "FALLBACK",
      color: "",
      instances: [trackedInstance({
        name: "fallback",
        annotationId: -1,
        bbox: [0.5, 0.2, 0.75, 0.6],
      })],
    })]);
    setViewerStoreStateForTest({ activeYoloTagId: "fallback-active" });
    measurementWidths = [20];

    const latest = await renderLatestDraw(1);

    expect(latest.trace).toEqual([
      ["get", "fallback.annotationId"],
      ["get", "fallback.annotationId"],
      ["get", "fallback.bbox"],
      ...activePaintTrace({
        color: "#22d3ee",
        label: "FALLBACK",
        textWidth: 20,
        x: 100,
        y: 20,
        width: 50,
        height: 40,
      }),
    ]);
    expect(measurementWidths).toEqual([]);
    expect(latest.state).toEqual({
      dash: [9, 3],
      fillStyle: "#000",
      strokeStyle: "#22d3ee",
      lineWidth: 3,
      globalAlpha: 0.37,
      font: "bold 11px sans-serif",
    });
  });

  it("keeps a valid active tag with only nonfree instances canvas-cold", async () => {
    publishTags([tag({
      id: "nonfree-active",
      name: "NONFREE",
      color: "#7c3aed",
      instances: [trackedInstance({
        name: "nonfree",
        annotationId: 42,
        bbox: [0.1, 0.2, 0.3, 0.4],
        forbidBbox: true,
      })],
    })]);
    setViewerStoreStateForTest({
      activeYoloTagId: "nonfree-active",
      yoloTagVisibility: new Proxy({}, {
        get() {
          throw new Error("active tag must suppress visible-tag visibility reads");
        },
      }),
    });

    const latest = await renderLatestDraw();

    expect(latest.trace).toEqual([
      ["get", "nonfree.annotationId"],
      ["get", "nonfree.annotationId"],
    ]);
    expect(latest.state).toEqual(INHERITED_STATE);
  });

  it("keeps the active pass and instance fields cold for a dangling active id", async () => {
    publishTags([tag({
      id: "hidden-survivor",
      name: "SURVIVOR",
      color: "#0f766e",
      instances: [trackedInstance({
        name: "hidden-survivor",
        annotationId: -1,
        bbox: [0.1, 0.2, 0.3, 0.4],
        forbidAnnotationId: true,
        forbidBbox: true,
      })],
    })]);
    setViewerStoreStateForTest({
      activeYoloTagId: "missing-active",
      yoloTagVisibility: { "hidden-survivor": false },
    });

    const latest = await renderLatestDraw();

    expect(latest.trace).toEqual([]);
    expect(latest.state).toEqual(INHERITED_STATE);
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
const ACTIVE_TAG_INSTANCES = readFileSync(
  join(process.cwd(), "src/components/viewer/render/activeTagInstances.ts"),
  "utf8",
);

const ACTIVE_HEADER =
  "    // ─── Draw free-floating active tag instances (annotationId = -1, not in annotation loop) ───\n";
const VISIBLE_HEADER =
  "    // ─── Draw visible tag instances (not the active tag) ───\n";
const SYMBOL_HEADER = "    // Draw symbol search results on current page\n";
const STRICT_REJECT = "        if (inst.annotationId !== -1) continue;";

function expectPostMoveOrder(source: string): void {
  const annotations = source.indexOf("    // Draw existing annotations");
  const active = source.indexOf(ACTIVE_HEADER);
  const activeCall = source.indexOf("drawActiveTagInstances(ctx, {", active);
  const visible = source.indexOf(VISIBLE_HEADER, activeCall);
  const visibleCall = source.indexOf("drawVisibleTagInstances(ctx, {", visible);
  const symbol = source.indexOf(SYMBOL_HEADER, visibleCall);
  const symbolCall = source.indexOf("drawSymbolSearchResults(ctx, {", symbol);
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
    symbolCall,
  );
  expect(annotations).toBeGreaterThan(-1);
  expect(active).toBeGreaterThan(annotations);
  expect(activeCall).toBeGreaterThan(active);
  expect(visible).toBeGreaterThan(activeCall);
  expect(visibleCall).toBeGreaterThan(visible);
  expect(symbol).toBeGreaterThan(visibleCall);
  expect(symbolCall).toBeGreaterThan(symbol);
  expect(dependencies).toBeGreaterThan(symbolCall);
}

describe("AnnotationOverlay active free-floating tag-instance post-move topology", () => {
  it("pins AO, import, upstream precompute/annotations, pure call, downstream calls, and dependencies", () => {
    expect(count(AO, "\n")).toBe(1_732);
    expect(Buffer.byteLength(AO, "utf8")).toBe(74_787);
    expect(sha256(AO)).toBe(
      "734e7d5ffdc2002fdd176b46b04b3bf0b0b98ae6a0839799ab279c6bfa7530f4",
    );

    const helperImport =
      'import { drawActiveTagInstances } from "./render/activeTagInstances";\n';
    expect(count(AO, helperImport)).toBe(1);
    expect(Buffer.byteLength(helperImport, "utf8")).toBe(70);
    expect(sha256(helperImport)).toBe(
      "9bd0a9e34d4b1a3fd5ae0ad333f3c56e29654524a1f155fc0b85cbb01c66042b",
    );

    const activePrecompute = exactSlice(
      AO,
      "    // ─── YOLO Tag highlighting: compute which annotations are tag instances on this page ───\n",
      "    // Visible tags: collect all visible tag instances on this page (only if explicitly toggled on)\n",
    );
    expect(count(activePrecompute, "\n")).toBe(9);
    expect(Buffer.byteLength(activePrecompute, "utf8")).toBe(454);
    expect(sha256(activePrecompute)).toBe(
      "9e237853c2caf5d5acc74b0fba073e8747f790908ee8bef2c9887ed7bc8d9918",
    );

    const annotations = exactSlice(AO, "    // Draw existing annotations\n", ACTIVE_HEADER);
    expect(count(annotations, "\n")).toBe(16);
    expect(Buffer.byteLength(annotations, "utf8")).toBe(417);
    expect(sha256(annotations)).toBe(
      "2422f753908674c7df08da0eda338df772b825cffceceea815cc1b98750ad80c",
    );

    const prefix = exactSlice(AO, "  // Draw annotations\n", ACTIVE_HEADER);
    expect(count(prefix, "\n")).toBe(73);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(2_882);
    expect(sha256(prefix)).toBe(
      "52783886b2b6694ae0c0f0abffe9dc3ff633fa6256dd30118ac542d5c810ea83",
    );

    const stage = exactSlice(AO, ACTIVE_HEADER, VISIBLE_HEADER);
    expect(count(stage, "\n")).toBe(8);
    expect(Buffer.byteLength(stage, "utf8")).toBe(222);
    expect(sha256(stage)).toBe(
      "4bc245eb6de44ef4520bf79bf03c325ed2d6bfcf869b096340a5e6b23b6b0f6e",
    );
    const semanticStage = stage.slice(0, -1);
    expect(count(semanticStage, "\n")).toBe(7);
    expect(Buffer.byteLength(semanticStage, "utf8")).toBe(221);
    expect(sha256(semanticStage)).toBe(
      "0c751f4d2a664f965da4da071d84e23b1a375b9004e611a97b19d73efa22d4b0",
    );
    expect(count(stage, "drawActiveTagInstances(ctx, {")).toBe(1);
    expect(stage).toContain("activeTag,");
    expect(stage).toContain("pageTagInstances,");
    expect(stage).toContain("width,");
    expect(stage).toContain("height,");

    const visibleCall = exactSlice(
      AO,
      VISIBLE_HEADER,
      "    // Draw in-progress rectangle (markup or table parse or symbol search)\n",
    );
    expect(count(visibleCall, "\n")).toBe(7);
    expect(Buffer.byteLength(visibleCall, "utf8")).toBe(173);
    expect(sha256(visibleCall)).toBe(
      "fabe47c339e0a7168096a5cd677a4fb9d488bfaf9a7cb1d89e127ae2c00e419f",
    );

    const symbolCall = exactSlice(
      AO,
      SYMBOL_HEADER,
      "    // Draw TATR cell structure overlays\n",
    );
    expect(count(symbolCall, "\n")).toBe(10);
    expect(Buffer.byteLength(symbolCall, "utf8")).toBe(226);
    expect(sha256(symbolCall)).toBe(
      "8e0f5bddbe341d94763a9f1ae2115de5aa4fb64aa315d242f04877a9ae32acef",
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
  });

  it("keeps one ordered call, one pure helper, and biting source oracles", () => {
    expectPostMoveOrder(AO);
    const stage = exactSlice(AO, ACTIVE_HEADER, VISIBLE_HEADER);
    const lookup = "const activeTagPageInsts = pageTagInstances.get(activeTag.id) || [];";

    expect(count(AO, ACTIVE_HEADER)).toBe(1);
    expect(count(AO, lookup)).toBe(1);
    expect(count(stage, "drawActiveTagInstances(ctx, {")).toBe(1);
    expect(count(AO, STRICT_REJECT.trim())).toBe(0);
    expect(count(AO, "drawActiveTagInstances(ctx, {")).toBe(1);
    expect(count(AO, 'from "./render/activeTagInstances"')).toBe(1);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/activeTagInstances.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/activeTagInstances.test.ts",
    ))).toBe(true);

    expect(() => expectPostMoveOrder(
      AO.replace("drawActiveTagInstances(ctx, {", "missingActiveTagInstances(ctx, {"),
    )).toThrow();
    const reordered = AO
      .replace(stage, "")
      .replace(SYMBOL_HEADER, `${stage}${SYMBOL_HEADER}`);
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(count(ACTIVE_TAG_INSTANCES, "\n")).toBe(62);
    expect(Buffer.byteLength(ACTIVE_TAG_INSTANCES, "utf8")).toBe(1_922);
    expect(sha256(ACTIVE_TAG_INSTANCES)).toBe(
      "fb4150c4aeb521d7d28ff3934ea85e1bfcc883c81e7cb380953b9a3bedc7033e",
    );
    expect(count(ACTIVE_TAG_INSTANCES, lookup)).toBe(1);
    expect(count(ACTIVE_TAG_INSTANCES, STRICT_REJECT.trim())).toBe(1);
    expect(count(ACTIVE_TAG_INSTANCES, "activeTag.color")).toBe(2);
    expect(count(ACTIVE_TAG_INSTANCES, "activeTag.name")).toBe(1);
    expect(count(ACTIVE_TAG_INSTANCES, "activeTag.tagText")).toBe(1);
    expect(count(ACTIVE_TAG_INSTANCES, "ctx.fillRect(")).toBe(2);
    expect(count(ACTIVE_TAG_INSTANCES, "ctx.strokeRect(")).toBe(1);
    expect(count(ACTIVE_TAG_INSTANCES, "ctx.measureText(")).toBe(1);
    expect(count(ACTIVE_TAG_INSTANCES, "ctx.fillText(")).toBe(1);
    expect(ACTIVE_TAG_INSTANCES).not.toMatch(
      /ctx\.(save|restore|setLineDash)|ctx\.globalAlpha|@\/(stores|queries)|fetch\(|persist|from "react"/i,
    );
  });
});
