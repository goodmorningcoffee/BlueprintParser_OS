import { describe, it, expect } from "vitest";
import {
  linesInside,
  findClusterIndexByY,
  clusterUnionBbox,
  scaleColBoundariesToBbox,
  rowTextFromClusterKV,
  rowTextFromClusterNumbered,
  rowTextFromClusterSpec,
  rowTextFromClusterGeneric,
  unionBboxes,
} from "../paragraph-helpers";
import type { TextractLine } from "@/types";

function line(
  top: number,
  left: number,
  width: number,
  text: string,
  wordGap = 0,
): TextractLine {
  const words = text.split(/\s+/).map((t, i) => ({
    text: t,
    bbox: [left + i * (width / text.split(/\s+/).length + wordGap), top, width / text.split(/\s+/).length, 0.02] as [number, number, number, number],
    confidence: 0.99,
  }));
  return {
    text,
    bbox: [left, top, width, 0.02],
    confidence: 0.99,
    words,
  };
}

describe("linesInside", () => {
  it("includes lines whose center is inside the bbox", () => {
    const a = line(0.5, 0.5, 0.1, "inside");
    const b = line(0.1, 0.1, 0.1, "outside");
    const inside = linesInside([0.4, 0.4, 0.3, 0.3], [a, b]);
    expect(inside).toHaveLength(1);
    expect(inside[0].text).toBe("inside");
  });

  it("drops lines with invalid bbox", () => {
    const bad = { text: "x", bbox: [], confidence: 1, words: [] } as unknown as TextractLine;
    const good = line(0.5, 0.5, 0.1, "good");
    const inside = linesInside([0.4, 0.4, 0.3, 0.3], [bad, good]);
    expect(inside).toHaveLength(1);
  });
});

describe("findClusterIndexByY", () => {
  const c1 = [line(0.10, 0.1, 0.3, "a")];
  const c2 = [line(0.30, 0.1, 0.3, "b")];
  const c3 = [line(0.60, 0.1, 0.3, "c")];

  it("returns -1 for empty clusters array", () => {
    expect(findClusterIndexByY([], 0.5)).toBe(-1);
  });

  it("returns the cluster index whose Y-range contains the cursor", () => {
    expect(findClusterIndexByY([c1, c2, c3], 0.11)).toBe(0);
    expect(findClusterIndexByY([c1, c2, c3], 0.31)).toBe(1);
    expect(findClusterIndexByY([c1, c2, c3], 0.61)).toBe(2);
  });

  it("returns -1 when cursor falls in a gap between clusters", () => {
    expect(findClusterIndexByY([c1, c2, c3], 0.25)).toBe(-1);
  });
});

describe("clusterUnionBbox", () => {
  it("returns zero-bbox for empty cluster", () => {
    expect(clusterUnionBbox([])).toEqual([0, 0, 0, 0]);
  });

  it("computes MinMax union of all cluster lines", () => {
    const cluster = [
      line(0.1, 0.1, 0.3, "first"),
      line(0.2, 0.2, 0.4, "second"),
    ];
    const [x0, y0, x1, y1] = clusterUnionBbox(cluster);
    expect(x0).toBeCloseTo(0.1, 5);
    expect(y0).toBeCloseTo(0.1, 5);
    expect(x1).toBeCloseTo(0.6, 5); // 0.2 + 0.4
    expect(y1).toBeCloseTo(0.22, 5); // 0.2 + 0.02
  });
});

describe("scaleColBoundariesToBbox", () => {
  it("scales proportionally from source bbox to target bbox", () => {
    // Source bbox: x0=0.1, x1=0.3 (width 0.2). Boundary at 0.2 is at mid.
    // Target bbox: x0=0.5, x1=0.9 (width 0.4). Mid → 0.7.
    const scaled = scaleColBoundariesToBbox([0.2], [0.1, 0.0, 0.3, 0.0], [0.5, 0.0, 0.9, 0.0]);
    expect(scaled).toHaveLength(1);
    expect(scaled[0]).toBeCloseTo(0.7, 5);
  });

  it("returns empty for zero-width bbox", () => {
    expect(scaleColBoundariesToBbox([0.5], [0.1, 0, 0.1, 0], [0.5, 0, 0.9, 0])).toEqual([]);
  });

  it("preserves multiple boundaries at relative positions", () => {
    // 3 evenly-spaced boundaries in source should scale to same proportions in target
    const scaled = scaleColBoundariesToBbox([0.15, 0.20, 0.25], [0.1, 0, 0.3, 0], [0.0, 0, 1.0, 0]);
    expect(scaled[0]).toBeCloseTo(0.25, 5);
    expect(scaled[1]).toBeCloseTo(0.50, 5);
    expect(scaled[2]).toBeCloseTo(0.75, 5);
  });
});

describe("rowTextFromClusterKV", () => {
  it("returns empty shape for empty cluster", () => {
    expect(rowTextFromClusterKV([])).toEqual({ Key: "", Value: "" });
  });

  it("uses the largest-gap line as K:V anchor", () => {
    // Line with a big inter-word gap should split there
    const l1: TextractLine = {
      text: "Key Value",
      bbox: [0.1, 0.1, 0.6, 0.02],
      confidence: 0.99,
      words: [
        { text: "Key", bbox: [0.1, 0.1, 0.05, 0.02], confidence: 1 },
        // Big gap from 0.15 to 0.5
        { text: "Value", bbox: [0.5, 0.1, 0.2, 0.02], confidence: 1 },
      ],
    };
    const result = rowTextFromClusterKV([l1]);
    expect(result.Key).toBe("Key");
    expect(result.Value).toBe("Value");
  });

  it("falls back to joined text when no meaningful gap", () => {
    const l1: TextractLine = {
      text: "abc def",
      bbox: [0.1, 0.1, 0.2, 0.02],
      confidence: 0.99,
      words: [
        { text: "abc", bbox: [0.1, 0.1, 0.05, 0.02], confidence: 1 },
        { text: "def", bbox: [0.16, 0.1, 0.05, 0.02], confidence: 1 },
      ],
    };
    const result = rowTextFromClusterKV([l1]);
    // Small gap → anchor still picked, first word becomes Key
    expect(result.Key.length).toBeGreaterThan(0);
  });
});

describe("rowTextFromClusterNumbered", () => {
  it("extracts leading numeric Key + rest as Note", () => {
    const l1: TextractLine = {
      text: "1. All concrete shall conform",
      bbox: [0.1, 0.1, 0.8, 0.02],
      confidence: 0.99,
      words: [
        { text: "1.", bbox: [0.1, 0.1, 0.04, 0.02], confidence: 1 },
        { text: "All", bbox: [0.15, 0.1, 0.04, 0.02], confidence: 1 },
      ],
    };
    const l2: TextractLine = {
      text: "to ACI 318.",
      bbox: [0.1, 0.13, 0.8, 0.02],
      confidence: 0.99,
      words: [{ text: "to", bbox: [0.1, 0.13, 0.02, 0.02], confidence: 1 }],
    };
    const result = rowTextFromClusterNumbered([l1, l2]);
    expect(result.Key).toBe("1");
    expect(result.Note).toContain("All concrete");
    expect(result.Note).toContain("to ACI 318");
  });

  it("returns empty Key when no numeric prefix", () => {
    const l1: TextractLine = {
      text: "no number here",
      bbox: [0.1, 0.1, 0.5, 0.02],
      confidence: 0.99,
      words: [{ text: "no", bbox: [0.1, 0.1, 0.02, 0.02], confidence: 1 }],
    };
    const result = rowTextFromClusterNumbered([l1]);
    expect(result.Key).toBe("");
    expect(result.Note).toBe("no number here");
  });
});

describe("rowTextFromClusterSpec", () => {
  it("uses first line as sectionHeader, rest joined as body", () => {
    const l1 = line(0.1, 0.1, 0.5, "PART 1 - GENERAL");
    const l2 = line(0.13, 0.1, 0.5, "Scope of work follows.");
    const l3 = line(0.16, 0.1, 0.5, "See related sections.");
    const result = rowTextFromClusterSpec([l1, l2, l3]);
    expect(result.sectionHeader).toBe("PART 1 - GENERAL");
    expect(result.body).toContain("Scope of work follows.");
    expect(result.body).toContain("See related sections.");
  });
});

describe("rowTextFromClusterGeneric", () => {
  it("returns all lines joined into `text`", () => {
    const l1 = line(0.1, 0.1, 0.3, "line one");
    const l2 = line(0.13, 0.1, 0.3, "line two");
    expect(rowTextFromClusterGeneric([l1, l2])).toEqual({ text: "line one line two" });
  });
});

describe("unionBboxes", () => {
  it("returns zero-bbox for empty array", () => {
    expect(unionBboxes([])).toEqual([0, 0, 0, 0]);
  });

  it("computes the enclosing bbox of all inputs", () => {
    const bboxes: [number, number, number, number][] = [
      [0.1, 0.2, 0.3, 0.4],
      [0.2, 0.1, 0.5, 0.3],
      [0.15, 0.35, 0.4, 0.5],
    ];
    expect(unionBboxes(bboxes)).toEqual([0.1, 0.1, 0.5, 0.5]);
  });
});
