// @vitest-environment jsdom
//
// [refactor jul19 P3.2] Authored PRE-MOVE as the parent-green executable TagAdd mousedown
// characterization; the topology block is rewritten POST-MOVE. TagAdd's exact payload belongs to
// the gesture lease, while complete rectangle settlement deliberately remains in AnnotationOverlay.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { YoloTag } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "tag-add-gesture-fixture";
const PAGE_NUMBER = 2;
const WIDTH = 200;
const HEIGHT = 100;
const TAG_A = "tag-add-A";
const TAG_B = "tag-add-B";

const existingInstance = {
  pageNumber: 1,
  annotationId: 41,
  bbox: [0.05, 0.06, 0.08, 0.09] as [number, number, number, number],
  confidence: 0.72,
};

function tag(id: string, instances: YoloTag["instances"] = []): YoloTag {
  return {
    id,
    name: id,
    tagText: id,
    yoloClass: "Door",
    yoloModel: "Fixture Model",
    source: "manual",
    scope: "project",
    instances,
  };
}

let queryClient: QueryClient;
const parentMouseDown = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div onMouseDown={parentMouseDown}>{children}</div>
    </QueryClientProvider>
  );
}

function noopContext(): CanvasRenderingContext2D {
  const target = { measureText: () => ({ width: 0 }) };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => {};
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function canvasRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: WIDTH,
    bottom: HEIGHT,
    width: WIDTH,
    height: HEIGHT,
    toJSON: () => ({}),
  } as DOMRect;
}

function seedOverlay(tags: YoloTag[] = [tag(TAG_A, [existingInstance]), tag(TAG_B)]): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  parentMouseDown.mockClear();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 91,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE_NUMBER,
    numPages: 3,
    pageNames: { 1: "A-101", 2: "A-102", 3: "A-103" },
    mode: "pointer",
    activeTool: null,
    activeYoloTagId: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
  seedAnnotations(queryClient, []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: tags });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
}

async function mountCanvas(): Promise<HTMLCanvasElement> {
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
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return canvas;
}

async function activateTagAdd(canvas: HTMLCanvasElement, tagId = TAG_A) {
  act(() => useToolStore.getState().setTagAddingMode(tagId));
  await waitFor(() => expect(canvas.style.cursor).toBe("crosshair"));
  const activation = useToolStore.getState().activeTool;
  if (activation?.kind !== "tagAdd") throw new Error("Expected TagAdd activation");
  return activation;
}

function press(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  button = 0,
): boolean {
  let dispatched = false;
  act(() => {
    dispatched = fireEvent.mouseDown(canvas, {
      clientX: x,
      clientY: y,
      button,
      detail: 1,
    });
  });
  return dispatched;
}

function move(canvas: HTMLCanvasElement, x: number, y: number): void {
  act(() => {
    fireEvent.mouseMove(canvas, { clientX: x, clientY: y, buttons: 1 });
  });
}

function release(canvas: HTMLCanvasElement): void {
  act(() => {
    fireEvent.mouseUp(canvas);
  });
}

function rows(): YoloTag[] {
  return queryClient.getQueryData<YoloTag[]>(queryKeys.yoloTags.all(PUBLIC_ID)) ?? [];
}

describe("TagAdd gesture freeze (real overlay)", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
  });

  it("does not start TagAdd drawing for an inactive empty-canvas press", async () => {
    seedOverlay([tag(TAG_A, [{ ...existingInstance, pageNumber: PAGE_NUMBER }])]);
    const canvas = await mountCanvas();

    expect(press(canvas, 190, 95)).toBe(true);

    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useToolStore.getState()._drawing).toBe(false);
  });

  it("stops before exact start publications and reverse-settles the captured tag", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    act(() => useUiStore.getState().setActiveYoloTagId(TAG_B));
    const activation = await activateTagAdd(canvas, TAG_A);
    const journal: string[] = [];
    const drawingPublications: boolean[] = [];
    const startPublications: Array<{ x: number; y: number }> = [];
    const endPublications: Array<{ x: number; y: number }> = [];
    const originalStop = Event.prototype.stopPropagation;
    vi.spyOn(Event.prototype, "stopPropagation").mockImplementation(function (this: Event) {
      journal.push("stop");
      originalStop.call(this);
    });
    const unsubscribeTool = useToolStore.subscribe((state, previous) => {
      if (state._drawing !== previous._drawing) {
        drawingPublications.push(state._drawing);
        if (state._drawing) journal.push("drawing");
      }
      if (state._drawStart !== previous._drawStart) startPublications.push(state._drawStart);
      if (state._drawEnd !== previous._drawEnd) endPublications.push(state._drawEnd);
      if (previous.activeTool === activation && state.activeTool !== activation) {
        journal.push("deactivate");
      }
    });
    const rowsBefore = rows();
    let cachePublicationActiveTool: unknown;
    let installedB: ReturnType<typeof useToolStore.getState>["activeTool"] = null;
    const unsubscribeCache = queryClient.getQueryCache().subscribe(() => {
      if (rows() === rowsBefore || journal.includes("cache")) return;
      cachePublicationActiveTool = useToolStore.getState().activeTool;
      journal.push("cache");
      useToolStore.getState().setTagAddingMode(TAG_B);
      installedB = useToolStore.getState().activeTool;
    });

    try {
      expect(press(canvas, 180, 80)).toBe(true);
      expect(journal).toEqual(["stop", "drawing"]);
      expect(parentMouseDown).not.toHaveBeenCalled();
      expect(drawingPublications).toEqual([true]);
      expect(startPublications).toEqual([{ x: 180, y: 80 }]);
      expect(endPublications).toEqual([{ x: 180, y: 80 }]);

      move(canvas, 40, 30);
      release(canvas);
    } finally {
      unsubscribeCache();
      unsubscribeTool();
    }

    expect(drawingPublications).toEqual([true, false]);
    expect(endPublications).toEqual([{ x: 180, y: 80 }, { x: 40, y: 30 }]);
    expect(journal.indexOf("deactivate")).toBeGreaterThan(journal.indexOf("drawing"));
    expect(journal.indexOf("deactivate")).toBeLessThan(journal.indexOf("cache"));
    expect(cachePublicationActiveTool).not.toBe(activation);
    expect(installedB).toMatchObject({ kind: "tagAdd", tagId: TAG_B });
    expect(useToolStore.getState().activeTool).toBe(installedB);
    expect(useUiStore.getState().activeYoloTagId).toBe(TAG_B);

    const tagA = rows().find((candidate) => candidate.id === TAG_A);
    const tagB = rows().find((candidate) => candidate.id === TAG_B);
    expect(tagA?.instances).toEqual([
      existingInstance,
      {
        pageNumber: PAGE_NUMBER,
        annotationId: -1,
        bbox: [0.2, 0.3, 0.9, 0.8],
        confidence: 1,
      },
    ]);
    expect(tagB?.instances).toEqual([]);
  });

  it.each([
    { label: "exactly one percent", end: [2, 1] as const, accepted: true },
    { label: "x epsilon under", end: [1.999, 20] as const, accepted: false },
    { label: "y epsilon under", end: [20, 0.999] as const, accepted: false },
  ])("uses the strict independent minimum at $label", async ({ end, accepted }) => {
    seedOverlay([tag(TAG_A)]);
    const canvas = await mountCanvas();
    const activation = await activateTagAdd(canvas);

    press(canvas, 0, 0);
    move(canvas, end[0], end[1]);
    release(canvas);

    expect(useToolStore.getState()._drawing).toBe(false);
    if (accepted) {
      expect(rows()[0].instances).toEqual([{
        pageNumber: PAGE_NUMBER,
        annotationId: -1,
        bbox: [0, 0, 0.01, 0.01],
        confidence: 1,
      }]);
      expect(useToolStore.getState().activeTool).toBeNull();
    } else {
      expect(rows()[0].instances).toEqual([]);
      expect(useToolStore.getState().activeTool).toBe(activation);
    }
  });

  it("deactivates a missing captured tag without publishing the cache", async () => {
    seedOverlay([tag(TAG_A)]);
    const canvas = await mountCanvas();
    await activateTagAdd(canvas, "missing-tag");
    const before = rows();

    press(canvas, 20, 20);
    move(canvas, 120, 70);
    release(canvas);

    expect(useToolStore.getState().activeTool).toBeNull();
    expect(rows()).toBe(before);
    expect(rows()[0].instances).toEqual([]);
  });

  it("keeps non-primary presses ungated and unprevented while stopping propagation", async () => {
    seedOverlay([tag(TAG_A)]);
    const canvas = await mountCanvas();
    await activateTagAdd(canvas);

    expect(press(canvas, 55, 35, 2)).toBe(true);

    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useToolStore.getState()).toMatchObject({
      _drawing: true,
      _drawStart: { x: 55, y: 35 },
      _drawEnd: { x: 55, y: 35 },
    });
  });

  it("keeps reentrant TagAdd B when A's initial publication makes the starter reject", async () => {
    seedOverlay([tag(TAG_A), tag(TAG_B)]);
    const canvas = await mountCanvas();
    const tagA = await activateTagAdd(canvas, TAG_A);
    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || !state._drawing || previous._drawing) return;
      admittedB = true;
      useToolStore.getState().setTagAddingMode(TAG_B);
    });

    try {
      expect(press(canvas, 70, 40)).toBe(true);
    } finally {
      unsubscribe();
    }

    const tagB = useToolStore.getState().activeTool;
    expect(admittedB).toBe(true);
    expect(tagB?.kind).toBe("tagAdd");
    expect(tagB).not.toBe(tagA);
    expect(tagB).toEqual({ kind: "tagAdd", tagId: TAG_B });
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useToolStore.getState()).toMatchObject({
      _drawing: false,
      _drawStart: { x: 0, y: 0 },
      _drawEnd: { x: 0, y: 0 },
    });
    expect(rows().every((candidate) => candidate.instances.length === 0)).toBe(true);
  });
});

describe("TagAdd seam topology pins (pre-move)", () => {
  const root = process.cwd();
  const overlayPath = join(root, "src/components/viewer/AnnotationOverlay.tsx");
  const registryPath = join(root, "src/components/viewer/tools/registry.ts");
  const controllerPath = join(root, "src/components/viewer/tools/tagAdd.ts");
  const AO = readFileSync(overlayPath, "utf8");
  const REGISTRY = readFileSync(registryPath, "utf8");
  const mouseDownStart = AO.indexOf("const handleMouseDown = useCallback(");
  const mouseMoveStart = AO.indexOf("const handleMouseMove = useCallback(");
  const MOUSEDOWN = AO.slice(mouseDownStart, mouseMoveStart);
  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const sha256 = (value: string): string =>
    createHash("sha256").update(value).digest("hex");

  it("pins the exact legacy branch as the sole mousedown home", () => {
    expect(mouseDownStart).toBeGreaterThan(-1);
    expect(mouseMoveStart).toBeGreaterThan(mouseDownStart);
    expect(existsSync(controllerPath)).toBe(false);
    const tagAddStart = MOUSEDOWN.indexOf(
      "      // Tag Add owns its exact tag payload",
    );
    const tagAddEnd = MOUSEDOWN.indexOf(
      "      // [refactor jul18 P3.2]",
      tagAddStart,
    );
    expect(tagAddStart).toBeGreaterThan(-1);
    expect(tagAddEnd).toBeGreaterThan(tagAddStart);
    const branch = MOUSEDOWN.slice(tagAddStart, tagAddEnd);
    expect(sha256(branch)).toBe(
      "8aa12bde214622075f634826e0eb221e649113fe53676a91bb94afc461cb9f8d",
    );
    expect(count(branch, 'if (activeTool?.kind === "tagAdd")')).toBe(1);
    expect(count(branch, "e.stopPropagation();")).toBe(1);
    expect(count(branch, "startDeferredDrawing(pos);")).toBe(1);
    expect(count(branch, "return;")).toBe(1);
    expect(branch).not.toContain("preventDefault");
    expect(branch).not.toContain("e.button");
  });

  it("pins controller absence, exact nine-tool priority, and shared capability ownership", () => {
    expect(REGISTRY).not.toContain('import { tagAddController } from "./tagAdd";');
    expect(REGISTRY).not.toContain("    tagAddController,");
    expect(REGISTRY).toContain(
      "keynotePickController,\n    tagPickController,\n    symbolSearchController,\n    parseRectController,",
    );
    const entries = REGISTRY.match(/^    \w+Controller,$/gm) ?? [];
    expect(entries).toHaveLength(9);
    expect(count(AO, "const startDeferredDrawing = useCallback(")).toBe(1);
    expect(count(AO, "deferredDrawing: { start: startDeferredDrawing },")).toBe(1);

    const starterStart = AO.indexOf("  const startDeferredDrawing = useCallback(");
    const starterEnd = AO.indexOf(
      "\n\n  useEffect(() => () => cancelDeferredDrawing()",
      starterStart,
    );
    expect(starterStart).toBeGreaterThan(-1);
    expect(starterEnd).toBeGreaterThan(starterStart);
    expect(sha256(AO.slice(starterStart, starterEnd + 1))).toBe(
      "3030df80243b6359dddfdd4a75e28f1ef38e6898649d011c9fd0609131a4fc8f",
    );
  });

  it("pins the shared TagAdd terminal and exact dependency contract", () => {
    const armStart = AO.indexOf('      if (owner.kind === "tagAdd") {');
    const armEnd = AO.indexOf("      switch (owner.activation.flow)", armStart);
    expect(armStart).toBeGreaterThan(-1);
    expect(armEnd).toBeGreaterThan(armStart);
    expect(sha256(AO.slice(armStart, armEnd))).toBe(
      "bcaa6f062b4f3f72dfe6bba0384b718fede7847f4cbe2bea98537feeb75d852f",
    );

    const callbackStart = AO.indexOf("  const handleMouseDown = useCallback(");
    const callbackEnd = AO.indexOf("\n  );", callbackStart);
    const callback = AO.slice(callbackStart, callbackEnd + "\n  );".length);
    const relativeStart = callback.lastIndexOf("\n    [");
    const relativeEnd = callback.indexOf("]\n  );", relativeStart);
    const rawDependencies = callback.slice(relativeStart + 1, relativeEnd + 2);
    const members = rawDependencies
      .trim()
      .slice(1, -1)
      .split(",")
      .map((member) => member.trim())
      .filter(Boolean);
    expect(members).toHaveLength(37);
    expect(createHash("md5").update(rawDependencies).digest("hex")).toBe(
      "dada8bf65ea7834550cc1e5fc221d5ee",
    );
  });
});
