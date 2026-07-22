// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { AreaPolygonData, ClientAnnotation } from "@/types";
import { drawAreaPolygons } from "../areaPolygons";

type AreaAnnotation = Pick<ClientAnnotation, "id" | "source" | "data">;

type TraceEntry =
  | [kind: "call", method: string, ...args: unknown[]]
  | [kind: "set", property: string, value: unknown];

function recordingContext(): {
  context: CanvasRenderingContext2D;
  trace: TraceEntry[];
  stackDepth: () => number;
} {
  const trace: TraceEntry[] = [];
  let stackDepth = 0;
  const context = {
    save() {
      trace.push(["call", "save"]);
      stackDepth += 1;
    },
    restore() {
      trace.push(["call", "restore"]);
      if (stackDepth > 0) stackDepth -= 1;
    },
    beginPath() {
      trace.push(["call", "beginPath"]);
    },
    closePath() {
      trace.push(["call", "closePath"]);
    },
    moveTo(x: number, y: number) {
      trace.push(["call", "moveTo", x, y]);
    },
    lineTo(x: number, y: number) {
      trace.push(["call", "lineTo", x, y]);
    },
    fill(rule?: CanvasFillRule) {
      trace.push(["call", "fill", ...(rule === undefined ? [] : [rule])]);
    },
    stroke() {
      trace.push(["call", "stroke"]);
    },
    arc(x: number, y: number, radius: number, start: number, end: number) {
      trace.push(["call", "arc", x, y, radius, start, end]);
    },
    measureText(text: string) {
      trace.push(["call", "measureText", text]);
      return { width: text.length * 6 };
    },
    fillRect(x: number, y: number, width: number, height: number) {
      trace.push(["call", "fillRect", x, y, width, height]);
    },
    fillText(text: string, x: number, y: number) {
      trace.push(["call", "fillText", text, x, y]);
    },
    setLineDash(segments: number[]) {
      trace.push(["call", "setLineDash", segments]);
    },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
      trace.push(["set", "strokeStyle", value]);
    },
    set lineWidth(value: number) {
      trace.push(["set", "lineWidth", value]);
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      trace.push(["set", "fillStyle", value]);
    },
    set font(value: string) {
      trace.push(["set", "font", value]);
    },
  } as unknown as CanvasRenderingContext2D;
  return { context, trace, stackDepth: () => stackDepth };
}

function areaData(
  takeoffItemId: number,
  color: string,
  vertices: { x: number; y: number }[],
  areaSqUnits: number,
  unit: AreaPolygonData["unit"],
  holes?: AreaPolygonData["holes"],
) {
  return {
    type: "area-polygon",
    takeoffItemId,
    color,
    vertices,
    ...(holes === undefined ? {} : { holes }),
    areaSqUnits,
    unit,
  } satisfies AreaPolygonData;
}

function areaAnnotation(
  id: number,
  data: ReturnType<typeof areaData> | Record<string, unknown>,
): AreaAnnotation {
  return { id, source: "takeoff", data };
}

const TRIANGLE = [
  { x: 0.1, y: 0.2 },
  { x: 0.4, y: 0.2 },
  { x: 0.25, y: 0.8 },
];

describe("drawAreaPolygons", () => {
  it("keeps empty input membership-, selection-, and canvas-cold", () => {
    const record = recordingContext();
    const hiddenTakeoffItemIds = new Set<number>();
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    const isSelected = vi.fn(() => true);

    drawAreaPolygons(record.context, {
      annotations: [],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: { isSelected },
    });

    expect(hiddenHas).not.toHaveBeenCalled();
    expect(isSelected).not.toHaveBeenCalled();
    expect(record.trace).toEqual([]);
    expect(record.stackDepth()).toBe(0);
  });

  it("keeps source, type, second-data, hidden, and minimum-vertex checks ordered and canvas-cold", () => {
    const record = recordingContext();
    const order: string[] = [];
    const hiddenPayload = {
      type: "area-polygon",
      takeoffItemId: 13,
      color: "#ef4444",
      get vertices() {
        order.push("hidden:vertices");
        return TRIANGLE;
      },
      areaSqUnits: 1,
      unit: "SF",
    };
    const missingPayload = {
      type: "area-polygon",
      takeoffItemId: 14,
      color: "#f59e0b",
      get vertices() {
        order.push("missing:vertices");
        return undefined;
      },
      areaSqUnits: 0,
      unit: "SI",
    };
    const shortVertices = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }];
    const shortPayload = {
      type: "area-polygon",
      takeoffItemId: 15,
      color: "#eab308",
      get vertices() {
        order.push("short:vertices");
        return shortVertices;
      },
      areaSqUnits: 0,
      unit: "SM",
    };
    const rows = [
      {
        id: 1,
        get source() {
          order.push("wrong-source:source");
          return "user" as const;
        },
        get data() {
          order.push("wrong-source:data");
          return areaData(11, "#dc2626", TRIANGLE, 1, "SF");
        },
      },
      {
        id: 2,
        get source() {
          order.push("wrong-type:source");
          return "takeoff" as const;
        },
        get data() {
          order.push("wrong-type:data");
          return { ...areaData(12, "#fb7185", TRIANGLE, 1, "SF"), type: "other" };
        },
      },
      {
        id: 6,
        source: "takeoff" as const,
        get data() {
          order.push("null:data");
          return null;
        },
      },
      {
        id: 7,
        source: "takeoff" as const,
        get data() {
          order.push("undefined:data");
          return undefined;
        },
      },
      {
        id: 3,
        source: "takeoff" as const,
        get data() {
          order.push("hidden:data");
          return hiddenPayload;
        },
      },
      {
        id: 4,
        source: "takeoff" as const,
        get data() {
          order.push("missing:data");
          return missingPayload;
        },
      },
      {
        id: 5,
        source: "takeoff" as const,
        get data() {
          order.push("short:data");
          return shortPayload;
        },
      },
    ] as unknown as AreaAnnotation[];
    const hiddenTakeoffItemIds = {
      has(this: unknown, id: number) {
        order.push(this === hiddenTakeoffItemIds ? `hidden:this:${id}` : `hidden:detached:${id}`);
        return id === 13;
      },
    } as unknown as ReadonlySet<number>;
    const isSelected = vi.fn(() => true);

    drawAreaPolygons(record.context, {
      annotations: rows,
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: { isSelected },
    });

    expect(order).toEqual([
      "wrong-source:source",
      "wrong-type:source",
      "wrong-type:data",
      "null:data",
      "undefined:data",
      "hidden:data",
      "hidden:data",
      "hidden:this:13",
      "missing:data",
      "missing:data",
      "hidden:this:14",
      "missing:vertices",
      "short:data",
      "short:data",
      "hidden:this:15",
      "short:vertices",
      "short:vertices",
    ]);
    expect(isSelected).not.toHaveBeenCalled();
    expect(record.trace).toEqual([]);
    expect(record.stackDepth()).toBe(0);
  });

  it("preserves holes, selection asymmetry, projection, negative fallback, and exact canvas state", () => {
    const record = recordingContext();
    const hiddenTakeoffItemIds = new Set<number>();
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    const isSelected = vi.fn((id: number) => id === 207);
    const row = areaAnnotation(207, areaData(
      17,
      "#f97316",
      TRIANGLE,
      -2,
      "SC",
      [
        {
          vertices: [
            { x: 0.18, y: 0.3 },
            { x: 0.25, y: 0.3 },
            { x: 0.22, y: 0.5 },
          ],
        },
        { vertices: [{ x: 0.12, y: 0.22 }, { x: 0.14, y: 0.24 }] },
      ],
    ));

    drawAreaPolygons(record.context, {
      annotations: [row],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: { isSelected },
    });

    expect(hiddenHas.mock.calls).toEqual([[17]]);
    expect(isSelected.mock.calls).toEqual([[207]]);
    expect(record.trace).toEqual([
      ["call", "save"],
      ["set", "fillStyle", "#f9731640"],
      ["call", "beginPath"],
      ["call", "moveTo", 20, 20],
      ["call", "lineTo", 80, 20],
      ["call", "lineTo", 50, 80],
      ["call", "closePath"],
      ["call", "moveTo", 36, 30],
      ["call", "lineTo", 50, 30],
      ["call", "lineTo", 44, 50],
      ["call", "closePath"],
      ["call", "fill", "evenodd"],
      ["set", "strokeStyle", "#f97316"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "moveTo", 20, 20],
      ["call", "lineTo", 80, 20],
      ["call", "lineTo", 50, 80],
      ["call", "closePath"],
      ["call", "stroke"],
      ["call", "beginPath"],
      ["call", "moveTo", 36, 30],
      ["call", "lineTo", 50, 30],
      ["call", "lineTo", 44, 50],
      ["call", "closePath"],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 20, 20, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 80, 20, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 50, 80, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "-- SC"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 31, 33.00000000000001, 38, 16],
      ["set", "fillStyle", "#f97316"],
      ["call", "fillText", "-- SC", 35, 45.00000000000001],
      ["call", "restore"],
    ]);
    expect(record.trace).not.toContainEqual(["call", "setLineDash", []]);
    expect(record.stackDepth()).toBe(0);
  });

  it("keeps the strict positive-area label boundary", () => {
    const record = recordingContext();
    const rows = [
      areaAnnotation(301, areaData(31, "#ef4444", TRIANGLE, 0, "SF")),
      areaAnnotation(303, areaData(33, "#f59e0b", TRIANGLE, -0.5, "SI")),
      areaAnnotation(305, areaData(35, "#84cc16", TRIANGLE, Number.NaN, "SM")),
      areaAnnotation(307, areaData(37, "#06b6d4", TRIANGLE, 0.5, "SC")),
    ];

    drawAreaPolygons(record.context, {
      annotations: rows,
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set(),
      selection: { isSelected: () => false },
    });

    expect(record.trace.filter((entry) =>
      entry[0] === "call" && entry[1] === "measureText"
    )).toEqual([
      ["call", "measureText", "-- SF"],
      ["call", "measureText", "-- SI"],
      ["call", "measureText", "-- SM"],
      ["call", "measureText", "0.5 SC"],
    ]);
    expect(record.stackDepth()).toBe(0);
  });

  it("keeps selection lookup before the id argument, preserves its receiver, and short-circuits locally", () => {
    const record = recordingContext();
    const order: string[] = [];
    const row = {
      get id() {
        order.push("id:get");
        return 411;
      },
      source: "takeoff" as const,
      data: areaData(41, "#14b8a6", TRIANGLE, 1, "SF"),
      get bbox() {
        throw new Error("area helper must not read bbox");
      },
    };
    const selection = {
      get isSelected() {
        order.push("selection:get");
        return function (this: unknown, id: number) {
          order.push(this === selection ? "selection:this" : "selection:detached");
          order.push(`selection:call:${id}`);
          return false;
        };
      },
    };

    drawAreaPolygons(record.context, {
      annotations: [row],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set(),
      selection,
    });
    expect(order).toEqual([
      "id:get",
      "id:get",
      "selection:get",
      "id:get",
      "selection:this",
      "selection:call:411",
    ]);

    order.length = 0;
    drawAreaPolygons(record.context, {
      annotations: [row],
      width: 200,
      height: 100,
      selectedId: 411,
      hiddenTakeoffItemIds: new Set(),
      selection: {
        get isSelected(): (annotationId: number) => boolean {
          throw new Error("local selection must short-circuit the selection lookup");
        },
      },
    });
    expect(order).toEqual(["id:get", "id:get"]);
    expect(record.stackDepth()).toBe(0);
  });

  it("captures holes once and iterates that same owner twice", () => {
    const record = recordingContext();
    const order: string[] = [];
    const hole = {
      vertices: [
        { x: 0.15, y: 0.3 },
        { x: 0.25, y: 0.3 },
        { x: 0.2, y: 0.5 },
      ],
    };
    const holes = {
      [Symbol.iterator]() {
        order.push("holes:iterate");
        return [hole][Symbol.iterator]();
      },
    };
    const data = {
      ...areaData(51, "#8b5cf6", TRIANGLE, 2, "SF"),
      get holes() {
        order.push("holes:get");
        return holes;
      },
    } as unknown as Record<string, unknown>;

    drawAreaPolygons(record.context, {
      annotations: [areaAnnotation(511, data)],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set(),
      selection: { isSelected: () => false },
    });

    expect(order).toEqual(["holes:get", "holes:iterate", "holes:iterate"]);
    expect(record.stackDepth()).toBe(0);
  });

  it("keeps eligible outer- and hole-vertex property reads in their exact paint phases", () => {
    const record = recordingContext();
    const order: string[] = [];
    const outerVertices = [...TRIANGLE];
    const holeVertices = [
      { x: 0.15, y: 0.3 },
      { x: 0.25, y: 0.3 },
      { x: 0.2, y: 0.5 },
    ];
    const hole = {
      get vertices() {
        order.push("hole:vertices");
        return holeVertices;
      },
    };
    const data = {
      type: "area-polygon",
      takeoffItemId: 53,
      color: "#6366f1",
      get vertices() {
        order.push("outer:vertices");
        return outerVertices;
      },
      get holes() {
        order.push("holes:get");
        return [hole];
      },
      areaSqUnits: 2,
      unit: "SF",
    } as unknown as Record<string, unknown>;

    drawAreaPolygons(record.context, {
      annotations: [areaAnnotation(513, data)],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set(),
      selection: {
        isSelected() {
          order.push("selection");
          return false;
        },
      },
    });

    expect(order).toEqual([
      ...Array<string>(2).fill("outer:vertices"),
      "holes:get",
      ...Array<string>(9).fill("outer:vertices"),
      ...Array<string>(10).fill("hole:vertices"),
      ...Array<string>(9).fill("outer:vertices"),
      ...Array<string>(10).fill("hole:vertices"),
      "selection",
      "outer:vertices",
    ]);
    expect(record.stackDepth()).toBe(0);
  });

  it("keeps selection, hole-iterator, and context failures fail-loud without finally restoration", () => {
    const rows = [
      areaAnnotation(601, areaData(61, "#ef4444", TRIANGLE, 1, "SF")),
      areaAnnotation(603, areaData(63, "#22d3ee", TRIANGLE, 2, "SF")),
    ];

    const selectionRecord = recordingContext();
    const hiddenTakeoffItemIds = new Set<number>();
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    expect(() => drawAreaPolygons(selectionRecord.context, {
      annotations: rows,
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: {
        get isSelected(): (annotationId: number) => boolean {
          throw new Error("selection boom");
        },
      },
    })).toThrow("selection boom");
    expect(hiddenHas.mock.calls).toEqual([[61]]);
    expect(selectionRecord.stackDepth()).toBe(1);
    expect(selectionRecord.trace).not.toContainEqual(["call", "restore"]);

    const holeRecord = recordingContext();
    const throwingHoles = {
      [Symbol.iterator]() {
        throw new Error("holes boom");
      },
    };
    const holeData = {
      ...areaData(65, "#a855f7", TRIANGLE, 3, "SF"),
      holes: throwingHoles,
    } as unknown as Record<string, unknown>;
    expect(() => drawAreaPolygons(holeRecord.context, {
      annotations: [areaAnnotation(605, holeData)],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set(),
      selection: { isSelected: () => false },
    })).toThrow("holes boom");
    expect(holeRecord.stackDepth()).toBe(1);
    expect(holeRecord.trace).not.toContainEqual(["call", "restore"]);

    const contextRecord = recordingContext();
    vi.spyOn(contextRecord.context, "moveTo").mockImplementation(() => {
      throw new Error("context boom");
    });
    expect(() => drawAreaPolygons(contextRecord.context, {
      annotations: rows,
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set(),
      selection: { isSelected: () => false },
    })).toThrow("context boom");
    expect(contextRecord.stackDepth()).toBe(1);
    expect(contextRecord.trace).not.toContainEqual(["call", "restore"]);
  });
});

// ─── DR014 MED-1 seam ledger: hidden-id domain (characterization at 6ac3a8f) ───
// The count-marker pass normalizes hide keys to the exact String domain
// (existingAnnotations renderIdKey, landed 003883e); THIS pass still gates with strict
// Set.has on the raw id domain. A string-id row ("7") therefore escapes an active numeric
// hide {7} here while its count-marker twin is hidden. These witnesses pin the CURRENT
// behavior; the marked expectations flip in the mirroring fix commit.
describe("drawAreaPolygons hidden-id domain seam (DR014)", () => {
  it("hides the numeric-id row under a numeric hide", () => {
    const record = recordingContext();
    drawAreaPolygons(record.context, {
      annotations: [areaAnnotation(901, areaData(7, "#ef4444", TRIANGLE, 10, "SF"))],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set([7]),
      selection: { isSelected: () => false },
    });
    expect(record.trace).toEqual([]);
  });

  it("DEFECT WITNESS (flips at fix): string-id twin escapes the numeric hide", () => {
    const record = recordingContext();
    drawAreaPolygons(record.context, {
      annotations: [
        areaAnnotation(902, areaData("7" as unknown as number, "#ef4444", TRIANGLE, 10, "SF")),
      ],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set([7]),
      selection: { isSelected: () => false },
    });
    expect(record.trace).not.toEqual([]);
  });

  it("keeps '07' distinct from 7 under every domain choice", () => {
    // Drawn today (strict has) and MUST remain drawn after the String-domain fix —
    // String("07") !== String(7). A Number()-domain mutant coerces and wrongly hides it.
    const record = recordingContext();
    drawAreaPolygons(record.context, {
      annotations: [
        areaAnnotation(903, areaData("07" as unknown as number, "#ef4444", TRIANGLE, 10, "SF")),
      ],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds: new Set([7]),
      selection: { isSelected: () => false },
    });
    expect(record.trace).not.toEqual([]);
  });

  it("CURRENT COUPLING (flips at fix): the gate reads the caller's Set.has with raw ids", () => {
    const hiddenTakeoffItemIds = new Set<number>([7]);
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    const record = recordingContext();
    drawAreaPolygons(record.context, {
      annotations: [
        areaAnnotation(904, areaData(7, "#ef4444", TRIANGLE, 10, "SF")),
        areaAnnotation(905, areaData("7" as unknown as number, "#22d3ee", TRIANGLE, 10, "SF")),
      ],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: { isSelected: () => false },
    });
    expect(hiddenHas.mock.calls).toEqual([[7], ["7"]]);
  });
});
