// @vitest-environment node
// [table pipeline WP-3.J] The automatic notes stages on the paragraph engine under `tools.notesAuto` (PLAN §3.5):
// A03 (`classifyTextRegions` notes grids) and A12 (`analyzePageIntelligence` note blocks). Synthetic fixtures only
// (rule 12). Expected values were measured first (logs/TP-3/WP-3.J-probe{1,2}.log), not guessed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { linesFromEvidence } from "@/lib/parse-engine/paragraphs/segment";
import {
  engineNoteBlocks,
  engineNotesGrid,
  isNotesAutoEngine,
  notesAutoPage,
  NOTES_AUTO_LINE_SPLIT_GAP,
} from "@/lib/specnote-parser/paragraph-auto";
import { buildPageEvidence, EVIDENCE_LINE_SPLIT_GAP } from "@/server/services/parse-engine/evidence";
import type { BboxLTWH, TextractPageData } from "@/types";

type Ltwh = [number, number, number, number];
const FIXTURES = join(process.cwd(), "src/lib/parse-engine/__fixtures__");
function fixture(id: string): { td: TextractPageData; region: Ltwh; truth: { key: string; text: string }[] } {
  const f = JSON.parse(readFileSync(join(FIXTURES, `${id}.synthetic.json`), "utf8"));
  const [x0, y0, x1, y1] = f.region as number[];
  return { td: f.page as TextractPageData, region: [x0, y0, x1 - x0, y1 - y0], truth: f.truth.items };
}
const keyedTruth = (truth: { key: string; text: string }[]) =>
  truth.filter((i) => i.key !== "").map((i) => [i.key.replace(/^\(|[.)]$/g, ""), i.text]);

/** A synthetic Textract page: one LINE per row, words laid out left to right (height h). */
function page(rows: [string, number, number][], h = 0.0075): TextractPageData {
  const lines: TextractPageData["lines"] = [];
  const words: TextractPageData["words"] = [];
  for (const [text, x, y] of rows) {
    let c = x;
    const ws = text.split(/\s+/).filter(Boolean).map((t) => {
      const w = t.length * 0.0042;
      const bbox: Ltwh = [c, y, w, h];
      c += w + 0.002;
      return { text: t, confidence: 99, bbox };
    });
    words.push(...ws);
    lines.push({ text, confidence: 99, words: ws, bbox: [x, y, c - 0.002 - x, h] });
  }
  return { lines, words };
}

const NOTES_FIXTURES = ["syn-notes-wrapped-hanging", "syn-notes-subblocks", "syn-notes-dimension-start", "syn-notes-two-column",
  "syn-notes-single-line", "syn-notes-lettered", "syn-notes-paren-keys", "syn-notes-preamble", "syn-notes-wrapped-tight-gap",
  "syn-kv-abbrev", "syn-kv-abbrev-same-line", "syn-sched-basic"];

describe("paragraph-auto: lines and the option", () => {
  it("splits lines with the evidence loader's gap, and builds the same lines a workspace parse reads", () => {
    expect(NOTES_AUTO_LINE_SPLIT_GAP).toBe(EVIDENCE_LINE_SPLIT_GAP);
    for (const id of ["syn-notes-two-column", "syn-kv-abbrev", "syn-spec-section"]) {
      const { td } = fixture(id);
      const ev = buildPageEvidence({
        pageNumber: 1, drawingNumber: null, keynotes: null, csiCodes: null, words: td.words, tables: null, layout: null,
        pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
      });
      expect(notesAutoPage(td).lines).toEqual(linesFromEvidence(ev));
    }
  });

  it("reads stored LAYOUT blocks and drops malformed ones; no OCR gives no lines", () => {
    const td = { ...page([["1. ZFKMP", 0.1, 0.1]]), layout: [{ k: "list", b: [0.1, 0.1, 0.3, 0.2] }, { k: "bogus", b: [0, 0, 1, 1] }, { k: "text", b: [0, 0] }] };
    expect(notesAutoPage(td as TextractPageData).layout).toEqual([{ k: "list", b: [0.1, 0.1, 0.3, 0.2] }]);
    expect(notesAutoPage(null)).toEqual({ lines: [] });
  });

  it("is on only for notesAuto = engine", () => {
    expect(isNotesAutoEngine({ notesAuto: "engine" })).toBe(true);
    expect(isNotesAutoEngine({ notesAuto: "legacy" })).toBe(false);
    expect(isNotesAutoEngine({})).toBe(false);
    expect(isNotesAutoEngine(undefined)).toBe(false);
  });
});

describe("A03 binders on the segmenter (engineNotesGrid)", () => {
  it("a wrapped numbered region reads one row per note with closed row bands (K31, C04-13)", () => {
    for (const id of ["syn-notes-wrapped-hanging", "syn-notes-wrapped-tight-gap", "syn-notes-single-line"]) {
      const { td, region, truth } = fixture(id);
      const grid = engineNotesGrid(notesAutoPage(td), region, "notes-numbered")!;
      expect(grid.headers).toEqual(["Key", "Note"]);
      expect(grid.rows.filter((r) => r.Key !== "").map((r) => [r.Key, r.Note])).toEqual(keyedTruth(truth));
      expect(grid.rowBoundaries).toHaveLength(grid.rows.length + 1);
    }
  });

  it("2.5 MM is text, not note 2 (C04-10 / K35)", () => {
    const { td, region, truth } = fixture("syn-notes-dimension-start");
    const grid = engineNotesGrid(notesAutoPage(td), region, "notes-numbered")!;
    expect(grid.rows.map((r) => r.Key)).toEqual(["1", "2", "3", "4"]);
    expect(grid.rows.map((r) => [r.Key, r.Note])).toEqual(keyedTruth(truth));
  });

  it("a sub-block header resets the numbering (C04-10): 1-5 then 1-3", () => {
    const { td, region } = fixture("syn-notes-subblocks");
    const grid = engineNotesGrid(notesAutoPage(td), region, "notes-numbered")!;
    expect(grid.rows.map((r) => r.Key)).toEqual(["1", "2", "3", "4", "5", "1", "2", "3"]);
  });

  it("two side-by-side note columns read 1-12 in order (C04-08)", () => {
    const { td, region } = fixture("syn-notes-two-column");
    const grid = engineNotesGrid(notesAutoPage(td), region, "notes-numbered")!;
    expect(grid.rows.map((r) => r.Key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  });

  it("a key-value legend with separate key and value LINEs reads as pairs, never key-only rows (C04-04 / K09)", () => {
    for (const id of ["syn-kv-abbrev", "syn-kv-abbrev-same-line"]) {
      const { td, region, truth } = fixture(id);
      const grid = engineNotesGrid(notesAutoPage(td), region, "notes-key-value")!;
      const pairs = grid.rows.filter((r) => r.Key !== "");
      expect(pairs.map((r) => [r.Key, r.Note])).toEqual(keyedTruth(truth));
      expect(pairs.every((r) => r.Note !== "")).toBe(true);
    }
  });

  it("no keyed paragraph → no grid (the legacy binders' no-rows outcome)", () => {
    const { td, region } = fixture("syn-kv-abbrev");
    expect(engineNotesGrid(notesAutoPage(td), region, "notes-numbered")).toBeUndefined();
    expect(engineNotesGrid(notesAutoPage(td), [0.01, 0.01, 0.01, 0.01] as BboxLTWH, "notes-numbered")).toBeUndefined();
  });
});

describe("classifyTextRegions under notesAuto", () => {
  it("legacy is the default; the engine changes only the notes grids, never the regions", () => {
    let notesRegions = 0;
    for (const id of NOTES_FIXTURES) {
      const { td } = fixture(id);
      const none = classifyTextRegions(td, []);
      const legacy = classifyTextRegions(td, [], { notesAuto: "legacy" });
      const engine = classifyTextRegions(td, [], { notesAuto: "engine" });
      expect(legacy).toEqual(none);
      expect(engine.map(({ grid: _g, ...r }) => r)).toEqual(legacy.map(({ grid: _g, ...r }) => r));
      for (const r of engine) {
        if (r.type !== "notes-numbered" && r.type !== "notes-key-value") {
          expect(r.grid).toEqual(legacy.find((l) => l.id === r.id)?.grid);
          continue;
        }
        notesRegions++;
        expect(r.grid).toEqual(engineNotesGrid(notesAutoPage(td), r.bbox, r.type));
      }
    }
    expect(notesRegions).toBeGreaterThanOrEqual(3); // single-line (numbered), kv-abbrev and sched-basic (key-value)
  });

  it("the classifier's key-value legend is bound as pairs under the engine (C04-04 through A03)", () => {
    const { td, truth } = fixture("syn-kv-abbrev");
    const [legacy] = classifyTextRegions(td, []);
    const [engine] = classifyTextRegions(td, [], { notesAuto: "engine" });
    expect(engine.type).toBe("notes-key-value");
    expect(engine.grid!.rows.filter((r) => r.Key !== "").map((r) => [r.Key, r.Note])).toEqual(keyedTruth(truth));
    expect(legacy.grid!.headers).toEqual(["Key", "Value"]); // the legacy shape stays the legacy default
  });
});

describe("A12 note blocks on the segmenter (analyzePageIntelligence)", () => {
  const p = 0.0135; // a line pitch of 1.8 line heights: the legacy continuation test (< 1.5 h) fails on every wrap
  const wrapped = page([["GENERAL NOTES", 0.1, 0.1], ["1. ZFKMP SNIEV HTJWZ DCZRP", 0.1, 0.1 + 2 * p], ["EJBC ZYSFM QTMYBW", 0.116, 0.1 + 3 * p],
    ["2. NEKQKA KXBDUU NJIUT", 0.1, 0.1 + 4 * p], ["UJYH YTJN HFBLJ", 0.116, 0.1 + 5 * p], ["3. LOZC QEISL MVN", 0.1, 0.1 + 6 * p]]);

  it("a block no longer ends at the first wrapped line (K31)", () => {
    expect(analyzePageIntelligence(null, wrapped, []).noteBlocks).toBeUndefined(); // legacy: 1 note, then the block ends
    const blocks = analyzePageIntelligence(null, wrapped, [], { notesAuto: "engine" }).noteBlocks!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe("GENERAL NOTES");
    expect(blocks[0].noteCount).toBe(3);
    expect(blocks[0].notes).toEqual([
      "1. ZFKMP SNIEV HTJWZ DCZRP EJBC ZYSFM QTMYBW",
      "2. NEKQKA KXBDUU NJIUT UJYH YTJN HFBLJ",
      "3. LOZC QEISL MVN",
    ]);
    const [x, y, w, h] = blocks[0].bbox;
    expect(x).toBeCloseTo(0.1, 6);
    expect(y).toBeCloseTo(0.1, 6);
    expect(x + w).toBeGreaterThan(0.2);
    expect(y + h).toBeCloseTo(0.1 + 6 * p + 0.0075, 6);
  });

  it("a sub-block header resets the numbering: two blocks, not one block of 8 (K35)", () => {
    const { td } = fixture("syn-notes-subblocks");
    expect(analyzePageIntelligence(null, td, []).noteBlocks!.map((b) => [b.title, b.noteCount])).toEqual([["GENERAL NOTES", 8]]);
    expect(analyzePageIntelligence(null, td, [], { notesAuto: "engine" }).noteBlocks!.map((b) => [b.title, b.noteCount]))
      .toEqual([["GENERAL NOTES", 5], ["ELECTRICAL NOTES", 3]]);
  });

  it("keeps the legacy blocks where legacy was right, and reads (1)-style keys legacy missed", () => {
    for (const id of ["syn-notes-wrapped-hanging", "syn-notes-single-line", "syn-notes-two-column", "syn-notes-dimension-start"]) {
      const { td } = fixture(id);
      expect(analyzePageIntelligence(null, td, [], { notesAuto: "engine" }).noteBlocks).toEqual(analyzePageIntelligence(null, td, []).noteBlocks);
    }
    const { td } = fixture("syn-notes-paren-keys");
    expect(analyzePageIntelligence(null, td, []).noteBlocks).toBeUndefined();
    expect(analyzePageIntelligence(null, td, [], { notesAuto: "engine" }).noteBlocks!.map((b) => b.noteCount)).toEqual([5]);
  });

  it("a bare-digit column (a schedule's numbers) is not a note list; sub-items fold into their note", () => {
    const column = page([["MARK DESCRIPTION", 0.5, 0.5], ["1 ZFKMP SNIEV", 0.5, 0.5 + p], ["2 NEKQKA KXBDUU", 0.5, 0.5 + 2 * p], ["3 LOZC QEISL", 0.5, 0.5 + 3 * p], ["4 MVN MEVMU", 0.5, 0.5 + 4 * p]]);
    expect(analyzePageIntelligence(null, column, [], { notesAuto: "engine" }).noteBlocks).toBeUndefined();
    const sub = page([["1. ZFKMP SNIEV", 0.1, 0.1], ["A. EJBC ZYSFM", 0.116, 0.1 + p], ["B. QTMYBW HTJWZ", 0.116, 0.1 + 2 * p], ["2. NEKQKA KXBDUU", 0.1, 0.1 + 3 * p]]);
    expect(engineNoteBlocks(notesAutoPage(sub))).toEqual([expect.objectContaining({
      title: "NOTES", noteCount: 2, notes: ["1. ZFKMP SNIEV A. EJBC ZYSFM B. QTMYBW HTJWZ", "2. NEKQKA KXBDUU"],
    })]);
  });

  it("the page-wide false-positive guards: one note is not a block, and a headerless list must start at 1 (VERIFY LOW-1)", () => {
    // Measured first: logs/TP-3/WP-3.J-fix-probe-guards.log.
    const list = (keys: string[], header?: string) => page([...(header ? [[header, 0.1, 0.1] as [string, number, number]] : []),
      ...keys.map((k, i) => [`${k} ZFKMP SNIEV HTJWZ`, 0.1, 0.1 + (i + 2) * p] as [string, number, number])]);
    const counts = (td: TextractPageData) => analyzePageIntelligence(null, td, [], { notesAuto: "engine" }).noteBlocks?.map((b) => [b.title, b.noteCount]);
    expect(counts(list(["1."]))).toBeUndefined(); // >= 2 notes
    expect(counts(list(["1."], "GENERAL NOTES"))).toBeUndefined(); // a header does not lift the >= 2 rule
    expect(counts(list(["1.", "2."]))).toEqual([["NOTES", 2]]);
    expect(counts(list(["3.", "4.", "5."]))).toBeUndefined(); // no NOTES header and the first key is not 1
    expect(counts(list(["3.", "4.", "5."], "GENERAL NOTES"))).toEqual([["GENERAL NOTES", 3]]); // the header admits it
    expect(counts(list(["1.", "2.", "3."]))).toEqual([["NOTES", 3]]); // so does a first key of 1
  });

  it("legacy is the default and the other analyses are unchanged; deterministic", () => {
    const { td } = fixture("syn-notes-subblocks");
    const legacy = analyzePageIntelligence("A-101", td, []);
    expect(analyzePageIntelligence("A-101", td, [], { notesAuto: "legacy" })).toEqual(legacy);
    const engine = analyzePageIntelligence("A-101", td, [], { notesAuto: "engine" });
    const { noteBlocks: _a, ...restEngine } = engine;
    const { noteBlocks: _b, ...restLegacy } = legacy;
    expect(restEngine).toEqual(restLegacy);
    expect(JSON.stringify(analyzePageIntelligence("A-101", td, [], { notesAuto: "engine" }))).toBe(JSON.stringify(engine));
  });
});
