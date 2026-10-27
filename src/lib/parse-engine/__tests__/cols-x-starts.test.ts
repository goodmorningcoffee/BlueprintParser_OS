// @vitest-environment node
// [table pipeline WP-3.B] `x-starts` columns: legacy parity with ocr-positions' left-edge finder, and the
// table-relative mode on normal and NARROW tables (the synthetic fixtures scaled to .35 about the region's
// top-left corner: same layout, smaller text, so ocr-positions' fixed .015 page gap merges columns).
// Truth = each fixture's `guided.cols` (its printed column lines). Private real slices: parity only, ids only,
// skipped with a logged reason when absent (PLAN §1.6 rule 12).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { methodOcrPositions } from "@/lib/services/table-parse";
import { ltwhToMinMax } from "@/lib/parse-engine/geometry";
import { bandIndex } from "@/lib/parse-engine/cells";
import { tableRelativeGap, xStartColumns } from "@/lib/parse-engine/cols/x-starts";
import type { ColWord } from "@/lib/parse-engine/types-cols";
import type { BboxMinMax } from "@/lib/parse-engine/types";
import type { TextractWord } from "@/types";

const ROOT = resolve(__dirname, "../../../..");
const FIXTURES = join(ROOT, "src/lib/parse-engine/__fixtures__");
const PRIVATE = resolve(process.env.BP_PRIVATE_GOLD_DIR ?? join(ROOT, "../../gitignore/projects/table_pipeline/fixtures_private"), "slices");

interface Fx { id: string; kind: string; region: BboxMinMax; page: { words: TextractWord[] }; guided: { rows: number[]; cols: number[] } }
const load = (dir: string, pred: (f: string) => boolean): Fx[] =>
  readdirSync(dir).filter(pred).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fx).filter((fx) => Array.isArray(fx.region));
const synthetic = load(FIXTURES, (f) => f.endsWith(".synthetic.json") && !f.startsWith("legacy"));
const words = (fx: Fx): ColWord[] => fx.page.words.map((w) => ({ t: w.text, b: ltwhToMinMax(w.bbox) }));

/** Share of the words inside the truth grid that land in the same column under `lines` as under the truth (0 when the counts differ). */
function wordAccuracy(ws: readonly ColWord[], region: BboxMinMax, truthCols: readonly number[], truthRows: readonly number[], lines: readonly number[]): number {
  let ok = 0;
  let n = 0;
  for (const w of ws) {
    const cx = (w.b[0] + w.b[2]) / 2;
    const cy = (w.b[1] + w.b[3]) / 2;
    if (cy < truthRows[0] || cy > truthRows[truthRows.length - 1] || cx < region[0] || cx > region[2] || cy < region[1] || cy > region[3]) continue;
    const t = bandIndex(cx, truthCols);
    if (t < 0) continue;
    n++;
    if (lines.length === truthCols.length && bandIndex(cx, lines) === t) ok++;
  }
  return n ? ok / n : 0;
}

/** The fixture scaled by `k` about the region's top-left corner (words, region and truth lines). */
function scaled(fx: Fx, k: number): { ws: ColWord[]; region: BboxMinMax; cols: number[]; rows: number[] } {
  const [x0, y0] = fx.region;
  const sx = (x: number): number => x0 + (x - x0) * k;
  const sy = (y: number): number => y0 + (y - y0) * k;
  return {
    ws: words(fx).map((w) => ({ t: w.t, b: [sx(w.b[0]), sy(w.b[1]), sx(w.b[2]), sy(w.b[3])] as BboxMinMax })),
    region: [sx(fx.region[0]), sy(fx.region[1]), sx(fx.region[2]), sy(fx.region[3])],
    cols: fx.guided.cols.map(sx),
    rows: fx.guided.rows.map(sy),
  };
}

// MEASURED 2026-10-27 on this branch: table-relative gets the column count and ≥ .93 of the words right on
// these 37 of 44 fixtures at full size AND at .35; legacy gets none of them at .35. The other 7 are not one
// grid (two side-by-side blocks, two-column notes, spec prose, a key column of symbols only, single-line notes).
const TABLE_RELATIVE_OK = [
  "syn-keynote-basic", "syn-keynote-multiline", "syn-keynote-shapes", "syn-keynote-sheet-keys", "syn-kv-abbrev-same-line",
  "syn-kv-abbrev", "syn-notes-dimension-start", "syn-notes-keynote-bubbles", "syn-notes-lettered", "syn-notes-paren-keys",
  "syn-notes-preamble", "syn-notes-subblocks", "syn-notes-wrapped-hanging", "syn-notes-wrapped-tight-gap", "syn-sched-basic",
  "syn-sched-center-align", "syn-sched-dup-headers", "syn-sched-ef-tags", "syn-sched-long", "syn-sched-multiline-middle",
  "syn-sched-multiline-top", "syn-sched-no-header", "syn-sched-row-lines", "syn-sched-section-rows", "syn-sched-shapes-centred-3line",
  "syn-sched-shapes-classical-dotted", "syn-sched-shapes-hex", "syn-sched-shapes-tall-last", "syn-sched-sparse",
  "syn-sched-textract-header-row", "syn-sched-textract-merged", "syn-sched-textract-multiline", "syn-sched-two-tier", "syn-sched-wide",
  "syn-sched-yjitter-multiline", "syn-sched-yjitter", "syn-spec-section",
];

function parityMismatches(fixtures: readonly Fx[]): { compared: number; bad: string[] } {
  let compared = 0;
  const bad: string[] = [];
  for (const fx of fixtures) {
    const legacy = methodOcrPositions(fx.page.words, fx.region);
    const mine = xStartColumns(words(fx), fx.region, { mode: "legacy" });
    if (legacy.colBoundaries) {
      compared++;
      if (JSON.stringify(mine.colLines) !== JSON.stringify(legacy.colBoundaries)) bad.push(fx.id);
    } else if (legacy.error && /^(too few words|too few row clusters|no stable column)/.test(legacy.error)) {
      compared++;
      if (mine.error !== legacy.error) bad.push(`${fx.id} (error)`);
    }
  }
  return { compared, bad };
}

describe("x-starts legacy mode = ocr-positions' left-edge columns", () => {
  it("is byte-equal on every synthetic fixture where ocr-positions yields columns or a column-stage error", () => {
    const { compared, bad } = parityMismatches(synthetic);
    expect(bad).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(40);
  });

  it("logs whether the private slices are present, and is byte-equal on them (ids only)", () => {
    if (!existsSync(PRIVATE)) {
      console.info(`[cols-x-starts] private parity SKIPPED: no slices at ${PRIVATE} (real slices never enter BP2)`);
      return;
    }
    const fixtures = load(PRIVATE, (f) => /^prv-.*\.json$/.test(f));
    const { compared, bad } = parityMismatches(fixtures);
    console.info(`[cols-x-starts] private parity: ${compared} slices compared, ${bad.length} mismatched`);
    expect(bad).toEqual([]);
  });
});

describe("x-starts table-relative mode", () => {
  const byId = new Map(synthetic.map((fx) => [fx.id, fx]));

  it("the gap is max(.003, .013 × width)", () => {
    expect(tableRelativeGap(1)).toBeCloseTo(0.013, 12);
    expect(tableRelativeGap(0.4)).toBeCloseTo(0.0052, 12);
    expect(tableRelativeGap(0.1)).toBe(0.003);
    expect(tableRelativeGap(Number.NaN)).toBe(0.003);
  });

  for (const k of [1, 0.35]) {
    it(`gets the column count and ≥ 90 % of the words right on the single-grid fixtures (scale ${k})`, () => {
      const misses: string[] = [];
      for (const id of TABLE_RELATIVE_OK) {
        const fx = byId.get(id);
        expect(fx, id).toBeDefined();
        const s = scaled(fx!, k);
        const h = xStartColumns(s.ws, s.region);
        const acc = wordAccuracy(s.ws, s.region, s.cols, s.rows, h.colLines);
        if (h.colLines.length !== s.cols.length || acc < 0.9) misses.push(`${id} cols ${h.colLines.length - 1}/${s.cols.length - 1} acc ${acc.toFixed(2)}`);
      }
      expect(misses).toEqual([]);
    });
  }

  it("narrow tables: the legacy fixed gap merges columns on every one of them, the table-relative gap does not", () => {
    const legacyRight = TABLE_RELATIVE_OK.filter((id) => {
      const s = scaled(byId.get(id)!, 0.35);
      const h = xStartColumns(s.ws, s.region, { mode: "legacy" });
      return h.colLines.length === s.cols.length && wordAccuracy(s.ws, s.region, s.cols, s.rows, h.colLines) >= 0.9;
    });
    expect(legacyRight).toEqual([]);
  });

  it("puts each line in the gutter, outer lines on the box", () => {
    const fx = byId.get("syn-sched-basic")!;
    const h = xStartColumns(words(fx), fx.region);
    expect(h.error).toBeUndefined();
    expect(h.colLines[0]).toBe(fx.region[0]);
    expect(h.colLines[h.colLines.length - 1]).toBe(fx.region[2]);
    // every inner line crosses no word of the box
    const ws = words(fx).filter((w) => (w.b[1] + w.b[3]) / 2 >= fx.region[1] && (w.b[1] + w.b[3]) / 2 <= fx.region[3]);
    for (const x of h.colLines.slice(1, -1)) expect(ws.filter((w) => w.b[0] < x && w.b[2] > x)).toEqual([]);
  });

  it("is deterministic and independent of word order (E-7)", () => {
    for (const id of ["syn-sched-basic", "syn-sched-two-tier", "syn-notes-wrapped-hanging"]) {
      const fx = byId.get(id)!;
      const ws = words(fx);
      const a = xStartColumns(ws, fx.region);
      expect(xStartColumns(ws, fx.region)).toEqual(a);
      const shuffled = ws.map((w, i) => ({ w, k: (i * 7919) % ws.length })).sort((p, q) => p.k - q.k).map((p) => p.w);
      expect(xStartColumns(shuffled, fx.region)).toEqual(a);
    }
  });

  it("fails without a vote on an empty or invalid box (R1)", () => {
    expect(xStartColumns([], [0, 0, 1, 1]).error).toMatch(/too few words/);
    expect(xStartColumns([], [0.5, 0, 0.4, 1]).error).toBe("invalid box");
    expect(xStartColumns([], [0.5, 0, 0.4, 1]).colLines).toEqual([]);
  });
});
