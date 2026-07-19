// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { drawGroupRings } from "../groupRings";

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
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
      trace.push(["set", "strokeStyle", value]);
    },
    set lineWidth(value: number) {
      trace.push(["set", "lineWidth", value]);
    },
    setLineDash(segments: number[]) {
      trace.push(["call", "setLineDash", segments]);
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      trace.push(["call", "strokeRect", x, y, width, height]);
    },
  } as unknown as CanvasRenderingContext2D;
  return { context, trace, stackDepth: () => stackDepth };
}

const annotations = [
  { id: 103, bbox: [0.125, 0.25, 0.375, 0.75] as [number, number, number, number] },
  { id: 102, bbox: [0.25, 0.125, 0.5, 0.375] as [number, number, number, number] },
  { id: 101, bbox: [0.5, 0.25, 0.875, 0.75] as [number, number, number, number] },
] as const;

describe("drawGroupRings", () => {
  it("keeps empty input resolver- and canvas-cold", () => {
    const record = recordingContext();
    const getGroupOutlineColor = vi.fn(() => "#ef4444");

    drawGroupRings(record.context, {
      annotations: [],
      width: 200,
      height: 100,
      getGroupOutlineColor,
    });

    expect(getGroupOutlineColor).not.toHaveBeenCalled();
    expect(record.trace).toEqual([]);
    expect(record.stackDepth()).toBe(0);
  });

  it("resolves every annotation once in input order and keeps falsy rows canvas-cold", () => {
    const record = recordingContext();
    const getGroupOutlineColor = vi.fn((id: number) => id === 102 ? "" : null);

    drawGroupRings(record.context, {
      annotations,
      width: 200,
      height: 100,
      getGroupOutlineColor,
    });

    expect(getGroupOutlineColor.mock.calls).toEqual([[103], [102], [101]]);
    expect(record.trace).toEqual([]);
    expect(record.stackDepth()).toBe(0);
  });

  it("resolves color before touching bbox and leaves a skipped row's bbox unread", () => {
    const record = recordingContext();
    const order: string[] = [];
    const lazyAnnotation = {
      id: 107,
      get bbox(): [number, number, number, number] {
        order.push("bbox:107");
        return [0.1, 0.2, 0.3, 0.4];
      },
    };

    drawGroupRings(record.context, {
      annotations: [lazyAnnotation],
      width: 200,
      height: 100,
      getGroupOutlineColor: (id) => {
        order.push(`resolver:${id}`);
        return null;
      },
    });

    expect(order).toEqual(["resolver:107"]);
    expect(record.trace).toEqual([]);
  });

  it("preserves min/max geometry and the exact per-colored-row canvas state trace", () => {
    const record = recordingContext();
    const colors = new Map<number, string>([
      [103, "#ef4444"],
      [101, "#22d3ee"],
    ]);
    const getGroupOutlineColor = vi.fn((id: number) => colors.get(id) ?? null);

    drawGroupRings(record.context, {
      annotations,
      width: 200,
      height: 100,
      getGroupOutlineColor,
    });

    expect(getGroupOutlineColor.mock.calls).toEqual([[103], [102], [101]]);
    expect(record.trace).toEqual([
      ["call", "save"],
      ["set", "strokeStyle", "#ef4444"],
      ["set", "lineWidth", 1.5],
      ["call", "setLineDash", [4, 2]],
      ["call", "strokeRect", 23, 23, 54, 54],
      ["call", "restore"],
      ["call", "save"],
      ["set", "strokeStyle", "#22d3ee"],
      ["set", "lineWidth", 1.5],
      ["call", "setLineDash", [4, 2]],
      ["call", "strokeRect", 98, 23, 79, 54],
      ["call", "restore"],
    ]);
    expect(record.stackDepth()).toBe(0);
  });

  it("keeps resolver and context failures fail-loud without adding finally restoration", () => {
    const resolverRecord = recordingContext();
    expect(() => drawGroupRings(resolverRecord.context, {
      annotations,
      width: 200,
      height: 100,
      getGroupOutlineColor: () => { throw new Error("resolver boom"); },
    })).toThrow("resolver boom");
    expect(resolverRecord.trace).toEqual([]);

    const contextRecord = recordingContext();
    vi.spyOn(contextRecord.context, "strokeRect").mockImplementation(() => {
      throw new Error("context boom");
    });
    expect(() => drawGroupRings(contextRecord.context, {
      annotations: annotations.slice(0, 1),
      width: 200,
      height: 100,
      getGroupOutlineColor: () => "#ef4444",
    })).toThrow("context boom");
    expect(contextRecord.stackDepth()).toBe(1);
    expect(contextRecord.trace).not.toContainEqual(["call", "restore"]);
  });
});
