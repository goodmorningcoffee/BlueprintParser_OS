// @vitest-environment node
// [table pipeline WP-2.0b] The one word-in-box predicate and the LTWH ↔ MinMax edge conversions.

import { describe, expect, it } from "vitest";
import { centreIn, centreOf, ltwhToMinMax, minMaxToLtwh, unionBox, wordsIn } from "../geometry";

describe("box conversions", () => {
  it("LTWH → MinMax → LTWH round-trips", () => {
    expect(ltwhToMinMax([0.5, 0.25, 0.25, 0.125])).toEqual([0.5, 0.25, 0.75, 0.375]);
    expect(minMaxToLtwh([0.5, 0.25, 0.75, 0.375])).toEqual([0.5, 0.25, 0.25, 0.125]);
    expect(centreOf([0, 0, 0.5, 0.25])).toEqual([0.25, 0.125]);
  });

  it("unionBox covers every box; empty → null", () => {
    expect(unionBox([[0.1, 0.2, 0.3, 0.4], [0.05, 0.3, 0.2, 0.5]])).toEqual([0.05, 0.2, 0.3, 0.5]);
    expect(unionBox([])).toBeNull();
  });
});

describe("wordsIn: a word belongs to a box when its centre lies inside", () => {
  const box = [0.25, 0.25, 0.5, 0.5] as const;
  const at = (t: string, cx: number, cy: number) => ({ t, b: [cx - 0.01, cy - 0.01, cx + 0.01, cy + 0.01] as const });

  it("keeps centre-inside words in input order, even when the box clips the word", () => {
    const words = [at("in2", 0.4, 0.4), at("out", 0.6, 0.4), at("in1", 0.26, 0.26), at("clipped", 0.255, 0.3)];
    expect(wordsIn(words, box).map((w) => w.t)).toEqual(["in2", "in1", "clipped"]);
  });

  it("closed edges include the far edge; half-open edges exclude it (grid tiling)", () => {
    const onFar = at("far", 0.5, 0.375);
    const onNear = at("near", 0.25, 0.375);
    expect(centreIn(onFar.b, box)).toBe(true);
    expect(centreIn(onFar.b, box, "half-open")).toBe(false);
    expect(centreIn(onNear.b, box, "half-open")).toBe(true);
    // two cells sharing x = .5: a centre on the boundary lands in exactly one
    const right = [0.5, 0.25, 0.75, 0.5] as const;
    expect([centreIn(onFar.b, box, "half-open"), centreIn(onFar.b, right, "half-open")]).toEqual([false, true]);
    expect(wordsIn([onFar, onNear], box, "half-open").map((w) => w.t)).toEqual(["near"]);
  });
});
