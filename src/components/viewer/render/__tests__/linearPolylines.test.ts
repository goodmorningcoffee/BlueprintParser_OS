// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ClientAnnotation, LinearPolylineData } from "@/types";
import { drawLinearPolylines } from "../linearPolylines";

type LinearAnnotation = Pick<ClientAnnotation, "id" | "source" | "data">;

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
    stroke() {
      trace.push(["call", "stroke"]);
    },
    arc(x: number, y: number, radius: number, start: number, end: number) {
      trace.push(["call", "arc", x, y, radius, start, end]);
    },
    fill() {
      trace.push(["call", "fill"]);
    },
    setLineDash(segments: number[]) {
      trace.push(["call", "setLineDash", segments]);
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

function linearData(
  takeoffItemId: number,
  color: string,
  vertices: { x: number; y: number }[],
  totalLength: number,
  unit: string,
) {
  return {
    type: "linear-polyline",
    takeoffItemId,
    color,
    vertices,
    totalLength,
    unit,
    segmentLengths: [],
  } satisfies LinearPolylineData;
}

function linearAnnotation(
  id: number,
  data: ReturnType<typeof linearData>,
): LinearAnnotation {
  return { id, source: "takeoff", data };
}

describe("drawLinearPolylines", () => {
  it("keeps empty input callback- and canvas-cold", () => {
    const record = recordingContext();
    const hiddenTakeoffItemIds = new Set<number>();
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    const isSelected = vi.fn(() => true);

    drawLinearPolylines(record.context, {
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

  it("keeps source/type, hidden, and minimum-vertex rejects ordered and canvas-cold", () => {
    const record = recordingContext();
    const hiddenTakeoffItemIds = new Set([503]);
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    const isSelected = vi.fn(() => true);
    const renderable = linearData(
      501,
      "#ef4444",
      [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
      2,
      "LF",
    );
    const annotations: LinearAnnotation[] = [
      { id: 501, source: "user", data: renderable },
      { id: 502, source: "takeoff", data: { ...renderable, type: "not-linear" } },
      linearAnnotation(503, { ...renderable, takeoffItemId: 503 }),
      {
        id: 505,
        source: "takeoff",
        data: {
          type: "linear-polyline",
          takeoffItemId: 505,
          color: "#f59e0b",
          totalLength: 0,
          unit: "LF",
          segmentLengths: [],
        },
      },
      linearAnnotation(507, linearData(
        507,
        "#eab308",
        [{ x: 0.3, y: 0.3 }],
        0,
        "LF",
      )),
      { id: 509, source: "takeoff", data: null },
    ];

    drawLinearPolylines(record.context, {
      annotations,
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: { isSelected },
    });

    expect(hiddenHas.mock.calls).toEqual([[503], [505], [507]]);
    expect(isSelected).not.toHaveBeenCalled();
    expect(record.trace).toEqual([]);
    expect(record.stackDepth()).toBe(0);
  });

  it("preserves source order, selection asymmetry, geometry, labels, and exact canvas state", () => {
    const record = recordingContext();
    const hiddenTakeoffItemIds = new Set<number>();
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    const isSelected = vi.fn((id: number) => id === 307);
    const annotations = [
      linearAnnotation(307, linearData(
        17,
        "#f97316",
        [{ x: 0.125, y: 0.25 }, { x: 0.375, y: 0.75 }],
        0,
        "m",
      )),
      linearAnnotation(303, linearData(
        18,
        "#a855f7",
        [{ x: 0.5, y: 0.25 }, { x: 0.875, y: 0.75 }],
        12.25,
        "LF",
      )),
      linearAnnotation(301, linearData(
        19,
        "#0ea5e9",
        [{ x: 0.25, y: 0.125 }, { x: 0.5, y: 0.375 }],
        0.5,
        "ft",
      )),
    ] as const;

    drawLinearPolylines(record.context, {
      annotations,
      width: 200,
      height: 100,
      selectedId: 303,
      hiddenTakeoffItemIds,
      selection: { isSelected },
    });

    expect(hiddenHas.mock.calls).toEqual([[17], [18], [19]]);
    expect(isSelected.mock.calls).toEqual([[307], [301]]);
    expect(record.trace).toEqual([
      ["call", "save"],
      ["set", "strokeStyle", "#f97316"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "moveTo", 25, 25],
      ["call", "lineTo", 75, 75],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 25, 25, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#f97316"],
      ["call", "beginPath"],
      ["call", "arc", 75, 75, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "-- m"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 81, 68, 32, 16],
      ["set", "fillStyle", "#f97316"],
      ["call", "fillText", "-- m", 85, 80],
      ["call", "restore"],
      ["call", "save"],
      ["set", "strokeStyle", "#a855f7"],
      ["set", "lineWidth", 3],
      ["call", "beginPath"],
      ["call", "moveTo", 100, 25],
      ["call", "lineTo", 175, 75],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 100, 25, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "fillStyle", "#a855f7"],
      ["call", "beginPath"],
      ["call", "arc", 175, 75, 4, 0, Math.PI * 2],
      ["call", "fill"],
      ["set", "strokeStyle", "#fff"],
      ["set", "lineWidth", 1],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "12.3 LF"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 181, 68, 50, 16],
      ["set", "fillStyle", "#a855f7"],
      ["call", "fillText", "12.3 LF", 185, 80],
      ["call", "restore"],
      ["call", "save"],
      ["set", "strokeStyle", "#0ea5e9"],
      ["set", "lineWidth", 2],
      ["call", "beginPath"],
      ["call", "moveTo", 50, 12.5],
      ["call", "lineTo", 100, 37.5],
      ["call", "stroke"],
      ["set", "font", "bold 11px sans-serif"],
      ["call", "measureText", "0.5 ft"],
      ["set", "fillStyle", "rgba(0,0,0,0.75)"],
      ["call", "fillRect", 106, 30.5, 44, 16],
      ["set", "fillStyle", "#0ea5e9"],
      ["call", "fillText", "0.5 ft", 110, 42.5],
      ["call", "restore"],
    ]);
    expect(record.trace).not.toContainEqual(["call", "setLineDash", []]);
    expect(record.trace).not.toContainEqual(["call", "closePath"]);
    expect(record.stackDepth()).toBe(0);
  });

  it("reads data twice and checks hidden membership before touching vertices", () => {
    const record = recordingContext();
    const order: string[] = [];
    const payload = {
      type: "linear-polyline",
      takeoffItemId: 77,
      color: "#ef4444",
      get vertices() {
        order.push("vertices");
        return [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }];
      },
      totalLength: 1,
      unit: "LF",
      segmentLengths: [],
    };
    const annotation = {
      id: 77,
      source: "takeoff" as const,
      get data() {
        order.push("data");
        return payload;
      },
    };
    const hiddenTakeoffItemIds = {
      has(id: number) {
        order.push(`hidden:${id}`);
        return true;
      },
    } as unknown as ReadonlySet<number>;

    drawLinearPolylines(record.context, {
      annotations: [annotation],
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: {
        isSelected: () => {
          order.push("selected");
          return false;
        },
      },
    });

    expect(order).toEqual(["data", "data", "hidden:77"]);
    expect(record.trace).toEqual([]);
  });

  it("keeps the selection member lookup before the annotation-id argument and preserves its receiver", () => {
    const record = recordingContext();
    const order: string[] = [];
    const row = {
      get id() {
        order.push("id:get");
        return 811;
      },
      source: "takeoff" as const,
      data: linearData(
        41,
        "#14b8a6",
        [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        1,
        "LF",
      ),
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

    drawLinearPolylines(record.context, {
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
      "selection:call:811",
    ]);
    expect(record.stackDepth()).toBe(0);
  });

  it("keeps callback and context failures fail-loud without finally restoration", () => {
    const callbackRecord = recordingContext();
    const hiddenTakeoffItemIds = new Set<number>();
    const hiddenHas = vi.spyOn(hiddenTakeoffItemIds, "has");
    const rows = [
      linearAnnotation(901, linearData(
        31,
        "#ef4444",
        [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        1,
        "LF",
      )),
      linearAnnotation(903, linearData(
        32,
        "#22d3ee",
        [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }],
        2,
        "LF",
      )),
    ];

    expect(() => drawLinearPolylines(callbackRecord.context, {
      annotations: rows,
      width: 200,
      height: 100,
      selectedId: null,
      hiddenTakeoffItemIds,
      selection: {
        isSelected: () => {
          throw new Error("selection boom");
        },
      },
    })).toThrow("selection boom");
    expect(hiddenHas.mock.calls).toEqual([[31]]);
    expect(callbackRecord.stackDepth()).toBe(1);
    expect(callbackRecord.trace).not.toContainEqual(["call", "restore"]);

    const contextRecord = recordingContext();
    vi.spyOn(contextRecord.context, "moveTo").mockImplementation(() => {
      throw new Error("context boom");
    });
    expect(() => drawLinearPolylines(contextRecord.context, {
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
// Mirror of the areaPolygons seam ledger: the count-marker pass normalizes hide keys to
// the exact String domain (existingAnnotations renderIdKey, 003883e); THIS pass still
// gates with strict Set.has on the raw id domain. Witnesses pin CURRENT behavior; the
// marked expectations flip in the mirroring fix commit.
describe("drawLinearPolylines hidden-id domain seam (DR014)", () => {
  const LINE = [
    { x: 0.1, y: 0.1 },
    { x: 0.6, y: 0.4 },
  ];

  it("hides the numeric-id row under a numeric hide", () => {
    const record = recordingContext();
    drawLinearPolylines(record.context, {
      annotations: [linearAnnotation(901, linearData(7, "#ef4444", LINE, 12, "ft"))],
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
    drawLinearPolylines(record.context, {
      annotations: [
        linearAnnotation(902, linearData("7" as unknown as number, "#ef4444", LINE, 12, "ft")),
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
    const record = recordingContext();
    drawLinearPolylines(record.context, {
      annotations: [
        linearAnnotation(903, linearData("07" as unknown as number, "#ef4444", LINE, 12, "ft")),
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
    drawLinearPolylines(record.context, {
      annotations: [
        linearAnnotation(904, linearData(7, "#ef4444", LINE, 12, "ft")),
        linearAnnotation(905, linearData("7" as unknown as number, "#22d3ee", LINE, 12, "ft")),
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
