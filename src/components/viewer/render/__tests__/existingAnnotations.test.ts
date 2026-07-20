// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  drawExistingAnnotations,
  type DrawExistingAnnotationsProps,
  type ExistingAnnotationActiveTag,
  type ExistingAnnotationSelection,
} from "../existingAnnotations";

type Annotation = DrawExistingAnnotationsProps["annotations"][number];
type Bbox = Annotation["bbox"];
type TakeoffItem = ReturnType<
  DrawExistingAnnotationsProps["getTakeoffItems"]
>[number];

type TraceEntry =
  | [kind: "get", property: string]
  | [kind: "set", property: string, value: unknown]
  | [kind: "call", method: string, ...args: unknown[]];

interface CanvasState {
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
  readonly context: CanvasRenderingContext2D;
  readonly trace: TraceEntry[];
  readonly state: () => CanvasState;
} {
  const trace: TraceEntry[] = [];
  const counts = new Map<string, number>();
  const measurementWidths = [...(options.measurementWidths ?? [])];
  const stack: Array<Omit<CanvasState, "stackDepth">> = [];
  let context: CanvasRenderingContext2D;

  const target: Record<PropertyKey, unknown> = {
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
  };

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
  const currentState = (): Omit<CanvasState, "stackDepth"> => ({
    fillStyle: target.fillStyle,
    strokeStyle: target.strokeStyle,
    lineWidth: target.lineWidth,
    globalAlpha: target.globalAlpha,
    font: target.font,
  });
  const call = (method: string, receiver: unknown, args: unknown[]): void => {
    trace.push(["call", method, ...args]);
    options.events?.push(
      `ctx:call:${method}:${receiver === context ? "receiver" : "detached"}`,
    );
    maybeThrow("call", method, occurrence("call", method));
  };

  const method = (
    name: string,
    afterCall?: (args: unknown[]) => unknown,
  ) => function (this: unknown, ...args: unknown[]): unknown {
    call(name, this, args);
    return afterCall?.(args);
  };

  Object.assign(target, {
    save: method("save", () => {
      stack.push(currentState());
    }),
    restore: method("restore", () => {
      const restored = stack.pop();
      if (!restored) throw new Error("unbalanced restore");
      Object.assign(target, restored);
    }),
    beginPath: method("beginPath"),
    closePath: method("closePath"),
    arc: method("arc"),
    rect: method("rect"),
    moveTo: method("moveTo"),
    lineTo: method("lineTo"),
    fill: method("fill"),
    stroke: method("stroke"),
    fillRect: method("fillRect"),
    strokeRect: method("strokeRect"),
    fillText: method("fillText"),
    measureText: method("measureText", (args) => {
      const width = measurementWidths.shift() ?? String(args[0]).length * 6;
      return {
        get width() {
          trace.push(["get", "measureText.width"]);
          const currentOccurrence = occurrence(
            "metrics-width",
            "measureText.width",
          );
          options.events?.push(`metrics:get-width:${currentOccurrence}`);
          maybeThrow(
            "metrics-width",
            "measureText.width",
            currentOccurrence,
          );
          return width;
        },
      };
    }),
  });

  const watchedMethods = new Set([
    "save",
    "restore",
    "beginPath",
    "closePath",
    "arc",
    "rect",
    "moveTo",
    "lineTo",
    "fill",
    "stroke",
    "fillRect",
    "strokeRect",
    "fillText",
    "measureText",
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
    state: () => ({ ...currentState(), stackDepth: stack.length }),
  };
}

function inheritedState(): CanvasState {
  return {
    fillStyle: "inherited-fill",
    strokeStyle: "inherited-stroke",
    lineWidth: 7,
    globalAlpha: 0.37,
    font: "italic 13px serif",
    stackDepth: 0,
  };
}

function annotation(
  id: number,
  name: string,
  bbox: Bbox,
  source: Annotation["source"],
  data: unknown = null,
): Annotation {
  return { id, name, bbox, source, data } as Annotation;
}

function countAnnotation({
  id,
  itemId = id,
  shape = "circle",
  color = "#2468ac",
  bbox = [0.1, 0.2, 0.5, 0.8],
}: {
  readonly id: number;
  readonly itemId?: number | string;
  readonly shape?: string;
  readonly color?: string;
  readonly bbox?: Bbox;
}): Annotation {
  return annotation(id, `marker-${id}`, bbox, "takeoff", {
    type: "count-marker",
    takeoffItemId: itemId,
    shape,
    color,
  });
}

function defaultProps(
  annotations: readonly Annotation[],
  overrides: Partial<DrawExistingAnnotationsProps> = {},
): DrawExistingAnnotationsProps {
  return {
    annotations,
    width: 200,
    height: 100,
    selectedId: null,
    hiddenTakeoffItemIds: new Set<number>(),
    selection: { isSelected: () => false },
    activeTag: null,
    activeTagAnnotationIds: new Set<number>(),
    symbolSearchResults: null,
    cssScale: 2,
    getLabelColor: () => "#e6194b",
    getTakeoffItems: () => [],
    ...overrides,
  };
}

function draw(
  context: CanvasRenderingContext2D,
  annotations: readonly Annotation[],
  overrides: Partial<DrawExistingAnnotationsProps> = {},
): void {
  drawExistingAnnotations(context, defaultProps(annotations, overrides));
}

interface IterableOptions {
  readonly throwOnNextIndex?: number;
  readonly error?: Error;
}

function trackedIterable<T>(
  prefix: string,
  values: readonly T[],
  events: string[],
  options: IterableOptions = {},
): readonly T[] {
  let index = 0;
  const iterable = {
    get [Symbol.iterator]() {
      events.push(`${prefix}:get-iterator`);
      return function (this: unknown) {
        events.push(
          `${prefix}:call-iterator:${this === iterable ? "receiver" : "detached"}`,
        );
        const iterator = {
          get next() {
            events.push(`${prefix}:get-next`);
            return function (this: unknown) {
              events.push(
                `${prefix}:call-next:${index}:${this === iterator ? "receiver" : "detached"}`,
              );
              if (index === options.throwOnNextIndex) {
                throw options.error ?? new Error(`${prefix} next boom`);
              }
              if (index >= values.length) {
                return { value: undefined, done: true };
              }
              const value = values[index];
              index += 1;
              return { value, done: false };
            };
          },
          get return() {
            events.push(`${prefix}:get-return`);
            return function (this: unknown) {
              events.push(
                `${prefix}:call-return:${this === iterator ? "receiver" : "detached"}`,
              );
              return { value: undefined, done: true };
            };
          },
        };
        return iterator;
      };
    },
  };
  return iterable as unknown as readonly T[];
}

function trackedBbox(
  prefix: string,
  values: readonly number[],
  events: string[],
  options: IterableOptions = {},
): Bbox {
  return trackedIterable(prefix, values, events, options) as unknown as Bbox;
}

function captureThrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function darkened(color: string): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const shorthandOrFull = match[1];
  const hex = shorthandOrFull.length === 3
    ? [...shorthandOrFull].map((digit) => digit + digit).join("")
    : shorthandOrFull;
  const rgb = Number.parseInt(hex, 16);
  return `rgb(${((rgb >> 16) & 0xff) * 0.7 | 0}, ${((rgb >> 8) & 0xff) * 0.7 | 0}, ${(rgb & 0xff) * 0.7 | 0})`;
}

function countTrace({
  shape,
  color,
  cx,
  cy,
  radius,
  selected = false,
  haloScale = 2,
  inheritedAlpha = 0.37,
}: {
  readonly shape: string;
  readonly color: string;
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly selected?: boolean;
  readonly haloScale?: number;
  readonly inheritedAlpha?: number;
}): TraceEntry[] {
  const path: TraceEntry[] = [];
  if (shape === "circle") {
    path.push(
      ["get", "arc"],
      ["call", "arc", cx, cy, radius, 0, Math.PI * 2],
    );
  } else if (shape === "square") {
    path.push(
      ["get", "rect"],
      ["call", "rect", cx - radius, cy - radius, radius * 2, radius * 2],
    );
  } else if (shape === "diamond") {
    path.push(
      ["get", "moveTo"], ["call", "moveTo", cx, cy - radius],
      ["get", "lineTo"], ["call", "lineTo", cx + radius, cy],
      ["get", "lineTo"], ["call", "lineTo", cx, cy + radius],
      ["get", "lineTo"], ["call", "lineTo", cx - radius, cy],
      ["get", "closePath"], ["call", "closePath"],
    );
  } else if (shape === "triangle") {
    path.push(
      ["get", "moveTo"], ["call", "moveTo", cx, cy - radius],
      ["get", "lineTo"], ["call", "lineTo", cx + radius, cy + radius],
      ["get", "lineTo"], ["call", "lineTo", cx - radius, cy + radius],
      ["get", "closePath"], ["call", "closePath"],
    );
  } else if (shape === "cross") {
    const arm = radius * 0.35;
    const points = [
      [cx - arm, cy - radius], [cx + arm, cy - radius],
      [cx + arm, cy - arm], [cx + radius, cy - arm],
      [cx + radius, cy + arm], [cx + arm, cy + arm],
      [cx + arm, cy + radius], [cx - arm, cy + radius],
      [cx - arm, cy + arm], [cx - radius, cy + arm],
      [cx - radius, cy - arm], [cx - arm, cy - arm],
    ] as const;
    for (const [index, point] of points.entries()) {
      const method = index === 0 ? "moveTo" : "lineTo";
      path.push(["get", method], ["call", method, point[0], point[1]]);
    }
    path.push(["get", "closePath"], ["call", "closePath"]);
  }

  return [
    ["get", "save"], ["call", "save"],
    ["set", "fillStyle", color],
    ["set", "strokeStyle", darkened(color)],
    ["set", "lineWidth", selected ? 3 : 1.5],
    ["get", "beginPath"], ["call", "beginPath"],
    ...path,
    ["set", "globalAlpha", inheritedAlpha * 0.8],
    ["get", "fill"], ["call", "fill"],
    ["set", "globalAlpha", inheritedAlpha],
    ["get", "stroke"], ["call", "stroke"],
    ...(selected ? [
      ["set", "strokeStyle", "#ffffff"],
      ["set", "lineWidth", 2],
      ["get", "beginPath"], ["call", "beginPath"],
      ["get", "arc"],
      ["call", "arc", cx, cy, radius + 4 / (haloScale || 1), 0, Math.PI * 2],
      ["get", "stroke"], ["call", "stroke"],
    ] as TraceEntry[] : []),
    ["get", "restore"], ["call", "restore"],
  ];
}

function labelTrace({
  name,
  color,
  x,
  y,
  width,
  height,
  measuredWidth,
  selected,
  user,
  area,
}: {
  readonly name: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly measuredWidth: number;
  readonly selected: boolean;
  readonly user: boolean;
  readonly area: boolean;
}): TraceEntry[] {
  const fontSize = Math.max(10, Math.min(13, height * 0.3));
  const extraWidth = selected ? (user ? 36 : 20) : 6;
  const trace: TraceEntry[] = [
    ["set", "font", `bold ${fontSize}px sans-serif`],
    ["get", "measureText"], ["call", "measureText", name],
    ["get", "measureText.width"],
    ["set", "fillStyle", "rgba(0,0,0,0.75)"],
    ["get", "fillRect"],
    ["call", "fillRect", x, y - fontSize - 4, measuredWidth + extraWidth, fontSize + 4],
    ["set", "fillStyle", color],
    ["get", "fillText"], ["call", "fillText", name, x + 3, y - 4],
  ];
  if (selected) {
    let iconX = x + measuredWidth + 8;
    if (user) {
      trace.push(
        ["set", "fillStyle", "#60a5fa"],
        ["set", "font", `${fontSize}px sans-serif`],
        ["get", "fillText"], ["call", "fillText", "✎", iconX, y - 4],
      );
      iconX += 16;
    }
    trace.push(
      ["set", "fillStyle", "#ff4444"],
      ["set", "font", `bold ${fontSize}px sans-serif`],
      ["get", "fillText"], ["call", "fillText", "x", iconX, y - 4],
    );
    if (!area) {
      trace.push(
        ["set", "fillStyle", color],
        ["get", "fillRect"], ["call", "fillRect", x - 3, y - 3, 6, 6],
        ["get", "fillRect"], ["call", "fillRect", x + width - 3, y - 3, 6, 6],
        ["get", "fillRect"], ["call", "fillRect", x - 3, y + height - 3, 6, 6],
        ["get", "fillRect"], ["call", "fillRect", x + width - 3, y + height - 3, 6, 6],
      );
    }
  }
  return trace;
}

function ordinaryTrace({
  name,
  color,
  x,
  y,
  width,
  height,
  measuredWidth,
  selected = false,
  user = false,
  dimmed = false,
}: {
  readonly name: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly measuredWidth: number;
  readonly selected?: boolean;
  readonly user?: boolean;
  readonly dimmed?: boolean;
}): TraceEntry[] {
  return [
    ["set", "globalAlpha", dimmed ? 0.25 : 1],
    ["set", "strokeStyle", color],
    ["set", "lineWidth", selected ? 3 : 2],
    ["get", "strokeRect"], ["call", "strokeRect", x, y, width, height],
    ["set", "fillStyle", `${color}15`],
    ["get", "fillRect"], ["call", "fillRect", x, y, width, height],
    ...labelTrace({
      name,
      color,
      x,
      y,
      width,
      height,
      measuredWidth,
      selected,
      user,
      area: false,
    }),
    ["set", "globalAlpha", 1],
  ];
}

function areaTrace({
  name,
  color,
  x,
  y,
  width,
  height,
  measuredWidth,
  selected = false,
  dimmed = false,
}: {
  readonly name: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly measuredWidth: number;
  readonly selected?: boolean;
  readonly dimmed?: boolean;
}): TraceEntry[] {
  return [
    ["set", "globalAlpha", dimmed ? 0.25 : 1],
    ...labelTrace({
      name,
      color,
      x,
      y,
      width,
      height,
      measuredWidth,
      selected,
      user: false,
      area: true,
    }),
    ["set", "globalAlpha", 1],
  ];
}

function activeMatchTrace({
  name,
  color,
  tagColor,
  tagLabel,
  x,
  y,
  width,
  height,
  measuredWidth,
  tagMeasuredWidth,
  selected = false,
}: {
  readonly name: string;
  readonly color: string;
  readonly tagColor: string;
  readonly tagLabel: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly measuredWidth: number;
  readonly tagMeasuredWidth: number;
  readonly selected?: boolean;
}): TraceEntry[] {
  return [
    ["set", "fillStyle", "#ff00ff40"],
    ["get", "fillRect"], ["call", "fillRect", x, y, width, height],
    ["set", "strokeStyle", tagColor],
    ["set", "lineWidth", 3],
    ["get", "strokeRect"], ["call", "strokeRect", x, y, width, height],
    ...labelTrace({
      name,
      color,
      x,
      y,
      width,
      height,
      measuredWidth,
      selected,
      user: false,
      area: false,
    }),
    ["set", "globalAlpha", 1],
    ["set", "font", "bold 11px sans-serif"],
    ["get", "measureText"], ["call", "measureText", tagLabel],
    ["get", "measureText.width"],
    ["set", "fillStyle", `${tagColor}dd`],
    ["get", "fillRect"],
    ["call", "fillRect", x, y + height + 1, tagMeasuredWidth + 6, 14],
    ["set", "fillStyle", "#000"],
    ["get", "fillText"],
    ["call", "fillText", tagLabel, x + 3, y + height + 12],
    ["set", "globalAlpha", 1],
  ];
}

describe("drawExistingAnnotations", () => {
  it("destructures ordered props before an empty custom traversal and stays callback-, set-, and canvas-cold", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const rows = trackedIterable<Annotation>("rows", [], events);
    const forbiddenSet = Object.defineProperty({}, "has", {
      get() {
        throw new Error("set.has must stay cold");
      },
    }) as ReadonlySet<number>;
    const forbiddenSelection = Object.defineProperty({}, "isSelected", {
      get() {
        throw new Error("selection must stay cold");
      },
    }) as ExistingAnnotationSelection;
    const props = {
      get annotations() {
        events.push("props:annotations");
        return rows;
      },
      get width() {
        events.push("props:width");
        return 200;
      },
      get height() {
        events.push("props:height");
        return 100;
      },
      get selectedId() {
        events.push("props:selectedId");
        return null;
      },
      get hiddenTakeoffItemIds() {
        events.push("props:hiddenTakeoffItemIds");
        return forbiddenSet;
      },
      get selection() {
        events.push("props:selection");
        return forbiddenSelection;
      },
      get activeTag() {
        events.push("props:activeTag");
        return null;
      },
      get activeTagAnnotationIds() {
        events.push("props:activeTagAnnotationIds");
        return forbiddenSet;
      },
      get symbolSearchResults() {
        events.push("props:symbolSearchResults");
        return null;
      },
      get cssScale() {
        events.push("props:cssScale");
        return 2;
      },
      get getLabelColor() {
        events.push("props:getLabelColor");
        return () => {
          throw new Error("getLabelColor must stay cold");
        };
      },
      get getTakeoffItems() {
        events.push("props:getTakeoffItems");
        return () => {
          throw new Error("getTakeoffItems must stay cold");
        };
      },
    } satisfies DrawExistingAnnotationsProps;

    drawExistingAnnotations(record.context, props);

    expect(events).toEqual([
      "props:annotations",
      "props:width",
      "props:height",
      "props:selectedId",
      "props:hiddenTakeoffItemIds",
      "props:selection",
      "props:activeTag",
      "props:activeTagAnnotationIds",
      "props:symbolSearchResults",
      "props:cssScale",
      "props:getLabelColor",
      "props:getTakeoffItems",
      "rows:get-iterator",
      "rows:call-iterator:receiver",
      "rows:get-next",
      "rows:call-next:0:receiver",
    ]);
    expect(record.trace).toEqual([]);
    expect(record.state()).toEqual(inheritedState());
  });

  it("draws all five count shapes plus an unknown shape in source order with exact paths and restored state", () => {
    const record = recordingContext();
    const shapes = [
      ["circle", "#ff0000", 8],
      ["square", "#00ff00", 0],
      ["diamond", "#0000ff", 12],
      ["triangle", "#abcdef", 10],
      ["cross", "#123456", -4],
      ["hexagon", "#654321", 6],
    ] as const;
    const rows = shapes.map(([shape, color], index) => countAnnotation({
      id: index + 1,
      shape,
      color,
    }));
    const items = shapes.map(([, , size], index) => ({
      id: index + 1,
      size,
    })) as readonly TakeoffItem[];
    let bridgeReads = 0;

    draw(record.context, rows, {
      selectedId: 5,
      getTakeoffItems: () => {
        bridgeReads += 1;
        return items;
      },
    });

    expect(record.trace).toEqual(shapes.flatMap(([shape, color, size], index) =>
      countTrace({
        shape,
        color,
        cx: 60,
        cy: 50,
        radius: (size || 10) / 2,
        selected: index === 4,
      })
    ));
    expect(bridgeReads).toBe(6);
    expect(record.state()).toEqual(inheritedState());
    expect(record.trace.filter((entry) =>
      entry[0] === "call" && entry[1] === "beginPath"
    )).toHaveLength(7);
  });

  it("keeps CSS count colors valid while darkening only opaque hex", () => {
    const record = recordingContext();

    draw(record.context, [
      countAnnotation({ id: 1, color: "#abc" }),
      countAnnotation({ id: 2, color: "#A1B2C3" }),
      countAnnotation({ id: 3, color: "red" }),
      countAnnotation({ id: 4, color: "#abcd" }),
      countAnnotation({ id: 5, color: "#12345678" }),
    ]);

    expect(record.trace.filter((entry) =>
      entry[0] === "set"
      && (entry[1] === "fillStyle" || entry[1] === "strokeStyle")
    )).toEqual([
      ["set", "fillStyle", "#abc"],
      ["set", "strokeStyle", "rgb(118, 130, 142)"],
      ["set", "fillStyle", "#A1B2C3"],
      ["set", "strokeStyle", "rgb(112, 124, 136)"],
      ["set", "fillStyle", "red"],
      ["set", "strokeStyle", "red"],
      ["set", "fillStyle", "#abcd"],
      ["set", "strokeStyle", "#abcd"],
      ["set", "fillStyle", "#12345678"],
      ["set", "strokeStyle", "#12345678"],
    ]);
    expect(record.trace.filter((entry) =>
      entry[0] === "set" && entry[1] === "globalAlpha"
    )).toEqual([
      ["set", "globalAlpha", 0.296], ["set", "globalAlpha", 0.37],
      ["set", "globalAlpha", 0.296], ["set", "globalAlpha", 0.37],
      ["set", "globalAlpha", 0.296], ["set", "globalAlpha", 0.37],
      ["set", "globalAlpha", 0.296], ["set", "globalAlpha", 0.37],
      ["set", "globalAlpha", 0.296], ["set", "globalAlpha", 0.37],
    ]);
  });

  it("keeps markerSize and cssScale || fallbacks, including zero and negative values", () => {
    const zeroRecord = recordingContext();
    draw(zeroRecord.context, [countAnnotation({ id: 1 })], {
      selectedId: 1,
      cssScale: 0,
      getTakeoffItems: () => [{ id: 1, size: 0 }],
    });
    expect(zeroRecord.trace).toEqual(countTrace({
      shape: "circle",
      color: "#2468ac",
      cx: 60,
      cy: 50,
      radius: 10,
      selected: true,
      haloScale: 0,
    }));

    const negativeRecord = recordingContext();
    draw(negativeRecord.context, [countAnnotation({ id: 2 })], {
      selectedId: 2,
      cssScale: -2,
      getTakeoffItems: () => [{ id: 2, size: -4 }],
    });
    expect(negativeRecord.trace).toEqual(countTrace({
      shape: "circle",
      color: "#2468ac",
      cx: 60,
      cy: 50,
      radius: 2,
      selected: true,
      haloScale: -2,
    }));
  });

  it("keeps a count marker with a falsy shape canvas-cold after its live item lookup", () => {
    const record = recordingContext();
    let bridgeReads = 0;

    draw(record.context, [countAnnotation({ id: 1, shape: "" })], {
      getTakeoffItems: () => {
        bridgeReads += 1;
        return [{ id: 1, size: 8 }];
      },
    });

    expect(bridgeReads).toBe(1);
    expect(record.trace).toEqual([]);
    expect(record.state()).toEqual(inheritedState());
  });

  it("uses hidden Set membership without coercing count item IDs", () => {
    const record = recordingContext();
    let bridgeReads = 0;

    draw(record.context, [countAnnotation({ id: 1, itemId: "7" })], {
      hiddenTakeoffItemIds: new Set([7]),
      getTakeoffItems: () => {
        bridgeReads += 1;
        return [{ id: 7, size: 8 }];
      },
    });

    expect(bridgeReads).toBe(1);
    expect(record.trace).toEqual(countTrace({
      shape: "circle",
      color: "#2468ac",
      cx: 60,
      cy: 50,
      radius: 4,
    }));
  });

  it("keeps a missing matched item optional and uses strict selected-ID admission", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const row = {
      id: "7",
      name: "coercive id",
      bbox: [0.1, 0.2, 0.5, 0.8] as Bbox,
      source: "takeoff" as const,
      data: {
        type: "count-marker",
        takeoffItemId: 999,
        color: "#2468ac",
        shape: "circle",
      },
    } as unknown as Annotation;
    const selection = {
      get isSelected() {
        events.push("selection:get-method");
        return function (this: unknown, id: number) {
          events.push(
            `selection:call:${String(id)}:${this === selection ? "receiver" : "detached"}`,
          );
          return false;
        };
      },
    } satisfies ExistingAnnotationSelection;

    draw(record.context, [row], {
      selectedId: 7,
      selection,
      getTakeoffItems: () => [],
    });

    expect(events.filter((event) => event.startsWith("selection:"))).toEqual([
      "selection:get-method",
      "selection:call:7:receiver",
    ]);
    expect(record.trace).toEqual(countTrace({
      shape: "circle",
      color: "#2468ac",
      cx: 60,
      cy: 50,
      radius: 5,
    }));
  });

  it("uses strict source and count-type admission even for coercible values", () => {
    const events: string[] = [];
    const record = recordingContext({
      events,
      measurementWidths: [8.25, 9.75],
    });
    const coercibleSource = {
      toString() {
        events.push("source:toString");
        return "takeoff";
      },
    };
    const coercibleType = {
      toString() {
        events.push("type:toString");
        return "count-marker";
      },
    };
    const sourceRow = annotation(
      1,
      "source",
      [0, 0, 0.1, 0.1],
      coercibleSource as Annotation["source"],
      {
        type: "count-marker",
        takeoffItemId: 1,
        color: "#000",
        shape: "circle",
      },
    );
    const typeRow = annotation(
      2,
      "type",
      [0.2, 0.2, 0.4, 0.4],
      "takeoff",
      {
        type: coercibleType,
        takeoffItemId: 2,
        color: "#000",
        shape: "circle",
      },
    );
    let bridgeReads = 0;

    draw(record.context, [sourceRow, typeRow], {
      getLabelColor: (name) => name === "source" ? "#111111" : "#222222",
      getTakeoffItems: () => {
        bridgeReads += 1;
        return [];
      },
    });

    expect(bridgeReads).toBe(0);
    expect(events).not.toContain("source:toString");
    expect(events).not.toContain("type:toString");
    expect(record.trace).toEqual([
      ...ordinaryTrace({
        name: "source",
        color: "#111111",
        x: 0,
        y: 0,
        width: 20,
        height: 10,
        measuredWidth: 8.25,
      }),
      ...ordinaryTrace({
        name: "type",
        color: "#222222",
        x: 40,
        y: 20,
        width: 40,
        height: 20,
        measuredWidth: 9.75,
      }),
    ]);
  });

  it("keeps count admission, hidden coldness, malformed continue, and one live bridge call per visible marker", () => {
    const events: string[] = [];
    const record = recordingContext({ events, measurementWidths: [11] });
    const hiddenData = {
      get type() {
        events.push("hidden:type");
        return "count-marker";
      },
      get takeoffItemId() {
        events.push("hidden:itemId");
        return 90;
      },
      get color(): never {
        throw new Error("hidden color must stay cold");
      },
      get shape(): never {
        throw new Error("hidden shape must stay cold");
      },
    };
    let hiddenDataReads = 0;
    const hidden = {
      get source() {
        events.push("hidden:source");
        return "takeoff" as const;
      },
      get data() {
        hiddenDataReads += 1;
        events.push(`hidden:data:${hiddenDataReads}`);
        return hiddenData;
      },
      get id(): never {
        throw new Error("hidden id must stay cold");
      },
      get name(): never {
        throw new Error("hidden name must stay cold");
      },
      get bbox(): never {
        throw new Error("hidden bbox must stay cold");
      },
    } as Annotation;
    const malformedData = {
      type: "count-marker",
      takeoffItemId: 91,
      get color() {
        events.push("malformed:color");
        return "";
      },
      get shape(): never {
        throw new Error("malformed shape must stay cold after falsy color");
      },
    };
    let malformedDataReads = 0;
    const malformed = {
      source: "takeoff" as const,
      get data() {
        malformedDataReads += 1;
        events.push(`malformed:data:${malformedDataReads}`);
        return malformedData;
      },
      id: 91,
      name: "must-not-be-a-box",
      get bbox(): never {
        throw new Error("malformed marker bbox must stay cold");
      },
    } as Annotation;
    const ordinary = annotation(3, "ordinary", [0.1, 0.2, 0.4, 0.4], "user");
    const rows = trackedIterable("rows", [hidden, malformed, ordinary], events);
    const hiddenSet = {
      get has() {
        events.push("hiddenSet:get-has");
        return function (this: unknown, id: number) {
          events.push(
            `hiddenSet:call:${id}:${this === hiddenSet ? "receiver" : "detached"}`,
          );
          return id === 90;
        };
      },
    } as unknown as ReadonlySet<number>;
    let bridgeReads = 0;

    draw(record.context, rows, {
      hiddenTakeoffItemIds: hiddenSet,
      getTakeoffItems: () => {
        bridgeReads += 1;
        events.push(`bridge:${bridgeReads}`);
        return [{ id: 91, size: 22 }];
      },
      getLabelColor: () => "#112233",
    });

    expect(hiddenDataReads).toBe(2);
    expect(malformedDataReads).toBe(3);
    expect(bridgeReads).toBe(1);
    expect(events).toContain("malformed:color");
    expect(events.indexOf("hidden:itemId")).toBeLessThan(
      events.indexOf("hiddenSet:get-has"),
    );
    expect(events.indexOf("hiddenSet:get-has")).toBeLessThan(
      events.indexOf("hiddenSet:call:90:receiver"),
    );
    expect(events.indexOf("bridge:1")).toBeLessThan(
      events.indexOf("malformed:data:3"),
    );
    expect(record.trace).toEqual(ordinaryTrace({
      name: "ordinary",
      color: "#112233",
      x: 20,
      y: 20,
      width: 60.00000000000001,
      height: 20,
      measuredWidth: 11,
    }));
    expect(record.state()).toEqual({
      ...inheritedState(),
      fillStyle: "#112233",
      strokeStyle: "#112233",
      lineWidth: 2,
      globalAlpha: 1,
      font: "bold 10px sans-serif",
    });
  });

  it("uses coercive first-match lookup order, selection property-before-ID, receiver calls, and item?.size timing", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    const dataReads = new Map<string, number>();
    const makeRow = (name: string, id: number, itemId: number | string): Annotation => {
      const markerData = {
        get type() {
          events.push(`${name}:type`);
          return "count-marker";
        },
        get takeoffItemId() {
          events.push(`${name}:itemId`);
          return itemId;
        },
        get color() {
          events.push(`${name}:color`);
          return id === 7 ? "#102030" : "#405060";
        },
        get shape() {
          events.push(`${name}:shape`);
          return id === 7 ? "circle" : "square";
        },
      };
      return {
        get source() {
          events.push(`${name}:source`);
          return "takeoff" as const;
        },
        get data() {
          const next = (dataReads.get(name) ?? 0) + 1;
          dataReads.set(name, next);
          events.push(`${name}:data:${next}`);
          return markerData;
        },
        get id() {
          events.push(`${name}:id`);
          return id;
        },
        get bbox() {
          events.push(`${name}:bbox`);
          return [0, 0, 0.2, 0.2] as Bbox;
        },
        name,
      } as Annotation;
    };
    const rows = [makeRow("first", 7, "7"), makeRow("second", 8, 8)];
    const selection = {
      get isSelected() {
        events.push("selection:get-method");
        return function (this: unknown, id: number) {
          events.push(
            `selection:call:${id}:${this === selection ? "receiver" : "detached"}`,
          );
          return false;
        };
      },
    } satisfies ExistingAnnotationSelection;
    let bridgeReads = 0;
    const makeItem = (prefix: string, id: number, size: number): TakeoffItem => ({
      get id() {
        events.push(`${prefix}:id`);
        return id;
      },
      get size() {
        events.push(`${prefix}:size`);
        return size;
      },
    });
    const getTakeoffItems = (): readonly TakeoffItem[] => {
      bridgeReads += 1;
      events.push(`bridge:${bridgeReads}`);
      const candidates = bridgeReads === 1
        ? [makeItem("decoy", 900, 99), makeItem("coercive", 7, 0)]
        : [makeItem("strict", 8, -4), makeItem("late", 8, 88)];
      const items = {
        get find() {
          events.push(`items${bridgeReads}:get-find`);
          return function (
            this: unknown,
            predicate: (item: TakeoffItem) => boolean,
          ) {
            events.push(
              `items${bridgeReads}:call-find:${this === items ? "receiver" : "detached"}`,
            );
            for (const candidate of candidates) {
              if (predicate(candidate)) return candidate;
            }
            return undefined;
          };
        },
      };
      return items as unknown as readonly TakeoffItem[];
    };

    draw(record.context, rows, {
      selectedId: 8,
      selection,
      getTakeoffItems,
      cssScale: 2,
    });

    expect(dataReads).toEqual(new Map([["first", 3], ["second", 3]]));
    expect(bridgeReads).toBe(2);
    expect(events.filter((event) => event.endsWith(":id"))).toEqual([
      "decoy:id",
      "decoy:id",
      "coercive:id",
      "coercive:id",
      "first:id",
      "first:id",
      "strict:id",
      "second:id",
    ]);
    expect(events).toContain("items1:call-find:receiver");
    expect(events).toContain("items2:call-find:receiver");
    expect(events).not.toContain("late:id");
    expect(events.indexOf("selection:get-method")).toBeLessThan(
      events.indexOf("selection:call:7:receiver"),
    );
    const firstIdReads = events.reduce<number[]>((indices, event, index) => {
      if (event === "first:id") indices.push(index);
      return indices;
    }, []);
    expect(firstIdReads).toHaveLength(2);
    expect(firstIdReads[0]).toBeLessThan(events.indexOf("selection:get-method"));
    expect(events.indexOf("selection:get-method")).toBeLessThan(firstIdReads[1]);
    expect(events.indexOf("selection:call:7:receiver")).toBeLessThan(
      events.indexOf("coercive:size"),
    );
    expect(events.indexOf("second:id")).toBeLessThan(
      events.indexOf("strict:size"),
    );
    expect(events.filter((event) => event === "selection:get-method")).toHaveLength(1);
    expect(record.trace).toEqual([
      ...countTrace({
        shape: "circle",
        color: "#102030",
        cx: 20,
        cy: 10,
        radius: 5,
      }),
      ...countTrace({
        shape: "square",
        color: "#405060",
        cx: 20,
        cy: 10,
        radius: -2,
        selected: true,
      }),
    ]);
  });

  it("keeps one interleaved generic traversal across ordinary, active-match, rejected YOLO, area, and negative MINMAX rows", () => {
    const events: string[] = [];
    const record = recordingContext({
      events,
      measurementWidths: [20, 28, 30, 27, 33],
    });
    const tracked = (
      prefix: string,
      id: number,
      name: string,
      bbox: Bbox,
      source: Annotation["source"],
      data: unknown = null,
    ): Annotation => ({
      get id() {
        events.push(`${prefix}:id`);
        return id;
      },
      get name() {
        events.push(`${prefix}:name`);
        return name;
      },
      get bbox() {
        events.push(`${prefix}:bbox`);
        return bbox;
      },
      get source() {
        events.push(`${prefix}:source`);
        return source;
      },
      get data() {
        events.push(`${prefix}:data`);
        return data as Annotation["data"];
      },
    });
    const rows = trackedIterable("rows", [
      tracked("user", 10, "User Selected", [0.1, 0.1, 0.3, 0.6], "user"),
      tracked("match", 20, "Matched YOLO", [0.6, 0.1, 0.75, 0.4], "yolo"),
      tracked("reject", 21, "Rejected YOLO", [0.01, 0.02, 0.03, 0.04], "yolo"),
      tracked("area", 30, "Area Selected", [0.3, 0.6, 0.5, 0.9], "takeoff", {
        type: "area-polygon",
      }),
      tracked("negative", 40, "Negative Box", [0.8, 0.8, 0.7, 0.6], "takeoff", {
        type: "other",
      }),
    ], events);
    const activeIds = {
      get has() {
        events.push("activeIds:get-has");
        return function (this: unknown, id: number) {
          events.push(
            `activeIds:call:${id}:${this === activeIds ? "receiver" : "detached"}`,
          );
          return id === 20;
        };
      },
    } as unknown as ReadonlySet<number>;
    const selection = {
      get isSelected() {
        events.push("selection:get-method");
        return function (this: unknown, id: number) {
          events.push(
            `selection:call:${id}:${this === selection ? "receiver" : "detached"}`,
          );
          return id === 10 || id === 30;
        };
      },
    } satisfies ExistingAnnotationSelection;
    const tagEvents: string[] = [];
    const tag = {
      get color() {
        tagEvents.push("tag:color");
        return "";
      },
      get name() {
        tagEvents.push("tag:name");
        return "";
      },
      get tagText() {
        tagEvents.push("tag:tagText");
        return "TAG FALLBACK";
      },
    } satisfies ExistingAnnotationActiveTag;
    const colors: Readonly<Record<string, string>> = {
      "User Selected": "#111111",
      "Matched YOLO": "#222222",
      "Rejected YOLO": "#333333",
      "Area Selected": "#444444",
      "Negative Box": "#555555",
    };

    draw(record.context, rows, {
      selectedId: 40,
      selection,
      activeTag: tag,
      activeTagAnnotationIds: activeIds,
      symbolSearchResults: null,
      getLabelColor: (name) => {
        events.push(`labelColor:${name}`);
        return colors[name] ?? "#000000";
      },
    });

    expect(record.trace).toEqual([
      ...ordinaryTrace({
        name: "User Selected",
        color: "#111111",
        x: 20,
        y: 10,
        width: 40,
        height: 50,
        measuredWidth: 20,
        selected: true,
        user: true,
        dimmed: true,
      }),
      ...activeMatchTrace({
        name: "Matched YOLO",
        color: "#222222",
        tagColor: "#22d3ee",
        tagLabel: "TAG FALLBACK",
        x: 120,
        y: 10,
        width: 30.000000000000004,
        height: 30.000000000000004,
        measuredWidth: 28,
        tagMeasuredWidth: 30,
      }),
      ...areaTrace({
        name: "Area Selected",
        color: "#444444",
        x: 60,
        y: 60,
        width: 40,
        height: 30.000000000000004,
        measuredWidth: 27,
        selected: true,
        dimmed: true,
      }),
      ...ordinaryTrace({
        name: "Negative Box",
        color: "#555555",
        x: 160,
        y: 80,
        width: -20.000000000000018,
        height: -20.000000000000007,
        measuredWidth: 33,
        selected: true,
        dimmed: true,
      }),
    ]);
    expect(events.filter((event) => event.startsWith("labelColor:"))).toEqual([
      "labelColor:User Selected",
      "labelColor:Matched YOLO",
      "labelColor:Rejected YOLO",
      "labelColor:Area Selected",
      "labelColor:Negative Box",
    ]);
    expect(events.indexOf("labelColor:Rejected YOLO")).toBeLessThan(
      events.indexOf("reject:bbox"),
    );
    expect(events.indexOf("reject:bbox")).toBeLessThan(
      events.indexOf("reject:source", events.indexOf("reject:bbox")),
    );
    expect(events.filter((event) => event.startsWith("activeIds:call:"))).toEqual([
      "activeIds:call:10:receiver",
      "activeIds:call:20:receiver",
      "activeIds:call:21:receiver",
      "activeIds:call:30:receiver",
      "activeIds:call:40:receiver",
    ]);
    expect(events.filter((event) => event === "selection:get-method")).toHaveLength(4);
    expect(events.filter((event) => event.startsWith("selection:call:"))).toEqual([
      "selection:call:10:receiver",
      "selection:call:10:receiver",
      "selection:call:20:receiver",
      "selection:call:30:receiver",
    ]);
    expect(tagEvents).toEqual([
      "tag:color",
      "tag:name",
      "tag:tagText",
      "tag:color",
    ]);
    expect(events.filter((event) => event.startsWith("rows:call-next:"))).toEqual([
      "rows:call-next:0:receiver",
      "rows:call-next:1:receiver",
      "rows:call-next:2:receiver",
      "rows:call-next:3:receiver",
      "rows:call-next:4:receiver",
      "rows:call-next:5:receiver",
    ]);
    expect(events).not.toContain("rows:get-return");
    expect(events.filter((event) => event.startsWith("ctx:call:")).every(
      (event) => event.endsWith(":receiver"),
    )).toBe(true);
    expect(record.state()).toEqual({
      fillStyle: "#555555",
      strokeStyle: "#555555",
      lineWidth: 3,
      globalAlpha: 1,
      font: "bold 10px sans-serif",
      stackDepth: 0,
    });
  });

  it("uses a strict non-null symbol sentinel and preserves null versus undefined active short-circuiting", () => {
    const row = annotation(1, "plain", [0, 0, 0.2, 0.1], "user");
    const cases = [
      { activeTag: null, symbolSearchResults: null, alpha: 1 },
      { activeTag: undefined, symbolSearchResults: null, alpha: 1 },
      { activeTag: null, symbolSearchResults: undefined, alpha: 0.25 },
      { activeTag: undefined, symbolSearchResults: false, alpha: 0.25 },
    ] as const;

    for (const testCase of cases) {
      const record = recordingContext({ measurementWidths: [9] });
      draw(record.context, [row], {
        activeTag: testCase.activeTag,
        symbolSearchResults: testCase.symbolSearchResults,
        getLabelColor: () => "#abcdef",
      });
      expect(record.trace, JSON.stringify(testCase)).toEqual(ordinaryTrace({
        name: "plain",
        color: "#abcdef",
        x: 0,
        y: 0,
        width: 40,
        height: 10,
        measuredWidth: 9,
        dimmed: testCase.alpha === 0.25,
        user: true,
      }));
    }
  });

  it("consumes bbox as MINMAX through its iterator, closes after four values, and preserves negative geometry", () => {
    const events: string[] = [];
    const record = recordingContext({ events, measurementWidths: [14] });
    const bbox = trackedBbox(
      "bbox",
      [0.75, 0.8, 0.25, 0.2, 999],
      events,
    );
    const row = annotation(1, "reversed", bbox, "user");

    draw(record.context, [row], {
      width: 200,
      height: 100,
      getLabelColor: () => "#13579b",
    });

    expect(events.filter((event) => event.startsWith("bbox:"))).toEqual([
      "bbox:get-iterator",
      "bbox:call-iterator:receiver",
      "bbox:get-next",
      "bbox:call-next:0:receiver",
      "bbox:call-next:1:receiver",
      "bbox:call-next:2:receiver",
      "bbox:call-next:3:receiver",
      "bbox:get-return",
      "bbox:call-return:receiver",
    ]);
    expect(record.trace).toEqual(ordinaryTrace({
      name: "reversed",
      color: "#13579b",
      x: 150,
      y: 80,
      width: -100,
      height: -60.00000000000001,
      measuredWidth: 14,
      user: true,
    }));
  });

  it("does not cache dynamic count data, color, shape, or live item size reads", () => {
    const events: string[] = [];
    const record = recordingContext({ events });
    let dataReads = 0;
    let colorReads = 0;
    let shapeReads = 0;
    const data = {
      get type() {
        events.push("data:type");
        return "count-marker";
      },
      get takeoffItemId() {
        events.push("data:itemId");
        return 4;
      },
      get color() {
        colorReads += 1;
        events.push(`data:color:${colorReads}`);
        return ["#010203", "#102030", "#304050"][colorReads - 1];
      },
      get shape() {
        shapeReads += 1;
        events.push(`data:shape:${shapeReads}`);
        return shapeReads === 1 ? "circle" : "square";
      },
    };
    const row = {
      source: "takeoff" as const,
      get data() {
        dataReads += 1;
        events.push(`ann:data:${dataReads}`);
        return data;
      },
      id: 4,
      name: "dynamic marker",
      bbox: [0.1, 0.2, 0.5, 0.8] as Bbox,
    } as Annotation;
    let sizeReads = 0;

    draw(record.context, [row], {
      getTakeoffItems: function (this: unknown) {
        events.push(`bridge:this:${this === undefined ? "undefined" : "bound"}`);
        return [{
          id: 4,
          get size() {
            sizeReads += 1;
            events.push(`item:size:${sizeReads}`);
            return 8;
          },
        }];
      },
    });

    expect(dataReads).toBe(3);
    expect(colorReads).toBe(3);
    expect(shapeReads).toBe(2);
    expect(sizeReads).toBe(1);
    expect(events).toContain("bridge:this:undefined");
    expect(record.trace).toEqual(countTrace({
      shape: "square",
      color: "#102030",
      cx: 60,
      cy: 50,
      radius: 4,
    }).map((entry) =>
      entry[0] === "set" && entry[1] === "strokeStyle"
        ? ["set", "strokeStyle", darkened("#304050")] as TraceEntry
        : entry
    ));
  });

  it("keeps active and annotation metadata live across two matched rows without caching fallbacks", () => {
    const events: string[] = [];
    const record = recordingContext({
      events,
      measurementWidths: [10, 11, 12, 13],
    });
    const makeRow = (
      prefix: string,
      id: number,
      names: readonly [string, string],
      bbox: Bbox,
    ): Annotation => {
      let nameRead = 0;
      return {
        id,
        source: "yolo" as const,
        data: null,
        bbox,
        get name() {
          nameRead += 1;
          events.push(`${prefix}:name:${nameRead}`);
          return names[nameRead - 1];
        },
      } as Annotation;
    };
    const colors = ["", "#111111", "#222222", ""];
    const names = ["", "SECOND TAG"];
    let colorRead = 0;
    let nameRead = 0;
    let textRead = 0;
    const tag = {
      get color() {
        colorRead += 1;
        events.push(`tag:color:${colorRead}`);
        return colors[colorRead - 1];
      },
      get name() {
        nameRead += 1;
        events.push(`tag:name:${nameRead}`);
        return names[nameRead - 1];
      },
      get tagText() {
        textRead += 1;
        events.push(`tag:text:${textRead}`);
        return "FIRST TAG";
      },
    } satisfies ExistingAnnotationActiveTag;
    const rows = [
      makeRow("first", 1, ["first-key", "First Label"], [0, 0, 0.2, 0.2]),
      makeRow("second", 2, ["second-key", "Second Label"], [0.5, 0.5, 0.7, 0.8]),
    ];

    draw(record.context, rows, {
      activeTag: tag,
      activeTagAnnotationIds: new Set([1, 2]),
      getLabelColor: function (this: unknown, name: string) {
        events.push(
          `label:${name}:${this === undefined ? "undefined" : "bound"}`,
        );
        return name === "first-key" ? "#aaaaaa" : "#bbbbbb";
      },
    });

    expect(colorRead).toBe(4);
    expect(nameRead).toBe(2);
    expect(textRead).toBe(1);
    expect(events.filter((event) => event.includes(":name:"))).toEqual([
      "first:name:1",
      "first:name:2",
      "tag:name:1",
      "second:name:1",
      "second:name:2",
      "tag:name:2",
    ]);
    expect(events).toContain("label:first-key:undefined");
    expect(events).toContain("label:second-key:undefined");
    expect(record.trace).toEqual([
      ...activeMatchTrace({
        name: "First Label",
        color: "#aaaaaa",
        tagColor: "#22d3ee",
        tagLabel: "FIRST TAG",
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        measuredWidth: 10,
        tagMeasuredWidth: 11,
      }).map((entry) =>
        entry[0] === "set" && entry[1] === "fillStyle" && entry[2] === "#22d3eedd"
          ? ["set", "fillStyle", "#111111dd"] as TraceEntry
          : entry
      ),
      ...activeMatchTrace({
        name: "Second Label",
        color: "#bbbbbb",
        tagColor: "#222222",
        tagLabel: "SECOND TAG",
        x: 100,
        y: 50,
        width: 39.99999999999999,
        height: 30.000000000000004,
        measuredWidth: 12,
        tagMeasuredWidth: 13,
      }).map((entry) =>
        entry[0] === "set" && entry[1] === "fillStyle" && entry[2] === "#222222dd"
          ? ["set", "fillStyle", "#22d3eedd"] as TraceEntry
          : entry
      ),
    ]);
  });

  it("closes the outer iterator at property, callback, Set, bbox-iterator, and canvas failure boundaries", () => {
    type FailureCase = {
      readonly label: string;
      readonly failure: Error;
      readonly make: (
        events: string[],
        record: ReturnType<typeof recordingContext>,
      ) => {
        readonly rows: readonly Annotation[];
        readonly overrides?: Partial<DrawExistingAnnotationsProps>;
      };
      readonly expectedCanvasEntries?: number;
      readonly failingInnerPrefix?: string;
    };
    const cases: readonly FailureCase[] = [
      {
        label: "annotation property",
        failure: new Error("source boom"),
        make(events) {
          const failure = this.failure;
          const row = {
            get source(): never {
              events.push("ann:source");
              throw failure;
            },
          } as unknown as Annotation;
          return { rows: trackedIterable("rows", [row], events) };
        },
        expectedCanvasEntries: 0,
      },
      {
        label: "label callback",
        failure: new Error("label boom"),
        make(events) {
          const failure = this.failure;
          return {
            rows: trackedIterable("rows", [
              annotation(1, "label", [0, 0, 1, 1], "user"),
            ], events),
            overrides: {
              getLabelColor: () => {
                events.push("label:call");
                throw failure;
              },
            },
          };
        },
        expectedCanvasEntries: 0,
      },
      {
        label: "active Set",
        failure: new Error("active set boom"),
        make(events) {
          const failure = this.failure;
          const ids = Object.defineProperty({}, "has", {
            get() {
              events.push("ids:get-has");
              return function (): never {
                events.push("ids:call-has");
                throw failure;
              };
            },
          }) as ReadonlySet<number>;
          return {
            rows: trackedIterable("rows", [
              annotation(1, "active", [0, 0, 1, 1], "user"),
            ], events),
            overrides: {
              activeTag: { color: "#000", name: "tag", tagText: "tag" },
              activeTagAnnotationIds: ids,
            },
          };
        },
        expectedCanvasEntries: 0,
      },
      {
        label: "bbox iterator",
        failure: new Error("bbox next boom"),
        make(events) {
          const bbox = trackedBbox("bbox", [0, 0, 1, 1], events, {
            throwOnNextIndex: 2,
            error: this.failure,
          });
          return {
            rows: trackedIterable("rows", [
              annotation(1, "bbox", bbox, "user"),
            ], events),
          };
        },
        expectedCanvasEntries: 0,
        failingInnerPrefix: "bbox",
      },
      {
        label: "canvas",
        failure: new Error("strokeRect boom"),
        make(events) {
          return {
            rows: trackedIterable("rows", [
              annotation(1, "canvas", [0, 0, 1, 1], "user"),
            ], events),
          };
        },
        expectedCanvasEntries: 5,
      },
    ];

    for (const testCase of cases) {
      const events: string[] = [];
      const record = recordingContext({
        events,
        failure: testCase.label === "canvas" ? {
          phase: "call",
          property: "strokeRect",
          error: testCase.failure,
        } : undefined,
      });
      const built = testCase.make(events, record);

      expect(captureThrown(() => draw(
        record.context,
        built.rows,
        built.overrides,
      )), testCase.label).toBe(testCase.failure);
      expect(events, testCase.label).toContain("rows:get-return");
      expect(events, testCase.label).toContain("rows:call-return:receiver");
      expect(record.trace, testCase.label).toHaveLength(
        testCase.expectedCanvasEntries ?? 0,
      );
      if (testCase.failingInnerPrefix) {
        expect(events, testCase.label).not.toContain(
          `${testCase.failingInnerPrefix}:get-return`,
        );
      }
    }
  });

  it("does not close the annotation iterator when its own next method fails after a completed row", () => {
    const events: string[] = [];
    const failure = new Error("rows next boom");
    const record = recordingContext({ events, measurementWidths: [8] });
    const rows = trackedIterable(
      "rows",
      [annotation(1, "done", [0, 0, 0.1, 0.1], "user")],
      events,
      { throwOnNextIndex: 1, error: failure },
    );

    expect(captureThrown(() => draw(record.context, rows))).toBe(failure);
    expect(events).not.toContain("rows:get-return");
    expect(events).not.toContain("rows:call-return:receiver");
    expect(record.trace).toEqual(ordinaryTrace({
      name: "done",
      color: "#e6194b",
      x: 0,
      y: 0,
      width: 20,
      height: 10,
      measuredWidth: 8,
      user: true,
    }));
  });

  it("leaks the count save frame and partial styles when a path call throws; there is no finally restore", () => {
    const events: string[] = [];
    const failure = new Error("arc boom");
    const record = recordingContext({
      events,
      failure: { phase: "call", property: "arc", error: failure },
    });
    const rows = trackedIterable(
      "rows",
      [countAnnotation({ id: 1, color: "#102030" })],
      events,
    );
    const normal = countTrace({
      shape: "circle",
      color: "#102030",
      cx: 60,
      cy: 50,
      radius: 4,
    });
    const arcCall = normal.findIndex((entry) =>
      entry[0] === "call" && entry[1] === "arc"
    );

    expect(captureThrown(() => draw(record.context, rows, {
      getTakeoffItems: () => [{ id: 1, size: 8 }],
    }))).toBe(failure);
    expect(record.trace).toEqual(normal.slice(0, arcCall + 1));
    expect(record.trace).not.toContainEqual(["call", "restore"]);
    expect(events).toContain("rows:call-return:receiver");
    expect(record.state()).toEqual({
      fillStyle: "#102030",
      strokeStyle: darkened("#102030"),
      lineWidth: 1.5,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 1,
    });
  });

  it("restores inherited alpha before propagating a count fill failure", () => {
    const events: string[] = [];
    const failure = new Error("fill boom");
    const record = recordingContext({
      events,
      failure: { phase: "call", property: "fill", error: failure },
    });
    const rows = trackedIterable(
      "rows",
      [countAnnotation({ id: 1, color: "#102030" })],
      events,
    );
    const normal = countTrace({
      shape: "circle",
      color: "#102030",
      cx: 60,
      cy: 50,
      radius: 4,
    });
    const fillCall = normal.findIndex((entry) =>
      entry[0] === "call" && entry[1] === "fill"
    );

    expect(captureThrown(() => draw(record.context, rows, {
      getTakeoffItems: () => [{ id: 1, size: 8 }],
    }))).toBe(failure);
    expect(record.trace).toEqual(normal.slice(0, fillCall + 2));
    expect(events).toContain("rows:call-return:receiver");
    expect(record.state()).toEqual({
      fillStyle: "#102030",
      strokeStyle: darkened("#102030"),
      lineWidth: 1.5,
      globalAlpha: 0.37,
      font: "italic 13px serif",
      stackDepth: 1,
    });
  });

  it("propagates generic canvas and measure-width failures without a final alpha reset or cleanup", () => {
    const normal = ordinaryTrace({
      name: "failure",
      color: "#123456",
      x: 20,
      y: 20,
      width: 60.00000000000001,
      height: 20,
      measuredWidth: 19,
      dimmed: true,
      user: true,
    });
    const cases = [
      {
        label: "fillText call",
        failure: {
          phase: "call" as const,
          property: "fillText",
          error: new Error("fillText boom"),
        },
        traceLength: normal.findIndex((entry) =>
          entry[0] === "call" && entry[1] === "fillText"
        ) + 1,
        state: {
          fillStyle: "#123456",
          strokeStyle: "#123456",
          lineWidth: 2,
          globalAlpha: 0.25,
          font: "bold 10px sans-serif",
          stackDepth: 0,
        },
      },
      {
        label: "measure width",
        failure: {
          phase: "metrics-width" as const,
          property: "measureText.width",
          error: new Error("width boom"),
        },
        traceLength: normal.findIndex((entry) =>
          entry[0] === "get" && entry[1] === "measureText.width"
        ) + 1,
        state: {
          fillStyle: "#12345615",
          strokeStyle: "#123456",
          lineWidth: 2,
          globalAlpha: 0.25,
          font: "bold 10px sans-serif",
          stackDepth: 0,
        },
      },
    ];

    for (const testCase of cases) {
      const events: string[] = [];
      const record = recordingContext({
        events,
        measurementWidths: [19],
        failure: testCase.failure,
      });
      const rows = trackedIterable("rows", [
        annotation(1, "failure", [0.1, 0.2, 0.4, 0.4], "user"),
      ], events);

      expect(captureThrown(() => draw(record.context, rows, {
        activeTag: null,
        symbolSearchResults: {},
        getLabelColor: () => "#123456",
      })), testCase.label).toBe(testCase.failure.error);
      expect(record.trace, testCase.label).toEqual(
        normal.slice(0, testCase.traceLength),
      );
      expect(record.trace, testCase.label).not.toContainEqual([
        "set",
        "globalAlpha",
        1,
      ]);
      expect(record.state(), testCase.label).toEqual(testCase.state);
      expect(events, testCase.label).toContain("rows:call-return:receiver");
    }
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("existingAnnotations source boundary", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/viewer/render/existingAnnotations.ts"),
    "utf8",
  );

  it("keeps a private count renderer, one annotation loop, and an injected pure boundary", () => {
    expect(countOccurrences(source, "function darkenOpaqueHexColor(")).toBe(1);
    expect(source).not.toContain("export function darkenOpaqueHexColor(");
    expect(countOccurrences(source, "function drawCountMarker(")).toBe(1);
    expect(source).not.toContain("export function drawCountMarker(");
    expect(countOccurrences(source, "for (const ann of annotations)")).toBe(1);
    expect(countOccurrences(source, "getTakeoffItems()")).toBe(1);
    expect(source).toContain("t.id === itemId || String(t.id) === String(itemId)");
    expect(source).toContain("const [minX, minY, maxX, maxY] = ann.bbox;");
    expect(source).toContain("ctx.strokeStyle = darkenOpaqueHexColor(data.color);");
    expect(source).toContain("ctx.globalAlpha = inheritedGlobalAlpha * 0.8;");
    expect(source).not.toContain('data.color + "cc"');
    expect(source).not.toMatch(/@tanstack|useQuery|useViewerStore|readTakeoffItems|labelColorMap/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(/);
  });
});
