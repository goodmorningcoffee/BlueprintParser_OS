// @vitest-environment node

import { describe, expect, it } from "vitest";
import { drawSymbolSearchResults } from "../symbolSearchResults";

type Bbox = readonly [number, number, number, number];

interface TestMatch {
  readonly id: string;
  readonly pageNumber: number;
  readonly bbox: Bbox;
  readonly confidence: number;
}

interface TestResults {
  readonly matches: readonly TestMatch[];
}

interface TestProps {
  readonly symbolSearchResults: TestResults | null;
  readonly pageNumber: number;
  readonly symbolSearchConfidence: number;
  readonly dismissedSymbolMatches: ReadonlySet<string>;
  readonly width: number;
  readonly height: number;
}

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

interface ContextOptions {
  readonly events?: string[];
  readonly throwOnSet?: { readonly property: string; readonly error: Error };
  readonly throwOnMethodGet?: { readonly method: string; readonly error: Error };
  readonly throwOnCall?: { readonly method: string; readonly error: Error };
}

function recordingContext(options: ContextOptions = {}): {
  context: CanvasRenderingContext2D;
  trace: TraceEntry[];
  state: () => CanvasState;
} {
  const trace: TraceEntry[] = [];
  let dash = [9, 3];
  let stackDepth = 0;
  let context: CanvasRenderingContext2D;
  const call = (method: string, receiver: unknown, args: unknown[]) => {
    trace.push(["call", method, ...args]);
    options.events?.push(
      `ctx:call:${method}:${receiver === context ? "receiver" : "detached"}`,
    );
    if (options.throwOnCall?.method === method) throw options.throwOnCall.error;
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
    "fillText",
    "setLineDash",
    "save",
    "restore",
  ]);
  context = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && watchedMethods.has(property)) {
        options.events?.push(`ctx:get:${property}`);
        if (options.throwOnMethodGet?.method === property) {
          throw options.throwOnMethodGet.error;
        }
      }
      return Reflect.get(object, property, receiver);
    },
    set(object, property, value, receiver) {
      if (typeof property === "string") {
        trace.push(["set", property, value]);
        options.events?.push(
          `ctx:set:${property}:${String(value)}:${receiver === context ? "receiver" : "detached"}`,
        );
        if (options.throwOnSet?.property === property) throw options.throwOnSet.error;
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

function paintTrace(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
): TraceEntry[] {
  return [
    ["set", "fillStyle", "rgba(34,211,238,0.15)"],
    ["call", "fillRect", x, y, width, height],
    ["set", "strokeStyle", "#22d3ee"],
    ["set", "lineWidth", 2.5],
    ["call", "setLineDash", []],
    ["call", "strokeRect", x, y, width, height],
    ["set", "font", "bold 10px sans-serif"],
    ["set", "fillStyle", "#22d3ee"],
    ["call", "fillText", label, x + 2, y - 3],
  ];
}

function match(
  id: string,
  pageNumber: number,
  bbox: Bbox,
  confidence: number,
): TestMatch {
  return { id, pageNumber, bbox, confidence };
}

function props(
  symbolSearchResults: TestResults | null,
  overrides: Partial<Omit<TestProps, "symbolSearchResults">> = {},
): TestProps {
  return {
    symbolSearchResults,
    pageNumber: overrides.pageNumber ?? 1,
    symbolSearchConfidence: overrides.symbolSearchConfidence ?? 0.75,
    dismissedSymbolMatches: overrides.dismissedSymbolMatches ?? new Set<string>(),
    width: overrides.width ?? 200,
    height: overrides.height ?? 100,
  };
}

function draw(
  context: CanvasRenderingContext2D,
  testProps: TestProps,
): void {
  drawSymbolSearchResults(context, testProps);
}

function expectInheritedState(record: ReturnType<typeof recordingContext>): void {
  expect(record.state()).toEqual({
    dash: [9, 3],
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
    stackDepth: 0,
  });
}

function expectNoEnvelope(trace: readonly TraceEntry[]): void {
  expect(trace.some((entry) =>
    entry[0] === "call" && (entry[1] === "save" || entry[1] === "restore")
  )).toBe(false);
}

function filterTrackedMatches(
  values: readonly TestMatch[],
  events: string[],
): readonly TestMatch[] {
  let proxy: readonly TestMatch[];
  const target = [...values];
  proxy = new Proxy(target, {
    get(object, property, receiver) {
      if (property !== "filter") return Reflect.get(object, property, receiver);
      events.push("matches:get-filter");
      return function (
        this: unknown,
        predicate: (value: TestMatch, index: number, array: TestMatch[]) => unknown,
      ) {
        events.push(`matches:call-filter:${this === proxy ? "receiver" : "detached"}`);
        return Array.prototype.filter.call(this, predicate) as TestMatch[];
      };
    },
  });
  return proxy;
}

function trackedDismissed(
  decisions: Readonly<Record<string, unknown>>,
  events: string[],
): ReadonlySet<string> {
  const target = new Set<string>();
  let proxy: ReadonlySet<string>;
  proxy = new Proxy(target, {
    get(object, property) {
      if (property !== "has") return Reflect.get(object, property, object);
      events.push("dismissed:get-has");
      return function (this: unknown, id: string): unknown {
        events.push(
          `dismissed:call-has:${id}:${this === proxy ? "receiver" : "detached"}`,
        );
        return decisions[id];
      };
    },
  }) as unknown as ReadonlySet<string>;
  return proxy;
}

function customBbox(
  values: readonly number[],
  events: string[],
  throwOnNextIndex?: number,
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
              if (index === throwOnNextIndex) throw new Error("bbox next boom");
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

interface IterableOptions {
  readonly throwOnNextIndex?: number;
  readonly errorMessage?: string;
}

function customMatchIterable(
  values: readonly TestMatch[],
  events: string[],
  options: IterableOptions = {},
): readonly TestMatch[] {
  let index = 0;
  const iterable = {
    get [Symbol.iterator]() {
      events.push("filtered:get-iterator");
      return function (this: unknown) {
        events.push(`filtered:call-iterator:${this === iterable ? "receiver" : "detached"}`);
        const iterator = {
          get next() {
            events.push("filtered:get-next");
            return function (this: unknown) {
              events.push(`filtered:call-next:${index}:${this === iterator ? "receiver" : "detached"}`);
              if (index === options.throwOnNextIndex) {
                throw new Error(options.errorMessage ?? "filtered next boom");
              }
              if (index >= values.length) return { value: undefined, done: true };
              const value = values[index];
              index += 1;
              return { value, done: false };
            };
          },
          get return() {
            events.push("filtered:get-return");
            return function (this: unknown) {
              events.push(`filtered:call-return:${this === iterator ? "receiver" : "detached"}`);
              return { value: undefined, done: true };
            };
          },
        };
        return iterator;
      };
    },
  };
  return iterable as unknown as readonly TestMatch[];
}

function resultsWithFilterReturn(
  returned: readonly TestMatch[],
  events: string[],
  predicateInputs: readonly TestMatch[] = [],
): TestResults {
  let matches: readonly TestMatch[];
  matches = {
    get filter() {
      events.push("matches:get-filter");
      return function (
        this: unknown,
        predicate: (value: TestMatch, index: number, array: readonly TestMatch[]) => unknown,
      ) {
        events.push(`matches:call-filter:${this === matches ? "receiver" : "detached"}`);
        predicateInputs.forEach((value, index) => predicate(value, index, predicateInputs));
        return returned;
      };
    },
  } as unknown as readonly TestMatch[];
  return { matches };
}

describe("drawSymbolSearchResults", () => {
  it("destructures props in order while a null result keeps all internals and canvas cold", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const dismissed = {
      has(): boolean {
        throw new Error("null dismissed set must stay cold");
      },
    } as unknown as ReadonlySet<string>;
    const testProps = {
      get symbolSearchResults() {
        events.push("props:symbolSearchResults");
        return null;
      },
      get pageNumber() {
        events.push("props:pageNumber");
        return 1;
      },
      get symbolSearchConfidence() {
        events.push("props:symbolSearchConfidence");
        return 0.75;
      },
      get dismissedSymbolMatches() {
        events.push("props:dismissedSymbolMatches");
        return dismissed;
      },
      get width() {
        events.push("props:width");
        return 200;
      },
      get height() {
        events.push("props:height");
        return 100;
      },
    };

    draw(record.context, testProps);

    expect(events).toEqual([
      "props:symbolSearchResults",
      "props:pageNumber",
      "props:symbolSearchConfidence",
      "props:dismissedSymbolMatches",
      "props:width",
      "props:height",
    ]);
    expect(record.trace).toEqual([]);
    expectInheritedState(record);
  });

  it("preserves exact predicate order, eager filtering, source order, paint, and leakage", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const coerciblePage = {
      [Symbol.toPrimitive]() {
        events.push("coercible:page-coercion");
        return 1;
      },
    } as unknown as number;
    const tracked = ({
      name,
      page,
      confidences,
      id,
      bbox,
    }: {
      name: string;
      page: number;
      confidences: readonly number[];
      id: string;
      bbox: Bbox;
    }): TestMatch => {
      let confidenceRead = 0;
      return {
        get pageNumber() {
          events.push(`${name}:pageNumber`);
          return page;
        },
        get confidence() {
          events.push(`${name}:confidence:${confidenceRead + 1}`);
          const value = confidences[Math.min(confidenceRead, confidences.length - 1)];
          confidenceRead += 1;
          return value;
        },
        get id() {
          events.push(`${name}:id`);
          return id;
        },
        get bbox() {
          events.push(`${name}:bbox`);
          return bbox;
        },
      };
    };
    const rows = [
      tracked({
        name: "strict",
        page: coerciblePage,
        confidences: [1],
        id: "strict",
        bbox: [0, 0, 1, 1],
      }),
      tracked({
        name: "offpage",
        page: 2,
        confidences: [1],
        id: "offpage",
        bbox: [0, 0, 1, 1],
      }),
      tracked({
        name: "below",
        page: 1,
        confidences: [0.749],
        id: "below",
        bbox: [0, 0, 1, 1],
      }),
      tracked({
        name: "truthy-dismissed",
        page: 1,
        confidences: [0.75],
        id: "truthy-dismissed",
        bbox: [0, 0, 1, 1],
      }),
      tracked({
        name: "boundary",
        page: 1,
        confidences: [0.75, 0.75],
        id: "boundary",
        bbox: [0.625, 0.125, 0.125, 0.375],
      }),
      tracked({
        name: "dynamic",
        page: 1,
        confidences: [0.751, 0.806],
        id: "dynamic",
        bbox: [0.125, 0.75, 0.25, 0.125],
      }),
    ];
    const matches = filterTrackedMatches(rows, events);
    const results = {
      get matches() {
        events.push("results:matches");
        return matches;
      },
    };
    const dismissed = trackedDismissed({
      "truthy-dismissed": "dismissed",
      boundary: 0,
      dynamic: undefined,
    }, events);

    draw(record.context, props(results, { dismissedSymbolMatches: dismissed }));

    const firstCanvas = events.findIndex((event) => event.startsWith("ctx:"));
    expect(events.slice(0, firstCanvas)).toEqual([
      "results:matches",
      "matches:get-filter",
      "matches:call-filter:receiver",
      "strict:pageNumber",
      "offpage:pageNumber",
      "below:pageNumber",
      "below:confidence:1",
      "truthy-dismissed:pageNumber",
      "truthy-dismissed:confidence:1",
      "dismissed:get-has",
      "truthy-dismissed:id",
      "dismissed:call-has:truthy-dismissed:receiver",
      "boundary:pageNumber",
      "boundary:confidence:1",
      "dismissed:get-has",
      "boundary:id",
      "dismissed:call-has:boundary:receiver",
      "dynamic:pageNumber",
      "dynamic:confidence:1",
      "dismissed:get-has",
      "dynamic:id",
      "dismissed:call-has:dynamic:receiver",
      "boundary:bbox",
    ]);
    expect(events).not.toContain("coercible:page-coercion");
    expect(events.indexOf("dynamic:bbox")).toBeGreaterThan(firstCanvas);
    expect(events).toContain("boundary:confidence:2");
    expect(events).toContain("dynamic:confidence:2");
    expect(record.trace).toEqual([
      ...paintTrace(125, 12.5, 25, 37.5, "75%"),
      ...paintTrace(25, 75, 50, 12.5, "81%"),
    ]);
    expect(record.state()).toEqual({
      dash: [],
      fillStyle: "#22d3ee",
      strokeStyle: "#22d3ee",
      lineWidth: 2.5,
      globalAlpha: 0.37,
      font: "bold 10px sans-serif",
      stackDepth: 0,
    });
    expectNoEnvelope(record.trace);
  });

  it("retains native filter length snapshot, sparse holes, inherited indices, and visit order", () => {
    const events: string[] = [];
    const record = recordingContext();
    const offpage = (name: string): TestMatch => ({
      id: name,
      get pageNumber() {
        events.push(`${name}:pageNumber`);
        return 2;
      },
      bbox: [0, 0, 1, 1],
      confidence: 1,
    });
    const target = Object.create({ 1: offpage("inherited-1") }) as Record<PropertyKey, unknown>;
    target.length = 4;
    target[0] = offpage("own-0");
    let source: readonly TestMatch[];
    source = new Proxy(target, {
      get(object, property, receiver) {
        if (property === "filter") {
          events.push("source:get-filter");
          return function (
            this: unknown,
            predicate: (value: TestMatch, index: number, array: TestMatch[]) => unknown,
          ) {
            events.push(`source:call-filter:${this === source ? "receiver" : "detached"}`);
            return Array.prototype.filter.call(this, predicate);
          };
        }
        if (property === "0") {
          events.push("source:get:0");
          object[2] = offpage("added-2");
        } else if (property === "1") {
          events.push("source:get:1");
        } else if (property === "2") {
          events.push("source:get:2");
          object[4] = offpage("late-4");
        }
        return Reflect.get(object, property, receiver);
      },
      has(object, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          events.push(`source:has:${property}`);
        }
        return Reflect.has(object, property);
      },
    }) as unknown as readonly TestMatch[];

    draw(record.context, props({ matches: source }));

    expect(events).toEqual([
      "source:get-filter",
      "source:call-filter:receiver",
      "source:has:0",
      "source:get:0",
      "own-0:pageNumber",
      "source:has:1",
      "source:get:1",
      "inherited-1:pageNumber",
      "source:has:2",
      "source:get:2",
      "added-2:pageNumber",
      "source:has:3",
    ]);
    expect(events).not.toContain("source:has:4");
    expect(record.trace).toEqual([]);
    expectInheritedState(record);
  });

  it("keeps null, empty, and fully rejected inputs canvas-cold", () => {
    const nullRecord = recordingContext();
    draw(nullRecord.context, props(null));
    expect(nullRecord.trace).toEqual([]);
    expectInheritedState(nullRecord);

    const emptyEvents: string[] = [];
    const emptyRecord = recordingContext();
    draw(emptyRecord.context, props({ matches: filterTrackedMatches([], emptyEvents) }));
    expect(emptyEvents).toEqual([
      "matches:get-filter",
      "matches:call-filter:receiver",
    ]);
    expect(emptyRecord.trace).toEqual([]);
    expectInheritedState(emptyRecord);

    const rejectedRecord = recordingContext();
    draw(rejectedRecord.context, props({
      matches: [match("other", 2, [0, 0, 1, 1], 1)],
    }));
    expect(rejectedRecord.trace).toEqual([]);
    expectInheritedState(rejectedRecord);
  });

  it("preserves custom filter-result and bbox iterator receivers, closes bbox, and uses LTWH", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const painted = {
      id: "painted",
      pageNumber: 1,
      confidence: 0.876,
      get bbox() {
        events.push("match:bbox");
        return customBbox([0.125, 0.25, 0.375, 0.5], events);
      },
    };
    const filtered = customMatchIterable([painted], events);

    draw(record.context, props(resultsWithFilterReturn(filtered, events)));

    expect(events).toEqual([
      "matches:get-filter",
      "matches:call-filter:receiver",
      "filtered:get-iterator",
      "filtered:call-iterator:receiver",
      "filtered:get-next",
      "filtered:call-next:0:receiver",
      "match:bbox",
      "bbox:get-iterator",
      "bbox:call-iterator:receiver",
      "bbox:get-next",
      "bbox:call-next:0:receiver",
      "bbox:call-next:1:receiver",
      "bbox:call-next:2:receiver",
      "bbox:call-next:3:receiver",
      "bbox:get-return",
      "bbox:call-return:receiver",
      "ctx:set:fillStyle:rgba(34,211,238,0.15):receiver",
      "ctx:get:fillRect",
      "ctx:call:fillRect:receiver",
      "ctx:set:strokeStyle:#22d3ee:receiver",
      "ctx:set:lineWidth:2.5:receiver",
      "ctx:get:setLineDash",
      "ctx:call:setLineDash:receiver",
      "ctx:get:strokeRect",
      "ctx:call:strokeRect:receiver",
      "ctx:set:font:bold 10px sans-serif:receiver",
      "ctx:set:fillStyle:#22d3ee:receiver",
      "ctx:get:fillText",
      "ctx:call:fillText:receiver",
      "filtered:call-next:1:receiver",
    ]);
    expect(events).not.toContain("filtered:get-return");
    expect(record.trace).toEqual(paintTrace(25, 25, 75, 50, "88%"));
  });

  it("propagates filter Get/call and late predicate failures before any paint", () => {
    const getRecord = recordingContext();
    const getFailure = {
      get filter(): never {
        throw new Error("filter get boom");
      },
    } as unknown as readonly TestMatch[];
    expect(() => draw(getRecord.context, props({ matches: getFailure }))).toThrow(
      "filter get boom",
    );
    expect(getRecord.trace).toEqual([]);

    const callRecord = recordingContext();
    const callFailure = {
      filter(): never {
        throw new Error("filter call boom");
      },
    } as unknown as readonly TestMatch[];
    expect(() => draw(callRecord.context, props({ matches: callFailure }))).toThrow(
      "filter call boom",
    );
    expect(callRecord.trace).toEqual([]);

    const predicateRecord = recordingContext();
    let acceptedBboxReads = 0;
    const accepted = {
      id: "accepted",
      pageNumber: 1,
      confidence: 1,
      get bbox(): Bbox {
        acceptedBboxReads += 1;
        return [0, 0, 1, 1];
      },
    };
    const lateFailure = {
      id: "late",
      get pageNumber(): number {
        throw new Error("predicate boom");
      },
      confidence: 1,
      bbox: [0, 0, 1, 1] as Bbox,
    };
    expect(() => draw(
      predicateRecord.context,
      props({ matches: [accepted, lateFailure] }),
    )).toThrow("predicate boom");
    expect(acceptedBboxReads).toBe(0);
    expect(predicateRecord.trace).toEqual([]);
  });

  it("propagates a returned-iterator next failure after completed paint without closing it", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const first = match("first", 1, [0.125, 0.25, 0.375, 0.5], 0.75);
    const filtered = customMatchIterable([first], events, {
      throwOnNextIndex: 1,
      errorMessage: "next boom",
    });

    expect(() => draw(
      record.context,
      props(resultsWithFilterReturn(filtered, events)),
    )).toThrow("next boom");

    expect(record.trace).toEqual(paintTrace(25, 25, 75, 50, "75%"));
    expect(events).not.toContain("filtered:get-return");
    expectNoEnvelope(record.trace);
  });

  it("propagates bbox iteration failure before paint and closes the filtered source", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const failing = {
      id: "failing",
      pageNumber: 1,
      confidence: 1,
      bbox: customBbox([0.125, 0.25, 0.375, 0.5], events, 2),
    };
    const filtered = customMatchIterable([failing], events);

    expect(() => draw(
      record.context,
      props(resultsWithFilterReturn(filtered, events)),
    )).toThrow("bbox next boom");

    expect(record.trace).toEqual([]);
    expect(events).toContain("filtered:get-return");
    expect(events).toContain("filtered:call-return:receiver");
    expect(events).not.toContain("bbox:get-return");
    expectInheritedState(record);
  });

  it("propagates fillStyle and fillRect failures with exact partial state and closes rows", () => {
    const setterEvents: string[] = [];
    const setterFailure = new Error("fillStyle boom");
    const setterRecord = recordingContext({
      events: setterEvents,
      throwOnSet: { property: "fillStyle", error: setterFailure },
    });
    const setterRows = customMatchIterable([
      match("first", 1, [0.125, 0.25, 0.375, 0.5], 0.75),
    ], setterEvents);
    expect(() => draw(
      setterRecord.context,
      props(resultsWithFilterReturn(setterRows, setterEvents)),
    )).toThrow(setterFailure);
    expect(setterRecord.trace).toEqual([
      ["set", "fillStyle", "rgba(34,211,238,0.15)"],
    ]);
    expect(setterEvents).toContain("filtered:call-return:receiver");
    expectInheritedState(setterRecord);

    const fillEvents: string[] = [];
    const fillFailure = new Error("fillRect boom");
    const fillRecord = recordingContext({
      events: fillEvents,
      throwOnCall: { method: "fillRect", error: fillFailure },
    });
    const fillRows = customMatchIterable([
      match("first", 1, [0.125, 0.25, 0.375, 0.5], 0.75),
    ], fillEvents);
    expect(() => draw(
      fillRecord.context,
      props(resultsWithFilterReturn(fillRows, fillEvents)),
    )).toThrow(fillFailure);
    expect(fillRecord.trace).toEqual([
      ["set", "fillStyle", "rgba(34,211,238,0.15)"],
      ["call", "fillRect", 25, 25, 75, 50],
    ]);
    expect(fillRecord.state()).toEqual({
      dash: [9, 3],
      fillStyle: "rgba(34,211,238,0.15)",
      strokeStyle: "inherited-stroke",
      lineWidth: 7,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 0,
    });
    expect(fillEvents).toContain("filtered:call-return:receiver");
  });

  it("propagates dash and stroke failures without cleanup", () => {
    const dashEvents: string[] = [];
    const dashFailure = new Error("dash boom");
    const dashRecord = recordingContext({
      events: dashEvents,
      throwOnCall: { method: "setLineDash", error: dashFailure },
    });
    const dashRows = customMatchIterable([
      match("first", 1, [0.125, 0.25, 0.375, 0.5], 0.75),
    ], dashEvents);
    expect(() => draw(
      dashRecord.context,
      props(resultsWithFilterReturn(dashRows, dashEvents)),
    )).toThrow(dashFailure);
    expect(dashRecord.trace).toEqual([
      ["set", "fillStyle", "rgba(34,211,238,0.15)"],
      ["call", "fillRect", 25, 25, 75, 50],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 2.5],
      ["call", "setLineDash", []],
    ]);
    expect(dashRecord.state()).toEqual({
      dash: [9, 3],
      fillStyle: "rgba(34,211,238,0.15)",
      strokeStyle: "#22d3ee",
      lineWidth: 2.5,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 0,
    });
    expect(dashEvents).toContain("filtered:call-return:receiver");

    const strokeEvents: string[] = [];
    const strokeFailure = new Error("stroke boom");
    const strokeRecord = recordingContext({
      events: strokeEvents,
      throwOnCall: { method: "strokeRect", error: strokeFailure },
    });
    const strokeRows = customMatchIterable([
      match("first", 1, [0.125, 0.25, 0.375, 0.5], 0.75),
    ], strokeEvents);
    expect(() => draw(
      strokeRecord.context,
      props(resultsWithFilterReturn(strokeRows, strokeEvents)),
    )).toThrow(strokeFailure);
    expect(strokeRecord.trace).toEqual([
      ["set", "fillStyle", "rgba(34,211,238,0.15)"],
      ["call", "fillRect", 25, 25, 75, 50],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 2.5],
      ["call", "setLineDash", []],
      ["call", "strokeRect", 25, 25, 75, 50],
    ]);
    expect(strokeRecord.state().dash).toEqual([]);
    expect(strokeRecord.state().font).toBe("italic 13px serif");
    expect(strokeEvents).toContain("filtered:call-return:receiver");
    expectNoEnvelope(strokeRecord.trace);
  });

  it("propagates second-confidence and fillText failures at their exact label states", () => {
    const confidenceEvents: string[] = [];
    const confidenceRecord = recordingContext({ events: confidenceEvents });
    let confidenceReads = 0;
    const confidenceFailure = {
      id: "confidence",
      pageNumber: 1,
      bbox: [0.125, 0.25, 0.375, 0.5] as Bbox,
      get confidence(): number {
        confidenceReads += 1;
        if (confidenceReads === 2) throw new Error("label confidence boom");
        return 0.75;
      },
    };
    const confidenceRows = customMatchIterable([confidenceFailure], confidenceEvents);
    expect(() => draw(
      confidenceRecord.context,
      props(resultsWithFilterReturn(confidenceRows, confidenceEvents, [confidenceFailure])),
    )).toThrow("label confidence boom");
    expect(confidenceReads).toBe(2);
    expect(confidenceRecord.trace).toEqual([
      ["set", "fillStyle", "rgba(34,211,238,0.15)"],
      ["call", "fillRect", 25, 25, 75, 50],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 2.5],
      ["call", "setLineDash", []],
      ["call", "strokeRect", 25, 25, 75, 50],
      ["set", "font", "bold 10px sans-serif"],
      ["set", "fillStyle", "#22d3ee"],
    ]);
    expect(confidenceEvents).toContain("filtered:call-return:receiver");

    const textEvents: string[] = [];
    const textFailure = new Error("fillText boom");
    const textRecord = recordingContext({
      events: textEvents,
      throwOnCall: { method: "fillText", error: textFailure },
    });
    const textMatch = match("text", 1, [0.125, 0.25, 0.375, 0.5], 0.806);
    const textRows = customMatchIterable([textMatch], textEvents);
    expect(() => draw(
      textRecord.context,
      props(resultsWithFilterReturn(textRows, textEvents)),
    )).toThrow(textFailure);
    expect(textRecord.trace).toEqual(paintTrace(25, 25, 75, 50, "81%"));
    expect(textRecord.state()).toEqual({
      dash: [],
      fillStyle: "#22d3ee",
      strokeStyle: "#22d3ee",
      lineWidth: 2.5,
      globalAlpha: 0.37,
      font: "bold 10px sans-serif",
      stackDepth: 0,
    });
    expect(textEvents).toContain("filtered:call-return:receiver");
    expectNoEnvelope(textRecord.trace);
  });
});
