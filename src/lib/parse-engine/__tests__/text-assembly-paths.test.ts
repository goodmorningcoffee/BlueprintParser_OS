// [table-pipeline WP-2.B] K07 / U24 / C04-03: every rewired legacy text join reads multi-line cells
// line by line (`lines.assembleText`), headers keep duplicates apart (`uniqueHeaders`, K06), and Notes
// Guided keeps its last note. Probes are pseudo-words; fixtures are the committed synthetic slices with
// their `truth` (what was printed, in reading order). Rule 12: no real drawing text here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import { joinKeynoteIntersections } from "@/lib/legacy-joins/keynote-manual";
import { joinManualCells } from "@/lib/legacy-joins/manual-cells";
import { joinNotesManualCells } from "@/lib/legacy-joins/notes-manual";
import { notesGuidedProposal } from "@/lib/legacy-joins/notes-guided-proposal";
import { runLegacyPath, type LegacySlice } from "@/lib/legacy-joins/legacy-paths";
import { methodOcrPositions } from "@/lib/services/table-parse";
import { parseNotesFromRegion } from "@/lib/specnote-parser";
import { scanClassForTexts } from "@/lib/tag-mapping";
import type { ClientAnnotation, TextractLine, TextractPageData, TextractWord } from "@/types";
import { loadSlices } from "./golden-harness";

type Ltwh = [number, number, number, number];
const W = (text: string, x: number, y: number, w = 0.03, h = 0.01): TextractWord =>
  ({ text, confidence: 99, bbox: [x, y, w, h] as Ltwh }) as TextractWord;

// C02 probe: a two-line cell whose lines start at the same x. x-only read "ALPHA GAMMA BETA DELTA".
const TWO_LINE = [W("ALPHA", 0.1, 0.1, 0.05), W("BETA", 0.16, 0.1, 0.04), W("GAMMA", 0.1, 0.115, 0.05), W("DELTA", 0.16, 0.115, 0.04)];
const TWO_LINE_TEXT = "ALPHA BETA GAMMA DELTA";
const CELL: [number, number, number, number] = [0.09, 0.09, 0.25, 0.14];

describe("K07 probes through every rewired join", () => {
  it("extractCellsFromGrid reads a two-line cell line by line", () => {
    const r = extractCellsFromGrid(TWO_LINE, [0.09, 0.14], [0.09, 0.25]);
    expect(r.rows).toEqual([{ "Column 1": TWO_LINE_TEXT }]);
  });

  it("extractCellsFromGrid keeps one line in x order under 1 % height jitter (C02 y-jitter)", () => {
    const words = [W("QQ", 0.15, 0.196, 0.04, 0.0105), W("RR", 0.195, 0.196, 0.04, 0.0095), W("SS", 0.24, 0.196, 0.03, 0.0098)];
    expect(extractCellsFromGrid(words, [0.19, 0.21], [0.14, 0.3]).rows).toEqual([{ "Column 1": "QQ RR SS" }]);
  });

  it("Table Manual, Keynote Manual and Notes Manual read the same cell line by line", () => {
    expect(joinManualCells(TWO_LINE, [CELL], [CELL], ["NAME"]).rows).toEqual([{ NAME: TWO_LINE_TEXT }]);
    const right: [number, number, number, number] = [0.25, 0.09, 0.4, 0.14];
    const kn = joinKeynoteIntersections([W("K1", 0.3, 0.11, 0.02), ...TWO_LINE], [right, CELL], [[0.09, 0.09, 0.4, 0.14]]);
    expect(kn).toEqual([{ key: "K1", description: TWO_LINE_TEXT }]);
    const nm = joinNotesManualCells([W("1.", 0.03, 0.1, 0.02), ...TWO_LINE], [[0.0, 0.09, 0.09, 0.14], CELL], [[0.0, 0.09, 0.25, 0.14]]);
    expect(nm?.rows).toEqual([{ Key: "1.", Note: TWO_LINE_TEXT }]);
  });

  it("the YOLO class scan (U24) groups a two-line tag by its line-aware text", () => {
    // Two boxes of the same class: the second tag's lower line starts further left (x-only read "YY XX").
    const words = [W("XX", 0.11, 0.1, 0.02, 0.01), W("YY", 0.105, 0.115, 0.03, 0.01), W("XX", 0.51, 0.1, 0.02, 0.01), W("YY", 0.505, 0.115, 0.03, 0.01)];
    const ann = (id: number, x: number) =>
      ({ id, pageNumber: 1, name: "tag_circle", source: "yolo", bbox: [x, 0.095, x + 0.04, 0.13], data: null }) as unknown as ClientAnnotation;
    const scan = scanClassForTexts("tag_circle", undefined, [ann(1, 0.1), ann(2, 0.5)], { 1: { words, lines: [], tables: [] } as unknown as TextractPageData });
    expect(scan.map((r) => [r.text, r.count])).toEqual([["XX YY", 2]]);
  });

  it("conserves words: every word inside a jittered grid lands in exactly one cell", () => {
    const words: TextractWord[] = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 5; c++) {
        for (let l = 0; l < 2; l++) {
          const jitter = ((r * 7 + c * 3 + l) % 5) * 0.0004;
          words.push(W(`w${r}${c}${l}a`, 0.1 + c * 0.1, 0.1 + r * 0.04 + l * 0.015 + jitter, 0.03, 0.01));
          words.push(W(`w${r}${c}${l}b`, 0.14 + c * 0.1, 0.1 + r * 0.04 + l * 0.015 - jitter, 0.03, 0.0095));
        }
      }
    }
    const rows = [0.095, 0.135, 0.175, 0.215, 0.255, 0.295, 0.335];
    const cols = [0.095, 0.195, 0.295, 0.395, 0.495, 0.595];
    const out = extractCellsFromGrid(words, rows, cols).rows.flatMap((r) => Object.values(r).join(" ").split(" ").filter(Boolean));
    expect(out.sort()).toEqual(words.map((w) => w.text).sort());
    // and each cell reads its upper line before its lower line
    const cell = extractCellsFromGrid(words, rows, cols).rows[2]["Column 4"];
    expect(cell).toBe("w230a w230b w231a w231b");
  });
});

describe("K06 duplicate headers keep both columns", () => {
  it("Table Manual: DOOR/FRAME × TYPE/MATERIAL keeps 4 columns", () => {
    const cols: [number, number, number, number][] = [0, 1, 2, 3].map((i) => [0.1 + i * 0.1, 0.1, 0.2 + i * 0.1, 0.2]);
    const words = [W("A1", 0.12, 0.15, 0.02), W("M1", 0.22, 0.15, 0.02), W("A2", 0.32, 0.15, 0.02), W("M2", 0.42, 0.15, 0.02)];
    const g = joinManualCells(words, cols, [[0.1, 0.1, 0.5, 0.2]], ["TYPE", "MATERIAL", "TYPE", "MATERIAL"]);
    expect(g.headers).toEqual(["TYPE", "MATERIAL", "TYPE (2)", "MATERIAL (2)"]);
    expect(g.rows).toEqual([{ TYPE: "A1", MATERIAL: "M1", "TYPE (2)": "A2", "MATERIAL (2)": "M2" }]);
  });

  it("OCR positions: a printed duplicate header gets its own key and its own values", () => {
    const s = fixture("syn-sched-dup-headers");
    const r = methodOcrPositions(s.page.words, s.region);
    const truth = s.truth as { headers: string[]; rows: string[][] };
    expect(new Set(r.headers).size).toBe(r.headers.length);
    expect(r.headers).toHaveLength(truth.headers.length);
    expect(r.rows.map((row) => r.headers.map((h) => row[h]))).toEqual(truth.rows);
  });
});

describe("Notes Guided keeps the last note (C04-03)", () => {
  function noteLine(text: string, x: number, y: number): TextractLine {
    const parts = text.split(" ");
    let c = x;
    const words = parts.map((p) => {
      const w = W(p, c, y, 0.006 * p.length, 0.006);
      c += 0.006 * p.length + 0.003;
      return w;
    });
    return { text, confidence: 99, bbox: [x, y, c - x, 0.006] as Ltwh, words } as TextractLine;
  }

  it("4 two-line notes → 4 rows, each read line by line", () => {
    const lines: TextractLine[] = [];
    const want: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const y = 0.1 + (n - 1) * 0.022;
      lines.push(noteLine(`${n}. QQQ RRR SSS`, 0.1, y), noteLine(`TTT UUU${n}`, 0.115, y + 0.009));
      want.push(`QQQ RRR SSS TTT UUU${n}`);
    }
    const pageData = { lines, words: lines.flatMap((l) => l.words ?? []), tables: [] } as unknown as TextractPageData;
    const region: [number, number, number, number] = [0.09, 0.095, 0.3, 0.2];
    const grid = parseNotesFromRegion(pageData, [region[0], region[1], region[2] - region[0], region[3] - region[1]]);
    expect(grid?.rowBoundaries).toHaveLength(4); // the binders return note tops only
    const { proposedRows, proposedCols } = notesGuidedProposal(grid, region);
    expect(proposedRows).toHaveLength(5);
    expect(proposedRows[4]).toBe(region[3]);
    const out = extractCellsFromGrid(pageData.words, proposedRows, proposedCols);
    expect(out.rows).toHaveLength(4);
    expect(out.rows.map((r) => r[out.headers[out.headers.length - 1]])).toEqual(want);
  });

  it("notesGuidedProposal keeps the empty shapes and never doubles a closed bottom", () => {
    const box: [number, number, number, number] = [0, 0.1, 1, 0.5];
    expect(notesGuidedProposal(null, box)).toEqual({ proposedRows: [], proposedCols: [] });
    expect(notesGuidedProposal({}, box)).toEqual({ proposedRows: [], proposedCols: [] });
    expect(notesGuidedProposal({ rowBoundaries: [0.2, 0.3], colBoundaries: [0, 1] }, box)).toEqual({ proposedRows: [0.2, 0.3, 0.5], proposedCols: [0, 1] });
    expect(notesGuidedProposal({ rowBoundaries: [0.2, 0.5] }, box).proposedRows).toEqual([0.2, 0.5]);
  });
});

// ── the synthetic fixtures' truth through every grid path (multi-line probe shapes) ────────────
const FIXTURE_DIR = join(__dirname, "../__fixtures__");
const SLICES = loadSlices(FIXTURE_DIR, ".synthetic.json") as (LegacySlice & { truth: unknown })[];
function fixture(id: string): LegacySlice & { truth: unknown } {
  const s = SLICES.find((x) => x.id === id);
  if (!s) throw new Error(`fixture ${id} missing`);
  return s;
}
const MULTILINE_GRIDS = ["syn-sched-multiline-top", "syn-sched-multiline-middle", "syn-sched-yjitter-multiline", "syn-sched-textract-multiline"];

describe("multi-line synthetic fixtures read their truth through every grid path", () => {
  for (const id of MULTILINE_GRIDS) {
    it(id, () => {
      const s = fixture(id);
      const truth = s.truth as { type: string; headers: string[]; rows: string[][] };
      expect(truth.type).toBe("grid");
      const valuesOf = (g: { headers: string[]; rows: Record<string, string>[] }) => g.rows.map((r) => g.headers.map((h) => r[h]));
      const manual = runLegacyPath("manual", s) as { headers: string[]; rows: Record<string, string>[] };
      expect(valuesOf(manual)).toEqual(truth.rows);
      const notesManual = runLegacyPath("notes-manual", s) as { headers: string[]; rows: Record<string, string>[] };
      expect(valuesOf(notesManual)).toEqual(truth.rows);
      const keynote = runLegacyPath("keynote-manual", s) as { key: string; description: string }[];
      expect(keynote.map((k) => [k.key, k.description])).toEqual(truth.rows.map((r) => [r[0], r.slice(1).filter(Boolean).join(" ")]));
      const guided = runLegacyPath("guided-extract", s) as { onLines: { headers: string[]; rows: Record<string, string>[] } };
      expect(valuesOf(guided.onLines)).toEqual([truth.headers, ...truth.rows]);
      const kg = runLegacyPath("keynote-guided", s) as { headers: string[]; rows: Record<string, string>[] };
      expect(valuesOf(kg)).toEqual([truth.headers, ...truth.rows]);
    });
  }
});

// ── boundary pins (WP-2.0a verification LOW-2: the goldens use exact-grid boxes only) ──────────
describe("join boundary rules are pinned", () => {
  it("extractCellsFromGrid is half-open: a centre on a shared edge lands in the right/lower cell only", () => {
    const onEdge = W("EDGE", 0.375, 0.375, 0.25, 0.25); // centre (0.5, 0.5)
    const r = extractCellsFromGrid([onEdge], [0.25, 0.5, 0.75], [0.25, 0.5, 0.75]);
    expect(r.rows).toEqual([{ "Column 1": "", "Column 2": "EDGE" }]);
  });

  it("Table Manual is closed: a centre exactly on the column's right edge stays in that column", () => {
    const g = joinManualCells([W("EDGE", 0.375, 0.375, 0.25, 0.25)], [[0.25, 0.25, 0.5, 0.75]], [[0.25, 0.25, 0.5, 0.75]], ["A"]);
    expect(g.rows).toEqual([{ A: "EDGE" }]);
  });

  it("Table Manual: a column exactly 50 % tag-like is the tag column", () => {
    const col: [number, number, number, number] = [0.1, 0.1, 0.2, 0.3];
    const rows: [number, number, number, number][] = [[0.1, 0.1, 0.2, 0.2], [0.1, 0.2, 0.2, 0.3]];
    const g = joinManualCells([W("D-1", 0.12, 0.14, 0.03), W("QQQQQQ", 0.12, 0.24, 0.03)], [col], rows, ["MARK"]);
    expect(g.tagColumn).toBe("MARK");
  });
});

// ── call-site pins (WP-2.0a verification LOW-1): the viewer still reaches the shared joins ─────
describe("viewer call sites use the shared joins", () => {
  const read = (f: string) => readFileSync(join(__dirname, "../../../components/viewer", f), "utf8");
  it.each([
    ["KeynotePanel.tsx", "@/lib/legacy-joins/keynote-manual", "joinKeynoteIntersections("],
    ["KeynotePanel.tsx", "@/lib/ocr-grid-detect", "extractCellsFromGrid("],
    ["ManualParseTab.tsx", "@/lib/legacy-joins/manual-cells", "joinManualCells("],
    ["NotesParser.tsx", "@/lib/legacy-joins/notes-manual", "joinNotesManualCells("],
    ["NotesParser.tsx", "@/lib/ocr-grid-detect", "extractCellsFromGrid("],
    ["GuidedParseTab.tsx", "@/lib/ocr-grid-detect", "extractCellsFromGrid("],
    ["FastManualParseOverlay.tsx", "@/lib/legacy-joins/notes-fast-manual", "fastManualGrid("],
  ])("%s imports %s and calls %s", (file, mod, call) => {
    const src = read(file);
    expect(src).toContain(`from "${mod}"`);
    expect(src.split(call).length - 1).toBeGreaterThanOrEqual(1); // at least one call
  });
});
