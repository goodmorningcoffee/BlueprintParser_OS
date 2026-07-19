// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  drawActiveTagInstances,
  type ActiveTagInstanceLookup,
  type ActiveTagInstanceRenderData,
  type ActiveTagRenderData,
  type DrawActiveTagInstancesProps,
} from "../activeTagInstances";

type Bbox = ActiveTagInstanceRenderData["bbox"];

type TraceEntry =
  | [kind: "get", property: string]
  | [kind: "set", property: string, value: unknown]
  | [kind: "call", method: string, ...args: unknown[]];

interface CanvasState {
  readonly dash: readonly number[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: unknown;
  readonly globalAlpha: unknown;
  readonly font: unknown;
  readonly stackDepth: number;
}

type FailurePhase = "get" | "set" | "call" | "metrics-width";

interface ContextFailure {
  readonly phase: FailurePhase;
  readonly property: string;
  readonly occurrence?: number;
  readonly error: Error;
}

interface ContextOptions {
  readonly events?: string[];
  readonly failure?: ContextFailure;
  readonly measurementWidths?: number[];
}

function recordingContext(options: ContextOptions = {}): {
  context: CanvasRenderingContext2D;
  trace: TraceEntry[];
  state: () => CanvasState;
} {
  const trace: TraceEntry[] = [];
  const counts = new Map<string, number>();
  const measurementWidths = options.measurementWidths ?? [];
  let dash = [9, 3];
  let stackDepth = 0;
  let context: CanvasRenderingContext2D;

  const occurrence = (phase: FailurePhase, property: string): number => {
    const key = `${phase}:${property}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
  const maybeThrow = (
    phase: FailurePhase,
    property: string,
    currentOccurrence: number,
  ): void => {
    const failure = options.failure;
    if (
      failure?.phase === phase
      && failure.property === property
      && (failure.occurrence ?? 1) === currentOccurrence
    ) {
      throw failure.error;
    }
  };
  const call = (method: string, receiver: unknown, args: unknown[]): void => {
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
    fillRect(this: unknown, ...args: unknown[]) {
      call("fillRect", this, args);
    },
    strokeRect(this: unknown, ...args: unknown[]) {
      call("strokeRect", this, args);
    },
    measureText(this: unknown, ...args: unknown[]) {
      call("measureText", this, args);
      const width = measurementWidths.shift();
      return {
        get width() {
          trace.push(["get", "measureText.width"]);
          const currentOccurrence = occurrence("metrics-width", "measureText.width");
          options.events?.push(`metrics:get-width:${currentOccurrence}`);
          maybeThrow("metrics-width", "measureText.width", currentOccurrence);
          return width ?? String(args[0]).length * 6;
        },
      };
    },
    fillText(this: unknown, ...args: unknown[]) {
      call("fillText", this, args);
    },
    setLineDash(this: unknown, segments: number[]) {
      call("setLineDash", this, [segments]);
      dash = [...segments];
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
    "fillRect",
    "strokeRect",
    "measureText",
    "fillText",
    "setLineDash",
    "save",
    "restore",
  ]);

  context = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && watchedMethods.has(property)) {
        trace.push(["get", property]);
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

function activeTag(
  overrides: Partial<ActiveTagRenderData> = {},
): ActiveTagRenderData {
  return {
    id: "active",
    color: "#2468ac",
    name: "ACTIVE",
    tagText: "ACTIVE TEXT",
    ...overrides,
  };
}

function instance(
  annotationId: number,
  bbox: Bbox = [0.125, 0.25, 0.625, 0.75],
): ActiveTagInstanceRenderData {
  return { annotationId, bbox };
}

function lookup(
  rows: readonly ActiveTagInstanceRenderData[] | undefined,
): ActiveTagInstanceLookup {
  return { get: () => rows };
}

function draw(
  context: CanvasRenderingContext2D,
  active: ActiveTagRenderData | null | undefined,
  rows: readonly ActiveTagInstanceRenderData[] = [],
  width = 200,
  height = 100,
): void {
  drawActiveTagInstances(context, {
    activeTag: active,
    pageTagInstances: lookup(rows),
    width,
    height,
  });
}

function paintTrace({
  color,
  labelColor = color,
  label,
  textWidth,
  x,
  y,
  width,
  height,
}: {
  readonly color: string;
  readonly labelColor?: string;
  readonly label: string;
  readonly textWidth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): TraceEntry[] {
  return [
    ["set", "fillStyle", "#ff00ff40"],
    ["get", "fillRect"],
    ["call", "fillRect", x, y, width, height],
    ["set", "strokeStyle", color],
    ["set", "lineWidth", 3],
    ["get", "strokeRect"],
    ["call", "strokeRect", x, y, width, height],
    ["set", "font", "bold 11px sans-serif"],
    ["get", "measureText"],
    ["call", "measureText", label],
    ["get", "measureText.width"],
    ["set", "fillStyle", `${labelColor}dd`],
    ["get", "fillRect"],
    ["call", "fillRect", x, y + height + 1, textWidth + 6, 14],
    ["set", "fillStyle", "#000"],
    ["get", "fillText"],
    ["call", "fillText", label, x + 3, y + height + 12],
  ];
}

interface IterableOptions {
  readonly throwOnNextIndex?: number;
  readonly error?: Error;
}

function trackedRows(
  values: readonly ActiveTagInstanceRenderData[],
  events: string[],
  options: IterableOptions = {},
): readonly ActiveTagInstanceRenderData[] {
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
  return iterable as unknown as readonly ActiveTagInstanceRenderData[];
}

function trackedBbox(
  name: string,
  values: readonly number[],
  events: string[],
  options: IterableOptions = {},
): Bbox {
  let index = 0;
  const iterable = {
    get [Symbol.iterator]() {
      events.push(`${name}:get-iterator`);
      return function (this: unknown) {
        events.push(`${name}:call-iterator:${this === iterable ? "receiver" : "detached"}`);
        const iterator = {
          get next() {
            events.push(`${name}:get-next`);
            return function (this: unknown) {
              events.push(`${name}:call-next:${index}:${this === iterator ? "receiver" : "detached"}`);
              if (index === options.throwOnNextIndex) {
                throw options.error ?? new Error(`${name} next boom`);
              }
              const value = values[index];
              index += 1;
              return { value, done: false };
            };
          },
          get return() {
            events.push(`${name}:get-return`);
            return function (this: unknown) {
              events.push(`${name}:call-return:${this === iterator ? "receiver" : "detached"}`);
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

function trackedInstance({
  name,
  annotationId,
  bbox,
  events,
  annotationError,
  bboxError,
}: {
  readonly name: string;
  readonly annotationId: unknown;
  readonly bbox: Bbox;
  readonly events: string[];
  readonly annotationError?: Error;
  readonly bboxError?: Error;
}): ActiveTagInstanceRenderData {
  return {
    get annotationId(): number {
      events.push(`${name}:annotationId`);
      if (annotationError) throw annotationError;
      return annotationId as number;
    },
    get bbox(): Bbox {
      events.push(`${name}:bbox`);
      if (bboxError) throw bboxError;
      return bbox;
    },
    get pageNumber(): never {
      throw new Error(`${name}.pageNumber must stay cold`);
    },
    get confidence(): never {
      throw new Error(`${name}.confidence must stay cold`);
    },
    get confidenceTier(): never {
      throw new Error(`${name}.confidenceTier must stay cold`);
    },
    get score(): never {
      throw new Error(`${name}.score must stay cold`);
    },
    get signals(): never {
      throw new Error(`${name}.signals must stay cold`);
    },
    get dropReason(): never {
      throw new Error(`${name}.dropReason must stay cold`);
    },
  } as ActiveTagInstanceRenderData;
}

function captureThrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectNoEnvelopeOrReset(trace: readonly TraceEntry[]): void {
  const forbidden = new Set(["save", "restore", "setLineDash"]);
  expect(trace.some((entry) =>
    (entry[0] === "get" || entry[0] === "call") && forbidden.has(entry[1])
  )).toBe(false);
  expect(trace.some((entry) =>
    entry[0] === "set" && entry[1] === "globalAlpha"
  )).toBe(false);
}

describe("drawActiveTagInstances", () => {
  it.each([null, undefined])(
    "destructures props in order while %s active stays lookup- and canvas-cold",
    (missingActive) => {
      const events: string[] = [];
      const record = recordingContext({ events });
      const forbiddenLookup = Object.defineProperty({}, "get", {
        get() {
          throw new Error("lookup.get must stay cold");
        },
      }) as ActiveTagInstanceLookup;
      const props = {
        get activeTag() {
          events.push("props:activeTag");
          return missingActive;
        },
        get pageTagInstances() {
          events.push("props:pageTagInstances");
          return forbiddenLookup;
        },
        get width() {
          events.push("props:width");
          return 200;
        },
        get height() {
          events.push("props:height");
          return 100;
        },
      } satisfies DrawActiveTagInstancesProps;

      drawActiveTagInstances(record.context, props);

      expect(events).toEqual([
        "props:activeTag",
        "props:pageTagInstances",
        "props:width",
        "props:height",
      ]);
      expect(record.trace).toEqual([]);
      expect(record.state()).toEqual(inheritedState());
    },
  );

  it("gets the lookup method before active id, preserves its receiver, and uses the || fallback", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const active = {
      get id() {
        events.push("active:get-id");
        return "active";
      },
      get color(): never {
        throw new Error("active.color must stay cold");
      },
      get name(): never {
        throw new Error("active.name must stay cold");
      },
      get tagText(): never {
        throw new Error("active.tagText must stay cold");
      },
    } satisfies ActiveTagRenderData;
    const lookupObject = {
      get get() {
        events.push("lookup:get-method");
        return function (this: unknown, id: string) {
          events.push(
            `lookup:call:${id}:${this === lookupObject ? "receiver" : "detached"}`,
          );
          return false as unknown as readonly ActiveTagInstanceRenderData[];
        };
      },
    } satisfies ActiveTagInstanceLookup;

    drawActiveTagInstances(record.context, {
      activeTag: active,
      pageTagInstances: lookupObject,
      width: 200,
      height: 100,
    });

    expect(events).toEqual([
      "lookup:get-method",
      "active:get-id",
      "lookup:call:active:receiver",
    ]);
    expect(record.trace).toEqual([]);
    expect(record.state()).toEqual(inheritedState());
  });

  it("preserves strict source admission, bbox iterator semantics, dynamic metadata, paint order, and leakage", () => {
    const events: string[] = [];
    const record = recordingContext({
      events,
      measurementWidths: [17.5, 23],
    });
    const rejectedNegative = trackedInstance({
      name: "negative",
      annotationId: -2,
      bbox: [0, 0, 1, 1],
      events,
      bboxError: new Error("negative bbox must stay cold"),
    });
    const acceptedFirst = trackedInstance({
      name: "first",
      annotationId: -1,
      bbox: trackedBbox("first-bbox", [0.625, 0.75, 0.125, 0.25, 999], events),
      events,
    });
    const rejectedString = trackedInstance({
      name: "string",
      annotationId: "-1",
      bbox: [0, 0, 1, 1],
      events,
      bboxError: new Error("string bbox must stay cold"),
    });
    const acceptedSecond = trackedInstance({
      name: "second",
      annotationId: -1,
      bbox: trackedBbox("second-bbox", [0.1, 0.2, 0.4, 0.6, 888], events),
      events,
    });
    const rows = trackedRows(
      [rejectedNegative, acceptedFirst, rejectedString, acceptedSecond],
      events,
    );
    const colors = ["#111111", "", "", "#abcdef"];
    const names = ["", "SECOND"];
    let colorReads = 0;
    let nameReads = 0;
    let tagTextReads = 0;
    const active = {
      get id() {
        events.push("active:id");
        return "active";
      },
      get color() {
        colorReads += 1;
        events.push(`active:color:${colorReads}`);
        return colors[colorReads - 1];
      },
      get name() {
        nameReads += 1;
        events.push(`active:name:${nameReads}`);
        return names[nameReads - 1];
      },
      get tagText() {
        tagTextReads += 1;
        events.push(`active:tagText:${tagTextReads}`);
        return "FIRST FALLBACK";
      },
    } satisfies ActiveTagRenderData;

    drawActiveTagInstances(record.context, {
      activeTag: active,
      pageTagInstances: lookup(rows),
      width: 200,
      height: 100,
    });

    expect(record.trace).toEqual([
      ...paintTrace({
        color: "#111111",
        labelColor: "#22d3ee",
        label: "FIRST FALLBACK",
        textWidth: 17.5,
        x: 125,
        y: 75,
        width: -100,
        height: -50,
      }),
      ...paintTrace({
        color: "#22d3ee",
        labelColor: "#abcdef",
        label: "SECOND",
        textWidth: 23,
        x: 20,
        y: 20,
        width: 60.00000000000001,
        height: 40,
      }),
    ]);
    expect(events.filter((event) => event.includes(":annotationId"))).toEqual([
      "negative:annotationId",
      "first:annotationId",
      "string:annotationId",
      "second:annotationId",
    ]);
    expect(events.filter((event) => event.startsWith("rows:"))).toEqual([
      "rows:get-iterator",
      "rows:call-iterator:receiver",
      "rows:get-next",
      "rows:call-next:0:receiver",
      "rows:call-next:1:receiver",
      "rows:call-next:2:receiver",
      "rows:call-next:3:receiver",
      "rows:call-next:4:receiver",
    ]);
    expect(events.filter((event) => event.startsWith("first-bbox:"))).toEqual([
      "first-bbox:get-iterator",
      "first-bbox:call-iterator:receiver",
      "first-bbox:get-next",
      "first-bbox:call-next:0:receiver",
      "first-bbox:call-next:1:receiver",
      "first-bbox:call-next:2:receiver",
      "first-bbox:call-next:3:receiver",
      "first-bbox:get-return",
      "first-bbox:call-return:receiver",
    ]);
    expect(events.filter((event) => event.startsWith("second-bbox:"))).toEqual([
      "second-bbox:get-iterator",
      "second-bbox:call-iterator:receiver",
      "second-bbox:get-next",
      "second-bbox:call-next:0:receiver",
      "second-bbox:call-next:1:receiver",
      "second-bbox:call-next:2:receiver",
      "second-bbox:call-next:3:receiver",
      "second-bbox:get-return",
      "second-bbox:call-return:receiver",
    ]);
    expect(events.filter((event) => event.startsWith("active:"))).toEqual([
      "active:id",
      "active:color:1",
      "active:name:1",
      "active:tagText:1",
      "active:color:2",
      "active:color:3",
      "active:name:2",
      "active:color:4",
    ]);
    expect(events.indexOf("active:color:1")).toBeGreaterThan(
      events.indexOf("ctx:call:fillRect:receiver"),
    );
    expect(events.indexOf("ctx:set:strokeStyle:#111111:receiver")).toBeGreaterThan(
      events.indexOf("active:color:1"),
    );
    expect(events.indexOf("active:name:1")).toBeGreaterThan(
      events.indexOf("ctx:call:strokeRect:receiver"),
    );
    expect(events.indexOf("ctx:set:font:bold 11px sans-serif:receiver")).toBeGreaterThan(
      events.indexOf("active:tagText:1"),
    );
    expect(events.indexOf("active:color:2")).toBeGreaterThan(
      events.indexOf("metrics:get-width:1"),
    );
    expect(events.indexOf("ctx:set:fillStyle:#22d3eedd:receiver")).toBeGreaterThan(
      events.indexOf("active:color:2"),
    );
    expect(events.indexOf("active:color:3")).toBeGreaterThan(
      events.indexOf("ctx:call:fillText:receiver"),
    );
    expect(events.indexOf("ctx:set:fillStyle:#abcdefdd:receiver")).toBeGreaterThan(
      events.indexOf("active:color:4"),
    );
    expect(events.filter((event) => event.startsWith("ctx:call:")).every(
      (event) => event.endsWith(":receiver"),
    )).toBe(true);
    expect(events.filter((event) => event === "first:bbox")).toHaveLength(1);
    expect(events.filter((event) => event === "second:bbox")).toHaveLength(1);
    expect(events).not.toContain("negative:bbox");
    expect(events).not.toContain("string:bbox");
    expect(events).toContain("first-bbox:get-return");
    expect(events).toContain("first-bbox:call-return:receiver");
    expect(events).toContain("second-bbox:get-return");
    expect(events).toContain("second-bbox:call-return:receiver");
    expect(events).not.toContain("rows:get-return");
    expect(colorReads).toBe(4);
    expect(nameReads).toBe(2);
    expect(tagTextReads).toBe(1);
    expect(record.state()).toEqual({
      ...inheritedState(),
      fillStyle: "#000",
      strokeStyle: "#22d3ee",
      lineWidth: 3,
      font: "bold 11px sans-serif",
    });
    expectNoEnvelopeOrReset(record.trace);
  });

  it("propagates lookup method, id, and lookup-call failures before iteration or canvas access", () => {
    const methodFailure = new Error("lookup method boom");
    const methodEvents: string[] = [];
    const methodRecord = recordingContext({ events: methodEvents });
    const methodActive = {
      get id(): never {
        throw new Error("id must stay cold");
      },
      color: "#123456",
      name: "ACTIVE",
      tagText: "TEXT",
    } satisfies ActiveTagRenderData;
    const methodLookup = Object.defineProperty({}, "get", {
      get() {
        methodEvents.push("lookup:get-method");
        throw methodFailure;
      },
    }) as ActiveTagInstanceLookup;

    expect(captureThrown(() => drawActiveTagInstances(methodRecord.context, {
      activeTag: methodActive,
      pageTagInstances: methodLookup,
      width: 200,
      height: 100,
    }))).toBe(methodFailure);
    expect(methodEvents).toEqual(["lookup:get-method"]);
    expect(methodRecord.trace).toEqual([]);
    expect(methodRecord.state()).toEqual(inheritedState());

    const idFailure = new Error("id boom");
    const idEvents: string[] = [];
    const idRecord = recordingContext({ events: idEvents });
    const idLookup = {
      get get() {
        idEvents.push("lookup:get-method");
        return function () {
          throw new Error("lookup call must stay cold");
        };
      },
    } satisfies ActiveTagInstanceLookup;
    const idActive = {
      get id(): never {
        idEvents.push("active:get-id");
        throw idFailure;
      },
      color: "#123456",
      name: "ACTIVE",
      tagText: "TEXT",
    } satisfies ActiveTagRenderData;

    expect(captureThrown(() => drawActiveTagInstances(idRecord.context, {
      activeTag: idActive,
      pageTagInstances: idLookup,
      width: 200,
      height: 100,
    }))).toBe(idFailure);
    expect(idEvents).toEqual(["lookup:get-method", "active:get-id"]);
    expect(idRecord.trace).toEqual([]);

    const callFailure = new Error("lookup call boom");
    const callEvents: string[] = [];
    const callRecord = recordingContext({ events: callEvents });
    const callLookup = {
      get get() {
        callEvents.push("lookup:get-method");
        return function (this: unknown, id: string): never {
          callEvents.push(
            `lookup:call:${id}:${this === callLookup ? "receiver" : "detached"}`,
          );
          throw callFailure;
        };
      },
    } satisfies ActiveTagInstanceLookup;

    expect(captureThrown(() => drawActiveTagInstances(callRecord.context, {
      activeTag: activeTag(),
      pageTagInstances: callLookup,
      width: 200,
      height: 100,
    }))).toBe(callFailure);
    expect(callEvents).toEqual([
      "lookup:get-method",
      "lookup:call:active:receiver",
    ]);
    expect(callRecord.trace).toEqual([]);
    expect(callRecord.state()).toEqual(inheritedState());
  });

  it("closes the outer iterator on annotation and bbox getter failures without touching canvas", () => {
    const cases = [
      {
        label: "annotation",
        annotationError: new Error("annotation boom"),
        bboxError: undefined,
      },
      {
        label: "bbox",
        annotationError: undefined,
        bboxError: new Error("bbox boom"),
      },
    ] as const;

    for (const testCase of cases) {
      const events: string[] = [];
      const record = recordingContext({ events });
      const row = trackedInstance({
        name: testCase.label,
        annotationId: -1,
        bbox: [0.1, 0.2, 0.3, 0.4],
        events,
        annotationError: testCase.annotationError,
        bboxError: testCase.bboxError,
      });
      const rows = trackedRows([row], events);
      const expectedFailure = testCase.annotationError ?? testCase.bboxError;

      expect(captureThrown(() => draw(record.context, activeTag(), rows))).toBe(
        expectedFailure,
      );
      expect(events, testCase.label).toContain("rows:get-return");
      expect(events, testCase.label).toContain("rows:call-return:receiver");
      expect(record.trace, testCase.label).toEqual([]);
      expect(record.state(), testCase.label).toEqual(inheritedState());
    }
  });

  it("closes the outer iterator when bbox iteration fails, but not the failing bbox iterator", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const failure = new Error("bbox next boom");
    const row = trackedInstance({
      name: "failing",
      annotationId: -1,
      bbox: trackedBbox("failing-bbox", [0.1, 0.2, 0.3, 0.4], events, {
        throwOnNextIndex: 2,
        error: failure,
      }),
      events,
    });
    const rows = trackedRows([row], events);

    expect(captureThrown(() => draw(record.context, activeTag(), rows))).toBe(failure);

    expect(events).toContain("rows:get-return");
    expect(events).toContain("rows:call-return:receiver");
    expect(events).not.toContain("failing-bbox:get-return");
    expect(events).not.toContain("failing-bbox:call-return:receiver");
    expect(record.trace).toEqual([]);
    expect(record.state()).toEqual(inheritedState());
  });

  it("does not close the outer iterator when its own next call fails after completed paint", () => {
    const events: string[] = [];
    const record = recordingContext({ events, measurementWidths: [12] });
    const painted = instance(-1);
    const failure = new Error("outer next boom");
    const rows = trackedRows([painted], events, {
      throwOnNextIndex: 1,
      error: failure,
    });

    expect(captureThrown(() => draw(record.context, activeTag(), rows))).toBe(failure);

    expect(record.trace).toEqual(paintTrace({
      color: "#2468ac",
      label: "ACTIVE",
      textWidth: 12,
      x: 25,
      y: 25,
      width: 100,
      height: 50,
    }));
    expect(events).not.toContain("rows:get-return");
    expect(events).not.toContain("rows:call-return:receiver");
    expect(record.state()).toEqual({
      ...inheritedState(),
      fillStyle: "#000",
      strokeStyle: "#2468ac",
      lineWidth: 3,
      font: "bold 11px sans-serif",
    });
    expectNoEnvelopeOrReset(record.trace);
  });

  it("propagates representative context failures with exact partial traces, state, and IteratorClose", () => {
    const normal = paintTrace({
      color: "#2468ac",
      label: "ACTIVE",
      textWidth: 19,
      x: 25,
      y: 25,
      width: 100,
      height: 50,
    });
    const cases: readonly {
      readonly label: string;
      readonly failure: ContextFailure;
      readonly traceLength: number;
      readonly state: CanvasState;
    }[] = [
      {
        label: "first fillRect method Get",
        failure: {
          phase: "get",
          property: "fillRect",
          error: new Error("fillRect get boom"),
        },
        traceLength: 2,
        state: { ...inheritedState(), fillStyle: "#ff00ff40" },
      },
      {
        label: "lineWidth setter",
        failure: {
          phase: "set",
          property: "lineWidth",
          error: new Error("lineWidth set boom"),
        },
        traceLength: 5,
        state: {
          ...inheritedState(),
          fillStyle: "#ff00ff40",
          strokeStyle: "#2468ac",
        },
      },
      {
        label: "strokeRect call",
        failure: {
          phase: "call",
          property: "strokeRect",
          error: new Error("strokeRect call boom"),
        },
        traceLength: 7,
        state: {
          ...inheritedState(),
          fillStyle: "#ff00ff40",
          strokeStyle: "#2468ac",
          lineWidth: 3,
        },
      },
      {
        label: "label fillRect call",
        failure: {
          phase: "call",
          property: "fillRect",
          occurrence: 2,
          error: new Error("label fillRect call boom"),
        },
        traceLength: 14,
        state: {
          ...inheritedState(),
          fillStyle: "#2468acdd",
          strokeStyle: "#2468ac",
          lineWidth: 3,
          font: "bold 11px sans-serif",
        },
      },
      {
        label: "fillText call",
        failure: {
          phase: "call",
          property: "fillText",
          error: new Error("fillText call boom"),
        },
        traceLength: 17,
        state: {
          ...inheritedState(),
          fillStyle: "#000",
          strokeStyle: "#2468ac",
          lineWidth: 3,
          font: "bold 11px sans-serif",
        },
      },
    ];

    for (const testCase of cases) {
      const events: string[] = [];
      const record = recordingContext({
        events,
        failure: testCase.failure,
        measurementWidths: [19],
      });
      const rows = trackedRows([instance(-1)], events);

      expect(captureThrown(() => draw(record.context, activeTag(), rows)), testCase.label)
        .toBe(testCase.failure.error);
      expect(record.trace, testCase.label).toEqual(normal.slice(0, testCase.traceLength));
      expect(record.state(), testCase.label).toEqual(testCase.state);
      expect(events, testCase.label).toContain("rows:get-return");
      expect(events, testCase.label).toContain("rows:call-return:receiver");
      expectNoEnvelopeOrReset(record.trace);
    }
  });

  it("propagates measureText width failure after its call without label cleanup", () => {
    const events: string[] = [];
    const failure = new Error("metrics width boom");
    const record = recordingContext({
      events,
      measurementWidths: [19],
      failure: {
        phase: "metrics-width",
        property: "measureText.width",
        error: failure,
      },
    });
    const rows = trackedRows([instance(-1)], events);
    const expected = paintTrace({
      color: "#2468ac",
      label: "ACTIVE",
      textWidth: 19,
      x: 25,
      y: 25,
      width: 100,
      height: 50,
    });

    expect(captureThrown(() => draw(record.context, activeTag(), rows))).toBe(failure);

    expect(record.trace).toEqual(expected.slice(0, 11));
    expect(events).toContain("ctx:get:measureText:1");
    expect(events).toContain("ctx:call:measureText:receiver");
    expect(events).toContain("metrics:get-width:1");
    expect(events).toContain("rows:call-return:receiver");
    expect(record.state()).toEqual({
      ...inheritedState(),
      fillStyle: "#ff00ff40",
      strokeStyle: "#2468ac",
      lineWidth: 3,
      font: "bold 11px sans-serif",
    });
    expectNoEnvelopeOrReset(record.trace);
  });

  it("keeps dynamic color and label failures at their exact partial-paint boundaries", () => {
    const cases = [
      {
        label: "first color",
        failureRead: 1,
        traceLength: 3,
        state: {
          ...inheritedState(),
          fillStyle: "#ff00ff40",
        },
      },
      {
        label: "name",
        failureRead: 2,
        traceLength: 7,
        state: {
          ...inheritedState(),
          fillStyle: "#ff00ff40",
          strokeStyle: "#2468ac",
          lineWidth: 3,
        },
      },
      {
        label: "second color",
        failureRead: 3,
        traceLength: 11,
        state: {
          ...inheritedState(),
          fillStyle: "#ff00ff40",
          strokeStyle: "#2468ac",
          lineWidth: 3,
          font: "bold 11px sans-serif",
        },
      },
    ] as const;
    const normal = paintTrace({
      color: "#2468ac",
      label: "ACTIVE",
      textWidth: 19,
      x: 25,
      y: 25,
      width: 100,
      height: 50,
    });

    for (const testCase of cases) {
      const events: string[] = [];
      const failure = new Error(`${testCase.label} boom`);
      const record = recordingContext({ events, measurementWidths: [19] });
      const rows = trackedRows([instance(-1)], events);
      let metadataRead = 0;
      const dynamic = {
        id: "active",
        get color() {
          metadataRead += 1;
          if (testCase.failureRead === metadataRead) throw failure;
          return "#2468ac";
        },
        get name() {
          metadataRead += 1;
          if (testCase.failureRead === metadataRead) throw failure;
          return "ACTIVE";
        },
        tagText: "ACTIVE TEXT",
      } satisfies ActiveTagRenderData;

      expect(captureThrown(() => draw(record.context, dynamic, rows)), testCase.label)
        .toBe(failure);
      expect(record.trace, testCase.label).toEqual(normal.slice(0, testCase.traceLength));
      expect(record.state(), testCase.label).toEqual(testCase.state);
      expect(events, testCase.label).toContain("rows:call-return:receiver");
      expectNoEnvelopeOrReset(record.trace);
    }
  });
});
