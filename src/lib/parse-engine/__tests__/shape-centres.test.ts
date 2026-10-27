// [table pipeline WP-2.C] Shape-centre rows v1 (parse-engine/rows/shape-centres.ts): midpoint bands (R3, K13)
// and row keys read inside the shape, else the crop read flagged and repaired against its siblings (C2-m4).
// All text is synthetic pseudo-text (rule 12).
import { describe, expect, it } from "vitest";
import type { LineWord } from "../lines";
import { bandIndexOf, midpointBands, readShapeKeys, repairCropKey, shapeBandAlignment, shapeRowBands } from "../rows/shape-centres";

type Box = [number, number, number, number];
const BOX: Box = [0.1, 0.1, 0.6, 0.6];
const shape = (cy: number, h = 0.016): Box => [0.112, cy - h / 2, 0.128, cy + h / 2];
const word = (t: string, x: number, y: number, h = 0.008): LineWord => ({ t, b: [x, y - h / 2, x + 0.006 * t.length, y + h / 2] });

/** The band index of every word (by its y-centre), grouped as the row's words. */
function rowsOf(words: readonly LineWord[], bands: readonly Box[]): string[][] {
  const rows = bands.map(() => [] as string[]);
  for (const w of words) {
    const i = bandIndexOf((w.b[1] + w.b[3]) / 2, bands);
    if (i >= 0) rows[i].push(w.t);
  }
  return rows;
}

describe("midpointBands (R3)", () => {
  it("cuts between consecutive shape centres; the first band starts half a gap above, the last ends half a gap below", () => {
    const bands = midpointBands([shape(0.2), shape(0.3), shape(0.4)], BOX);
    expect(bands.map((b) => [b[1], b[3]].map((v) => Math.round(v * 1e6) / 1e6))).toEqual([[0.15, 0.25], [0.25, 0.35], [0.35, 0.45]]);
    expect(bands.every((b) => b[0] === BOX[0] && b[2] === BOX[2])).toBe(true);
    expect(midpointBands([], BOX)).toEqual([]);
  });

  it("K13 probe: a description centred on its shape over 3 lines stays in its own row, and the header stays out", () => {
    const cs = [0.2, 0.25, 0.3, 0.35];
    const d = 0.012; // line pitch inside a row; 3 lines centred on the shape
    const words: LineWord[] = [word("HDRA", 0.2, 0.17)];
    cs.forEach((c, i) => { words.push(word(`R${i}A`, 0.2, c - d), word(`R${i}B`, 0.2, c), word(`R${i}C`, 0.2, c + d)); });
    const bands = midpointBands(cs.map((c) => shape(c)), BOX, words.map((w) => w.b));
    const rows = rowsOf(words, bands);
    expect(rows).toEqual(cs.map((_, i) => [`R${i}A`, `R${i}B`, `R${i}C`]));
    expect(bandIndexOf(0.17, bands)).toBe(-1); // the header line is above the first band
  });

  it("the last tall row keeps its trailing lines (down to the last word inside the box)", () => {
    const cs = [0.2, 0.22, 0.24, 0.26];
    const words: LineWord[] = cs.map((c, i) => word(`R${i}`, 0.2, c));
    for (let k = 1; k <= 4; k++) words.push(word(`T${k}`, 0.2, 0.26 + k * 0.01)); // 4 more lines under the last tag
    words.push(word("OUTSIDE", 0.2, 0.65)); // below the box: never pulled in
    const bands = midpointBands(cs.map((c) => shape(c, 0.012)), BOX, words.map((w) => w.b));
    const rows = rowsOf(words, bands);
    expect(rows[3]).toEqual(["R3", "T1", "T2", "T3", "T4"]);
    expect(bands[3][3]).toBeCloseTo(0.30 + 0.004, 9);
    expect(rows.flat()).not.toContain("OUTSIDE");
  });

  it("[fix round, MED-2] the last band stops at a gap: a distant word INSIDE the box (a footnote) stays out", () => {
    const cs = [0.2, 0.22, 0.24, 0.26];
    const words: LineWord[] = cs.map((c, i) => word(`R${i}`, 0.2, c));
    for (let k = 1; k <= 4; k++) words.push(word(`T${k}`, 0.2, 0.26 + k * 0.01));
    words.push(word("FOOTNOTE", 0.2, 0.5)); // inside the box, ~20 line pitches below the last line
    const bands = midpointBands(cs.map((c) => shape(c, 0.012)), BOX, words.map((w) => w.b));
    const rows = rowsOf(words, bands);
    expect(rows[3]).toEqual(["R3", "T1", "T2", "T3", "T4"]);
    expect(bands[3][3]).toBeCloseTo(0.30 + 0.004, 9);
    expect(rows.flat()).not.toContain("FOOTNOTE");
    // the same under the top-aligned rule
    const top = shapeRowBands(cs.map((c) => shape(c, 0.012)), BOX, words.map((w) => w.b), { align: "top" }).bands;
    expect(rowsOf(words, top).flat()).not.toContain("FOOTNOTE");
    expect(top[3][3]).toBeCloseTo(0.30 + 0.004, 9);
  });

  it("bands follow the input order of the shapes, are never inverted, and honour a known header bottom", () => {
    const boxes = [shape(0.4), shape(0.2), shape(0.3)];
    const bands = midpointBands(boxes, BOX);
    expect(bands.map((b) => Math.round(b[1] * 1e6) / 1e6)).toEqual([0.35, 0.15, 0.25]);
    const top = midpointBands([shape(0.2), shape(0.3)], BOX, [], { top: 0.18 });
    expect(top[0][1]).toBe(0.18);
    // a header bottom below the first midpoint cannot invert a band
    const low = midpointBands([shape(0.2), shape(0.3)], BOX, [], { top: 0.27 });
    expect(low.every((b) => b[3] >= b[1])).toBe(true);
    // clamped into the box
    const tight = midpointBands([shape(0.105), shape(0.2)], BOX);
    expect(tight[0][1]).toBe(BOX[1]);
  });

  it("a single shape with no words gets its own extent (half its height either side of its centre)", () => {
    const [b] = midpointBands([shape(0.3, 0.02)], BOX);
    expect([b[1], b[3]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.29, 0.31]);
  });

  it("is deterministic (E-7)", () => {
    const boxes = [0.2, 0.23, 0.29, 0.31].map((c) => shape(c));
    const words = [word("AA", 0.2, 0.33), word("BB", 0.2, 0.4)].map((w) => w.b);
    expect(midpointBands(boxes, BOX, words)).toEqual(midpointBands(boxes, BOX, words));
  });
});

describe("shapeRowBands: one alignment per column (WP-2.C guard for top-aligned notes)", () => {
  /** Wrapped notes, uniform line spacing, each bubble beside the FIRST line; the last line of a note is short. */
  function topAligned(): { shapes: Box[]; words: LineWord[]; truth: string[][] } {
    const h = 0.0105;
    const notes = [2, 3, 2, 3]; // lines per note
    const shapes: Box[] = [];
    const words: LineWord[] = [];
    const truth: string[][] = [];
    let y = 0.2;
    notes.forEach((k, i) => {
      shapes.push(shape(y, 0.014));
      const row: string[] = [];
      for (let l = 0; l < k; l++) {
        const short = l === k - 1;
        for (let j = 0; j < (short ? 2 : 6); j++) { const t = `N${i}L${l}W${j}`; words.push(word(t, 0.15 + j * 0.06, y + l * h)); row.push(t); }
      }
      truth.push(row);
      y += k * h;
    });
    return { shapes, words, truth };
  }

  it("a top-aligned column keeps the shape-top cuts, so no note loses its last line", () => {
    const { shapes, words, truth } = topAligned();
    expect(shapeBandAlignment(shapes, BOX, words.map((w) => w.b))).toBe("top");
    const { bands, align } = shapeRowBands(shapes, BOX, words.map((w) => w.b));
    expect(align).toBe("top");
    expect(rowsOf(words, bands)).toEqual(truth);
    // the pure R3 rule would move lines across notes here
    expect(rowsOf(words, midpointBands(shapes, BOX, words.map((w) => w.b)))).not.toEqual(truth);
  });

  it("a centred column (white space between rows) stays on midpoints, as do single-line rows and an explicit align", () => {
    const cs = [0.2, 0.25, 0.3];
    const words: LineWord[] = [];
    cs.forEach((c, i) => { for (const d of [-0.012, 0, 0.012]) words.push(word(`C${i}`, 0.2, c + d)); });
    expect(shapeRowBands(cs.map((c) => shape(c)), BOX, words.map((w) => w.b)).align).toBe("centre");
    const single = cs.map((c, i) => word(`S${i}`, 0.2, c));
    expect(shapeBandAlignment(cs.map((c) => shape(c)), BOX, single.map((w) => w.b))).toBe("centre");
    expect(shapeBandAlignment(cs.map((c) => shape(c)), BOX, [])).toBe("centre");
    const { shapes, words: tw } = topAligned();
    expect(shapeRowBands(shapes, BOX, tw.map((w) => w.b), { align: "centre" }).align).toBe("centre");
    expect(shapeRowBands([], BOX)).toEqual({ bands: [], align: "centre" });
  });
});

describe("row keys: inside, else the crop read (flagged), repaired against sibling keys (C2-m4)", () => {
  it("restores a dropped dot or slash from the siblings' format", () => {
    expect(repairCropKey("34", ["3.1", "3.2", "3.3"])).toBe("3.4");
    expect(repairCropKey("310", ["3.1", "3.2", "3.11"])).toBe("3.10"); // two sibling formats; only D.DD lines up with 3 characters
    expect(repairCropKey("78", ["1/2", "3/4", "5/8"])).toBe("7/8");
    expect(repairCropKey("a14", ["A.1.1", "A.1.2", "A.1.3"])).toBe("A.1.4");
  });

  it("keeps a crop read that fits, has its own separator, or that no single sibling format explains", () => {
    expect(repairCropKey("Q4", ["Q1", "Q2", "Q3"])).toBeNull(); // already fits
    expect(repairCropKey("3.4", ["3.1", "3.2", "3.3"])).toBeNull(); // has a separator
    expect(repairCropKey("34", ["3.1"])).toBeNull(); // too few siblings
    expect(repairCropKey("345", ["3.1", "3.2", "3.3"])).toBeNull(); // no format lines up
    expect(repairCropKey("12", ["1.2", "3/4"])).toBeNull(); // two formats tie
    expect(repairCropKey("", ["3.1", "3.2"])).toBeNull();
    // [fix round, LOW-1] a repair a sibling already holds would duplicate a unique key: kept as read
    expect(repairCropKey("12", ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "10", "11"])).toBeNull();
    expect(repairCropKey("31", ["3.1", "3.2", "3.3"])).toBeNull();
    expect(repairCropKey("12", ["1/2", "3/4", "5/8"])).toBeNull();
  });

  it("reads the words inside the shape first, else the crop read with key-from-crop, repaired when it lost a separator", () => {
    const shapes = [
      { bbox: shape(0.2), text: "31" },
      { bbox: shape(0.25), text: "32" },
      { bbox: shape(0.3), text: "33" },
      { bbox: shape(0.35), text: "34" },
      { bbox: shape(0.4), text: "QX" },
      { bbox: shape(0.45) },
    ];
    const words = [word("3.1", 0.114, 0.2), word("3.2", 0.114, 0.25), word("3.3", 0.114, 0.3), word("FAR", 0.3, 0.35)];
    expect(readShapeKeys(shapes, words)).toEqual([
      { key: "3.1", src: "inside", flags: [] },
      { key: "3.2", src: "inside", flags: [] },
      { key: "3.3", src: "inside", flags: [] },
      { key: "3.4", src: "crop", flags: ["key-from-crop", "key-repaired"] },
      { key: "QX", src: "crop", flags: ["key-from-crop"] },
      { key: null, src: null, flags: [] },
    ]);
  });

  it("an inside read is line-aware (two stacked lines read top to bottom)", () => {
    const s = { bbox: [0.11, 0.19, 0.14, 0.215] as Box };
    const words = [word("B2", 0.112, 0.207), word("A1", 0.12, 0.197)];
    expect(readShapeKeys([s], words)[0]).toEqual({ key: "A1 B2", src: "inside", flags: [] });
  });
});
