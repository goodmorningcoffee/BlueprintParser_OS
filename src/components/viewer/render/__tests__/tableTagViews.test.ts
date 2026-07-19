// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { drawTableTagViews } from "../tableTagViews";

type Bbox = [number, number, number, number];

interface TestView {
  readonly pageNum: number;
  readonly bbox: Bbox;
  readonly tagTexts: readonly string[];
  readonly source: "schedule" | "keynote";
}

interface TestTag {
  readonly id: string;
}

interface TestInstance {
  readonly bbox: Bbox;
}

type TraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown];

interface ContextOptions {
  readonly events?: string[];
  readonly metricsWidth?: number;
  readonly throwOnMetricsWidth?: Error;
}

function recordingContext(options: ContextOptions = {}): {
  context: CanvasRenderingContext2D;
  trace: TraceEntry[];
} {
  const trace: TraceEntry[] = [];
  let firstCanvasMutation = true;
  const generatedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const target: Record<PropertyKey, unknown> = {
    measureText(text: string) {
      trace.push(["call", "measureText", text]);
      options.events?.push(`metrics:measure:${text}`);
      return {
        get width() {
          options.events?.push("metrics:width");
          if (options.throwOnMetricsWidth) throw options.throwOnMetricsWidth;
          return options.metricsWidth ?? text.length * 6;
        },
      };
    },
  };
  const context = new Proxy(target, {
    get(object, property, receiver) {
      if (property === "measureText") options.events?.push("ctx:get:measureText");
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (typeof property !== "string") return undefined;
      let method = generatedMethods.get(property);
      if (!method) {
        method = (...args: unknown[]) => {
          trace.push(["call", property, ...args]);
          if (firstCanvasMutation) {
            firstCanvasMutation = false;
            options.events?.push(`canvas:first:call:${property}`);
          }
        };
        generatedMethods.set(property, method);
      }
      return method;
    },
    set(object, property, value, receiver) {
      if (typeof property === "string") {
        trace.push(["set", property, value]);
        if (firstCanvasMutation) {
          firstCanvasMutation = false;
          options.events?.push(`canvas:first:set:${property}`);
        }
      }
      return Reflect.set(object, property, value, receiver);
    },
  }) as unknown as CanvasRenderingContext2D;
  return { context, trace };
}

function regionPaint(
  x: number,
  y: number,
  width: number,
  height: number,
): TraceEntry[] {
  return [
    ["set", "fillStyle", "rgba(59, 130, 246, 0.08)"],
    ["set", "strokeStyle", "rgba(59, 130, 246, 0.3)"],
    ["set", "lineWidth", 1.5],
    ["call", "fillRect", x, y, width, height],
    ["call", "strokeRect", x, y, width, height],
  ];
}

function instancePaint(
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  measuredWidth = label.length * 6,
): TraceEntry[] {
  return [
    ["set", "fillStyle", "#ff00ff25"],
    ["set", "strokeStyle", "#ff00ff"],
    ["set", "lineWidth", 1.5],
    ["call", "fillRect", x, y, width, height],
    ["call", "strokeRect", x, y, width, height],
    ["set", "font", "bold 9px sans-serif"],
    ["call", "measureText", label],
    ["set", "fillStyle", "#ff00ffcc"],
    ["call", "fillRect", x, y + height + 1, measuredWidth + 6, 12],
    ["set", "fillStyle", "#fff"],
    ["call", "fillText", label, x + 3, y + height + 10],
  ];
}

function view(
  pageNum: number,
  bbox: Bbox,
  tagTexts: readonly string[],
  source: TestView["source"],
): TestView {
  return { pageNum, bbox, tagTexts, source };
}

function draw(
  context: CanvasRenderingContext2D,
  activeTableTagViews: Readonly<Record<string, TestView>>,
  tagTextIndex: ReadonlyMap<string, TestTag> = new Map(),
  pageTagInstances: ReadonlyMap<string, readonly TestInstance[]> = new Map(),
): void {
  drawTableTagViews(context, {
    activeTableTagViews,
    pageNumber: 1,
    width: 200,
    height: 100,
    tagTextIndex,
    pageTagInstances,
  });
}

describe("drawTableTagViews", () => {
  it("keeps an empty enumerable-string guard map- and canvas-cold", () => {
    const record = recordingContext();
    const reads: string[] = [];
    const inherited = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(inherited, "inherited", {
      enumerable: true,
      get() {
        reads.push("inherited");
        return view(1, [0, 0, 1, 1], [], "schedule");
      },
    });
    const active = Object.create(inherited) as Record<PropertyKey, unknown>;
    Object.defineProperty(active, "non-enumerable", {
      enumerable: false,
      get() {
        reads.push("non-enumerable");
        return view(1, [0, 0, 1, 1], [], "schedule");
      },
    });
    Object.defineProperty(active, Symbol("symbol-view"), {
      enumerable: true,
      get() {
        reads.push("symbol");
        return view(1, [0, 0, 1, 1], [], "schedule");
      },
    });
    const tagTextIndex = new Map<string, TestTag>();
    const pageTagInstances = new Map<string, readonly TestInstance[]>();
    const tagGet = vi.spyOn(tagTextIndex, "get");
    const instanceGet = vi.spyOn(pageTagInstances, "get");

    draw(
      record.context,
      active as unknown as Readonly<Record<string, TestView>>,
      tagTextIndex,
      pageTagInstances,
    );

    expect(reads).toEqual([]);
    expect(tagGet).not.toHaveBeenCalled();
    expect(instanceGet).not.toHaveBeenCalled();
    expect(record.trace).toEqual([]);
  });

  it("runs Object.keys before eager Object.values and preserves numeric/string own-key order", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const target: Record<PropertyKey, unknown> = {};
    const install = (key: string, value: TestView) => {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get() {
          events.push(`views:get:${key}`);
          return value;
        },
      });
    };
    // Deliberately install strings around integer-index keys. ECMAScript own-key order is 2, 10,
    // then the non-index strings in their insertion order.
    install("alpha", view(1, [0.25, 0.25, 0.5, 0.5], [], "schedule"));
    install("10", view(1, [0.125, 0.125, 0.25, 0.25], [], "schedule"));
    install("2", view(1, [0, 0, 0.125, 0.125], [], "schedule"));
    install("omega", view(1, [0.5, 0.5, 0.75, 0.75], [], "schedule"));
    Object.defineProperty(target, "ignored", {
      configurable: true,
      enumerable: false,
      get() {
        events.push("views:get:ignored");
        return view(1, [0, 0, 1, 1], [], "schedule");
      },
    });
    const symbolKey = Symbol("ignored");
    Object.defineProperty(target, symbolKey, {
      configurable: true,
      enumerable: true,
      get() {
        events.push("views:get:symbol");
        return view(1, [0, 0, 1, 1], [], "schedule");
      },
    });
    const active = new Proxy(target, {
      ownKeys(object) {
        events.push("views:ownKeys");
        return Reflect.ownKeys(object);
      },
    });

    draw(
      record.context,
      active as unknown as Readonly<Record<string, TestView>>,
    );

    expect(events.slice(0, 7)).toEqual([
      "views:ownKeys",
      "views:ownKeys",
      "views:get:2",
      "views:get:10",
      "views:get:alpha",
      "views:get:omega",
      "canvas:first:set:fillStyle",
    ]);
    expect(events).not.toContain("views:get:ignored");
    expect(events).not.toContain("views:get:symbol");
    expect(record.trace.filter((entry) =>
      entry[0] === "call" && entry[1] === "fillRect"
    )).toEqual([
      ["call", "fillRect", 0, 0, 25, 12.5],
      ["call", "fillRect", 25, 12.5, 25, 12.5],
      ["call", "fillRect", 50, 25, 50, 25],
      ["call", "fillRect", 100, 50, 50, 25],
    ]);
  });

  it("keeps page gating local to regions and preserves tag, duplicate, and instance order", () => {
    const record = recordingContext();
    const activeTableTagViews = {
      offPage: view(
        2,
        [0, 0, 1, 1],
        ["A-1", "missing", "A-1", "orphan"],
        "schedule",
      ),
      onPage: view(1, [0.5, 0.125, 0.875, 0.5], ["B-2"], "keynote"),
    };
    const tagTextIndex = new Map<string, TestTag>([
      ["A-1:schedule", { id: "tag-a" }],
      ["orphan:schedule", { id: "tag-orphan" }],
      ["B-2:keynote", { id: "tag-b" }],
    ]);
    const pageTagInstances = new Map<string, readonly TestInstance[]>([
      ["tag-a", [
        { bbox: [0.125, 0.25, 0.375, 0.5] },
        { bbox: [0.5, 0.125, 0.75, 0.375] },
      ]],
      ["tag-b", [{ bbox: [0.25, 0.5, 0.5, 0.75] }]],
    ]);
    const tagGet = vi.spyOn(tagTextIndex, "get");
    const instanceGet = vi.spyOn(pageTagInstances, "get");

    draw(record.context, activeTableTagViews, tagTextIndex, pageTagInstances);

    expect(tagGet.mock.calls).toEqual([
      ["A-1:schedule"],
      ["missing:schedule"],
      ["A-1:schedule"],
      ["orphan:schedule"],
      ["B-2:keynote"],
    ]);
    expect(instanceGet.mock.calls).toEqual([
      ["tag-a"],
      ["tag-a"],
      ["tag-orphan"],
      ["tag-b"],
    ]);
    expect(record.trace).toEqual([
      ...instancePaint("A-1", 22, 22, 56, 31),
      ...instancePaint("A-1", 97, 9.5, 56, 31),
      ...instancePaint("A-1", 22, 22, 56, 31),
      ...instancePaint("A-1", 97, 9.5, 56, 31),
      ...regionPaint(100, 12.5, 75, 37.5),
      ...instancePaint("B-2", 47, 47, 56, 31),
    ]);
    expect(record.trace.some((entry) =>
      entry[0] === "call" && (entry[1] === "save" || entry[1] === "restore")
    )).toBe(false);
  });

  it("preserves getter counts plus Map method receiver and property-before-argument order", () => {
    const events: string[] = [];
    const record = recordingContext({ events, metricsWidth: 17.25 });
    const renderedView = {
      get pageNum() {
        events.push("view:pageNum");
        return 1;
      },
      get bbox(): Bbox {
        events.push("view:bbox");
        return [0, 0, 0.125, 0.125];
      },
      get tagTexts(): readonly string[] {
        events.push("view:tagTexts");
        return ["X-1"];
      },
      get source(): "schedule" {
        events.push("view:source");
        return "schedule";
      },
    };
    const active: Record<string, TestView> = {};
    Object.defineProperty(active, "view", {
      enumerable: true,
      get() {
        events.push("views:get:view");
        return renderedView;
      },
    });
    const matchingTag = {
      get id() {
        events.push("match:id");
        return "tag-x";
      },
    };
    const tagTextIndex = {
      get get() {
        events.push("tagMap:get-method");
        return function (this: unknown, key: string): TestTag | undefined {
          events.push(this === tagTextIndex
            ? `tagMap:call:${key}:receiver`
            : `tagMap:call:${key}:detached`);
          return matchingTag;
        };
      },
    } as unknown as ReadonlyMap<string, TestTag>;
    const renderedInstance = {
      get bbox(): Bbox {
        events.push("instance:bbox");
        return [0.25, 0.25, 0.5, 0.5];
      },
    };
    const pageTagInstances = {
      get get() {
        events.push("pageMap:get-method");
        return function (this: unknown, key: string): readonly TestInstance[] | undefined {
          events.push(this === pageTagInstances
            ? `pageMap:call:${key}:receiver`
            : `pageMap:call:${key}:detached`);
          return [renderedInstance];
        };
      },
    } as unknown as ReadonlyMap<string, readonly TestInstance[]>;

    draw(record.context, active, tagTextIndex, pageTagInstances);

    expect(events).toEqual([
      "views:get:view",
      "view:pageNum",
      "view:bbox",
      "canvas:first:set:fillStyle",
      "view:tagTexts",
      "tagMap:get-method",
      "view:source",
      "tagMap:call:X-1:schedule:receiver",
      "pageMap:get-method",
      "match:id",
      "pageMap:call:tag-x:receiver",
      "instance:bbox",
      "ctx:get:measureText",
      "metrics:measure:X-1",
      "metrics:width",
    ]);
    expect(record.trace).toEqual([
      ...regionPaint(0, 0, 25, 12.5),
      ...instancePaint("X-1", 47, 22, 56, 31, 17.25),
    ]);
  });

  it("retains the logical-or fallback for a falsey page-map result", () => {
    const record = recordingContext();
    const pageGet = vi.fn(function (this: unknown, key: string) {
      expect(this).toBe(pageTagInstances);
      expect(key).toBe("tag-x");
      return false;
    });
    const pageTagInstances = {
      get: pageGet,
    } as unknown as ReadonlyMap<string, readonly TestInstance[]>;

    expect(() => draw(
      record.context,
      { offPage: view(2, [0, 0, 1, 1], ["X-1"], "schedule") },
      new Map([["X-1:schedule", { id: "tag-x" }]]),
      pageTagInstances,
    )).not.toThrow();

    expect(pageGet).toHaveBeenCalledTimes(1);
    expect(record.trace).toEqual([]);
  });

  it("propagates lookup and TextMetrics failures with the exact partial state and no cleanup", () => {
    const lookupRecord = recordingContext();
    const lookupFailure = {
      get get(): ReadonlyMap<string, TestTag>["get"] {
        throw new Error("lookup boom");
      },
    } as unknown as ReadonlyMap<string, TestTag>;

    expect(() => draw(
      lookupRecord.context,
      { onPage: view(1, [0, 0, 0.25, 0.25], ["X-1"], "schedule") },
      lookupFailure,
    )).toThrow("lookup boom");
    expect(lookupRecord.trace).toEqual(regionPaint(0, 0, 50, 25));

    const metricsRecord = recordingContext({
      throwOnMetricsWidth: new Error("metrics boom"),
    });
    expect(() => draw(
      metricsRecord.context,
      { offPage: view(2, [0, 0, 1, 1], ["X-1"], "schedule") },
      new Map([["X-1:schedule", { id: "tag-x" }]]),
      new Map([["tag-x", [{ bbox: [0.25, 0.25, 0.5, 0.5] }]]]),
    )).toThrow("metrics boom");
    expect(metricsRecord.trace).toEqual([
      ["set", "fillStyle", "#ff00ff25"],
      ["set", "strokeStyle", "#ff00ff"],
      ["set", "lineWidth", 1.5],
      ["call", "fillRect", 47, 22, 56, 31],
      ["call", "strokeRect", 47, 22, 56, 31],
      ["set", "font", "bold 9px sans-serif"],
      ["call", "measureText", "X-1"],
    ]);
    for (const trace of [lookupRecord.trace, metricsRecord.trace]) {
      expect(trace.some((entry) =>
        entry[0] === "call" && (entry[1] === "save" || entry[1] === "restore")
      )).toBe(false);
    }
  });
});
