// @vitest-environment node
// [table pipeline WP-3.B] Column methods other than x-starts: textract-cells (spans, header flags),
// rulings (crop → page mapping) and primitive-grid (vertical_area separators). Synthetic geometry only.
import { describe, expect, it } from "vitest";
import { pickTextractTable, textractCellsColumns } from "@/lib/parse-engine/cols/textract-cells";
import { rulingsHypothesis } from "@/lib/parse-engine/cols/rulings";
import { primitiveGridColumns } from "@/lib/parse-engine/cols/primitive-grid";
import type { BboxMinMax, EnginePageEvidence, EngineTextractCell } from "@/lib/parse-engine/types";

type Table = EnginePageEvidence["textractTables"][number];

/** A Textract table on a regular grid: xs / ys are the grid lines; `spans` merges cells (anchor r,c → rs,cs). */
function table(xs: number[], ys: number[], opts: { hdrRows?: number; spans?: { r: number; c: number; rs: number; cs: number }[] } = {}): Table {
  const covered = new Set<string>();
  const cells: EngineTextractCell[] = [];
  for (const s of opts.spans ?? []) for (let r = s.r; r < s.r + s.rs; r++) for (let c = s.c; c < s.c + s.cs; c++) if (r !== s.r || c !== s.c) covered.add(`${r}:${c}`);
  for (let r = 0; r + 1 < ys.length; r++) {
    for (let c = 0; c + 1 < xs.length; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const s = opts.spans?.find((p) => p.r === r && p.c === c);
      const rs = s?.rs ?? 1;
      const cs = s?.cs ?? 1;
      cells.push({ r, c, rs, cs, b: [xs[c], ys[r], xs[c + cs], ys[r + rs]], ...(r < (opts.hdrRows ?? 0) ? { hdr: true as const } : {}) });
    }
  }
  return { b: [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]], cells };
}

const XS = [0.1, 0.15, 0.3, 0.38, 0.5];
const YS = [0.2, 0.22, 0.24, 0.26, 0.28, 0.3];

describe("textract-cells columns", () => {
  it("lines, spans and header rows from the stored table", () => {
    const t = table(XS, YS, { hdrRows: 1, spans: [{ r: 0, c: 1, rs: 1, cs: 2 }, { r: 2, c: 3, rs: 2, cs: 1 }] });
    const h = textractCellsColumns([t], [0.09, 0.19, 0.51, 0.31]);
    expect(h.error).toBeUndefined();
    expect(h.colLines).toEqual(XS);
    expect(h.rowLines).toEqual(YS);
    expect(h.headerRows).toBe(1);
    expect(h.cells?.filter((c) => c.rs > 1 || c.cs > 1).map((c) => [c.r, c.c, c.rs, c.cs])).toEqual([[0, 1, 1, 2], [2, 3, 2, 1]]);
    expect(h.cells?.filter((c) => c.header).length).toBe(3); // header row: 4 columns, one span of 2
    expect(h.conf).toBe(0.794); // the table covers .4 × .1 of the .42 × .12 box
  });

  it("the loader's shape (covered cells kept, anchor widened): same lines, and `cells` never overlap (VERIFY LOW-1)", () => {
    const spans = [{ r: 0, c: 1, rs: 1, cs: 2 }, { r: 2, c: 3, rs: 2, cs: 1 }];
    // evidence.ts engineTables: EVERY grid CELL, each with its own box; the anchor gets rs/cs and the union box
    const cells: EngineTextractCell[] = [];
    for (let r = 0; r + 1 < YS.length; r++) {
      for (let c = 0; c + 1 < XS.length; c++) {
        const s = spans.find((p) => p.r === r && p.c === c);
        const rs = s?.rs ?? 1;
        const cs = s?.cs ?? 1;
        cells.push({ r, c, rs, cs, b: [XS[c], YS[r], XS[c + cs], YS[r + rs]], ...(r === 0 ? { hdr: true as const } : {}) });
      }
    }
    const h = textractCellsColumns([{ b: [XS[0], YS[0], XS[4], YS[5]], cells }], [0.09, 0.19, 0.51, 0.31]);
    expect(h.colLines).toEqual(XS);
    expect(h.rowLines).toEqual(YS);
    expect(h.headerRows).toBe(1);
    expect(h.cells?.length).toBe(18); // 20 grid cells, 2 covered by the anchors
    expect(h.cells?.some((c) => (c.r === 0 && c.c === 2) || (c.r === 3 && c.c === 3))).toBe(false);
    expect(h.cells?.filter((c) => c.header).length).toBe(3);
    const occupied = new Set<string>();
    for (const c of h.cells ?? []) for (let r = c.r; r < c.r + c.rs; r++) for (let k = c.c; k < c.c + c.cs; k++) {
      expect(occupied.has(`${r}:${k}`), `${r}:${k} listed twice`).toBe(false);
      occupied.add(`${r}:${k}`);
    }
    expect(occupied.size).toBe(20);
  });

  it("a box over part of the table re-indexes rows", () => {
    const t = table(XS, YS, { spans: [{ r: 2, c: 3, rs: 2, cs: 1 }] });
    // rows 3..4 only: the span (rows 2-3) is centred at y .26, above the box
    const h = textractCellsColumns([t], [0.09, 0.265, 0.51, 0.31]);
    expect(h.rowLines).toEqual([0.26, 0.28, 0.3]);
    expect(h.cells?.every((c) => c.r >= 0 && c.r < 2 && c.rs === 1)).toBe(true);
    expect(h.headerRows).toBe(0);
  });

  it("a span reaching past the box is clipped to the rows present", () => {
    const t = table(XS, YS, { spans: [{ r: 2, c: 3, rs: 2, cs: 1 }] });
    // rows 0..2: the span's centre (.26) is in the box, its second row (centre .27) is not
    const h = textractCellsColumns([t], [0.09, 0.19, 0.51, 0.262]);
    expect(h.rowLines).toEqual([0.2, 0.22, 0.24, 0.26]);
    const anchor = h.cells?.find((c) => c.r === 2 && c.c === 3);
    expect(anchor?.rs).toBe(1);
  });

  it("picks the table covering the box (≥ .3), else fails without a vote", () => {
    const a = table([0.1, 0.2], [0.1, 0.2]);
    const b = table(XS, YS);
    expect(pickTextractTable([a, b], [0.1, 0.2, 0.5, 0.3])?.index).toBe(1);
    expect(textractCellsColumns([a], [0.6, 0.6, 0.9, 0.9]).error).toMatch(/covers/);
    expect(textractCellsColumns([], [0, 0, 1, 1]).error).toMatch(/no Textract TABLE/);
  });

  it("is deterministic (E-7)", () => {
    const t = table(XS, YS, { hdrRows: 2 });
    expect(textractCellsColumns([t], [0.09, 0.19, 0.51, 0.31])).toEqual(textractCellsColumns([t], [0.09, 0.19, 0.51, 0.31]));
  });
});

describe("rulings (pure half)", () => {
  const crop: BboxMinMax = [0.2, 0.4, 0.6, 0.8];
  it("maps crop-normalised lines onto the page and proposes both axes", () => {
    const h = rulingsHypothesis({ rows: [0, 0.25, 0.5, 1], cols: [0, 0.5, 1], confidence: 0.7 }, crop);
    expect(h.colLines.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.2, 0.4, 0.6]);
    expect(h.rowLines?.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.4, 0.5, 0.6, 0.8]);
    expect(h.conf).toBe(0.7);
  });
  it("uses the whole-pixel crop the script reports, drops lines outside the box, needs 2 lines per axis", () => {
    const h = rulingsHypothesis({ rows: [0.5], cols: [0, 0.5, 1], confidence: 0.5, crop: [0.2, 0.4, 0.4, 0.8] }, crop, [0.2, 0.4, 0.35, 0.8]);
    expect(h.colLines).toEqual([0.2, 0.30000000000000004]);
    expect(h.rowLines).toBeUndefined();
    expect(rulingsHypothesis({ rows: [], cols: [], confidence: 0 }, crop).error).toMatch(/no ruled lines/);
    expect(rulingsHypothesis({ rows: [], cols: [], confidence: 0, error: "boom" }, crop).error).toBe("boom");
  });
});

describe("primitive-grid columns", () => {
  const box: BboxMinMax = [0.1, 0.1, 0.5, 0.5];
  it("vertical_area edges inside the box are separators; grid / horizontal_area are not", () => {
    const h = primitiveGridColumns([
      { b: [0.2, 0.12, 0.3, 0.48], cls: "vertical_area" },
      { b: [0.3005, 0.12, 0.4, 0.48], cls: "vertical_area" },
      { b: [0.1, 0.1, 0.5, 0.5], cls: "grid" },
      { b: [0.1, 0.2, 0.5, 0.25], cls: "horizontal_area" },
      { b: [0.6, 0.1, 0.7, 0.5], cls: "vertical_area" }, // outside
      { b: [0.25, 0.1, 0.27, 0.15], cls: "vertical_area" }, // too short
    ], box);
    expect(h.error).toBeUndefined();
    expect(h.colLines.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.1, 0.2, 0.3003, 0.4, 0.5]);
  });
  it("no strip → no vote", () => {
    expect(primitiveGridColumns([], box).error).toMatch(/no vertical_area/);
  });
});
