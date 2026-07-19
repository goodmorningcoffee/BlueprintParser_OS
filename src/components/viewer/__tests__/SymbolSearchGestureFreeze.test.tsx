// @vitest-environment jsdom
//
// [refactor jul18 P3.2] Authored PRE-MOVE as the executable symbolSearch mousedown freeze; its
// topology block is rewritten POST-MOVE. The legacy branch was a terminal deferred-rectangle
// start: every symbolTemplate press stopped propagation and returned, including a start rejected
// by reentrant exact-activation ownership. Shared settlement deliberately stays in the overlay.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "symbol-search-gesture-fixture";
const PAGE_NUMBER = 2;
const WIDTH = 200;
const HEIGHT = 100;

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

function seedOverlay(activeTakeoffItemId: number | null = null): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  parentMouseDown.mockClear();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 74,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE_NUMBER,
    numPages: 3,
    pageNames: { 1: "A-101", 2: "A-102", 3: "A-103" },
    mode: "pointer",
    activeTool: null,
    activeTakeoffItemId,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    symbolSearchTemplateBbox: null,
    symbolSearchSourcePage: null,
  });
  seedAnnotations(queryClient, []);
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

async function activateSymbol(canvas: HTMLCanvasElement) {
  act(() => useToolStore.getState().setSymbolSearchActive(true));
  await waitFor(() => expect(canvas.style.cursor).toBe("crosshair"));
  const activation = useToolStore.getState().activeTool;
  if (activation?.kind !== "symbolTemplate") {
    throw new Error("Expected symbolTemplate activation");
  }
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

function drawingState() {
  const { _drawing, _drawStart, _drawEnd } = useToolStore.getState();
  return { _drawing, _drawStart, _drawEnd };
}

describe("symbolSearch gesture freeze (real overlay)", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
  });

  it("stops before exact start publications and reverse-settles anisotropic bbox/page/fallback", async () => {
    seedOverlay(812);
    const canvas = await mountCanvas();
    const activation = await activateSymbol(canvas);
    const journal: string[] = [];
    const drawingPublications: boolean[] = [];
    const startPublications: Array<{ x: number; y: number }> = [];
    const endPublications: Array<{ x: number; y: number }> = [];
    const bboxPublications: Array<[number, number, number, number]> = [];
    const pagePublications: number[] = [];
    const originalStop = Event.prototype.stopPropagation;
    vi.spyOn(Event.prototype, "stopPropagation").mockImplementation(function (this: Event) {
      journal.push("stop");
      originalStop.call(this);
    });
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state._drawing !== previous._drawing) {
        drawingPublications.push(state._drawing);
        if (state._drawing) journal.push("drawing");
      }
      if (state._drawStart !== previous._drawStart) startPublications.push(state._drawStart);
      if (state._drawEnd !== previous._drawEnd) endPublications.push(state._drawEnd);
      if (state.symbolSearchTemplateBbox !== previous.symbolSearchTemplateBbox &&
          state.symbolSearchTemplateBbox !== null) {
        bboxPublications.push(state.symbolSearchTemplateBbox);
      }
      if (state.symbolSearchSourcePage !== previous.symbolSearchSourcePage &&
          state.symbolSearchSourcePage !== null) {
        pagePublications.push(state.symbolSearchSourcePage);
      }
    });

    try {
      expect(press(canvas, 180, 80)).toBe(true);
      expect(journal).toEqual(["stop", "drawing"]);
      expect(parentMouseDown).not.toHaveBeenCalled();
      expect(drawingState()).toEqual({
        _drawing: true,
        _drawStart: { x: 180, y: 80 },
        _drawEnd: { x: 180, y: 80 },
      });
      expect(drawingPublications).toEqual([true]);
      expect(startPublications).toEqual([{ x: 180, y: 80 }]);
      expect(endPublications).toEqual([{ x: 180, y: 80 }]);

      move(canvas, 40, 30);
      expect(endPublications).toEqual([{ x: 180, y: 80 }, { x: 40, y: 30 }]);
      release(canvas);

      expect(useToolStore.getState()._drawing).toBe(false);
      expect(drawingPublications).toEqual([true, false]);
      expect(bboxPublications).toEqual([[0.2, 0.3, 0.9, 0.8]]);
      expect(pagePublications).toEqual([PAGE_NUMBER]);
      expect(useToolStore.getState().symbolSearchTemplateBbox).toEqual([
        0.2, 0.3, 0.9, 0.8,
      ]);
      expect(useToolStore.getState().symbolSearchSourcePage).toBe(PAGE_NUMBER);
      expect(useToolStore.getState().activeTool).not.toBe(activation);
      expect(useToolStore.getState().activeTool).toEqual({ kind: "takeoffPlacement" });
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { label: "exactly one percent", end: [2, 1] as const, accepted: true },
    { label: "x epsilon under", end: [1.999, 20] as const, accepted: false },
    { label: "y epsilon under", end: [20, 0.999] as const, accepted: false },
  ])("uses a strict independent minimum at $label", async ({ end, accepted }) => {
    seedOverlay();
    const canvas = await mountCanvas();
    const activation = await activateSymbol(canvas);

    press(canvas, 0, 0);
    move(canvas, end[0], end[1]);
    release(canvas);

    const state = useToolStore.getState();
    expect(state._drawing).toBe(false);
    if (accepted) {
      expect(state.symbolSearchTemplateBbox).toEqual([0, 0, 0.01, 0.01]);
      expect(state.symbolSearchSourcePage).toBe(PAGE_NUMBER);
      expect(state.activeTool).toBeNull();
    } else {
      expect(state.symbolSearchTemplateBbox).toBeNull();
      expect(state.symbolSearchSourcePage).toBeNull();
      expect(state.activeTool).toBe(activation);
    }
  });

  it("consumes propagation when a reentrant Symbol B makes the starter reject", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    const symbolA = await activateSymbol(canvas);
    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || !state._drawing || previous._drawing) return;
      admittedB = true;
      useToolStore.getState().setSymbolSearchActive(true);
    });

    try {
      press(canvas, 70, 40);
    } finally {
      unsubscribe();
    }

    const symbolB = useToolStore.getState().activeTool;
    expect(admittedB).toBe(true);
    expect(symbolB).toEqual(symbolA);
    expect(symbolB).not.toBe(symbolA);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(drawingState()).toEqual({
      _drawing: false,
      _drawStart: { x: 0, y: 0 },
      _drawEnd: { x: 0, y: 0 },
    });
    expect(useToolStore.getState().symbolSearchTemplateBbox).toBeNull();
    expect(useToolStore.getState().symbolSearchSourcePage).toBeNull();
  });

  it("keeps reentrant Symbol B admitted by A's bbox publication", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    const symbolA = await activateSymbol(canvas);
    let symbolB: typeof symbolA | null = null;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (symbolB || state.symbolSearchTemplateBbox === null ||
          state.symbolSearchTemplateBbox === previous.symbolSearchTemplateBbox) return;
      useToolStore.getState().setSymbolSearchActive(true);
      const candidate = useToolStore.getState().activeTool;
      if (candidate?.kind !== "symbolTemplate") {
        throw new Error("Expected reentrant symbolTemplate activation");
      }
      symbolB = candidate;
    });

    try {
      press(canvas, 20, 20);
      move(canvas, 120, 70);
      release(canvas);
    } finally {
      unsubscribe();
    }

    expect(symbolB).not.toBeNull();
    expect(symbolB).not.toBe(symbolA);
    expect(useToolStore.getState().activeTool).toBe(symbolB);
    expect(useToolStore.getState().symbolSearchTemplateBbox).toEqual([
      0.1, 0.2, 0.6, 0.7,
    ]);
    expect(useToolStore.getState().symbolSearchSourcePage).toBe(PAGE_NUMBER);
  });

  it("mouseleave cancels without publishing or deactivating the exact Symbol", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    const activation = await activateSymbol(canvas);

    press(canvas, 20, 20);
    move(canvas, 120, 70);
    act(() => {
      fireEvent.mouseLeave(canvas);
    });

    expect(useToolStore.getState()._drawing).toBe(false);
    expect(useToolStore.getState().activeTool).toBe(activation);
    expect(useToolStore.getState().symbolSearchTemplateBbox).toBeNull();
    expect(useToolStore.getState().symbolSearchSourcePage).toBeNull();
    release(canvas);
    expect(useToolStore.getState().activeTool).toBe(activation);
    expect(useToolStore.getState().symbolSearchTemplateBbox).toBeNull();
  });

  it("keeps non-primary presses ungated and unprevented while stopping propagation", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    await activateSymbol(canvas);

    expect(press(canvas, 55, 35, 2)).toBe(true);

    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(drawingState()).toEqual({
      _drawing: true,
      _drawStart: { x: 55, y: 35 },
      _drawEnd: { x: 55, y: 35 },
    });
  });
});

describe("symbolSearch seam topology pins (post-move)", () => {
  const root = process.cwd();
  const overlayPath = join(root, "src/components/viewer/AnnotationOverlay.tsx");
  const registryPath = join(root, "src/components/viewer/tools/registry.ts");
  const controllerPath = join(root, "src/components/viewer/tools/symbolSearch.ts");
  const AO = readFileSync(overlayPath, "utf8");
  const REGISTRY = readFileSync(registryPath, "utf8");
  const CONTROLLER = readFileSync(controllerPath, "utf8");
  const mouseDownStart = AO.indexOf("const handleMouseDown = useCallback(");
  const mouseMoveStart = AO.indexOf("const handleMouseMove = useCallback(");
  const MOUSEDOWN = AO.slice(mouseDownStart, mouseMoveStart);
  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const sha256 = (value: string): string =>
    createHash("sha256").update(value).digest("hex");

  it("pins the legacy branch absent and the controller as the sole mousedown home", () => {
    expect(mouseDownStart).toBeGreaterThan(-1);
    expect(mouseMoveStart).toBeGreaterThan(mouseDownStart);
    expect(existsSync(controllerPath)).toBe(true);
    expect(count(MOUSEDOWN, "// Symbol search draw mode")).toBe(0);
    expect(count(MOUSEDOWN, 'if (activeTool?.kind === "symbolTemplate")')).toBe(0);
    expect(count(CONTROLLER, 'kind: "symbolSearch"')).toBe(1);
    expect(count(CONTROLLER, 'state.activeTool?.kind === "symbolTemplate"')).toBe(1);
    expect(count(CONTROLLER, 'press.toolAtDown.activeTool?.kind === "symbolTemplate"')).toBe(1);
    expect(count(CONTROLLER, "event.stopPropagation();")).toBe(1);
    expect(count(CONTROLLER, "deferredDrawing.start(context.press.position);")).toBe(1);
    expect(CONTROLLER).not.toContain("invalidateToolTailAuthority");
    expect(CONTROLLER).not.toContain("context.press.position, false");
  });

  it("pins exact registry placement and the retained starter/factory/dependency contract", () => {
    expect(REGISTRY).toContain('import { symbolSearchController } from "./symbolSearch";');
    expect(REGISTRY).toContain(
      "keynotePickController,\n    tagPickController,\n    symbolSearchController,\n    parseRectController,",
    );
    expect(count(AO, "const startDeferredDrawing = useCallback(")).toBe(1);
    expect(count(AO, "deferredDrawing: { start: startDeferredDrawing },")).toBe(1);
    expect(AO).toContain(
      "starts, and symbolSearch starts are claimed at the registry seam",
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

  it("pins shared settlement and exact activation/page ownership outside the move", () => {
    const starterStart = AO.indexOf("  const startDeferredDrawing = useCallback(");
    const starterEnd = AO.indexOf("\n\n  useEffect(() => () => cancelDeferredDrawing()", starterStart);
    const starter = AO.slice(starterStart, starterEnd + 1);
    expect(sha256(starter)).toBe(
      "3030df80243b6359dddfdd4a75e28f1ef38e6898649d011c9fd0609131a4fc8f",
    );

    const symbolStart = AO.indexOf('      if (owner.kind === "symbolTemplate") {');
    const symbolEnd = AO.indexOf("        return;\n", symbolStart) +
      "        return;\n".length;
    const symbolTerminal = AO.slice(symbolStart, symbolEnd);
    expect(symbolTerminal).toContain("state.activeTool === owner.activation");
    expect(symbolTerminal).toContain(
      "symbolSearchTemplateBbox: bbox, symbolSearchSourcePage: lease.pageNumber",
    );
    expect(symbolTerminal).toContain(
      "publishSettledSymbolSearchDeactivate(owner.activation);",
    );
    expect(sha256(symbolTerminal)).toBe(
      "dfa921fd6436cb602a56f71807a98fcc53294afcc8896cadfb7fa9d316e77ed8",
    );
  });
});
