// @vitest-environment jsdom
//
// [refactor jul20 P3.3] Direct-parent executable freeze for the visible YOLO-tag instance paint
// stage. It locks the inline tier/dash/geometry contract before a pure render-helper extraction.

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
import type { YoloTag } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "visible-tag-instances-render-freeze";
const PROJECT_DB_ID = 1_940;
const WIDTH = 200;
const HEIGHT = 100;

type TagInstance = YoloTag["instances"][number];
type ConfidenceTier = NonNullable<TagInstance["confidenceTier"]>;

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
  bbox,
  tier,
  annotationId = 10,
  forbidTier = false,
}: {
  name: string;
  bbox: TagInstance["bbox"];
  tier?: ConfidenceTier;
  annotationId?: number;
  forbidTier?: boolean;
}): TagInstance {
  return {
    pageNumber: 1,
    annotationId,
    get bbox() {
      stageTrace.push(["get", `${name}.bbox`]);
      return bbox;
    },
    confidence: 1,
    get confidenceTier() {
      stageTrace.push(["get", `${name}.confidenceTier`]);
      if (forbidTier) throw new Error(`${name}.confidenceTier must stay cold`);
      return tier;
    },
  };
}

function tag({
  id,
  text,
  color,
  instances,
}: {
  id: string;
  text: string;
  color?: string;
  instances: TagInstance[];
}): YoloTag {
  return {
    id,
    name: text,
    tagText: text,
    yoloClass: "fixture",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    color,
    instances,
  };
}

function trackedVisibility(
  values: Readonly<Record<string, unknown>>,
): Record<string, boolean> {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      stageTrace.push(["get", `visibility.${property}`]);
      return values[property];
    },
  }) as Record<string, boolean>;
}

function seedTags(tags: YoloTag[]): void {
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: tags });
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

function strokeTrace(
  color: string,
  lineWidth: number,
  dash: readonly number[],
  x: number,
  y: number,
  width: number,
  height: number,
): StageTraceEntry[] {
  return [
    ["set", "strokeStyle", color],
    ["set", "lineWidth", lineWidth],
    ["call", "setLineDash", [...dash]],
    ["call", "strokeRect", x, y, width, height],
    ["call", "setLineDash", []],
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
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("fetch", vi.fn((url: unknown) => {
    throw new Error(`Unexpected fetch in visible-tag render freeze: ${String(url)}`);
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
  seedTags([]);
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

describe("AnnotationOverlay visible tag-instance render freeze", () => {
  it("keeps tier snapshots, tag/instance source order, MIN/MAX geometry, dashes, and leakage", async () => {
    seedTags([
      tag({
        id: "low",
        text: "LOW",
        color: "#111111",
        instances: [trackedInstance({
          name: "low",
          bbox: [0.75, 0.125, 0.875, 0.5],
          tier: "low",
        })],
      }),
      tag({
        id: "medium",
        text: "MEDIUM",
        color: "#222222",
        instances: [trackedInstance({
          name: "medium",
          bbox: [0.125, 0.75, 0.375, 0.875],
          tier: "medium",
        })],
      }),
      tag({
        id: "high",
        text: "HIGH",
        color: "#123456",
        instances: [
          trackedInstance({
            name: "high-first",
            bbox: [0.875, 0.625, 0.9375, 0.875],
            tier: "high",
          }),
          trackedInstance({
            name: "high-second",
            bbox: [0.25, 0.0625, 0.375, 0.1875],
            tier: "high",
          }),
        ],
      }),
      tag({
        id: "legacy",
        text: "LEGACY",
        color: "",
        instances: [trackedInstance({
          name: "legacy",
          bbox: [0.0625, 0.5, 0.1875, 0.75],
        })],
      }),
    ]);
    setViewerStoreStateForTest({
      yoloTagVisibility: trackedVisibility({}),
    });

    const latest = await renderLatestDraw(5);

    expect(latest.trace).toEqual([
      ["get", "visibility.low"],
      ["get", "low.confidenceTier"],
      ["get", "low.bbox"],
      ["get", "visibility.medium"],
      ["get", "medium.confidenceTier"],
      ["get", "medium.bbox"],
      ["get", "visibility.high"],
      ["get", "high-first.confidenceTier"],
      ["get", "high-first.bbox"],
      ["get", "high-second.confidenceTier"],
      ["get", "high-second.bbox"],
      ["get", "visibility.legacy"],
      ["get", "legacy.confidenceTier"],
      ["get", "legacy.bbox"],
      ...strokeTrace("#ef4444", 1, [2, 4], 150, 12.5, 25, 37.5),
      ...strokeTrace("#f59e0b", 1.5, [4, 3], 25, 75, 50, 12.5),
      ...strokeTrace("#123456", 1.5, [4, 3], 175, 62.5, 12.5, 25),
      ...strokeTrace("#123456", 1.5, [4, 3], 50, 6.25, 25, 12.5),
      ...strokeTrace("#22d3ee", 1.5, [4, 3], 12.5, 50, 25, 25),
    ]);
    expect(latest.state).toEqual({
      dash: [],
      fillStyle: "inherited-fill",
      strokeStyle: "#22d3ee",
      lineWidth: 1.5,
      globalAlpha: 0.37,
      font: "italic 13px serif",
    });
    expect(latest.trace.some((entry) =>
      entry[0] === "call" && (entry[1] === "save" || entry[1] === "restore")
    )).toBe(false);
  });

  it("hides only an exact-false tag before tier/bbox access and keeps canvas cold", async () => {
    seedTags([tag({
      id: "hidden",
      text: "HIDDEN",
      color: "#123456",
      instances: [trackedInstance({
        name: "hidden",
        bbox: [0.125, 0.25, 0.375, 0.5],
        tier: "high",
        forbidTier: true,
      })],
    })]);
    setViewerStoreStateForTest({
      yoloTagVisibility: trackedVisibility({ hidden: false }),
    });

    const latest = await renderLatestDraw();

    expect(latest.trace).toEqual([["get", "visibility.hidden"]]);
    expect(latest.state).toEqual(INHERITED_STATE);
  });

  it("suppresses every visible-tag builder read when a real active tag exists", async () => {
    seedTags([tag({
      id: "active",
      text: "ACTIVE",
      color: "#123456",
      instances: [trackedInstance({
        name: "active",
        bbox: [0.125, 0.25, 0.375, 0.5],
        tier: "low",
        annotationId: 42,
        forbidTier: true,
      })],
    })]);
    setViewerStoreStateForTest({
      activeYoloTagId: "active",
      yoloTagVisibility: trackedVisibility({ active: true }),
    });

    const latest = await renderLatestDraw();

    expect(latest.trace).toEqual([]);
    expect(latest.state).toEqual(INHERITED_STATE);
  });

  it("keeps visible-tag construction live when a truthy active tag id has no matching tag", async () => {
    seedTags([tag({
      id: "survivor",
      text: "SURVIVOR",
      color: "#0f766e",
      instances: [trackedInstance({
        name: "survivor",
        bbox: [0.125, 0.25, 0.375, 0.5],
        tier: "high",
      })],
    })]);
    setViewerStoreStateForTest({
      activeYoloTagId: "missing-tag",
      yoloTagVisibility: trackedVisibility({}),
    });

    const latest = await renderLatestDraw(1);

    expect(latest.trace).toEqual([
      ["get", "visibility.survivor"],
      ["get", "survivor.confidenceTier"],
      ["get", "survivor.bbox"],
      ...strokeTrace("#0f766e", 1.5, [4, 3], 25, 25, 50, 25),
    ]);
    expect(latest.state).toEqual({
      ...INHERITED_STATE,
      dash: [],
      strokeStyle: "#0f766e",
      lineWidth: 1.5,
    });
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
const VISIBLE_TAG_INSTANCES = readFileSync(
  join(process.cwd(), "src/components/viewer/render/visibleTagInstances.ts"),
  "utf8",
);

function expectPostMoveOrder(source: string): void {
  const annotations = source.indexOf("    // Draw existing annotations");
  const active = source.indexOf("    // ─── Draw free-floating active tag instances");
  const visible = source.indexOf("    // ─── Draw visible tag instances (not the active tag) ───");
  const visibleCall = source.indexOf("drawVisibleTagInstances(ctx, {", visible);
  const symbol = source.indexOf("    // Draw symbol search results on current page", visibleCall);
  const symbolCall = source.indexOf("drawSymbolSearchResults(ctx, {", symbol);
  const cells = source.indexOf("drawTableCellStructure(ctx, {", symbolCall);
  const llm = source.indexOf("drawLlmHighlight(ctx, {", cells);
  const table = source.indexOf("drawTableTagViews(ctx, {", llm);
  const area = source.indexOf("drawAreaPolygons(ctx, {", table);
  const linear = source.indexOf("drawLinearPolylines(ctx, {", area);
  const group = source.indexOf("drawGroupRings(ctx, {", linear);
  const dependencies = source.indexOf(
    "  }, [pageAnnotations, width, height, selectedId",
    group,
  );
  expect(annotations).toBeGreaterThan(-1);
  expect(active).toBeGreaterThan(annotations);
  expect(visible).toBeGreaterThan(active);
  expect(visibleCall).toBeGreaterThan(visible);
  expect(symbol).toBeGreaterThan(visibleCall);
  expect(symbolCall).toBeGreaterThan(symbol);
  expect(cells).toBeGreaterThan(symbolCall);
  expect(llm).toBeGreaterThan(cells);
  expect(table).toBeGreaterThan(llm);
  expect(area).toBeGreaterThan(table);
  expect(linear).toBeGreaterThan(area);
  expect(group).toBeGreaterThan(linear);
  expect(dependencies).toBeGreaterThan(group);
}

describe("AnnotationOverlay visible tag-instance post-move topology", () => {
  it("pins AO, import, upstream builder/prefix, pure call, bridge, downstream call, and dependencies", () => {
    expect(count(AO, "\n")).toBe(1_732);
    expect(Buffer.byteLength(AO, "utf8")).toBe(74_787);
    expect(sha256(AO)).toBe(
      "734e7d5ffdc2002fdd176b46b04b3bf0b0b98ae6a0839799ab279c6bfa7530f4",
    );

    const helperImport =
      'import { drawVisibleTagInstances } from "./render/visibleTagInstances";\n';
    expect(count(AO, helperImport)).toBe(1);
    expect(Buffer.byteLength(helperImport, "utf8")).toBe(72);
    expect(sha256(helperImport)).toBe(
      "d48affa9d69a3996721d35e2a00da7a816a951ea8e35408bf6999f0e46d45441",
    );

    const builder = exactSlice(
      AO,
      "    // Visible tags: collect all visible tag instances on this page (only if explicitly toggled on)\n",
      "\n\n    // Draw existing annotations",
    );
    expect(count(builder, "\n")).toBe(24);
    expect(Buffer.byteLength(builder, "utf8")).toBe(1_242);
    expect(sha256(builder)).toBe(
      "31a74493fe0881294c78efdc8944fec0d6ecef045e4929b7d0d43594926cc096",
    );

    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // ─── Draw visible tag instances (not the active tag) ───\n",
    );
    expect(count(prefix, "\n")).toBe(81);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(3_104);
    expect(sha256(prefix)).toBe(
      "09f593c53fd2637aff1bb2427949ac0920e2ee4a6b1118f324d7bbfc0b66e2b0",
    );

    const stage = exactSlice(
      AO,
      "    // ─── Draw visible tag instances (not the active tag) ───\n",
      "    // Draw in-progress rectangle (markup or table parse or symbol search)\n",
    );
    expect(count(stage, "\n")).toBe(7);
    expect(Buffer.byteLength(stage, "utf8")).toBe(173);
    expect(sha256(stage)).toBe(
      "fabe47c339e0a7168096a5cd677a4fb9d488bfaf9a7cb1d89e127ae2c00e419f",
    );
    const semanticStage = stage.slice(0, -1);
    expect(count(semanticStage, "\n")).toBe(6);
    expect(Buffer.byteLength(semanticStage, "utf8")).toBe(172);
    expect(sha256(semanticStage)).toBe(
      "1bae9675c5992abe8ec8eb8ad6b248e908bc48f9dcce866506e4dda55f2d542d",
    );
    expect(count(stage, "drawVisibleTagInstances(ctx, {")).toBe(1);
    expect(stage).toContain("visibleTagInstances,");
    expect(stage).toContain("width,");
    expect(stage).toContain("height,");

    const bridge = exactSlice(
      AO,
      "    // Draw in-progress rectangle (markup or table parse or symbol search)\n",
      "    // Draw symbol search results on current page\n",
    );
    expect(count(bridge, "\n")).toBe(3);
    expect(Buffer.byteLength(bridge, "utf8")).toBe(172);
    expect(sha256(bridge)).toBe(
      "b275af597e98cd0dd6d61382723e0f4108a1b4dc2635ad3ed9c0dacb9e280d6e",
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
    const header = "    // ─── Draw visible tag instances (not the active tag) ───\n";
    const loop = "    for (const vi of visibleTagInstances) {";
    expect(count(AO, header)).toBe(1);
    expect(count(AO, loop)).toBe(0);
    expect(count(AO, "vi.tier === \"low\"")).toBe(0);
    expect(count(AO, 'import { drawVisibleTagInstances } from "./render/visibleTagInstances";')).toBe(1);
    expect(count(AO, "drawVisibleTagInstances(ctx, {")).toBe(1);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/visibleTagInstances.ts",
    ))).toBe(true);
    expect(existsSync(join(
      process.cwd(),
      "src/components/viewer/render/__tests__/visibleTagInstances.test.ts",
    ))).toBe(true);

    expect(() => expectPostMoveOrder(
      AO.replace("drawVisibleTagInstances(ctx, {", "missingVisibleTagInstances(ctx, {"),
    )).toThrow();
    const stage = exactSlice(
      AO,
      header,
      "    // Draw in-progress rectangle (markup or table parse or symbol search)\n",
    );
    const reordered = AO
      .replace(stage, "")
      .replace(
        "    // Draw TATR cell structure overlays",
        `${stage}    // Draw TATR cell structure overlays`,
      );
    expect(() => expectPostMoveOrder(reordered)).toThrow();

    expect(count(VISIBLE_TAG_INSTANCES, "\n")).toBe(36);
    expect(Buffer.byteLength(VISIBLE_TAG_INSTANCES, "utf8")).toBe(1_268);
    expect(sha256(VISIBLE_TAG_INSTANCES)).toBe(
      "be0fed58bea56d8eaf6ca519043de2f40c8e9c4052cbbaf4e7c22a7c420ee5f8",
    );
    expect(count(VISIBLE_TAG_INSTANCES, loop.trim())).toBe(1);
    expect(count(VISIBLE_TAG_INSTANCES, 'vi.tier === "low"')).toBe(2);
    expect(count(VISIBLE_TAG_INSTANCES, "ctx.setLineDash(")).toBe(2);
    expect(VISIBLE_TAG_INSTANCES).toContain(
      'ctx.setLineDash(vi.tier === "low" ? [2, 4] : [4, 3]);',
    );
    expect(VISIBLE_TAG_INSTANCES).toContain("ctx.setLineDash([]);");
    expect(VISIBLE_TAG_INSTANCES).not.toMatch(
      /@\/(stores|queries)|fetch\(|persist|from "react"/i,
    );
  });
});
