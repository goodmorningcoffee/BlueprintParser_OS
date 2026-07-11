// @vitest-environment jsdom

// [refactor jul11 P2.4 B3a] RED regression net for AnnotationOverlay's scanClass transport.
//
// The scan result is project-agnostic tool state. A late project-A response must not repopulate it
// after reset installs project B, and an older scan in one project must not overwrite a newer scan.
// The deferred transport deliberately IGNORES AbortSignal: an abort-only implementation would hide
// the completion race instead of proving the invocation identity/token guard.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientAnnotation } from "@/types";
import type { ToolTagScanResults } from "@/stores/toolStore";
import { useToolStore } from "@/stores/toolStore";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PROJECT_A = "project-A";
const PROJECT_B = "project-B";
const PAGE = 1;
const MODEL = "Fixture Model";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function yoloAnnotation(
  id: number,
  name: string,
  bbox: [number, number, number, number],
): ClientAnnotation {
  return {
    id,
    pageNumber: PAGE,
    name,
    bbox,
    note: null,
    source: "yolo",
    data: { modelName: MODEL, confidence: 0.99 },
  };
}

const DOOR = yoloAnnotation(1, "Door", [0.1, 0.1, 0.4, 0.4]);
const WINDOW = yoloAnnotation(2, "Window", [0.6, 0.1, 0.9, 0.4]);

function scanTexts(label: string, annotationId: number): ToolTagScanResults["texts"] {
  return [{
    text: `${label}-101`,
    count: 1,
    pages: [PAGE],
    instances: [{
      pageNumber: PAGE,
      annotationId,
      bbox: [0.1, 0.1, 0.2, 0.2],
      confidence: 0.99,
    }],
  }];
}

let queryClient: QueryClient;
let requests: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedProject(publicId: string, annotations: ClientAnnotation[]): void {
  queryClient.setQueryData(queryKeys.annotations.all(publicId), annotations);
  queryClient.setQueryData(queryKeys.pagesWindow.active(publicId), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: PAGE, to: PAGE },
  });
  seedYoloTagsFromBootstrap(queryClient, publicId, { yoloTags: [] });
}

function installProject(publicId: string): void {
  setViewerStoreStateForTest({
    projectId: publicId === PROJECT_A ? 101 : 202,
    publicId,
    isDemo: false,
    pageNumber: PAGE,
    numPages: 1,
    mode: "pointer",
    yoloTagPickingMode: true,
    showDetections: true,
    activeModels: { [MODEL]: true },
  });
}

function canvasRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

function clickAt(canvas: HTMLCanvasElement, x: number, y: number): void {
  fireEvent.mouseDown(canvas, { clientX: x, clientY: y, button: 0 });
}

function requestBody(index: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[index][1] as RequestInit).body));
}

async function resolveScan(
  index: number,
  texts: ToolTagScanResults["texts"],
): Promise<ReturnType<typeof vi.fn>> {
  const json = vi.fn().mockResolvedValue({ texts });
  await act(async () => {
    requests[index].resolve({ ok: true, status: 200, json } as unknown as Response);
    // Flush fetch resolution, response JSON, and the following publication/guard continuation.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  return json;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (typeof url !== "string" || !url.endsWith("/map-tags-batch")) {
      throw new Error(`unexpected AnnotationOverlay scan request: ${String(url)}`);
    }
    const request = deferred<Response>();
    requests.push(request);
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());

  resetProjectData();
  seedProject(PROJECT_A, [DOOR, WINDOW]);
  installProject(PROJECT_A);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderCanvas(): HTMLCanvasElement {
  const { container } = render(
    <AnnotationOverlay width={100} height={100} cssScale={1} />,
    { wrapper },
  );
  const canvas = container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Expected AnnotationOverlay canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return canvas;
}

describe("AnnotationOverlay scanClass request ownership", () => {
  it("publishes the exact successful scan for the active project", async () => {
    const canvas = renderCanvas();
    clickAt(canvas, 20, 20);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/projects/${PROJECT_A}/map-tags-batch`);
    expect(requestBody(0)).toEqual({
      action: "scanClass",
      yoloClass: "Door",
      yoloModel: MODEL,
    });
    expect(useToolStore.getState().yoloTagPickingMode).toBe(false);

    const texts = scanTexts("Door", DOOR.id);
    await resolveScan(0, texts);

    await waitFor(() => expect(useToolStore.getState().tagScanResults).toEqual({
      yoloClass: "Door",
      yoloModel: MODEL,
      texts,
    }));
  });

  it("does not let project A repopulate project B after the project reset", async () => {
    const canvas = renderCanvas();
    clickAt(canvas, 20, 20);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const projectBSentinel: ToolTagScanResults = {
      yoloClass: "Project-B-sentinel",
      yoloModel: "B model",
      texts: scanTexts("B", 202),
    };
    seedProject(PROJECT_B, []);
    act(() => {
      resetProjectData();
      installProject(PROJECT_B);
      useToolStore.setState({ tagScanResults: projectBSentinel });
    });
    expect(useToolStore.getState().tagScanResults).toBe(projectBSentinel);

    await resolveScan(0, scanTexts("Door", DOOR.id));

    // Reference identity rejects even a same-shaped stale publication; B owns this tool preview.
    expect(useToolStore.getState().tagScanResults).toBe(projectBSentinel);
  });

  it("keeps the newer same-project scan when responses resolve in reverse order", async () => {
    const canvas = renderCanvas();
    clickAt(canvas, 20, 20); // request 0: Door
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => useToolStore.setState({ yoloTagPickingMode: true, mode: "pointer" }));
    clickAt(canvas, 70, 20); // request 1: Window
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(0)).toMatchObject({ yoloClass: "Door" });
    expect(requestBody(1)).toMatchObject({ yoloClass: "Window" });

    const windowTexts = scanTexts("Window", WINDOW.id);
    await resolveScan(1, windowTexts);
    await waitFor(() => expect(useToolStore.getState().tagScanResults).toEqual({
      yoloClass: "Window",
      yoloModel: MODEL,
      texts: windowTexts,
    }));

    await resolveScan(0, scanTexts("Door", DOOR.id));

    expect(useToolStore.getState().tagScanResults).toEqual({
      yoloClass: "Window",
      yoloModel: MODEL,
      texts: windowTexts,
    });
  });
});
