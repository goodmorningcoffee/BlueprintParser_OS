// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  drawVisibleTagInstances,
  type DrawVisibleTagInstancesProps,
  type VisibleTagInstanceRenderData,
} from "../visibleTagInstances";

type Bbox = VisibleTagInstanceRenderData["bbox"];

type TraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown];

interface CanvasState {
  readonly dash: readonly number[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: unknown;
  readonly globalAlpha: unknown;
  readonly font: unknown;
  readonly stackDepth: number;
}

interface ContextFailure {
  readonly phase: "get" | "set" | "call";
  readonly property: string;
  readonly occurrence?: number;
  readonly error: Error;
}

interface ContextOptions {
  readonly events?: string[];
  readonly failure?: ContextFailure;
}

function recordingContext(options: ContextOptions = {}): {
  context: CanvasRenderingContext2D;
  trace: TraceEntry[];
  state: () => CanvasState;
} {
  const trace: TraceEntry[] = [];
  const counts = new Map<string, number>();
  let dash = [9, 3];
  let stackDepth = 0;
  let context: CanvasRenderingContext2D;

  const occurrence = (phase: ContextFailure["phase"], property: string) => {
    const key = `${phase}:${property}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
  const maybeThrow = (
    phase: ContextFailure["phase"],
    property: string,
    currentOccurrence: number,
  ) => {
    const failure = options.failure;
    if (
      failure?.phase === phase
      && failure.property === property
      && (failure.occurrence ?? 1) === currentOccurrence
    ) {
      throw failure.error;
    }
  };
  const call = (method: string, receiver: unknown, args: unknown[]) => {
    trace.push(["call", method, ...args]);
    options.events?.push(
      `ctx:call:${method}:${receiver === context ? "receiver" : "detached"}`,
    );
    maybeThrow("call", method, occurrence("call", method));
  };

  const target: Record<PropertyKey, unknown> = {
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
    setLineDash(this: unknown, segments: number[]) {
      call("setLineDash", this, [segments]);
      dash = [...segments];
    },
    strokeRect(this: unknown, ...args: unknown[]) {
      call("strokeRect", this, args);
    },
    fillRect(this: unknown, ...args: unknown[]) {
      call("fillRect", this, args);
    },
    fillText(this: unknown, ...args: unknown[]) {
      call("fillText", this, args);
    },
    save(this: unknown) {
      call("save", this, []);
      stackDepth += 1;
    },
    restore(this: unknown) {
      call("restore", this, []);
      stackDepth -= 1;
    },
  };
  const watchedMethods = new Set([
    "setLineDash",
    "strokeRect",
    "fillRect",
    "fillText",
    "save",
    "restore",
  ]);

  context = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && watchedMethods.has(property)) {
        const currentOccurrence = occurrence("get", property);
        options.events?.push(`ctx:get:${property}:${currentOccurrence}`);
        maybeThrow("get", property, currentOccurrence);
      }
      return Reflect.get(object, property, receiver);
    },
    set(object, property, value, receiver) {
      if (typeof property === "string") {
        trace.push(["set", property, value]);
        const currentOccurrence = occurrence("set", property);
        options.events?.push(
          `ctx:set:${property}:${String(value)}:${receiver === context ? "receiver" : "detached"}`,
        );
        maybeThrow("set", property, currentOccurrence);
      }
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
      stackDepth,
    }),
  };
}

function row(
  bbox: Bbox,
  color: string,
  tier: VisibleTagInstanceRenderData["tier"],
): VisibleTagInstanceRenderData {
  return { bbox, color, tier };
}

function paintTrace(
  bbox: Bbox,
  color: string,
  tier: VisibleTagInstanceRenderData["tier"],
  width = 200,
  height = 100,
): TraceEntry[] {
  const [minX, minY, maxX, maxY] = bbox;
  return [
    ["set", "strokeStyle", color],
    ["set", "lineWidth", tier === "low" ? 1 : 1.5],
    ["call", "setLineDash", tier === "low" ? [2, 4] : [4, 3]],
    [
      "call",
      "strokeRect",
      minX * width,
      minY * height,
      (maxX - minX) * width,
      (maxY - minY) * height,
    ],
    ["call", "setLineDash", []],
  ];
}

function draw(
  context: CanvasRenderingContext2D,
  visibleTagInstances: readonly VisibleTagInstanceRenderData[],
  width = 200,
  height = 100,
): void {
  drawVisibleTagInstances(context, { visibleTagInstances, width, height });
}

function inheritedState(): CanvasState {
  return {
    dash: [9, 3],
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
    stackDepth: 0,
  };
}

function expectNoEnvelopeFillOrText(trace: readonly TraceEntry[]): void {
  const forbidden = new Set(["save", "restore", "fillRect", "fillText"]);
  expect(trace.some((entry) =>
    entry[0] === "call" && forbidden.has(entry[1])
  )).toBe(false);
}

interface IterableOptions {
  readonly throwOnNextIndex?: number;
  readonly error?: Error;
}

function trackedRows(
  values: readonly VisibleTagInstanceRenderData[],
  events: string[],
  options: IterableOptions = {},
): readonly VisibleTagInstanceRenderData[] {
  let index = 0;
  const iterable = {
    get [Symbol.iterator]() {
      events.push("rows:get-iterator");
      return function (this: unknown) {
        events.push(`rows:call-iterator:${this === iterable ? "receiver" : "detached"}`);
        const iterator = {
          get next() {
            events.push("rows:get-next");
            return function (this: unknown) {
              events.push(`rows:call-next:${index}:${this === iterator ? "receiver" : "detached"}`);
              if (index === options.throwOnNextIndex) {
                throw options.error ?? new Error("rows next boom");
              }
              if (index >= values.length) return { value: undefined, done: true };
              const value = values[index];
              index += 1;
              return { value, done: false };
            };
          },
          get return() {
            events.push("rows:get-return");
            return function (this: unknown) {
              events.push(`rows:call-return:${this === iterator ? "receiver" : "detached"}`);
              return { value: undefined, done: true };
            };
          },
        };
        return iterator;
      };
    },
  };
  return iterable as unknown as readonly VisibleTagInstanceRenderData[];
}

function trackedBbox(
  values: readonly number[],
  events: string[],
  options: IterableOptions = {},
): Bbox {
  let index = 0;
  const iterable = {
    get [Symbol.iterator]() {
      events.push("bbox:get-iterator");
      return function (this: unknown) {
        events.push(`bbox:call-iterator:${this === iterable ? "receiver" : "detached"}`);
        const iterator = {
          get next() {
            events.push("bbox:get-next");
            return function (this: unknown) {
              events.push(`bbox:call-next:${index}:${this === iterator ? "receiver" : "detached"}`);
              if (index === options.throwOnNextIndex) {
                throw options.error ?? new Error("bbox next boom");
              }
              const value = values[index];
              index += 1;
              return { value, done: false };
            };
          },
          get return() {
            events.push("bbox:get-return");
            return function (this: unknown) {
              events.push(`bbox:call-return:${this === iterator ? "receiver" : "detached"}`);
              return { value: undefined, done: true };
            };
          },
        };
        return iterator;
      };
    },
  };
  return iterable as unknown as Bbox;
}

describe("drawVisibleTagInstances", () => {
  it("destructures props in order while empty input remains entirely canvas-cold", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const props = {
      get visibleTagInstances() {
        events.push("props:visibleTagInstances");
        return [];
      },
      get width() {
        events.push("props:width");
        return 200;
      },
      get height() {
        events.push("props:height");
        return 100;
      },
    } satisfies DrawVisibleTagInstancesProps;

    drawVisibleTagInstances(record.context, props);

    expect(events).toEqual([
      "props:visibleTagInstances",
      "props:width",
      "props:height",
    ]);
    expect(record.trace).toEqual([]);
    expect(record.state()).toEqual(inheritedState());
  });

  it("preserves source order, MINMAX geometry, tier styles, dash resets, and final leakage", () => {
    const record = recordingContext();
    const low = row([0.625, 0.125, 0.125, 0.375], "#dc2626", "low");
    const medium = row([0.125, 0.75, 0.375, 0.25], "#f59e0b", "medium");
    const high = row([0.4, 0.2, 0.9, 0.8], "#22d3ee", "high");

    draw(record.context, [low, medium, high]);

    expect(record.trace).toEqual([
      ...paintTrace(low.bbox, low.color, low.tier),
      ...paintTrace(medium.bbox, medium.color, medium.tier),
      ...paintTrace(high.bbox, high.color, high.tier),
    ]);
    expect(record.state()).toEqual({
      dash: [],
      fillStyle: "inherited-fill",
      strokeStyle: "#22d3ee",
      lineWidth: 1.5,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 0,
    });
    expectNoEnvelopeFillOrText(record.trace);
  });

  it("gets bbox once, ignores builder-only name, closes four values, and re-reads tier", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    let bboxReads = 0;
    let nameReads = 0;
    let tierReads = 0;
    const dynamic = {
      get bbox() {
        bboxReads += 1;
        events.push("row:bbox");
        return trackedBbox([0.125, 0.25, 0.625, 0.75, 999], events);
      },
      get color() {
        events.push("row:color");
        return "#a855f7";
      },
      get name() {
        nameReads += 1;
        return "builder-only-name";
      },
      get tier(): VisibleTagInstanceRenderData["tier"] {
        tierReads += 1;
        events.push(`row:tier:${tierReads}`);
        return tierReads === 1 ? "low" : "high";
      },
    };
    const rows = trackedRows([dynamic], events);

    draw(record.context, rows);

    expect(events).toEqual([
      "rows:get-iterator",
      "rows:call-iterator:receiver",
      "rows:get-next",
      "rows:call-next:0:receiver",
      "row:bbox",
      "bbox:get-iterator",
      "bbox:call-iterator:receiver",
      "bbox:get-next",
      "bbox:call-next:0:receiver",
      "bbox:call-next:1:receiver",
      "bbox:call-next:2:receiver",
      "bbox:call-next:3:receiver",
      "bbox:get-return",
      "bbox:call-return:receiver",
      "row:color",
      "ctx:set:strokeStyle:#a855f7:receiver",
      "row:tier:1",
      "ctx:set:lineWidth:1:receiver",
      "ctx:get:setLineDash:1",
      "row:tier:2",
      "ctx:call:setLineDash:receiver",
      "ctx:get:strokeRect:1",
      "ctx:call:strokeRect:receiver",
      "ctx:get:setLineDash:2",
      "ctx:call:setLineDash:receiver",
      "rows:call-next:1:receiver",
    ]);
    expect(bboxReads).toBe(1);
    expect(nameReads).toBe(0);
    expect(tierReads).toBe(2);
    expect(record.trace).toEqual([
      ["set", "strokeStyle", "#a855f7"],
      ["set", "lineWidth", 1],
      ["call", "setLineDash", [4, 3]],
      ["call", "strokeRect", 25, 25, 100, 50],
      ["call", "setLineDash", []],
    ]);
    expect(events).not.toContain("rows:get-return");
  });

  it("uses strict non-coercive tier equality for runtime non-string values", () => {
    const record = recordingContext();
    let coercions = 0;
    const coercibleTier = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return "low";
      },
    } as unknown as VisibleTagInstanceRenderData["tier"];
    const impostor = row(
      [0.125, 0.25, 0.625, 0.75],
      "#6366f1",
      coercibleTier,
    );

    expect(String(coercibleTier)).toBe("low");
    coercions = 0;
    expect(coercibleTier).not.toBe("low");

    draw(record.context, [impostor]);

    expect(coercions).toBe(0);
    expect(record.trace).toEqual(paintTrace(
      impostor.bbox,
      impostor.color,
      impostor.tier,
    ));
    expect(record.state()).toEqual({
      ...inheritedState(),
      dash: [],
      strokeStyle: "#6366f1",
      lineWidth: 1.5,
    });
  });

  it("closes the outer iterable when bbox iteration fails, but does not close the failing bbox", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const failure = new Error("bbox next boom");
    const failing = row(
      trackedBbox([0.125, 0.25, 0.625, 0.75], events, {
        throwOnNextIndex: 2,
        error: failure,
      }),
      "#ef4444",
      "low",
    );
    const rows = trackedRows([failing], events);

    expect(() => draw(record.context, rows)).toThrow(failure);

    expect(events).toContain("rows:get-return");
    expect(events).toContain("rows:call-return:receiver");
    expect(events).not.toContain("bbox:get-return");
    expect(record.trace).toEqual([]);
    expect(record.state()).toEqual(inheritedState());
  });

  it("does not close the outer iterable when its own next call throws after completed paint", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const painted = row([0.125, 0.25, 0.625, 0.75], "#10b981", "medium");
    const failure = new Error("rows next boom");
    const rows = trackedRows([painted], events, {
      throwOnNextIndex: 1,
      error: failure,
    });

    expect(() => draw(record.context, rows)).toThrow(failure);

    expect(record.trace).toEqual(paintTrace(
      painted.bbox,
      painted.color,
      painted.tier,
    ));
    expect(record.state()).toEqual({
      ...inheritedState(),
      dash: [],
      strokeStyle: "#10b981",
      lineWidth: 1.5,
    });
    expect(events).not.toContain("rows:get-return");
    expect(events).not.toContain("rows:call-return:receiver");
    expectNoEnvelopeFillOrText(record.trace);
  });

  it("propagates color and first-tier getter failures and closes the outer iterator", () => {
    const bbox = [0.125, 0.25, 0.625, 0.75] as const;
    const testCases: readonly {
      readonly name: string;
      readonly error: Error;
      readonly makeRow: (error: Error) => VisibleTagInstanceRenderData;
      readonly expectedTrace: readonly TraceEntry[];
      readonly expectedState: CanvasState;
    }[] = [
      {
        name: "color getter",
        error: new Error("color get boom"),
        makeRow: (error) => ({
          bbox,
          get color(): string {
            throw error;
          },
          tier: "low",
        }),
        expectedTrace: [],
        expectedState: inheritedState(),
      },
      {
        name: "first tier getter",
        error: new Error("tier get boom"),
        makeRow: (error) => ({
          bbox,
          color: "#ef4444",
          get tier(): VisibleTagInstanceRenderData["tier"] {
            throw error;
          },
        }),
        expectedTrace: [["set", "strokeStyle", "#ef4444"]],
        expectedState: {
          ...inheritedState(),
          strokeStyle: "#ef4444",
        },
      },
    ];

    for (const testCase of testCases) {
      const events: string[] = [];
      const record = recordingContext({ events });
      const rows = trackedRows([testCase.makeRow(testCase.error)], events);
      let thrown: unknown;

      try {
        draw(record.context, rows);
      } catch (error) {
        thrown = error;
      }

      expect(thrown, testCase.name).toBe(testCase.error);
      expect(record.trace, testCase.name).toEqual(testCase.expectedTrace);
      expect(record.state(), testCase.name).toEqual(testCase.expectedState);
      expect(events, testCase.name).toContain("rows:get-return");
      expect(events, testCase.name).toContain("rows:call-return:receiver");
      expectNoEnvelopeFillOrText(record.trace);
    }
  });

  it("gets setLineDash before tier Get #2 and keeps that getter cold on Get failure", () => {
    const events: string[] = [];
    const failure = new Error("setLineDash get boom");
    const record = recordingContext({
      events,
      failure: { phase: "get", property: "setLineDash", error: failure },
    });
    let tierReads = 0;
    const failing = {
      bbox: [0.125, 0.25, 0.625, 0.75] as const,
      color: "#ef4444",
      get tier(): VisibleTagInstanceRenderData["tier"] {
        tierReads += 1;
        events.push(`row:tier:${tierReads}`);
        return "low";
      },
    };
    const rows = trackedRows([failing], events);

    expect(() => draw(record.context, rows)).toThrow(failure);

    expect(tierReads).toBe(1);
    expect(events.indexOf("ctx:get:setLineDash:1")).toBeGreaterThan(
      events.indexOf("row:tier:1"),
    );
    expect(events).not.toContain("row:tier:2");
    expect(events).toContain("rows:call-return:receiver");
    expect(record.trace).toEqual([
      ["set", "strokeStyle", "#ef4444"],
      ["set", "lineWidth", 1],
    ]);
    expect(record.state()).toEqual({
      ...inheritedState(),
      strokeStyle: "#ef4444",
      lineWidth: 1,
    });
  });

  it("propagates canvas setter, method-get, and call failures with exact partial state", () => {
    const bbox = [0.125, 0.25, 0.625, 0.75] as const;
    const testCases: readonly {
      readonly name: string;
      readonly failure: ContextFailure;
      readonly expectedTrace: readonly TraceEntry[];
      readonly expectedState: CanvasState;
    }[] = [
      {
        name: "lineWidth setter",
        failure: {
          phase: "set",
          property: "lineWidth",
          error: new Error("lineWidth set boom"),
        },
        expectedTrace: [
          ["set", "strokeStyle", "#ef4444"],
          ["set", "lineWidth", 1],
        ],
        expectedState: {
          ...inheritedState(),
          strokeStyle: "#ef4444",
        },
      },
      {
        name: "strokeRect method get",
        failure: {
          phase: "get",
          property: "strokeRect",
          error: new Error("strokeRect get boom"),
        },
        expectedTrace: [
          ["set", "strokeStyle", "#ef4444"],
          ["set", "lineWidth", 1],
          ["call", "setLineDash", [2, 4]],
        ],
        expectedState: {
          ...inheritedState(),
          dash: [2, 4],
          strokeStyle: "#ef4444",
          lineWidth: 1,
        },
      },
      {
        name: "strokeRect call",
        failure: {
          phase: "call",
          property: "strokeRect",
          error: new Error("strokeRect call boom"),
        },
        expectedTrace: [
          ["set", "strokeStyle", "#ef4444"],
          ["set", "lineWidth", 1],
          ["call", "setLineDash", [2, 4]],
          ["call", "strokeRect", 25, 25, 100, 50],
        ],
        expectedState: {
          ...inheritedState(),
          dash: [2, 4],
          strokeStyle: "#ef4444",
          lineWidth: 1,
        },
      },
      {
        name: "reset method get",
        failure: {
          phase: "get",
          property: "setLineDash",
          occurrence: 2,
          error: new Error("dash reset get boom"),
        },
        expectedTrace: [
          ["set", "strokeStyle", "#ef4444"],
          ["set", "lineWidth", 1],
          ["call", "setLineDash", [2, 4]],
          ["call", "strokeRect", 25, 25, 100, 50],
        ],
        expectedState: {
          ...inheritedState(),
          dash: [2, 4],
          strokeStyle: "#ef4444",
          lineWidth: 1,
        },
      },
      {
        name: "reset call",
        failure: {
          phase: "call",
          property: "setLineDash",
          occurrence: 2,
          error: new Error("dash reset boom"),
        },
        expectedTrace: [
          ["set", "strokeStyle", "#ef4444"],
          ["set", "lineWidth", 1],
          ["call", "setLineDash", [2, 4]],
          ["call", "strokeRect", 25, 25, 100, 50],
          ["call", "setLineDash", []],
        ],
        expectedState: {
          ...inheritedState(),
          dash: [2, 4],
          strokeStyle: "#ef4444",
          lineWidth: 1,
        },
      },
    ];

    for (const testCase of testCases) {
      const events: string[] = [];
      const record = recordingContext({
        events,
        failure: testCase.failure,
      });
      const first = row(bbox, "#ef4444", "low");
      const forbiddenSecond = {
        get bbox(): Bbox {
          throw new Error(`${testCase.name}: second row must stay cold`);
        },
        color: "#000000",
        tier: "high" as const,
      };
      const rows = trackedRows([first, forbiddenSecond], events);
      let thrown: unknown;

      try {
        draw(record.context, rows);
      } catch (error) {
        thrown = error;
      }

      expect(thrown, testCase.name).toBe(testCase.failure.error);
      expect(record.trace, testCase.name).toEqual(testCase.expectedTrace);
      expect(record.state(), testCase.name).toEqual(testCase.expectedState);
      expect(events, testCase.name).toContain("rows:get-return");
      expect(events, testCase.name).toContain("rows:call-return:receiver");
      expect(events, testCase.name).not.toContain("rows:call-next:1:receiver");
      expectNoEnvelopeFillOrText(record.trace);
    }
  });
});
