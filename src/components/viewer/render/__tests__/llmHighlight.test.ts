// @vitest-environment node

import { describe, expect, it } from "vitest";
import { drawLlmHighlight } from "../llmHighlight";

type Bbox = readonly [number, number, number, number];

interface TestHighlight {
  readonly pageNumber: number;
  readonly bbox: Bbox;
  readonly label?: string;
}

type TraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown];

interface ContextOptions {
  readonly events?: string[];
  readonly metricsWidth?: number;
  readonly throwOnStrokeRect?: Error;
  readonly throwOnMetricsWidth?: Error;
  readonly throwOnFillText?: Error;
}

interface CanvasState {
  readonly dash: readonly number[];
  readonly strokeStyle: unknown;
  readonly lineWidth: unknown;
  readonly fillStyle: unknown;
  readonly font: unknown;
}

function recordingContext(options: ContextOptions = {}): {
  context: CanvasRenderingContext2D;
  trace: TraceEntry[];
  state: () => CanvasState;
} {
  const trace: TraceEntry[] = [];
  let dash = [1, 1];
  let context: CanvasRenderingContext2D;
  const target: Record<PropertyKey, unknown> = {
    strokeStyle: "initial-stroke",
    lineWidth: 7,
    fillStyle: "initial-fill",
    font: "initial-font",
    setLineDash(this: unknown, segments: number[]) {
      trace.push(["call", "setLineDash", segments]);
      options.events?.push(
        `ctx:call:setLineDash:${this === context ? "receiver" : "detached"}:${segments.join(",")}`,
      );
      dash = [...segments];
    },
    strokeRect(this: unknown, x: number, y: number, width: number, height: number) {
      trace.push(["call", "strokeRect", x, y, width, height]);
      options.events?.push(
        `ctx:call:strokeRect:${this === context ? "receiver" : "detached"}`,
      );
      if (options.throwOnStrokeRect) throw options.throwOnStrokeRect;
    },
    fillRect(this: unknown, x: number, y: number, width: number, height: number) {
      trace.push(["call", "fillRect", x, y, width, height]);
      options.events?.push(
        `ctx:call:fillRect:${this === context ? "receiver" : "detached"}`,
      );
    },
    measureText(this: unknown, text: string) {
      trace.push(["call", "measureText", text]);
      options.events?.push(
        `ctx:call:measureText:${this === context ? "receiver" : "detached"}:${text}`,
      );
      return {
        get width() {
          options.events?.push("metrics:width");
          if (options.throwOnMetricsWidth) throw options.throwOnMetricsWidth;
          return options.metricsWidth ?? text.length * 6;
        },
      };
    },
    fillText(this: unknown, text: string, x: number, y: number) {
      trace.push(["call", "fillText", text, x, y]);
      options.events?.push(
        `ctx:call:fillText:${this === context ? "receiver" : "detached"}:${text}`,
      );
      if (options.throwOnFillText) throw options.throwOnFillText;
    },
  };
  const watchedMethods = new Set([
    "setLineDash",
    "strokeRect",
    "fillRect",
    "measureText",
    "fillText",
  ]);
  context = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && watchedMethods.has(property)) {
        options.events?.push(`ctx:get:${property}`);
      }
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (typeof property !== "string") return undefined;
      return (...args: unknown[]) => {
        trace.push(["call", property, ...args]);
        options.events?.push(`ctx:call:${property}:generated`);
      };
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
      strokeStyle: target.strokeStyle,
      lineWidth: target.lineWidth,
      fillStyle: target.fillStyle,
      font: target.font,
    }),
  };
}

const BASE_TRACE: TraceEntry[] = [
  ["set", "strokeStyle", "#22d3ee"],
  ["set", "lineWidth", 3],
  ["call", "setLineDash", [8, 4]],
  ["call", "strokeRect", 25, 25, 100, 50],
  ["call", "setLineDash", []],
  ["set", "fillStyle", "#22d3ee20"],
  ["call", "fillRect", 25, 25, 100, 50],
];

function draw(
  context: CanvasRenderingContext2D,
  llmHighlight: TestHighlight | null,
): void {
  drawLlmHighlight(context, {
    llmHighlight,
    pageNumber: 1,
    width: 200,
    height: 100,
  });
}

function expectNoStateEnvelope(trace: readonly TraceEntry[]): void {
  expect(trace.some((entry) =>
    entry[0] === "call" && (entry[1] === "save" || entry[1] === "restore")
  )).toBe(false);
}

describe("drawLlmHighlight", () => {
  it("keeps null input entirely canvas-cold", () => {
    const record = recordingContext();

    draw(record.context, null);

    expect(record.trace).toEqual([]);
    expect(record.state()).toEqual({
      dash: [1, 1],
      strokeStyle: "initial-stroke",
      lineWidth: 7,
      fillStyle: "initial-fill",
      font: "initial-font",
    });
  });

  it("reads only pageNumber once for a wrong-page highlight", () => {
    const record = recordingContext();
    const reads: string[] = [];
    const wrongPage = {
      get pageNumber() {
        reads.push("pageNumber");
        return 2;
      },
      get bbox(): Bbox {
        reads.push("bbox");
        throw new Error("wrong-page bbox must stay cold");
      },
      get label(): string {
        reads.push("label");
        throw new Error("wrong-page label must stay cold");
      },
    };

    draw(record.context, wrongPage);

    expect(reads).toEqual(["pageNumber"]);
    expect(record.trace).toEqual([]);
  });

  it.each([
    ["empty string", ""],
    ["runtime zero", 0],
    ["runtime false", false],
    ["runtime null", null],
  ])("uses exact truthiness for a defined falsey label: %s", (_name, falseyLabel) => {
    const record = recordingContext();
    let labelReads = 0;
    const highlight = {
      pageNumber: 1,
      bbox: [0.125, 0.25, 0.625, 0.75] as Bbox,
      get label() {
        labelReads += 1;
        return falseyLabel;
      },
    } as unknown as TestHighlight;

    draw(record.context, highlight);

    expect(labelReads).toBe(1);
    expect(record.trace).toEqual(BASE_TRACE);
    expect(record.state()).toEqual({
      dash: [],
      strokeStyle: "#22d3ee",
      lineWidth: 3,
      fillStyle: "#22d3ee20",
      font: "initial-font",
    });
    expectNoStateEnvelope(record.trace);
  });

  it("keeps the exact labeled trace, TextMetrics width, and intentional final leakage", () => {
    const record = recordingContext({ metricsWidth: 37 });

    draw(record.context, {
      pageNumber: 1,
      bbox: [0.125, 0.25, 0.625, 0.75],
      label: "Door A",
    });

    expect(record.trace).toEqual([
      ...BASE_TRACE,
      ["set", "font", "bold 12px sans-serif"],
      ["call", "measureText", "Door A"],
      ["set", "fillStyle", "#22d3eedd"],
      ["call", "fillRect", 25, 7, 45, 16],
      ["set", "fillStyle", "#000"],
      ["call", "fillText", "Door A", 29, 20],
    ]);
    expect(record.state()).toEqual({
      dash: [],
      strokeStyle: "#22d3ee",
      lineWidth: 3,
      fillStyle: "#000",
      font: "bold 12px sans-serif",
    });
    expectNoStateEnvelope(record.trace);
  });

  it("preserves bbox destructuring and three label Gets with method-before-argument receivers", () => {
    const events: string[] = [];
    const record = recordingContext({ events, metricsWidth: 41 });
    const values = [0.125, 0.25, 0.625, 0.75];
    let index = 0;
    const bboxIterable = {
      get [Symbol.iterator]() {
        events.push("bbox:get-iterator");
        return function (this: unknown) {
          events.push(
            `bbox:call-iterator:${this === bboxIterable ? "receiver" : "detached"}`,
          );
          return {
            next() {
              events.push(`bbox:next:${index}`);
              const value = values[index];
              index += 1;
              return { value, done: false };
            },
            return() {
              events.push("bbox:return");
              return { value: undefined, done: true };
            },
          };
        };
      },
    };
    let labelRead = 0;
    const labels = ["gate-label", "measure-label", "paint-label"];
    const highlight = {
      get pageNumber() {
        events.push("highlight:pageNumber");
        return 1;
      },
      get bbox() {
        events.push("highlight:bbox");
        return bboxIterable;
      },
      get label() {
        const label = labels[labelRead];
        labelRead += 1;
        events.push(`highlight:label:${label}`);
        return label;
      },
    } as unknown as TestHighlight;

    draw(record.context, highlight);

    expect(events).toEqual([
      "highlight:pageNumber",
      "highlight:bbox",
      "bbox:get-iterator",
      "bbox:call-iterator:receiver",
      "bbox:next:0",
      "bbox:next:1",
      "bbox:next:2",
      "bbox:next:3",
      "bbox:return",
      "ctx:get:setLineDash",
      "ctx:call:setLineDash:receiver:8,4",
      "ctx:get:strokeRect",
      "ctx:call:strokeRect:receiver",
      "ctx:get:setLineDash",
      "ctx:call:setLineDash:receiver:",
      "ctx:get:fillRect",
      "ctx:call:fillRect:receiver",
      "highlight:label:gate-label",
      "ctx:get:measureText",
      "highlight:label:measure-label",
      "ctx:call:measureText:receiver:measure-label",
      "metrics:width",
      "ctx:get:fillRect",
      "ctx:call:fillRect:receiver",
      "ctx:get:fillText",
      "highlight:label:paint-label",
      "ctx:call:fillText:receiver:paint-label",
    ]);
    expect(record.trace).toEqual([
      ...BASE_TRACE,
      ["set", "font", "bold 12px sans-serif"],
      ["call", "measureText", "measure-label"],
      ["set", "fillStyle", "#22d3eedd"],
      ["call", "fillRect", 25, 7, 49, 16],
      ["set", "fillStyle", "#000"],
      ["call", "fillText", "paint-label", 29, 20],
    ]);
    expect(labelRead).toBe(3);
  });

  it("propagates a bbox iterator failure before any canvas mutation", () => {
    const record = recordingContext();
    let nextCall = 0;
    let labelReads = 0;
    const bboxIterable = {
      [Symbol.iterator]() {
        return {
          next() {
            nextCall += 1;
            if (nextCall === 2) throw new Error("bbox boom");
            return { value: 0.125, done: false };
          },
        };
      },
    };
    const highlight = {
      pageNumber: 1,
      bbox: bboxIterable,
      get label() {
        labelReads += 1;
        return "cold";
      },
    } as unknown as TestHighlight;

    expect(() => draw(record.context, highlight)).toThrow("bbox boom");
    expect(nextCall).toBe(2);
    expect(labelReads).toBe(0);
    expect(record.trace).toEqual([]);
  });

  it("leaves the dash set when strokeRect throws before the reset", () => {
    const record = recordingContext({
      throwOnStrokeRect: new Error("stroke boom"),
    });

    expect(() => draw(record.context, {
      pageNumber: 1,
      bbox: [0.125, 0.25, 0.625, 0.75],
    })).toThrow("stroke boom");

    expect(record.trace).toEqual([
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 3],
      ["call", "setLineDash", [8, 4]],
      ["call", "strokeRect", 25, 25, 100, 50],
    ]);
    expect(record.state()).toEqual({
      dash: [8, 4],
      strokeStyle: "#22d3ee",
      lineWidth: 3,
      fillStyle: "initial-fill",
      font: "initial-font",
    });
    expectNoStateEnvelope(record.trace);
  });

  it("propagates TextMetrics.width failure after the base fill without label cleanup", () => {
    const record = recordingContext({
      throwOnMetricsWidth: new Error("metrics boom"),
    });

    expect(() => draw(record.context, {
      pageNumber: 1,
      bbox: [0.125, 0.25, 0.625, 0.75],
      label: "Door A",
    })).toThrow("metrics boom");

    expect(record.trace).toEqual([
      ...BASE_TRACE,
      ["set", "font", "bold 12px sans-serif"],
      ["call", "measureText", "Door A"],
    ]);
    expect(record.state()).toEqual({
      dash: [],
      strokeStyle: "#22d3ee",
      lineWidth: 3,
      fillStyle: "#22d3ee20",
      font: "bold 12px sans-serif",
    });
    expectNoStateEnvelope(record.trace);
  });

  it("propagates fillText failure after publishing the black final style", () => {
    const record = recordingContext({
      metricsWidth: 37,
      throwOnFillText: new Error("text boom"),
    });

    expect(() => draw(record.context, {
      pageNumber: 1,
      bbox: [0.125, 0.25, 0.625, 0.75],
      label: "Door A",
    })).toThrow("text boom");

    expect(record.trace).toEqual([
      ...BASE_TRACE,
      ["set", "font", "bold 12px sans-serif"],
      ["call", "measureText", "Door A"],
      ["set", "fillStyle", "#22d3eedd"],
      ["call", "fillRect", 25, 7, 45, 16],
      ["set", "fillStyle", "#000"],
      ["call", "fillText", "Door A", 29, 20],
    ]);
    expect(record.state()).toEqual({
      dash: [],
      strokeStyle: "#22d3ee",
      lineWidth: 3,
      fillStyle: "#000",
      font: "bold 12px sans-serif",
    });
    expectNoStateEnvelope(record.trace);
  });
});
