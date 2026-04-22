import { describe, it, expect } from "vitest";
import { clusterByTolerance } from "@/lib/geom/cluster-by-tolerance";

describe("clusterByTolerance", () => {
  it("returns empty array for empty input", () => {
    expect(clusterByTolerance<number>([], (x) => x, 1)).toEqual([]);
  });

  it("returns single-item cluster for single-item input", () => {
    expect(clusterByTolerance([42], (x) => x, 1)).toEqual([[42]]);
  });

  it("groups items within tolerance together", () => {
    expect(clusterByTolerance([0, 0.5, 1.0], (x) => x, 1)).toEqual([[0, 0.5, 1.0]]);
  });

  it("splits when gap exceeds tolerance", () => {
    expect(clusterByTolerance([0, 0.5, 3.0, 3.2], (x) => x, 1)).toEqual([
      [0, 0.5],
      [3.0, 3.2],
    ]);
  });

  it("sorts input before clustering", () => {
    expect(clusterByTolerance([3.0, 0, 3.2, 0.5], (x) => x, 1)).toEqual([
      [0, 0.5],
      [3.0, 3.2],
    ]);
  });

  it("compares to last item in cluster, not cluster range", () => {
    // pdfplumber contract: drift-tolerant chains. 0 → 0.8 → 1.6 → 2.4 with
    // tolerance 1.0 should all land in one cluster even though start→end = 2.4.
    expect(clusterByTolerance([0, 0.8, 1.6, 2.4], (x) => x, 1)).toEqual([
      [0, 0.8, 1.6, 2.4],
    ]);
  });

  it("extracts keys via keyFn on object inputs", () => {
    const lines = [
      { id: "a", top: 0.1 },
      { id: "b", top: 0.12 },
      { id: "c", top: 0.4 },
    ];
    expect(clusterByTolerance(lines, (l) => l.top, 0.05)).toEqual([
      [{ id: "a", top: 0.1 }, { id: "b", top: 0.12 }],
      [{ id: "c", top: 0.4 }],
    ]);
  });

  it("treats equal keys as same cluster", () => {
    expect(clusterByTolerance([1, 1, 1, 1], (x) => x, 0)).toEqual([[1, 1, 1, 1]]);
  });

  it("tolerance of zero means exact-match clustering", () => {
    expect(clusterByTolerance([1, 1, 2, 2, 3], (x) => x, 0)).toEqual([
      [1, 1],
      [2, 2],
      [3],
    ]);
  });
});
