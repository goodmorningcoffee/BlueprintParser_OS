// @vitest-environment node
//
// [refactor jul18 P3.2] Direct contract for tagPickController. The real-overlay gesture net
// freezes the render projection and action-owned authority retirement; this isolated net pins the
// controller's terminal claims, exact request journal, continuation guards, and registry slot.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MouseEvent as ReactMouseEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolStoreState } from "@/stores/toolStore";
import type { ClientAnnotation } from "@/types";
import type { MapTagsHttpResult, MapTagsScanResponse } from "@/lib/client-map-tags";

const { requestMapTagsBatchMock } = vi.hoisted(() => ({
  requestMapTagsBatchMock: vi.fn(),
}));

vi.mock("@/lib/client-map-tags", () => ({
  requestMapTagsBatch: requestMapTagsBatchMock,
}));

import { dispatchToolMouseDown, TOOLS } from "../tools/registry";
import { tagPickController } from "../tools/tagPick";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

type ScanResult = MapTagsHttpResult<MapTagsScanResponse>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushRequestChain(): Promise<void> {
  // request -> HTTP shape -> data -> guarded publication/catch
  for (let stage = 0; stage < 8; stage += 1) await Promise.resolve();
}

function toolState(
  activeTool: unknown = { kind: "tagPick" },
  mode: ToolStoreState["mode"] = "move",
  actions: Partial<ToolStoreState> = {},
): Readonly<ToolStoreState> {
  return { activeTool, mode, ...actions } as unknown as Readonly<ToolStoreState>;
}

function annotation(
  id: number,
  name: string,
  bbox: [number, number, number, number] = [0.3, 0.2, 0.6, 0.7],
  over: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber: 2,
    name,
    bbox,
    note: null,
    source: "yolo",
    data: { modelName: "fixture-model", confidence: 0.99 },
    ...over,
  };
}

function eventWith(options: {
  button?: number;
  stopPropagation?: ReturnType<typeof vi.fn>;
  preventDefault?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    button: options.button ?? 0,
    stopPropagation: options.stopPropagation ?? vi.fn(),
    preventDefault: options.preventDefault ?? vi.fn(),
  } as unknown as ReactMouseEvent & {
    button: number;
    stopPropagation: ReturnType<typeof vi.fn>;
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

function scanRef(initial: AbortController | null = null) {
  let value = initial;
  let reads = 0;
  let writes = 0;
  const ref = {} as { current: AbortController | null };
  Object.defineProperty(ref, "current", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return value;
    },
    set(next: AbortController | null) {
      writes += 1;
      value = next;
    },
  });
  return {
    ref,
    peek: () => value,
    reads: () => reads,
    writes: () => writes,
  };
}

function harness(options: {
  position?: { x: number; y: number };
  annotations?: readonly ClientAnnotation[];
  includeAnnotations?: boolean;
  includeCapability?: boolean;
  publicId?: string;
  priorController?: AbortController | null;
} = {}) {
  const session = { publicId: options.publicId ?? "tag-pick-project" };
  const lifecycle = { live: true };
  const deactivateFresh = vi.fn();
  const publishFresh = vi.fn();
  const deactivateCaptured = vi.fn();
  const currentToolState = toolState(
    { kind: "tagPick" },
    "move",
    {
      setYoloTagPickingMode: deactivateFresh,
      setTagScanResults: publishFresh,
    },
  );
  const toolGetState = vi.fn(() => currentToolState);
  const sessionGetState = vi.fn(() => ({ publicId: session.publicId }));
  const trackedRef = scanRef(options.priorController ?? null);
  const position = options.position ?? { x: 80, y: 30 };
  const press: ToolPressSnapshot = {
    toolAtDown: toolState(),
    position,
    publicId: session.publicId,
    pageNumber: 2,
  };
  const context: ToolContext = {
    press,
    page: {
      publicId: press.publicId,
      number: 2,
      width: 200,
      height: 100,
    },
    stores: {
      tool: { getState: toolGetState },
      session: { getState: sessionGetState },
      viewerCore: { getState: vi.fn() },
      parseFlow: { getState: vi.fn() },
      ui: { getState: vi.fn() },
    } as unknown as ToolContext["stores"],
    canAdoptProjectLifecycle: () => lifecycle.live,
    ...(options.includeAnnotations === false
      ? {}
      : { pageAnnotations: options.annotations ?? [annotation(1, "Door")] }),
    ...(options.includeCapability === false
      ? {}
      : {
          tagPick: {
            scanControllerRef: trackedRef.ref,
            setPickingMode: deactivateCaptured,
          },
        }),
  };
  return {
    context,
    session,
    lifecycle,
    trackedRef,
    toolGetState,
    sessionGetState,
    deactivateFresh,
    deactivateCaptured,
    publishFresh,
  };
}

beforeEach(() => {
  requestMapTagsBatchMock.mockReset();
  requestMapTagsBatchMock.mockImplementation(() => new Promise(() => {}));
});

describe("tagPickController identity and eligibility", () => {
  it("is the frozen tagPick identity with kind-only eligibility in every mode", () => {
    expect(tagPickController.kind).toBe("tagPick");
    expect(Object.isFrozen(tagPickController)).toBe(true);
    const activationA = { kind: "tagPick" };
    const activationB = { kind: "tagPick" };
    expect(activationB).not.toBe(activationA);
    expect(activationB).toEqual(activationA);

    for (const mode of ["move", "pointer", "markup"] as const) {
      for (const activation of [activationA, activationB, { kind: "tagPick", bait: true }]) {
        const state = toolState(activation, mode);
        const press = { ...harness().context.press, toolAtDown: state };
        expect(tagPickController.matches(press)).toBe(true);
        expect(tagPickController.wantsEvents(state)).toBe(true);
      }
    }
  });

  it("rejects controller-neighbor bait, other tools, and null", () => {
    for (const activeTool of [
      { kind: "keynotePick" },
      { kind: "symbolSearch" },
      { kind: "symbolTemplate" },
      { kind: "tagAdd", tagId: "tag" },
      { kind: "parseRect", flow: "keynote" },
      null,
    ]) {
      const state = toolState(activeTool);
      const press = { ...harness().context.press, toolAtDown: state };
      expect(tagPickController.matches(press)).toBe(false);
      expect(tagPickController.wantsEvents(state)).toBe(false);
    }
  });
});

describe("tagPickController capability guards and geometry", () => {
  it.each([
    {
      label: "pageAnnotations",
      includeAnnotations: false,
      includeCapability: true,
      message: "tagPick controller requires pageAnnotations",
    },
    {
      label: "request capability",
      includeAnnotations: true,
      includeCapability: false,
      message: "tagPick controller requires its request capability",
    },
  ])("fails for missing $label before every effect", ({
    includeAnnotations,
    includeCapability,
    message,
  }) => {
    const h = harness({ includeAnnotations, includeCapability });
    const event = eventWith();

    expect(() => tagPickController.onMouseDown(event, h.context)).toThrow(message);

    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(h.toolGetState).not.toHaveBeenCalled();
    expect(h.sessionGetState).not.toHaveBeenCalled();
    expect(h.deactivateFresh).not.toHaveBeenCalled();
    expect(h.deactivateCaptured).not.toHaveBeenCalled();
    expect(h.trackedRef.reads()).toBe(0);
    expect(h.trackedRef.writes()).toBe(0);
    expect(requestMapTagsBatchMock).not.toHaveBeenCalled();
  });

  it.each([
    { edge: "left", position: { x: 60, y: 45 }, hit: true },
    { edge: "top", position: { x: 90, y: 20 }, hit: true },
    { edge: "right", position: { x: 120, y: 45 }, hit: true },
    { edge: "bottom", position: { x: 90, y: 70 }, hit: true },
    { edge: "left epsilon", position: { x: 59.999, y: 45 }, hit: false },
    { edge: "top epsilon", position: { x: 90, y: 19.999 }, hit: false },
    { edge: "right epsilon", position: { x: 120.001, y: 45 }, hit: false },
    { edge: "bottom epsilon", position: { x: 90, y: 70.001 }, hit: false },
  ])("uses anisotropic inclusive max geometry at $edge", ({ position, hit }) => {
    const h = harness({ position });
    const event = eventWith();

    expect(tagPickController.onMouseDown(event, h.context)).toBe(true);

    expect(event.stopPropagation).toHaveBeenCalledTimes(hit ? 1 : 0);
    expect(requestMapTagsBatchMock).toHaveBeenCalledTimes(hit ? 1 : 0);
    expect(h.deactivateFresh).toHaveBeenCalledTimes(hit ? 1 : 0);
    expect(h.deactivateCaptured).toHaveBeenCalledTimes(hit ? 0 : 1);
  });

  it("pins inline max-form geometry at the min-plus-extent helper's ULP discriminator", () => {
    const h = harness({
      position: { x: 30, y: 50 },
      annotations: [annotation(2, "ULP hit", [0.01, 0, 0.15, 1])],
    });

    expect(tagPickController.onMouseDown(eventWith(), h.context)).toBe(true);

    expect(requestMapTagsBatchMock).toHaveBeenCalledTimes(1);
    expect(requestMapTagsBatchMock.mock.calls[0][1]).toMatchObject({ yoloClass: "ULP hit" });
  });

  it("claims an empty-projection miss through captured deactivation", () => {
    const h = harness({ annotations: [] });
    const event = eventWith();

    expect(tagPickController.onMouseDown(event, h.context)).toBe(true);

    expect(h.deactivateCaptured).toHaveBeenCalledExactlyOnceWith(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(requestMapTagsBatchMock).not.toHaveBeenCalled();
    expect(h.trackedRef.reads()).toBe(0);
  });

  it("skips non-YOLO bait and picks the first overlapping YOLO in array order", () => {
    const rows = [
      annotation(3, "User bait", undefined, { source: "user" }),
      annotation(4, "First", undefined, { data: { modelName: "first-model" } }),
      annotation(5, "Second", undefined, { data: { modelName: "second-model" } }),
    ];
    const h = harness({ annotations: rows });

    expect(tagPickController.onMouseDown(eventWith(), h.context)).toBe(true);

    expect(requestMapTagsBatchMock).toHaveBeenCalledTimes(1);
    expect(requestMapTagsBatchMock.mock.calls[0][1]).toEqual({
      action: "scanClass",
      yoloClass: "First",
      yoloModel: "first-model",
    });
  });

  it.each([
    { label: "absent", data: undefined },
    { label: "null", data: null },
    { label: "empty", data: { modelName: "" } },
  ])("uses the || model fallback when modelName is $label", ({ data }) => {
    const h = harness({
      annotations: [annotation(6, "Fallback", undefined, { data })],
    });

    tagPickController.onMouseDown(eventWith(), h.context);

    expect(requestMapTagsBatchMock.mock.calls[0][1]).toEqual({
      action: "scanClass",
      yoloClass: "Fallback",
      yoloModel: "unknown",
    });
  });
});

describe("tagPickController exact hit and miss journals", () => {
  it("orders stop -> fresh tool -> fresh session -> deactivate -> abort/install -> typed request", () => {
    const journal: string[] = [];
    const prior = new AbortController();
    vi.spyOn(prior, "abort").mockImplementation((reason?: unknown) => {
      journal.push("abort");
      AbortController.prototype.abort.call(prior, reason);
    });
    const row = annotation(1, "Door");
    Object.defineProperty(row, "data", {
      configurable: true,
      get: () => {
        journal.push("model");
        return { modelName: "fixture-model", confidence: 0.99 };
      },
    });
    Object.defineProperty(row, "name", {
      configurable: true,
      get: () => {
        journal.push("class");
        return "Door";
      },
    });
    const h = harness({ priorController: prior, annotations: [row] });
    const originalToolState = h.toolGetState();
    h.toolGetState.mockClear();
    h.toolGetState.mockImplementation(() => {
      journal.push("tool-read");
      return originalToolState;
    });
    h.sessionGetState.mockImplementation(() => {
      journal.push("session-read");
      const capturedPublicId = h.session.publicId;
      return Object.defineProperty({}, "publicId", {
        configurable: true,
        get: () => {
          journal.push("pid");
          return capturedPublicId;
        },
      }) as ReturnType<typeof h.sessionGetState>;
    });
    h.deactivateFresh.mockImplementation(() => {
      journal.push("deactivate");
      // A synchronous subscriber changing the session must not change this request's captured pid.
      h.session.publicId = "reentrant-successor";
    });
    const ref = h.context.tagPick!.scanControllerRef;
    let installed = ref.current;
    Object.defineProperty(ref, "current", {
      configurable: true,
      get: () => installed,
      set: (next: AbortController | null) => {
        journal.push("install");
        installed = next;
      },
    });
    requestMapTagsBatchMock.mockImplementation((..._args: unknown[]) => {
      journal.push("request");
      return new Promise(() => {});
    });
    const event = eventWith({
      button: 2,
      stopPropagation: vi.fn(() => journal.push("stop")),
    });

    expect(tagPickController.onMouseDown(event, h.context)).toBe(true);

    expect(journal).toEqual([
      "stop",
      "model",
      "tool-read",
      "session-read",
      "deactivate",
      "pid",
      "class",
      "abort",
      "install",
      "request",
    ]);
    expect(requestMapTagsBatchMock).toHaveBeenCalledExactlyOnceWith(
      "tag-pick-project",
      { action: "scanClass", yoloClass: "Door", yoloModel: "fixture-model" },
      { signal: installed!.signal },
    );
    expect(requestMapTagsBatchMock.mock.calls[0][2].signal).toBe(installed!.signal);
    expect(ref.current).toBe(installed);
    expect(prior.signal.aborted).toBe(true);
    expect(h.deactivateCaptured).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("deactivates a blank-pid hit before returning, without abort/request/ref replacement", () => {
    const prior = new AbortController();
    const abort = vi.spyOn(prior, "abort");
    const h = harness({ publicId: "", priorController: prior });

    expect(tagPickController.onMouseDown(eventWith(), h.context)).toBe(true);

    expect(h.toolGetState).toHaveBeenCalledTimes(1);
    expect(h.sessionGetState).toHaveBeenCalledTimes(1);
    expect(h.deactivateFresh).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.deactivateCaptured).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(h.trackedRef.peek()).toBe(prior);
    expect(h.trackedRef.writes()).toBe(0);
    expect(requestMapTagsBatchMock).not.toHaveBeenCalled();
  });

  it("claims a miss with only captured deactivation and leaves bubbling/request state untouched", () => {
    const prior = new AbortController();
    const abort = vi.spyOn(prior, "abort");
    const h = harness({
      position: { x: 10, y: 90 },
      priorController: prior,
      annotations: [annotation(7, "Miss")],
    });
    const event = eventWith({ button: 2 });

    expect(tagPickController.onMouseDown(event, h.context)).toBe(true);

    expect(h.deactivateCaptured).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.deactivateFresh).not.toHaveBeenCalled();
    expect(h.toolGetState).not.toHaveBeenCalled();
    expect(h.sessionGetState).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(requestMapTagsBatchMock).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(h.trackedRef.reads()).toBe(0);
    expect(h.trackedRef.writes()).toBe(0);
    expect(h.trackedRef.peek()).toBe(prior);
    expect(h.publishFresh).not.toHaveBeenCalled();
  });

  it("keeps request replacement local to each mounted-overlay capability", () => {
    const first = harness();
    tagPickController.onMouseDown(eventWith(), first.context);
    const firstController = first.trackedRef.peek();
    expect(firstController).toBeInstanceOf(AbortController);

    const second = harness();
    tagPickController.onMouseDown(eventWith(), second.context);
    const secondController = second.trackedRef.peek();

    expect(secondController).toBeInstanceOf(AbortController);
    expect(secondController).not.toBe(firstController);
    expect(firstController!.signal.aborted).toBe(false);
    expect(secondController!.signal.aborted).toBe(false);
    expect(requestMapTagsBatchMock).toHaveBeenCalledTimes(2);
  });
});

describe("tagPickController request settlement", () => {
  it.each([
    {
      guard: "ref identity",
      mutate: (h: ReturnType<typeof harness>) => {
        h.context.tagPick!.scanControllerRef.current = new AbortController();
      },
    },
    {
      guard: "signal",
      mutate: (h: ReturnType<typeof harness>) => {
        h.trackedRef.peek()!.abort();
      },
    },
    {
      guard: "fresh session",
      mutate: (h: ReturnType<typeof harness>) => {
        h.session.publicId = "successor-project";
      },
    },
    {
      guard: "project lifecycle",
      mutate: (h: ReturnType<typeof harness>) => {
        h.lifecycle.live = false;
      },
    },
  ])("rejects a successful response on isolated $guard failure", async ({ mutate }) => {
    const request = deferred<ScanResult>();
    requestMapTagsBatchMock.mockReturnValueOnce(request.promise);
    const h = harness();
    tagPickController.onMouseDown(eventWith(), h.context);
    mutate(h);

    request.resolve({ ok: true, data: { texts: [] } });
    await flushRequestChain();

    expect(h.publishFresh).not.toHaveBeenCalled();
  });

  it("checks current success as ref -> signal -> session -> lifecycle -> tool -> publication", async () => {
    const request = deferred<ScanResult>();
    requestMapTagsBatchMock.mockReturnValueOnce(request.promise);
    const h = harness();
    tagPickController.onMouseDown(eventWith(), h.context);
    const installed = h.trackedRef.peek();
    expect(installed).toBeInstanceOf(AbortController);

    const journal: string[] = [];
    const ref = h.context.tagPick!.scanControllerRef;
    let current = installed;
    Object.defineProperty(ref, "current", {
      configurable: true,
      get: () => {
        journal.push("ref");
        return current;
      },
      set: (next: AbortController | null) => {
        current = next;
      },
    });
    const abortedDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    );
    if (!abortedDescriptor?.get) throw new Error("AbortSignal.aborted getter unavailable");
    const abortedSpy = vi.spyOn(AbortSignal.prototype, "aborted", "get")
      .mockImplementation(function (this: AbortSignal) {
        journal.push("signal");
        return abortedDescriptor.get!.call(this) as boolean;
      });
    const liveToolState = h.toolGetState();
    h.toolGetState.mockClear();
    h.toolGetState.mockImplementation(() => {
      journal.push("tool");
      return liveToolState;
    });
    h.sessionGetState.mockClear();
    h.sessionGetState.mockImplementation(() => {
      journal.push("session");
      return { publicId: h.session.publicId } as ReturnType<typeof h.sessionGetState>;
    });
    Object.defineProperty(h.context, "canAdoptProjectLifecycle", {
      configurable: true,
      value: () => {
        journal.push("lifecycle");
        return true;
      },
    });
    h.publishFresh.mockImplementation(() => {
      journal.push("publish");
    });

    try {
      request.resolve({ ok: true, data: { texts: [] } });
      await flushRequestChain();
    } finally {
      abortedSpy.mockRestore();
    }

    expect(journal).toEqual([
      "ref",
      "signal",
      "session",
      "lifecycle",
      "tool",
      "publish",
    ]);
  });

  it("keeps a current project-wide scan adoptable across page changes", async () => {
    const request = deferred<ScanResult>();
    requestMapTagsBatchMock.mockReturnValueOnce(request.promise);
    const h = harness();
    tagPickController.onMouseDown(eventWith(), h.context);
    (h.context.page as { number: number }).number = 99;

    request.resolve({ ok: true, data: { texts: [] } });
    await flushRequestChain();

    expect(h.context.stores.viewerCore.getState).not.toHaveBeenCalled();
    expect(h.publishFresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "exact texts",
      texts: [{
        text: "D-101",
        count: 1,
        pages: [2],
        instances: [],
      }],
      expected: [{
        text: "D-101",
        count: 1,
        pages: [2],
        instances: [],
      }],
    },
    { label: "falsy texts", texts: null, expected: [] },
    { label: "empty-string wire bait", texts: "", expected: [] },
  ])("publishes current success with texts || [] for $label", async ({ texts, expected }) => {
    const request = deferred<ScanResult>();
    requestMapTagsBatchMock.mockReturnValueOnce(request.promise);
    const h = harness();
    tagPickController.onMouseDown(eventWith(), h.context);
    const installed = h.trackedRef.peek();

    request.resolve({
      ok: true,
      data: { texts } as unknown as MapTagsScanResponse,
    });
    await flushRequestChain();

    expect(installed).toBeInstanceOf(AbortController);
    expect(requestMapTagsBatchMock.mock.calls[0][2].signal).toBe(installed!.signal);
    expect(h.toolGetState).toHaveBeenCalledTimes(2);
    expect(h.sessionGetState).toHaveBeenCalledTimes(2);
    expect(h.publishFresh).toHaveBeenCalledExactlyOnceWith({
      yoloClass: "Door",
      yoloModel: "fixture-model",
      texts: expected,
    });
    expect(h.trackedRef.peek()).toBe(installed);
  });

  it.each([
    {
      silence: "AbortError",
      error: Object.assign(new Error("cancelled"), { name: "AbortError" }),
      mutate: (_h: ReturnType<typeof harness>) => {},
    },
    {
      silence: "stale request identity",
      error: new Error("stale"),
      mutate: (h: ReturnType<typeof harness>) => {
        h.context.tagPick!.scanControllerRef.current = new AbortController();
      },
    },
    {
      silence: "retired lifecycle",
      error: new Error("retired"),
      mutate: (h: ReturnType<typeof harness>) => {
        h.lifecycle.live = false;
      },
    },
  ])("silences an exact $silence rejection", async ({ error, mutate }) => {
    const request = deferred<ScanResult>();
    requestMapTagsBatchMock.mockReturnValueOnce(request.promise);
    const h = harness();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tagPickController.onMouseDown(eventWith(), h.context);
    mutate(h);

    request.reject(error);
    await flushRequestChain();

    expect(consoleError).not.toHaveBeenCalled();
    expect(h.publishFresh).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    {
      label: "current live error",
      mutate: (_h: ReturnType<typeof harness>) => {},
    },
    {
      label: "session-changed error (no catch-session guard)",
      mutate: (h: ReturnType<typeof harness>) => {
        h.session.publicId = "successor-project";
      },
    },
    {
      label: "aborted-signal ordinary error (no catch-signal guard)",
      mutate: (h: ReturnType<typeof harness>) => {
        h.trackedRef.peek()!.abort();
      },
    },
  ])("logs the exact $label", async ({ label, mutate }) => {
    const request = deferred<ScanResult>();
    const error = new Error(label);
    requestMapTagsBatchMock.mockReturnValueOnce(request.promise);
    const h = harness();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tagPickController.onMouseDown(eventWith(), h.context);
    mutate(h);

    request.reject(error);
    await flushRequestChain();

    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      "[YOLO_TAG] Class scan failed:",
      error,
    );
    expect(h.publishFresh).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("turns a non-OK response into the exact current HTTP error without consuming data", async () => {
    const request = deferred<ScanResult>();
    requestMapTagsBatchMock.mockReturnValueOnce(request.promise);
    const h = harness();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tagPickController.onMouseDown(eventWith(), h.context);

    const dataRead = vi.fn();
    const nonOk = { ok: false, status: 503 };
    Object.defineProperty(nonOk, "data", {
      get: dataRead,
    });
    request.resolve(nonOk as ScanResult);
    await flushRequestChain();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe("[YOLO_TAG] Class scan failed:");
    expect(consoleError.mock.calls[0][1]).toBeInstanceOf(Error);
    expect((consoleError.mock.calls[0][1] as Error).message).toBe("HTTP 503");
    expect(dataRead).not.toHaveBeenCalled();
    expect(h.publishFresh).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("tagPick real registry integration and topology", () => {
  it("occupies keynotePick -> tagPick -> symbolSearch -> tagAdd -> parseRect exactly", () => {
    const index = TOOLS.indexOf(tagPickController);
    expect(index).toBeGreaterThan(0);
    expect(TOOLS[index]).toBe(tagPickController);
    expect(TOOLS.slice(index - 1, index + 4).map((tool) => tool.kind)).toEqual([
      "keynotePick",
      "tagPick",
      "symbolSearch",
      "tagAdd",
      "parseRect",
    ]);
  });

  it("claims both hit and miss through one lazy real-registry context", () => {
    const hit = harness();
    const hitContext = vi.fn(() => hit.context);
    const hitEvent = eventWith();
    expect(dispatchToolMouseDown(
      TOOLS,
      hitEvent,
      hit.context.press,
      hitContext,
    )).toBe(true);
    expect(hitContext).toHaveBeenCalledTimes(1);
    expect(hitEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(requestMapTagsBatchMock).toHaveBeenCalledTimes(1);

    requestMapTagsBatchMock.mockClear();
    const miss = harness({ position: { x: 10, y: 90 } });
    const missContext = vi.fn(() => miss.context);
    const missEvent = eventWith();
    expect(dispatchToolMouseDown(
      TOOLS,
      missEvent,
      miss.context.press,
      missContext,
    )).toBe(true);
    expect(missContext).toHaveBeenCalledTimes(1);
    expect(missEvent.stopPropagation).not.toHaveBeenCalled();
    expect(miss.deactivateCaptured).toHaveBeenCalledExactlyOnceWith(false);
    expect(requestMapTagsBatchMock).not.toHaveBeenCalled();
  });

  it("keeps typed transport local and forbids alternate geometry/event/authority journals", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/viewer/tools/tagPick.ts"),
      "utf8",
    );

    expect(source).toContain('import { requestMapTagsBatch } from "@/lib/client-map-tags";');
    expect(source).toContain("function startTagScan(");
    expect(source).toContain("capability.scanControllerRef.current = controller;");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("pointInNormalizedBbox");
    expect(source).not.toContain("preventDefault");
    expect(source).not.toContain("event.button");
    expect(source).not.toContain("invalidateToolTailAuthority");
    expect(source).not.toContain("cssScale");
    expect(source).not.toContain('kind === "tagAdd"');
    expect(source).not.toMatch(/^let\s+/m);
    expect(source).not.toMatch(
      /^(?:const|var)\s+\w*(?:ControllerRef|RequestRef|ScanRef)\w*\s*=/m,
    );
  });
});
