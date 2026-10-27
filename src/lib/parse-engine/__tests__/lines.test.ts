// @vitest-environment node
// [table pipeline WP-2.0b] Line grouping and line-aware cell text (K07). All text is synthetic.

import { describe, expect, it } from "vitest";
import { assembleText, lineWordsFromLtwh, wordsToLines, type LineWord } from "../lines";

/** A MinMax word from an LTWH-style spec, like the C02 probes. */
const W = (t: string, x: number, y: number, w = 0.03, h = 0.01): LineWord => ({ t, b: [x, y, x + w, y + h] });

/** Seeded LCG so the shuffles are reproducible. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = xs.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("assembleText: the C02 probes", () => {
  it("a two-line cell reads line by line, not interleaved by x (K07 interleave)", () => {
    // line 1: QAAL ZEBRO; line 2: WOLLAN FRIMP — x-only sorting gives QAAL WOLLAN ZEBRO FRIMP
    const words = [W("QAAL", 0.1, 0.1, 0.05), W("ZEBRO", 0.16, 0.1, 0.04), W("WOLLAN", 0.1, 0.115, 0.05), W("FRIMP", 0.16, 0.115, 0.04)];
    expect(assembleText(words)).toBe("QAAL ZEBRO WOLLAN FRIMP");
    expect(assembleText(words, { lineSep: "\n" })).toBe("QAAL ZEBRO\nWOLLAN FRIMP");
  });

  it("y-jitter on one line keeps x order (K07 jitter: exact y-centre sort scrambles it)", () => {
    // heights .0105 / .0095 / .0098 move the centres by < .001; a y-centre sort gives Bdor Cwal Agyp
    for (let i = 0; i < 4; i++) {
      const y = 0.2 + i * 0.05;
      const words = [W("Agyp", 0.15, y - 0.004, 0.04, 0.0105), W("Bdor", 0.195, y - 0.004, 0.04, 0.0095), W("Cwal", 0.24, y - 0.004, 0.03, 0.0098)];
      expect(assembleText(words)).toBe("Agyp Bdor Cwal");
    }
  });

  it("a centred three-line description reads its lines top to bottom (K13 probe shape)", () => {
    const words: LineWord[] = [];
    for (let l = 2; l >= 0; l--) words.push(W(`rz${l + 1}`, 0.15, 0.2 + (l - 1) * 0.012 - 0.004, 0.04, 0.008));
    expect(assembleText(words, { lineSep: "\n" })).toBe("rz1\nrz2\nrz3");
    expect(wordsToLines(words)).toHaveLength(3);
  });

  it("a wrapped two-word line keeps both words when the second sits slightly higher", () => {
    const words = [W("Lok", 0.1, 0.3005), W("Mip", 0.14, 0.2995), W("Nur", 0.18, 0.301)];
    expect(assembleText(words)).toBe("Lok Mip Nur");
  });
});

describe("wordsToLines", () => {
  const grid: LineWord[] = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 5; c++) {
      const jitter = ((r * 7 + c * 3) % 5) * 0.0004 - 0.0008;
      grid.push(W(`w${r}${c}`, 0.1 + c * 0.05, 0.1 + r * 0.02 + jitter, 0.04, 0.009 + (c % 3) * 0.0005));
    }
  }

  it("conserves words: every finite word lands in exactly one line, tokens preserved", () => {
    const lines = wordsToLines(grid);
    const idx = lines.flatMap((l) => l.wordIdx).sort((a, b) => a - b);
    expect(idx).toEqual(grid.map((_, i) => i));
    const tokens = assembleText(grid).split(" ").sort();
    expect(tokens).toEqual(grid.map((w) => w.t).sort());
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.text)).toEqual([0, 1, 2, 3, 4, 5].map((r) => [0, 1, 2, 3, 4].map((c) => `w${r}${c}`).join(" ")));
  });

  it("is deterministic and input-order independent", () => {
    const a = assembleText(grid, { lineSep: "\n" });
    for (const seed of [1, 7, 42, 1234]) {
      expect(assembleText(shuffled(grid, seed), { lineSep: "\n" })).toBe(a);
    }
    expect(JSON.stringify(wordsToLines(grid))).toBe(JSON.stringify(wordsToLines(grid)));
  });

  it("reports the union box and input indices in reading order", () => {
    const words = [W("b", 0.2, 0.1), W("a", 0.1, 0.1)];
    expect(wordsToLines(words)).toEqual([{ text: "a b", b: [0.1, 0.1, 0.23, 0.11], wordIdx: [1, 0] }]);
  });

  it("splitGap splits a line at a wide gap (two text columns); default does not", () => {
    const words = [W("p1", 0.1, 0.1), W("p2", 0.135, 0.1), W("q1", 0.5, 0.1), W("q2", 0.535, 0.1)];
    expect(wordsToLines(words).map((l) => l.text)).toEqual(["p1 p2 q1 q2"]);
    expect(wordsToLines(words, { splitGap: 1.2 }).map((l) => l.text)).toEqual(["p1 p2", "q1 q2"]);
  });

  it("skips words with a non-finite box and blank text never adds separators", () => {
    const words = [W("x", 0.1, 0.1), { t: "bad", b: [NaN, 0, 1, 1] as const }, W(" ", 0.15, 0.1), W("y", 0.2, 0.1)];
    const lines = wordsToLines(words);
    expect(lines.flatMap((l) => l.wordIdx).sort()).toEqual([0, 2, 3]);
    expect(assembleText(words)).toBe("x y");
    expect(assembleText([])).toBe("");
  });

  it("a running mean, not the first word, anchors the line", () => {
    // h .01, tol .005: d2 is .006 below d0 (a first-word anchor would split it off) but only
    // .0045 below the running mean of d0 and d1, so the line holds
    const words = [W("d0", 0.1, 0.1), W("d1", 0.14, 0.103), W("d2", 0.18, 0.106), W("e0", 0.1, 0.13)];
    expect(wordsToLines(words).map((l) => l.text)).toEqual(["d0 d1 d2", "e0"]);
  });
});

describe("lineWordsFromLtwh", () => {
  it("converts LTWH words index for index and lets malformed boxes drop out", () => {
    const words = lineWordsFromLtwh([
      { text: "k", bbox: [0.1, 0.2, 0.05, 0.01] },
      { text: "z", bbox: [0.1, 0.2, Number.NaN, 0.01] },
    ]);
    expect(words[0].t).toBe("k");
    [0.1, 0.2, 0.15, 0.21].forEach((v, i) => expect(words[0].b[i]).toBeCloseTo(v, 12));
    expect(words[1].b.every(Number.isNaN)).toBe(true);
    expect(assembleText(words)).toBe("k");
  });
});
