// @vitest-environment node

import { describe, expect, it } from "vitest";
import { drawTableCellStructure } from "../tableCellStructure";

type Bbox = readonly [number, number, number, number];

interface TestCell {
  readonly bbox: Bbox;
  readonly highlighted: boolean;
  readonly type: string;
}

interface TestTableCellStructure {
  readonly pageNumber: number;
  readonly cells: readonly TestCell[];
}

type TraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown];

interface ContextOptions {
  readonly events?: string[];
  readonly throwOnFillRect?: Error;
  readonly throwOnStrokeRect?: Error;
  readonly throwOnSet?: {
    readonly property: string;
    readonly error: Error;
  };
}

interface CanvasState {
  readonly dash: readonly number[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: unknown;
  readonly globalAlpha: unknown;
  readonly font: unknown;
  readonly stackDepth: number;
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
  const target: Record<PropertyKey, unknown> = {
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
    fillRect(this: unknown, x: number, y: number, width: number, height: number) {
      trace.push(["call", "fillRect", x, y, width, height]);
      options.events?.push(
        `ctx:call:fillRect:${this === context ? "receiver" : "detached"}`,
      );
      if (options.throwOnFillRect) throw options.throwOnFillRect;
    },
    strokeRect(this: unknown, x: number, y: number, width: number, height: number) {
      trace.push(["call", "strokeRect", x, y, width, height]);
      options.events?.push(
        `ctx:call:strokeRect:${this === context ? "receiver" : "detached"}`,
      );
      if (options.throwOnStrokeRect) throw options.throwOnStrokeRect;
    },
    setLineDash(this: unknown, segments: number[]) {
      trace.push(["call", "setLineDash", segments]);
      options.events?.push(
        `ctx:call:setLineDash:${this === context ? "receiver" : "detached"}`,
      );
      dash = [...segments];
    },
    save(this: unknown) {
      trace.push(["call", "save"]);
      options.events?.push(
        `ctx:call:save:${this === context ? "receiver" : "detached"}`,
      );
      stackDepth += 1;
    },
    restore(this: unknown) {
      trace.push(["call", "restore"]);
      options.events?.push(
        `ctx:call:restore:${this === context ? "receiver" : "detached"}`,
      );
      stackDepth -= 1;
    },
  };
  const watchedMethods = new Set([
    "fillRect",
    "strokeRect",
    "setLineDash",
    "save",
    "restore",
  ]);
  context = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && watchedMethods.has(property)) {
        options.events?.push(`ctx:get:${property}`);
      }
      return Reflect.get(object, property, receiver);
    },
    set(object, property, value, receiver) {
      if (typeof property === "string") {
        trace.push(["set", property, value]);
        options.events?.push(
          `ctx:set:${property}:${String(value)}:${receiver === context ? "receiver" : "detached"}`,
        );
        if (options.throwOnSet?.property === property) {
          throw options.throwOnSet.error;
        }
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
  fillStyle: string,
  strokeStyle: string,
  lineWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
): TraceEntry[] {
  return [
    ["set", "fillStyle", fillStyle],
    ["call", "fillRect", x, y, width, height],
    ["set", "strokeStyle", strokeStyle],
    ["set", "lineWidth", lineWidth],
    ["call", "strokeRect", x, y, width, height],
  ];
}

function highlightedPaint(
  x: number,
  y: number,
  width: number,
  height: number,
): TraceEntry[] {
  return paintTrace(
    "rgba(34,211,238,0.25)",
    "#22d3ee",
    2.5,
    x,
    y,
    width,
    height,
  );
}

function headerPaint(
  x: number,
  y: number,
  width: number,
  height: number,
): TraceEntry[] {
  return paintTrace(
    "rgba(168,85,247,0.15)",
    "rgba(168,85,247,0.7)",
    1.25,
    x,
    y,
    width,
    height,
  );
}

function dataPaint(
  x: number,
  y: number,
  width: number,
  height: number,
): TraceEntry[] {
  return paintTrace(
    "rgba(34,211,238,0.05)",
    "rgba(34,211,238,0.7)",
    1,
    x,
    y,
    width,
    height,
  );
}

function cell(
  bbox: Bbox,
  highlighted: boolean,
  type: string,
): TestCell {
  return { bbox, highlighted, type };
}

function structure(
  cells: readonly TestCell[],
  pageNumber = 5,
): TestTableCellStructure {
  return { pageNumber, cells };
}

interface DrawOverrides {
  readonly pageNumber?: number;
  readonly showTableCellStructure?: boolean;
  readonly width?: number;
  readonly height?: number;
}

function draw(
  context: CanvasRenderingContext2D,
  tableCellStructure: TestTableCellStructure | null,
  overrides: DrawOverrides = {},
): void {
  drawTableCellStructure(context, {
    tableCellStructure,
    pageNumber: overrides.pageNumber ?? 5,
    showTableCellStructure: overrides.showTableCellStructure ?? true,
    width: overrides.width ?? 320,
    height: overrides.height ?? 180,
  });
}

function customBbox(
  label: string,
  values: readonly number[],
  events: string[],
  throwOnNextIndex?: number,
): Bbox {
  let index = 0;
  const iterable = {
    get [Symbol.iterator]() {
      events.push(`${label}:get-iterator`);
      return function (this: unknown) {
        events.push(
          `${label}:call-iterator:${this === iterable ? "receiver" : "detached"}`,
        );
        const iterator = {
          get next() {
            events.push(`${label}:get-next`);
            return function (this: unknown) {
              events.push(
                `${label}:call-next:${index}:${this === iterator ? "receiver" : "detached"}`,
              );
              if (index === throwOnNextIndex) throw new Error(`${label} next boom`);
              const value = values[index];
              index += 1;
              return { value, done: false };
            };
          },
          get return() {
            events.push(`${label}:get-return`);
            return function (this: unknown) {
              events.push(
                `${label}:call-return:${this === iterator ? "receiver" : "detached"}`,
              );
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

interface CellIterableOptions {
  readonly throwOnNextIndex?: number;
  readonly errorMessage?: string;
}

function customCells(
  label: string,
  values: readonly TestCell[],
  events: string[],
  options: CellIterableOptions = {},
): readonly TestCell[] {
  let index = 0;
  const iterable = {
    get [Symbol.iterator]() {
      events.push(`${label}:get-iterator`);
      return function (this: unknown) {
        events.push(
          `${label}:call-iterator:${this === iterable ? "receiver" : "detached"}`,
        );
        const iterator = {
          get next() {
            events.push(`${label}:get-next`);
            return function (this: unknown) {
              events.push(
                `${label}:call-next:${index}:${this === iterator ? "receiver" : "detached"}`,
              );
              if (index === options.throwOnNextIndex) {
                throw new Error(options.errorMessage ?? `${label} next boom`);
              }
              if (index >= values.length) return { value: undefined, done: true };
              const value = values[index];
              index += 1;
              return { value, done: false };
            };
          },
          get return() {
            events.push(`${label}:get-return`);
            return function (this: unknown) {
              events.push(
                `${label}:call-return:${this === iterator ? "receiver" : "detached"}`,
              );
              return { value: undefined, done: true };
            };
          },
        };
        return iterator;
      };
    },
  };
  return iterable as unknown as readonly TestCell[];
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

function expectNoEnvelopeOrDash(trace: readonly TraceEntry[]): void {
  expect(trace.some((entry) =>
    entry[0] === "call" && (
      entry[1] === "save" ||
      entry[1] === "restore" ||
      entry[1] === "setLineDash"
    )
  )).toBe(false);
}

describe("drawTableCellStructure", () => {
  it("keeps null input entirely canvas-cold", () => {
    const record = recordingContext();

    draw(record.context, null, { showTableCellStructure: false });

    expect(record.trace).toEqual([]);
    expectInheritedState(record);
  });

  it("keeps structure, strict page equality, and show gating in their exact order", () => {
    const record = recordingContext();
    const events: string[] = [];
    const wrongPage = {
      get pageNumber() {
        events.push("wrong:pageNumber");
        return 6;
      },
      get cells(): readonly TestCell[] {
        events.push("wrong:cells");
        throw new Error("wrong-page cells must stay cold");
      },
    };

    draw(record.context, wrongPage);

    const boxedCurrentPage = {
      [Symbol.toPrimitive]() {
        events.push("boxed:coerce");
        return 5;
      },
    } as unknown as number;
    const boxedPage = {
      get pageNumber() {
        events.push("boxed:pageNumber");
        return boxedCurrentPage;
      },
      get cells(): readonly TestCell[] {
        events.push("boxed:cells");
        throw new Error("strict-mismatch cells must stay cold");
      },
    };

    draw(record.context, boxedPage);

    const hiddenSamePage = {
      get pageNumber() {
        events.push("hidden:pageNumber");
        return 5;
      },
      get cells(): readonly TestCell[] {
        events.push("hidden:cells");
        throw new Error("hidden same-page cells must stay cold");
      },
    };

    draw(record.context, hiddenSamePage, { showTableCellStructure: false });

    expect(events).toEqual([
      "wrong:pageNumber",
      "boxed:pageNumber",
      "hidden:pageNumber",
    ]);
    expect(record.trace).toEqual([]);
    expectInheritedState(record);
  });

  it("reads same-page visible cells once but keeps an empty collection canvas-cold", () => {
    const record = recordingContext();
    const events: string[] = [];
    const empty = customCells("cells", [], events);
    const tableCellStructure = {
      get pageNumber() {
        events.push("structure:pageNumber");
        return 5;
      },
      get cells() {
        events.push("structure:cells");
        return empty;
      },
    };

    draw(record.context, tableCellStructure);

    expect(events).toEqual([
      "structure:pageNumber",
      "structure:cells",
      "cells:get-iterator",
      "cells:call-iterator:receiver",
      "cells:get-next",
      "cells:call-next:0:receiver",
    ]);
    expect(record.trace).toEqual([]);
    expectInheritedState(record);
  });

  it("preserves cells and bbox iterator Gets, receivers, IteratorClose, source order, and canvas method receivers", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const first = {
      get bbox() {
        events.push("first:bbox");
        return customBbox("first-bbox", [0.75, 0.125, 0.875, 0.5], events);
      },
      get highlighted() {
        events.push("first:highlighted");
        return true;
      },
      get type(): string {
        events.push("first:type");
        throw new Error("highlighted type must stay cold");
      },
    };
    const second = {
      get bbox() {
        events.push("second:bbox");
        return customBbox("second-bbox", [0.125, 0.25, 0.375, 0.5], events);
      },
      get highlighted() {
        events.push("second:highlighted");
        return true;
      },
      get type(): string {
        events.push("second:type");
        throw new Error("highlighted type must stay cold");
      },
    };
    const cells = customCells("cells", [first, second], events);
    const tableCellStructure = {
      get pageNumber() {
        events.push(
          `structure:pageNumber:${this === tableCellStructure ? "receiver" : "detached"}`,
        );
        return 5;
      },
      get cells() {
        events.push(
          `structure:cells:${this === tableCellStructure ? "receiver" : "detached"}`,
        );
        return cells;
      },
    };

    draw(record.context, tableCellStructure);

    expect(events).toEqual([
      "structure:pageNumber:receiver",
      "structure:cells:receiver",
      "cells:get-iterator",
      "cells:call-iterator:receiver",
      "cells:get-next",
      "cells:call-next:0:receiver",
      "first:bbox",
      "first-bbox:get-iterator",
      "first-bbox:call-iterator:receiver",
      "first-bbox:get-next",
      "first-bbox:call-next:0:receiver",
      "first-bbox:call-next:1:receiver",
      "first-bbox:call-next:2:receiver",
      "first-bbox:call-next:3:receiver",
      "first-bbox:get-return",
      "first-bbox:call-return:receiver",
      "first:highlighted",
      "ctx:set:fillStyle:rgba(34,211,238,0.25):receiver",
      "ctx:get:fillRect",
      "ctx:call:fillRect:receiver",
      "ctx:set:strokeStyle:#22d3ee:receiver",
      "ctx:set:lineWidth:2.5:receiver",
      "ctx:get:strokeRect",
      "ctx:call:strokeRect:receiver",
      "cells:call-next:1:receiver",
      "second:bbox",
      "second-bbox:get-iterator",
      "second-bbox:call-iterator:receiver",
      "second-bbox:get-next",
      "second-bbox:call-next:0:receiver",
      "second-bbox:call-next:1:receiver",
      "second-bbox:call-next:2:receiver",
      "second-bbox:call-next:3:receiver",
      "second-bbox:get-return",
      "second-bbox:call-return:receiver",
      "second:highlighted",
      "ctx:set:fillStyle:rgba(34,211,238,0.25):receiver",
      "ctx:get:fillRect",
      "ctx:call:fillRect:receiver",
      "ctx:set:strokeStyle:#22d3ee:receiver",
      "ctx:set:lineWidth:2.5:receiver",
      "ctx:get:strokeRect",
      "ctx:call:strokeRect:receiver",
      "cells:call-next:2:receiver",
    ]);
    expect(events).not.toContain("first:type");
    expect(events).not.toContain("second:type");
    expect(events).not.toContain("cells:get-return");
    expect(record.trace).toEqual([
      ...highlightedPaint(240, 22.5, 40, 67.5),
      ...highlightedPaint(40, 45, 80, 45),
    ]);
  });

  it.each([
    ["non-empty string", "selected"],
    ["object", { selected: true }],
  ])("uses highlighted truthiness and keeps type cold for a runtime-truthy %s", (_name, highlighted) => {
    const record = recordingContext();
    let highlightedReads = 0;
    let typeReads = 0;
    const runtimeCell = {
      bbox: [0.125, 0.25, 0.375, 0.5] as Bbox,
      get highlighted() {
        highlightedReads += 1;
        return highlighted;
      },
      get type(): string {
        typeReads += 1;
        throw new Error("truthy highlighted type must stay cold");
      },
    } as unknown as TestCell;

    draw(record.context, structure([runtimeCell]));

    expect(highlightedReads).toBe(1);
    expect(typeReads).toBe(0);
    expect(record.trace).toEqual(highlightedPaint(40, 45, 80, 45));
  });

  it.each([
    ["zero", 0],
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
  ])("uses the ordinary branch for runtime-falsey highlighted value %s", (_name, highlighted) => {
    const record = recordingContext();
    let highlightedReads = 0;
    let typeReads = 0;
    const runtimeCell = {
      bbox: [0.125, 0.25, 0.375, 0.5] as Bbox,
      get highlighted() {
        highlightedReads += 1;
        return highlighted;
      },
      get type() {
        typeReads += 1;
        return "data";
      },
    } as unknown as TestCell;

    draw(record.context, structure([runtimeCell]));

    expect(highlightedReads).toBe(1);
    expect(typeReads).toBe(2);
    expect(record.trace).toEqual(dataPaint(40, 45, 80, 45));
  });

  it("gets column type once, row and data type twice, and does not cache a dynamic type", () => {
    const record = recordingContext();
    const reads: string[] = [];
    let columnReads = 0;
    let rowReads = 0;
    let dataReads = 0;
    let dynamicReads = 0;
    const rows = [
      {
        bbox: [0, 0, 0.125, 0.125] as Bbox,
        highlighted: false,
        get type() {
          columnReads += 1;
          reads.push(`column:${columnReads}`);
          if (columnReads > 1) throw new Error("column type read twice");
          return "column-header";
        },
      },
      {
        bbox: [0.125, 0.125, 0.25, 0.25] as Bbox,
        highlighted: false,
        get type() {
          rowReads += 1;
          reads.push(`row:${rowReads}`);
          return "row-header";
        },
      },
      {
        bbox: [0.25, 0.25, 0.375, 0.375] as Bbox,
        highlighted: false,
        get type() {
          dataReads += 1;
          reads.push(`data:${dataReads}`);
          return "data";
        },
      },
      {
        bbox: [0.375, 0.375, 0.5, 0.5] as Bbox,
        highlighted: false,
        get type() {
          dynamicReads += 1;
          reads.push(`dynamic:${dynamicReads}`);
          return dynamicReads === 1 ? "ordinary" : "row-header";
        },
      },
    ];

    draw(record.context, structure(rows));

    expect(reads).toEqual([
      "column:1",
      "row:1",
      "row:2",
      "data:1",
      "data:2",
      "dynamic:1",
      "dynamic:2",
    ]);
    expect(record.trace).toEqual([
      ...headerPaint(0, 0, 40, 22.5),
      ...headerPaint(40, 22.5, 40, 22.5),
      ...dataPaint(80, 45, 40, 22.5),
      ...headerPaint(120, 67.5, 40, 22.5),
    ]);
  });

  it("keeps all branch styles, anisotropic MIN/MAX geometry, source order, and final canvas leakage exact", () => {
    const record = recordingContext();
    const rows = [
      cell([0.75, 0.125, 0.875, 0.5], true, "data"),
      cell([0.125, 0.75, 0.375, 0.875], false, "column-header"),
      cell([0.5, 0.25, 0.75, 0.5], false, "row-header"),
      cell([0.0625, 0.5, 0.1875, 0.75], false, "data"),
    ];

    draw(record.context, structure(rows));

    expect(record.trace).toEqual([
      ...highlightedPaint(240, 22.5, 40, 67.5),
      ...headerPaint(40, 135, 80, 22.5),
      ...headerPaint(160, 45, 80, 45),
      ...dataPaint(20, 90, 40, 45),
    ]);
    expect(record.state()).toEqual({
      dash: [9, 3],
      fillStyle: "rgba(34,211,238,0.05)",
      strokeStyle: "rgba(34,211,238,0.7)",
      lineWidth: 1,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 0,
    });
    expectNoEnvelopeOrDash(record.trace);
  });

  it("propagates a cells iterator failure after the exact completed-row state", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    let laterReads = 0;
    const later = {
      get bbox(): Bbox {
        laterReads += 1;
        return [0, 0, 1, 1];
      },
      highlighted: true,
      type: "data",
    };
    const cells = customCells(
      "cells",
      [cell([0.125, 0.25, 0.375, 0.5], false, "data"), later],
      events,
      { throwOnNextIndex: 1, errorMessage: "cells boom" },
    );

    expect(() => draw(record.context, structure(cells))).toThrow("cells boom");

    expect(record.trace).toEqual(dataPaint(40, 45, 80, 45));
    expect(laterReads).toBe(0);
    expect(events).not.toContain("cells:get-return");
    expectNoEnvelopeOrDash(record.trace);
  });

  it("propagates a bbox iterator failure before paint and IteratorCloses the cells source", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    let highlightedReads = 0;
    let laterReads = 0;
    const failing = {
      get bbox() {
        events.push("cell:bbox");
        return customBbox("bbox", [0.125, 0.25, 0.375, 0.5], events, 2);
      },
      get highlighted() {
        highlightedReads += 1;
        return true;
      },
      type: "data",
    };
    const later = {
      get bbox(): Bbox {
        laterReads += 1;
        return [0, 0, 1, 1];
      },
      highlighted: true,
      type: "data",
    };
    const cells = customCells("cells", [failing, later], events);

    expect(() => draw(record.context, structure(cells))).toThrow("bbox next boom");

    expect(record.trace).toEqual([]);
    expect(highlightedReads).toBe(0);
    expect(laterReads).toBe(0);
    expect(events).toContain("cells:get-return");
    expect(events).toContain("cells:call-return:receiver");
    expect(events).not.toContain("bbox:get-return");
    expectInheritedState(record);
  });

  it("propagates highlighted and second type getter failures before paint", () => {
    const highlightedEvents: string[] = [];
    const highlightedRecord = recordingContext();
    let highlightedTypeReads = 0;
    const highlightedFailure = {
      bbox: [0.125, 0.25, 0.375, 0.5] as Bbox,
      get highlighted(): boolean {
        throw new Error("highlighted boom");
      },
      get type() {
        highlightedTypeReads += 1;
        return "data";
      },
    };
    const highlightedCells = customCells(
      "highlighted-cells",
      [highlightedFailure],
      highlightedEvents,
    );

    expect(() => draw(
      highlightedRecord.context,
      structure(highlightedCells),
    )).toThrow("highlighted boom");
    expect(highlightedRecord.trace).toEqual([]);
    expect(highlightedTypeReads).toBe(0);
    expect(highlightedEvents).toContain("highlighted-cells:call-return:receiver");
    expectInheritedState(highlightedRecord);

    const typeEvents: string[] = [];
    const typeRecord = recordingContext();
    let typeReads = 0;
    const typeFailure = {
      bbox: [0.125, 0.25, 0.375, 0.5] as Bbox,
      highlighted: false,
      get type(): string {
        typeReads += 1;
        if (typeReads === 2) throw new Error("type boom");
        return "ordinary";
      },
    };
    const typeCells = customCells("type-cells", [typeFailure], typeEvents);

    expect(() => draw(typeRecord.context, structure(typeCells))).toThrow("type boom");
    expect(typeReads).toBe(2);
    expect(typeRecord.trace).toEqual([]);
    expect(typeEvents).toContain("type-cells:call-return:receiver");
    expectInheritedState(typeRecord);
  });

  it("propagates a fillStyle setter failure with only the attempted publication", () => {
    const events: string[] = [];
    const failure = new Error("fillStyle boom");
    const record = recordingContext({
      events,
      throwOnSet: { property: "fillStyle", error: failure },
    });
    let laterReads = 0;
    const later = {
      get bbox(): Bbox {
        laterReads += 1;
        return [0, 0, 1, 1];
      },
      highlighted: true,
      type: "data",
    };
    const cells = customCells("cells", [
      cell([0.125, 0.25, 0.375, 0.5], true, "data"),
      later,
    ], events);

    expect(() => draw(record.context, structure(cells))).toThrow(failure);

    expect(record.trace).toEqual([
      ["set", "fillStyle", "rgba(34,211,238,0.25)"],
    ]);
    expect(laterReads).toBe(0);
    expect(events).toContain("cells:call-return:receiver");
    expectInheritedState(record);
    expectNoEnvelopeOrDash(record.trace);
  });

  it("propagates fillRect failure before stroke publication and stops later rows", () => {
    const events: string[] = [];
    const failure = new Error("fillRect boom");
    const record = recordingContext({ events, throwOnFillRect: failure });
    let laterReads = 0;
    const later = {
      get bbox(): Bbox {
        laterReads += 1;
        return [0, 0, 1, 1];
      },
      highlighted: false,
      type: "data",
    };
    const cells = customCells("cells", [
      cell([0.125, 0.25, 0.375, 0.5], false, "row-header"),
      later,
    ], events);

    expect(() => draw(record.context, structure(cells))).toThrow(failure);

    expect(record.trace).toEqual([
      ["set", "fillStyle", "rgba(168,85,247,0.15)"],
      ["call", "fillRect", 40, 45, 80, 45],
    ]);
    expect(record.state()).toEqual({
      dash: [9, 3],
      fillStyle: "rgba(168,85,247,0.15)",
      strokeStyle: "inherited-stroke",
      lineWidth: 7,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 0,
    });
    expect(laterReads).toBe(0);
    expect(events).toContain("cells:call-return:receiver");
    expectNoEnvelopeOrDash(record.trace);
  });

  it("propagates strokeRect failure after full branch publication and stops later rows", () => {
    const events: string[] = [];
    const failure = new Error("strokeRect boom");
    const record = recordingContext({ events, throwOnStrokeRect: failure });
    let laterReads = 0;
    const later = {
      get bbox(): Bbox {
        laterReads += 1;
        return [0, 0, 1, 1];
      },
      highlighted: false,
      type: "data",
    };
    const cells = customCells("cells", [
      cell([0.125, 0.25, 0.375, 0.5], true, "data"),
      later,
    ], events);

    expect(() => draw(record.context, structure(cells))).toThrow(failure);

    expect(record.trace).toEqual(highlightedPaint(40, 45, 80, 45));
    expect(record.state()).toEqual({
      dash: [9, 3],
      fillStyle: "rgba(34,211,238,0.25)",
      strokeStyle: "#22d3ee",
      lineWidth: 2.5,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 0,
    });
    expect(laterReads).toBe(0);
    expect(events).toContain("cells:call-return:receiver");
    expectNoEnvelopeOrDash(record.trace);
  });
});
