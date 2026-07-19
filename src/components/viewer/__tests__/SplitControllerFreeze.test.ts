// @vitest-environment node
//
// [refactor jul19 P3.2] Direct contract for the mechanically extracted Split mousedown
// controller. The parent real-overlay freeze proves browser integration; this file makes the
// controller-only claim values, staged capability guards, exact effect order, holed-target
// fail-closed policy, and registry stop boundary observable after the legacy AO branch has gone.

import { readFileSync } from "node:fs";
import type { MouseEvent as ReactMouseEvent } from "react";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimLatestToolOperation,
  claimToolTailAuthority,
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
  ownsLatestToolOperation,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import type { ToolStoreState } from "@/stores/toolStore";
import type { ClientAnnotation } from "@/types";
import { splitController } from "../tools/split";
import { dispatchToolMouseDown, TOOLS } from "../tools/registry";
import type {
  ToolContext,
  ToolController,
  ToolPressSnapshot,
} from "../tools/types";

type Journal = string[];
type SplitCapability = NonNullable<ToolContext["split"]>;
type SplitPreview = NonNullable<ToolStoreState["splitPreview"]>;

const MISS_MESSAGE = "Line does not cross any area polygon in exactly 2 places";
const HOLED_TARGET_MESSAGE = "Area polygons with holes cannot be split yet";

let fetchProbe: ReturnType<typeof vi.fn>;

function toolState(
  overrides: Partial<
    Pick<
      ToolStoreState,
      "activeTool" | "mode" | "splitLineA" | "splitLineB" | "splitPreview"
    >
  > = {},
): Readonly<ToolStoreState> {
  const activeTool =
    overrides.activeTool === undefined
      ? ({ kind: "split" } as const)
      : overrides.activeTool;
  return Object.freeze({
    activeTool: activeTool === null ? null : Object.freeze({ ...activeTool }),
    mode: "move",
    splitLineA: null,
    splitLineB: null,
    splitPreview: null,
    ...overrides,
  }) as unknown as Readonly<ToolStoreState>;
}

function pressFor(
  state: Readonly<ToolStoreState>,
  position: Readonly<{ x: number; y: number }> = Object.freeze({
    x: 60,
    y: 70,
  }),
): ToolPressSnapshot {
  return Object.freeze({
    toolAtDown: state,
    position,
    publicId: "split-controller",
    pageNumber: 3,
  });
}

function eventFor(journal: Journal, token: object) {
  return Object.freeze({
    button: 2,
    detail: 3,
    stopPropagation: vi.fn(() => {
      journal.push(
        `stop:tail-${ownsToolTailAuthority(token) ? "owned" : "retired"}`,
      );
    }),
    preventDefault: vi.fn(() => {
      journal.push("preventDefault");
    }),
  }) as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

function capabilityFor(
  journal: Journal,
  token: object,
): SplitCapability & {
  setLineEndpoint: ReturnType<typeof vi.fn>;
  setPreview: ReturnType<typeof vi.fn>;
  publishError: ReturnType<typeof vi.fn>;
} {
  return {
    setLineEndpoint: vi.fn(
      (which: "a" | "b", point: { x: number; y: number } | null) => {
        journal.push(
          `line:${which}:${point?.x},${point?.y}:tail-${
            ownsToolTailAuthority(token) ? "owned" : "retired"
          }`,
        );
      },
    ),
    setPreview: vi.fn((_preview: SplitPreview | null) => {
      journal.push("preview");
    }),
    publishError: vi.fn((message: string, delayMs?: number) => {
      journal.push(`error:${message}:${String(delayMs)}`);
    }),
  };
}

function contextFor(options: {
  state?: Readonly<ToolStoreState>;
  position?: Readonly<{ x: number; y: number }>;
  journal: Journal;
  token: object;
  includeSplit?: boolean;
  split?: SplitCapability;
  includeAnnotations?: boolean;
  annotations?: readonly ClientAnnotation[];
  canAdopt?: boolean;
}) {
  const press = pressFor(
    options.state ?? toolState(),
    options.position ?? Object.freeze({ x: 60, y: 70 }),
  );
  const storeRead = vi.fn(() => {
    throw new Error("Split controller must not read a store");
  });
  const stores = {
    session: { getState: storeRead },
    viewerCore: { getState: storeRead },
    tool: { getState: storeRead },
    parseFlow: { getState: storeRead },
    ui: { getState: storeRead },
  } as unknown as ToolContext["stores"];
  const canAdoptProjectLifecycle = vi.fn(() => {
    options.journal.push("canAdopt");
    return options.canAdopt ?? true;
  });
  const split = options.split ?? capabilityFor(options.journal, options.token);
  const context = Object.freeze({
    press,
    page: Object.freeze({
      publicId: press.publicId,
      number: press.pageNumber,
      width: 200,
      height: 100,
    }),
    stores,
    canAdoptProjectLifecycle,
    ...(options.includeSplit === false ? {} : { split }),
    ...(options.includeAnnotations === false
      ? {}
      : { pageAnnotations: options.annotations ?? Object.freeze([]) }),
  }) as ToolContext;
  return {
    context,
    split,
    storeRead,
    canAdoptProjectLifecycle,
  };
}

function areaAnnotation(
  id: number,
  vertices: { x: number; y: number }[],
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  const xs = vertices.map((point) => point.x);
  const ys = vertices.map((point) => point.y);
  return Object.freeze({
    id,
    pageNumber: 3,
    name: `Area ${id}`,
    bbox: Object.freeze([
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ]) as unknown as ClientAnnotation["bbox"],
    note: null,
    source: "takeoff",
    data: Object.freeze({
      type: "area-polygon",
      takeoffItemId: 41,
      color: "#22c55e",
      vertices,
      areaSqUnits: 1,
      unit: "SF",
    }),
    ...overrides,
  });
}

function installLatestSentinels() {
  const bucketFill = claimLatestToolOperation("bucketFill", {});
  const symbolSession = claimLatestToolOperation("symbolSession", {});
  return { bucketFill, symbolSession };
}

function expectForbiddenEffectsCold(
  storeRead: ReturnType<typeof vi.fn>,
  latest: ReturnType<typeof installLatestSentinels>,
): void {
  expect(storeRead).not.toHaveBeenCalled();
  expect(fetchProbe).not.toHaveBeenCalled();
  expect(ownsLatestToolOperation("bucketFill", latest.bucketFill)).toBe(true);
  expect(ownsLatestToolOperation("symbolSession", latest.symbolSession)).toBe(
    true,
  );
}

beforeEach(() => {
  fetchProbe = vi.fn();
  vi.stubGlobal("fetch", fetchProbe);
});

afterEach(() => {
  invalidateToolTailAuthority();
  invalidateLatestToolOperation("bucketFill");
  invalidateLatestToolOperation("symbolSession");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("splitController eligibility and render gate", () => {
  it("is frozen and matches/wants events for exactly the Split activation", () => {
    expect(Object.isFrozen(splitController)).toBe(true);
    expect(splitController.kind).toBe("split");

    const cases = [
      { activeTool: { kind: "split" } as const, expected: true },
      { activeTool: { kind: "bucketFill" } as const, expected: false },
      {
        activeTool: { kind: "takeoffPlacement" } as const,
        expected: false,
      },
      {
        activeTool: { kind: "parseRect", flow: "table" } as const,
        expected: false,
      },
      { activeTool: null, expected: false },
    ];
    for (const { activeTool, expected } of cases) {
      const state = toolState({ activeTool });
      expect(splitController.matches(pressFor(state))).toBe(expected);
      expect(splitController.wantsEvents(state)).toBe(expected);
    }
  });
});

describe("splitController staged capability guards", () => {
  it("preview-open stops and claims before requiring any capability", () => {
    const preview = Object.freeze({
      targetAnnotationId: 91,
      original: Object.freeze([
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ]),
      left: Object.freeze([
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.9 },
      ]),
      right: Object.freeze([
        { x: 0.5, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ]),
      lineA: Object.freeze({ x: 0.5, y: 0.1 }),
      lineB: Object.freeze({ x: 0.5, y: 0.9 }),
    }) as unknown as SplitPreview;
    const token = claimToolTailAuthority({ witness: "preview" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead, canAdoptProjectLifecycle } = contextFor({
      state: toolState({ splitPreview: preview }),
      journal,
      token,
      includeSplit: false,
      includeAnnotations: false,
    });
    const event = eventFor(journal, token);

    expect(splitController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual(["stop:tail-owned"]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true);
    expect(split.setLineEndpoint).not.toHaveBeenCalled();
    expect(split.setPreview).not.toHaveBeenCalled();
    expect(split.publishError).not.toHaveBeenCalled();
    expect(canAdoptProjectLifecycle).not.toHaveBeenCalled();
    expectForbiddenEffectsCold(storeRead, latest);
  });

  it("requires Split commands after preview, before invalidation or publication", () => {
    const token = claimToolTailAuthority({ witness: "missing-split" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, storeRead, canAdoptProjectLifecycle } = contextFor({
      journal,
      token,
      includeSplit: false,
      includeAnnotations: false,
    });
    const event = eventFor(journal, token);

    expect(() => splitController.onMouseDown(event, context)).toThrow(
      /split controller requires the split capability/,
    );

    expect(journal).toEqual(["stop:tail-owned"]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true);
    expect(canAdoptProjectLifecycle).not.toHaveBeenCalled();
    expectForbiddenEffectsCold(storeRead, latest);
  });

  it("first click needs no annotations and orders stop -> invalidate -> A", () => {
    const token = claimToolTailAuthority({ witness: "first" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead, canAdoptProjectLifecycle } = contextFor({
      journal,
      token,
      includeAnnotations: false,
      position: Object.freeze({ x: 60, y: 70 }),
    });
    const event = eventFor(journal, token);

    expect(splitController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual(["stop:tail-owned", "line:a:0.3,0.7:tail-retired"]);
    expect(split.setLineEndpoint).toHaveBeenCalledExactlyOnceWith("a", {
      x: 0.3,
      y: 0.7,
    });
    expect(split.setPreview).not.toHaveBeenCalled();
    expect(split.publishError).not.toHaveBeenCalled();
    expect(canAdoptProjectLifecycle).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    expectForbiddenEffectsCold(storeRead, latest);
  });

  it("second click fences after B and claims without requiring annotations when retired", () => {
    const capturedA = Object.freeze({ x: 0.05, y: 0.5 });
    const token = claimToolTailAuthority({ witness: "fence" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead, canAdoptProjectLifecycle } = contextFor({
      state: toolState({ splitLineA: capturedA }),
      position: Object.freeze({ x: 190, y: 50 }),
      journal,
      token,
      includeAnnotations: false,
      canAdopt: false,
    });
    const event = eventFor(journal, token);

    expect(splitController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual([
      "stop:tail-owned",
      "line:b:0.95,0.5:tail-retired",
      "canAdopt",
    ]);
    expect(split.setLineEndpoint).toHaveBeenCalledExactlyOnceWith("b", {
      x: 0.95,
      y: 0.5,
    });
    expect(split.setPreview).not.toHaveBeenCalled();
    expect(split.publishError).not.toHaveBeenCalled();
    expect(canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    expectForbiddenEffectsCold(storeRead, latest);
  });

  it("requires annotations only after B and an accepted lifecycle fence", () => {
    const token = claimToolTailAuthority({ witness: "missing-annotations" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead, canAdoptProjectLifecycle } = contextFor({
      state: toolState({ splitLineA: Object.freeze({ x: 0.05, y: 0.5 }) }),
      position: Object.freeze({ x: 190, y: 50 }),
      journal,
      token,
      includeAnnotations: false,
    });
    const event = eventFor(journal, token);

    expect(() => splitController.onMouseDown(event, context)).toThrow(
      /split controller requires pageAnnotations/,
    );

    expect(journal).toEqual([
      "stop:tail-owned",
      "line:b:0.95,0.5:tail-retired",
      "canAdopt",
    ]);
    expect(split.setLineEndpoint).toHaveBeenCalledTimes(1);
    expect(split.setPreview).not.toHaveBeenCalled();
    expect(split.publishError).not.toHaveBeenCalled();
    expect(canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    expectForbiddenEffectsCold(storeRead, latest);
  });
});

describe("splitController second-click result arms", () => {
  it("miss orders stop -> invalidate/B -> fence -> exact error and retains the claim", () => {
    const capturedA = Object.freeze({ x: 0.05, y: 0.05 });
    const token = claimToolTailAuthority({ witness: "miss" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead, canAdoptProjectLifecycle } = contextFor({
      state: toolState({ splitLineA: capturedA }),
      position: Object.freeze({ x: 190, y: 5 }),
      journal,
      token,
      annotations: Object.freeze([]),
    });
    const event = eventFor(journal, token);

    expect(splitController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual([
      "stop:tail-owned",
      "line:b:0.95,0.05:tail-retired",
      "canAdopt",
      `error:${MISS_MESSAGE}:3500`,
    ]);
    expect(split.setLineEndpoint).toHaveBeenCalledExactlyOnceWith("b", {
      x: 0.95,
      y: 0.05,
    });
    expect(split.publishError).toHaveBeenCalledExactlyOnceWith(
      MISS_MESSAGE,
      3500,
    );
    expect(split.setPreview).not.toHaveBeenCalled();
    expect(canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    expectForbiddenEffectsCold(storeRead, latest);
  });

  it("rejects the longest holed target without falling through to a shorter polygon", () => {
    const shorterVertices = Object.freeze([
      { x: 0.1, y: 0.4 },
      { x: 0.25, y: 0.4 },
      { x: 0.25, y: 0.6 },
      { x: 0.1, y: 0.6 },
    ]) as unknown as { x: number; y: number }[];
    const holedWinnerVertices = Object.freeze([
      { x: 0.3, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.9, y: 0.8 },
      { x: 0.3, y: 0.8 },
    ]) as unknown as { x: number; y: number }[];
    const holeSentinel = Object.freeze([
      { x: 0.5, y: 0.4 },
      { x: 0.7, y: 0.4 },
      { x: 0.7, y: 0.6 },
      { x: 0.5, y: 0.6 },
    ]) as unknown as { x: number; y: number }[];
    const annotations = Object.freeze([
      areaAnnotation(301, shorterVertices),
      areaAnnotation(302, holedWinnerVertices, {
        data: Object.freeze({
          type: "area-polygon",
          takeoffItemId: 41,
          color: "#22c55e",
          vertices: holedWinnerVertices,
          holes: Object.freeze([Object.freeze({ vertices: holeSentinel })]),
          areaSqUnits: 1,
          unit: "SF",
        }),
      }),
    ]);
    const capturedA = Object.freeze({ x: 0.05, y: 0.5 });
    const token = claimToolTailAuthority({ witness: "holed-winner" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead, canAdoptProjectLifecycle } = contextFor({
      state: toolState({ splitLineA: capturedA }),
      position: Object.freeze({ x: 190, y: 50 }),
      journal,
      token,
      annotations,
    });
    const event = eventFor(journal, token);

    expect(splitController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual([
      "stop:tail-owned",
      "line:b:0.95,0.5:tail-retired",
      "canAdopt",
      `error:${HOLED_TARGET_MESSAGE}:5000`,
    ]);
    expect(split.setLineEndpoint).toHaveBeenCalledExactlyOnceWith("b", {
      x: 0.95,
      y: 0.5,
    });
    expect(split.publishError).toHaveBeenCalledExactlyOnceWith(
      HOLED_TARGET_MESSAGE,
      5000,
    );
    expect(split.setPreview).not.toHaveBeenCalled();
    expect(canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expectForbiddenEffectsCold(storeRead, latest);
  });

  it("accepts the longest empty-holes target despite a shorter holed candidate", () => {
    const shorterHoledVertices = Object.freeze([
      { x: 0.05, y: 0.4 },
      { x: 0.15, y: 0.4 },
      { x: 0.15, y: 0.6 },
      { x: 0.05, y: 0.6 },
    ]) as unknown as { x: number; y: number }[];
    const vertices = Object.freeze([
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ]) as unknown as { x: number; y: number }[];
    const annotations = Object.freeze([
      areaAnnotation(400, shorterHoledVertices, {
        data: Object.freeze({
          type: "area-polygon",
          takeoffItemId: 41,
          color: "#22c55e",
          vertices: shorterHoledVertices,
          holes: Object.freeze([
            Object.freeze({
              vertices: Object.freeze([
                { x: 0.08, y: 0.45 },
                { x: 0.12, y: 0.45 },
                { x: 0.1, y: 0.55 },
              ]),
            }),
          ]),
          areaSqUnits: 1,
          unit: "SF",
        }),
      }),
      areaAnnotation(401, vertices, {
        data: Object.freeze({
          type: "area-polygon",
          takeoffItemId: 41,
          color: "#22c55e",
          vertices,
          holes: Object.freeze([]),
          areaSqUnits: 1,
          unit: "SF",
        }),
      }),
    ]);
    const token = claimToolTailAuthority({ witness: "empty-holes" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead } = contextFor({
      state: toolState({
        splitLineA: Object.freeze({ x: 0.05, y: 0.5 }),
      }),
      position: Object.freeze({ x: 190, y: 50 }),
      journal,
      token,
      annotations,
    });

    expect(splitController.onMouseDown(eventFor(journal, token), context)).toBe(
      true,
    );

    expect(split.setPreview).toHaveBeenCalledTimes(1);
    expect(split.setPreview).toHaveBeenCalledWith(
      expect.objectContaining({ targetAnnotationId: 401, original: vertices }),
    );
    expect(split.publishError).not.toHaveBeenCalled();
    expectForbiddenEffectsCold(storeRead, latest);
  });

  it("success selects the longest valid candidate and publishes the exact captured payload", () => {
    const smallVertices = Object.freeze([
      { x: 0.1, y: 0.4 },
      { x: 0.3, y: 0.4 },
      { x: 0.3, y: 0.6 },
      { x: 0.1, y: 0.6 },
    ]) as unknown as { x: number; y: number }[];
    const winningVertices = Object.freeze([
      { x: 0.4, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.9, y: 0.8 },
      { x: 0.4, y: 0.8 },
    ]) as unknown as { x: number; y: number }[];
    const baitVertices = Object.freeze([
      { x: 0.01, y: 0.1 },
      { x: 0.99, y: 0.1 },
      { x: 0.99, y: 0.9 },
      { x: 0.01, y: 0.9 },
    ]) as unknown as { x: number; y: number }[];
    const capturedA = Object.freeze({ x: 0.05, y: 0.5 });
    const annotations = Object.freeze([
      areaAnnotation(900, baitVertices, { source: "user" }),
      areaAnnotation(901, baitVertices, {
        data: Object.freeze({
          type: "count-marker",
          takeoffItemId: 41,
          color: "#ef4444",
        }),
      }),
      areaAnnotation(201, smallVertices),
      areaAnnotation(202, winningVertices),
    ]);
    const token = claimToolTailAuthority({ witness: "success" });
    const latest = installLatestSentinels();
    const journal: Journal = [];
    const { context, split, storeRead, canAdoptProjectLifecycle } = contextFor({
      state: toolState({ splitLineA: capturedA }),
      position: Object.freeze({ x: 190, y: 50 }),
      journal,
      token,
      annotations,
    });
    const event = eventFor(journal, token);

    expect(splitController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual([
      "stop:tail-owned",
      "line:b:0.95,0.5:tail-retired",
      "canAdopt",
      "preview",
    ]);
    expect(split.setLineEndpoint).toHaveBeenCalledExactlyOnceWith("b", {
      x: 0.95,
      y: 0.5,
    });
    expect(split.setPreview).toHaveBeenCalledTimes(1);
    const lineB = (split.setLineEndpoint as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as { x: number; y: number } | null;
    const preview = (split.setPreview as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as SplitPreview;
    expect(preview.targetAnnotationId).toBe(202);
    expect(preview.original).toBe(winningVertices);
    expect(preview.lineA).toBe(capturedA);
    expect(preview.lineB).toBe(lineB);
    expect(preview).toEqual({
      targetAnnotationId: 202,
      original: winningVertices,
      left: [
        { x: 0.9, y: 0.5 },
        { x: 0.9, y: 0.8 },
        { x: 0.4, y: 0.8 },
        { x: 0.4, y: 0.5 },
      ],
      right: [
        { x: 0.4, y: 0.5 },
        { x: 0.4, y: 0.2 },
        { x: 0.9, y: 0.2 },
        { x: 0.9, y: 0.5 },
      ],
      lineA: capturedA,
      lineB: { x: 0.95, y: 0.5 },
    });
    expect(split.publishError).not.toHaveBeenCalled();
    expect(canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    expectForbiddenEffectsCold(storeRead, latest);
  });
});

describe("splitController real registry integration", () => {
  it("occupies the exact slot and claims before every later controller is consulted", () => {
    expect(
      TOOLS.filter((controller) => controller === splitController),
    ).toEqual([splitController]);
    expect(TOOLS.indexOf(splitController)).toBe(1);
    expect(TOOLS[0]?.kind).toBe("calibration");
    expect(TOOLS[2]?.kind).toBe("takeoffPolygon");

    const preview = Object.freeze({
      targetAnnotationId: 1,
      original: [],
      left: [],
      right: [],
      lineA: Object.freeze({ x: 0.1, y: 0.1 }),
      lineB: Object.freeze({ x: 0.9, y: 0.9 }),
    }) as unknown as SplitPreview;
    const token = claimToolTailAuthority({ witness: "registry" });
    const journal: Journal = [];
    const { context } = contextFor({
      state: toolState({ splitPreview: preview }),
      journal,
      token,
      includeSplit: false,
      includeAnnotations: false,
    });
    const event = eventFor(journal, token);
    const dispatchTrace: string[] = [];
    const tracedControllers = TOOLS.map((controller): ToolController => ({
      ...controller,
      matches(press) {
        dispatchTrace.push(`${controller.kind}:matches`);
        return controller.matches(press);
      },
      onMouseDown(nextEvent, nextContext) {
        dispatchTrace.push(`${controller.kind}:onMouseDown`);
        return controller.onMouseDown(nextEvent, nextContext);
      },
    }));
    const createContext = vi.fn(() => context);

    expect(
      dispatchToolMouseDown(
        tracedControllers,
        event,
        context.press,
        createContext,
      ),
    ).toBe(true);

    expect(dispatchTrace).toEqual([
      "calibration:matches",
      "split:matches",
      "split:onMouseDown",
    ]);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(journal).toEqual(["stop:tail-owned"]);
    expect(ownsToolTailAuthority(token)).toBe(true);
  });
});

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function controllerObject(source: ts.SourceFile): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "splitController" &&
      node.initializer
    ) {
      let expression = unwrapExpression(node.initializer);
      if (ts.isCallExpression(expression)) {
        const callee = expression.expression.getText(source);
        if (callee === "Object.freeze" && expression.arguments[0]) {
          expression = unwrapExpression(expression.arguments[0]);
        }
      }
      if (ts.isObjectLiteralExpression(expression)) found = expression;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error("Expected splitController object literal");
  return found;
}

function directReturns(method: ts.MethodDeclaration): ts.ReturnStatement[] {
  if (!method.body) return [];
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (
      node !== method.body &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  return returns;
}

describe("splitController literal-claim and ownership source policy", () => {
  const sourceUrl = new URL("../tools/split.ts", import.meta.url);
  const sourceText = readFileSync(sourceUrl, "utf8");
  const source = ts.createSourceFile(
    sourceUrl.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  it("keeps all six direct exits as literal true claims", () => {
    const object = controllerObject(source);
    const method = object.properties.find(
      (property): property is ts.MethodDeclaration =>
        ts.isMethodDeclaration(property) &&
        property.name.getText(source) === "onMouseDown",
    );
    if (!method) throw new Error("Expected splitController.onMouseDown method");
    const returns = directReturns(method);
    expect(returns).toHaveLength(6);
    expect(returns.map((statement) => statement.expression?.kind)).toEqual(
      Array(6).fill(ts.SyntaxKind.TrueKeyword),
    );
  });

  it("owns only captured geometry, Split commands, and generic tail invalidation", () => {
    expect(sourceText).toContain("Object.freeze(");
    expect(sourceText).toContain("toolAtDown.splitLineA");
    expect(sourceText).toContain("findSplittablePolygons(");
    expect(sourceText).toContain("const best = candidates[0];");
    expect(sourceText).toContain(MISS_MESSAGE);
    expect(sourceText).toContain("3500");
    expect(sourceText).not.toContain("event.preventDefault");
    expect(sourceText).not.toContain("event.button");
    expect(sourceText).not.toContain("event.detail");
    expect(sourceText).not.toContain("context.cssScale");
    expect(sourceText).not.toContain("context.stores");
    expect(sourceText).not.toContain("fetch(");
    expect(sourceText).not.toContain("persistFetch");
    expect(sourceText).not.toContain("setTimeout(");
    expect(sourceText).not.toContain("claimLatestToolOperation(");
    expect(sourceText).not.toContain("invalidateLatestToolOperation(");
    expect(sourceText).not.toContain("ownsLatestToolOperation(");
    expect(sourceText).not.toContain("useToolStore");
    expect(sourceText).not.toContain("readAnnotations(");
    expect(sourceText).not.toContain("queryKeys");
    expect(sourceText).not.toContain("return false");
  });
});
