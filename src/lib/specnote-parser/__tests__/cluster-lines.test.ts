import { describe, it, expect } from "vitest";
import { clusterLinesByYGap } from "../cluster-lines";
import type { TextractLine } from "@/types";

function line(top: number, height: number, text = "x"): TextractLine {
  return {
    text,
    bbox: [0, top, 1, height],
    confidence: 0.99,
    words: [{ text, bbox: [0, top, 1, height], confidence: 0.99 }],
  };
}

describe("clusterLinesByYGap", () => {
  it("returns empty for empty input", () => {
    expect(clusterLinesByYGap([], 0.02)).toEqual([]);
  });

  it("groups closely-spaced lines into one cluster", () => {
    const lines = [line(0.1, 0.02), line(0.13, 0.02), line(0.16, 0.02)];
    const clusters = clusterLinesByYGap(lines, 0.02);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it("splits on a gap larger than tolerance", () => {
    const lines = [line(0.1, 0.02), line(0.13, 0.02), line(0.5, 0.02), line(0.53, 0.02)];
    const clusters = clusterLinesByYGap(lines, 0.02);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toHaveLength(2);
    expect(clusters[1]).toHaveLength(2);
  });

  it("sorts input lines top-to-bottom before clustering", () => {
    const lines = [line(0.5, 0.02, "b"), line(0.1, 0.02, "a")];
    const clusters = clusterLinesByYGap(lines, 0.01);
    expect(clusters[0][0].text).toBe("a");
    expect(clusters[1][0].text).toBe("b");
  });

  it("tolerance larger than gap keeps lines in the same cluster", () => {
    // A ends at 0.12; B starts at 0.14; gap = 0.02; tolerance = 0.03.
    const lines = [line(0.1, 0.02), line(0.14, 0.02)];
    const clusters = clusterLinesByYGap(lines, 0.03);
    expect(clusters).toHaveLength(1);
  });

  it("drops lines with invalid bbox", () => {
    const bad = { text: "bad", bbox: [], words: [] } as unknown as TextractLine;
    const lines = [line(0.1, 0.02), bad, line(0.12, 0.02)];
    const clusters = clusterLinesByYGap(lines, 0.02);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it("handles overlapping lines correctly (bottom updates max)", () => {
    const lines = [
      line(0.1, 0.05), // bottom = 0.15
      line(0.12, 0.02), // top within previous, overlapping
      line(0.18, 0.02), // gap from 0.15 to 0.18 = 0.03
    ];
    const clusters = clusterLinesByYGap(lines, 0.02);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toHaveLength(2);
    expect(clusters[1]).toHaveLength(1);
  });
});
