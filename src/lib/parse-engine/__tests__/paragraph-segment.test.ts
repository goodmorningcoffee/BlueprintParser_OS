// @vitest-environment node
// [table pipeline WP-3.C] The paragraph segmenter (K31–K35, K09, K33) on the WP-2.0a synthetic fixtures
// and on inline pseudo-word probes (rule 12: no real drawing text).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ltwhToMinMax } from "../geometry";
import { zStructureParagraphDoc } from "../schema";
import { linesFromEvidence, segmentParagraphs, segmentParagraphsDetailed } from "../paragraphs/segment";
import type { BboxMinMax, EngineLayoutBlock, EnginePageEvidence, StructureParagraphDoc } from "../types";
import type { SegmentLine, SegmentRequest } from "../types-paragraphs";

type Ltwh = [number, number, number, number];
interface Fixture {
  id: string;
  region: BboxMinMax;
  page: { lines: { text: string; bbox: Ltwh; words: { text: string; bbox: Ltwh }[] }[] };
  truth: { items: { key: string; text: string }[] };
}

const FIXTURES = join(process.cwd(), "src/lib/parse-engine/__fixtures__");
function fixture(id: string): { lines: SegmentLine[]; bbox: BboxMinMax; truth: Fixture["truth"]["items"] } {
  const f = JSON.parse(readFileSync(join(FIXTURES, `${id}.synthetic.json`), "utf8")) as Fixture;
  const lines: SegmentLine[] = f.page.lines.map((l) => ({
    text: l.text,
    b: ltwhToMinMax(l.bbox),
    words: l.words.map((w) => ({ t: w.text, b: ltwhToMinMax(w.bbox) })),
  }));
  return { lines, bbox: f.region, truth: f.truth.items };
}

/** One OCR LINE at (x, y): words laid out left to right (height 0.0075, gap 0.002). */
function line(text: string, x: number, y: number, h = 0.0075): SegmentLine {
  const parts = text.split(/\s+/).filter(Boolean);
  let c = x;
  const words = parts.map((p) => {
    const w = p.length * 0.0042;
    const b: BboxMinMax = [c, y, c + w, y + h];
    c += w + 0.002;
    return { t: p, b };
  });
  return { text, b: [x, y, c - 0.002, y + h], words };
}

/** Keyed paragraphs as `[key, text]`, in order. */
const keyed = (doc: StructureParagraphDoc) => doc.paragraphs.filter((p) => p.key !== null).map((p) => [p.key, p.text]);
const stripKey = (k: string) => k.replace(/^\(|[.)]$/g, "");

describe("segmentParagraphs on the synthetic fixtures", () => {
  const NOTES = ["syn-notes-wrapped-hanging", "syn-notes-wrapped-tight-gap", "syn-notes-single-line", "syn-notes-lettered", "syn-notes-paren-keys", "syn-notes-keynote-bubbles"];

  for (const id of NOTES) {
    it(`${id}: every keyed truth item is one paragraph with its wrapped lines (K31)`, () => {
      const { lines, bbox, truth } = fixture(id);
      const doc = segmentParagraphs({ lines, bbox });
      const want = truth.filter((t) => t.key !== "").map((t) => [stripKey(t.key), t.text]);
      expect(keyed(doc)).toEqual(want);
      expect(doc.kind).toBe("notes");
      expect(zStructureParagraphDoc.parse(doc)).toEqual(doc);
    });
  }

  it("6 wrapped notes → 6 paragraphs with lineCount > 1, and the heading is the title and the block header", () => {
    const { lines, bbox } = fixture("syn-notes-wrapped-hanging");
    const doc = segmentParagraphs({ lines, bbox });
    expect(doc.paragraphs).toHaveLength(6);
    expect(doc.paragraphs.every((p) => p.lineCount >= 2)).toBe(true);
    expect(doc.paragraphs.map((p) => p.keyPath)).toEqual([["1"], ["2"], ["3"], ["4"], ["5"], ["6"]]);
    expect(doc.paragraphs.every((p) => p.depth === 0 && p.keyNorm === p.key)).toBe(true);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]).toMatchObject({ id: "b1", header: "GENERAL NOTES", headerNorm: "GENERAL NOTES" });
    expect(doc.title).toEqual({ text: "GENERAL NOTES", src: "header-band", conf: 0.9 });
    expect(doc.paragraphs.every((p) => p.blockId === "b1")).toBe(true);
    expect(doc.sources.segment).toEqual(["ocr-lines"]);
  });

  it("`2.5 MM` and `1:50` at a line start are text, not keys (K35)", () => {
    const { lines, bbox, truth } = fixture("syn-notes-dimension-start");
    const doc = segmentParagraphs({ lines, bbox });
    expect(keyed(doc)).toEqual(truth.map((t) => [stripKey(t.key), t.text]));
    expect(doc.paragraphs.map((p) => p.key)).toEqual(["1", "2", "3", "4"]);
    expect(doc.paragraphs[0].text).toContain("2.5 GE");
    expect(doc.paragraphs[2].text).toContain("1:50");
  });

  it("'see note 4 …' and 'Notes: …' do not open a header; the spec hierarchy is kept (K34)", () => {
    const { lines, bbox } = fixture("syn-spec-sentence-header-trap");
    const doc = segmentParagraphs({ lines, bbox });
    expect(doc.kind).toBe("spec");
    expect(doc.spec).toEqual({ section: "06 10 00" });
    expect(doc.blocks.map((b) => b.headerNorm)).toEqual(["SECTION 06 10 00 ZFKMP"]);
    expect(doc.paragraphs.map((p) => [p.key, p.keyPath.join("."), p.depth])).toEqual([
      ["1.01", "1.01", 0],
      ["A", "1.01.A", 1],
      ["B", "1.01.B", 1],
      ["1.02", "1.02", 0],
    ]);
    expect(doc.paragraphs[1].text.startsWith("see note 4")).toBe(true);
    expect(doc.paragraphs[2].text.startsWith("Notes:")).toBe(true);
  });

  it("sub-block headers reset numbering: GENERAL NOTES 1-5 then ELECTRICAL NOTES 1-3 (K35)", () => {
    const { lines, bbox } = fixture("syn-notes-subblocks");
    const doc = segmentParagraphs({ lines, bbox });
    expect(doc.blocks.map((b) => b.header)).toEqual(["GENERAL NOTES", "ELECTRICAL NOTES"]);
    const byBlock = doc.blocks.map((b) => doc.paragraphs.filter((p) => p.blockId === b.id).map((p) => p.key));
    expect(byBlock).toEqual([["1", "2", "3", "4", "5"], ["1", "2", "3"]]);
    expect(doc.paragraphs).toHaveLength(8);
  });

  it("two-column notes read 1-6 then 7-12, monotonic, and box slack does not kill the split (K33)", () => {
    const { lines, bbox, truth } = fixture("syn-notes-two-column");
    const tight = segmentParagraphsDetailed({ lines, bbox });
    expect(tight.columns).toHaveLength(2);
    expect(tight.doc.paragraphs.map((p) => p.key)).toEqual(truth.map((t) => stripKey(t.key)));
    expect(keyed(tight.doc)).toEqual(truth.map((t) => [stripKey(t.key), t.text]));
    expect(tight.doc.quality.flags).toContain("multi-column");
    // the user drags a generous box: an empty run at each edge is slack, not a gutter
    const slack: BboxMinMax = [bbox[0] - 0.15, bbox[1] - 0.02, bbox[2] + 0.06, bbox[3] + 0.03];
    const loose = segmentParagraphsDetailed({ lines, bbox: slack });
    expect(loose.columns).toHaveLength(2);
    expect(loose.doc.paragraphs.map((p) => p.key)).toEqual(truth.map((t) => stripKey(t.key)));
  });

  it("dense two-column spec: PART 2 in the right column opens a block; articles run 1.01-1.04, 2.01-2.04", () => {
    const { lines, bbox } = fixture("syn-spec-multicolumn-dense");
    const r = segmentParagraphsDetailed({ lines, bbox });
    expect(r.columns).toHaveLength(2);
    expect(r.doc.kind).toBe("spec");
    expect(r.doc.blocks.map((b) => b.headerNorm)).toEqual(["SECTION 07 92 00 ZFKMP", "PART 1 GENERAL", "PART 2 PRODUCTS"]);
    expect(r.doc.paragraphs.map((p) => p.key)).toEqual(["1.01", "1.02", "1.03", "1.04", "2.01", "2.02", "2.03", "2.04"]);
    // the distractor lines outside the region are ignored
    expect(r.assignment.every((a) => a.line < lines.length)).toBe(true);
    expect(r.assignment).toHaveLength(lines.filter((l) => l.b[1] > bbox[1] && l.b[3] < bbox[3]).length);
  });

  it("spec section fixture: SECTION title, PART blocks, articles with lettered paragraphs and END OF SECTION", () => {
    const { lines, bbox } = fixture("syn-spec-section");
    const doc = segmentParagraphs({ lines, bbox });
    expect(doc.kind).toBe("spec");
    expect(doc.spec).toEqual({ section: "09 21 16" });
    expect(doc.title?.text).toBe("SECTION 09 21 16 - ZFKMP ZYSFM");
    expect(doc.blocks.map((b) => b.headerNorm)).toEqual(["SECTION 09 21 16 ZFKMP ZYSFM", "PART 1 GENERAL", "PART 2 PRODUCTS"]);
    expect(doc.paragraphs.map((p) => [p.keyPath.join("."), p.depth])).toEqual([["1.01", 0], ["1.01.A", 1], ["1.01.B", 1], ["1.02", 0], ["1.02.A", 1], ["2.01", 0], ["2.01.A", 1]]);
    expect(doc.paragraphs.map((p) => p.blockId)).toEqual(["b2", "b2", "b2", "b2", "b2", "b3", "b3"]);
  });

  it("two sections in one region: the second SECTION opens a new block; spec.section is the first", () => {
    const { lines, bbox } = fixture("syn-spec-two-sections");
    const doc = segmentParagraphs({ lines, bbox });
    expect(doc.spec).toEqual({ section: "08 71 00" });
    expect(doc.blocks.map((b) => b.headerNorm)).toEqual(["SECTION 08 71 00 ZFKMP HTJWZ", "PART 1 GENERAL", "END OF SECTION", "SECTION 09 91 23 ZFKMP", "PART 1 GENERAL"]);
    expect(doc.paragraphs.map((p) => [p.key, p.blockId])).toEqual([["1.01", "b2"], ["1.01", "b5"]]);
  });

  it("lines before the first number are kept as an unkeyed lead-in paragraph (K35)", () => {
    const { lines, bbox, truth } = fixture("syn-notes-preamble");
    const doc = segmentParagraphs({ lines, bbox });
    const lead = doc.paragraphs.filter((p) => p.key === null);
    expect(lead).toHaveLength(1);
    expect(lead[0].text).toBe(`${truth[0].text} ${truth[1].text}`);
    expect(lead[0]).toMatchObject({ keyPath: [], keyNorm: "", depth: 0, lineCount: 2 });
    expect(doc.paragraphs.indexOf(lead[0])).toBe(0);
    expect(keyed(doc)).toEqual(truth.filter((t) => t.key !== "").map((t) => [stripKey(t.key), t.text]));
    expect(doc.quality.flags).toContain("lead-in");
  });

  it("keynote bubbles: bare digits are weak keys, accepted in sequence and in the key column", () => {
    const { lines, bbox } = fixture("syn-notes-keynote-bubbles");
    const doc = segmentParagraphs({ lines, bbox });
    expect(doc.paragraphs.map((p) => p.key)).toEqual(["1", "2", "3", "4", "5"]);
    expect(doc.quality.flags).toContain("weak-keys");
  });

  for (const id of ["syn-kv-abbrev-same-line", "syn-kv-abbrev"]) {
    it(`${id}: key/value legend rows become one paragraph per pair through kv-pairs (K09)`, () => {
      const { lines, bbox, truth } = fixture(id);
      const doc = segmentParagraphs({ lines, bbox });
      expect(keyed(doc)).toEqual(truth.filter((t) => t.key !== "").map((t) => [t.key, t.text]));
      expect(doc.paragraphs.every((p) => p.keyPath.length === 1 && p.keyNorm === p.key)).toBe(true);
      expect(doc.quality.flags).toContain("kv-pairs");
      expect(zStructureParagraphDoc.parse(doc)).toEqual(doc);
    });
  }

  it("the abbreviations heading is the block header, not a pair", () => {
    const { lines, bbox } = fixture("syn-kv-abbrev");
    const doc = segmentParagraphs({ lines, bbox });
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].headerNorm).toBe("ABBREVIATIONS");
    expect(doc.quality.flags).toContain("legend");
    expect(doc.paragraphs).toHaveLength(6);
  });

  it("every fixture doc validates against the contract and is byte-equal on a second run (E-7)", () => {
    for (const id of [...NOTES, "syn-notes-subblocks", "syn-notes-two-column", "syn-spec-section", "syn-spec-multicolumn-dense", "syn-kv-abbrev", "syn-notes-preamble", "syn-notes-dimension-start"]) {
      const { lines, bbox } = fixture(id);
      const a = segmentParagraphs({ lines, bbox });
      const b = segmentParagraphs({ lines, bbox });
      expect(JSON.stringify(a), id).toBe(JSON.stringify(b));
      expect(() => zStructureParagraphDoc.parse(a), id).not.toThrow();
      // input order does not matter
      const shuffled = [...lines].reverse();
      const c = segmentParagraphs({ lines: shuffled, bbox });
      expect(c.paragraphs.map((p) => [p.key, p.text]), id).toEqual(a.paragraphs.map((p) => [p.key, p.text]));
    }
  });
});

describe("segmentParagraphs probes", () => {
  it("a weak bare number in the text column is a continuation, not a key", () => {
    const lines = [
      line("1 ZFKMP SNIEV HTJWZ DCZRP", 0.55, 0.15),
      line("2 LAYERS QTMYBW JHWUL", 0.566, 0.16), // wrapped line that starts with a digit, indented
      line("2 LOZC QEISL NEKQKA", 0.55, 0.17),
      line("3 MVN MEVMU DZGMP", 0.55, 0.18),
    ];
    const doc = segmentParagraphs({ lines, bbox: [0.54, 0.14, 0.8, 0.2] });
    expect(doc.paragraphs.map((p) => [p.key, p.text])).toEqual([
      ["1", "ZFKMP SNIEV HTJWZ DCZRP 2 LAYERS QTMYBW JHWUL"],
      ["2", "LOZC QEISL NEKQKA"],
      ["3", "MVN MEVMU DZGMP"],
    ]);
  });

  it("a strong key out of sequence but in the key column still opens a paragraph (printed keys may skip)", () => {
    const lines = [line("1. ZFKMP SNIEV", 0.55, 0.15), line("2. HTJWZ DCZRP", 0.55, 0.16), line("5. EJBC ZYSFM", 0.55, 0.17), line("(2) LAYERS WRIS", 0.566, 0.18)];
    const doc = segmentParagraphs({ lines, bbox: [0.54, 0.14, 0.8, 0.2] });
    expect(doc.paragraphs.map((p) => p.key)).toEqual(["1", "2", "5"]);
    expect(doc.paragraphs[2].text).toBe("EJBC ZYSFM (2) LAYERS WRIS");
  });

  it("spec `1.01 › A › 1`: a numbered item under a lettered paragraph is depth 2 with the full keyPath", () => {
    const lines = [
      line("SECTION 08 71 00 - ZFKMP", 0.55, 0.15),
      line("PART 1 GENERAL", 0.55, 0.16),
      line("1.01 SNIEV HTJWZ", 0.558, 0.17),
      line("A. DCZRP EJBC ZYSFM", 0.566, 0.18),
      line("1. QTMYBW JHWUL", 0.574, 0.19),
      line("ESEUS LOZC", 0.59, 0.2),
      line("2. QEISL NEKQKA", 0.574, 0.21),
      line("B. KXBDUU NJIUT", 0.566, 0.22),
      line("1.02 UJYH YTJN", 0.558, 0.23),
      line("2.3 MM HFBLJ ERKZM", 0.574, 0.24), // a dimension inside the spec body: not an article (not in sequence)
    ];
    const doc = segmentParagraphs({ lines, bbox: [0.54, 0.14, 0.8, 0.26] });
    expect(doc.kind).toBe("spec");
    expect(doc.paragraphs.map((p) => [p.keyPath.join(" › "), p.depth, p.keyNorm])).toEqual([
      ["1.01", 0, "1.01"],
      ["1.01 › A", 1, "A"],
      ["1.01 › A › 1", 2, "1"],
      ["1.01 › A › 2", 2, "2"],
      ["1.01 › B", 1, "B"],
      ["1.02", 0, "1.02"],
    ]);
    expect(doc.paragraphs[2].text).toBe("QTMYBW JHWUL ESEUS LOZC");
    expect(doc.paragraphs[5].text).toBe("UJYH YTJN 2.3 MM HFBLJ ERKZM");
  });

  it("a weak article in sequence is a key (2.1, 2.2, 2.3) in a spec", () => {
    const lines = [line("PART 2 PRODUCTS", 0.55, 0.15), line("2.1 ZFKMP SNIEV", 0.558, 0.16), line("2.2 HTJWZ DCZRP", 0.558, 0.17), line("2.3 EJBC ZYSFM", 0.558, 0.18)];
    const doc = segmentParagraphs({ lines, bbox: [0.54, 0.14, 0.8, 0.2] });
    expect(doc.paragraphs.map((p) => p.key)).toEqual(["2.1", "2.2", "2.3"]);
    expect(doc.kind).toBe("spec");
  });

  it("a `(CONT.)` header marks the block continued and keeps its printed numbering (§1.7 rule 5)", () => {
    const lines = [line("GENERAL NOTES (CONT.)", 0.55, 0.15), line("8. ZFKMP SNIEV", 0.55, 0.16), line("9. HTJWZ DCZRP", 0.55, 0.17)];
    const doc = segmentParagraphs({ lines, bbox: [0.54, 0.14, 0.8, 0.2] });
    expect(doc.blocks[0]).toMatchObject({ header: "GENERAL NOTES (CONT.)", headerNorm: "GENERAL NOTES", continued: true });
    expect(doc.paragraphs.map((p) => p.key)).toEqual(["8", "9"]);
    expect(doc.quality.flags).toContain("continued");
    expect(zStructureParagraphDoc.parse(doc)).toEqual(doc);
  });

  it("tag keys (K-01, K-02) open paragraphs; a bare tag never starts a list", () => {
    const lines = [line("KEYNOTES", 0.55, 0.15), line("K-01 ZFKMP SNIEV", 0.55, 0.16), line("K-02 HTJWZ DCZRP", 0.55, 0.17), line("A1 EJBC ZYSFM", 0.55, 0.18)];
    const doc = segmentParagraphs({ lines, bbox: [0.54, 0.14, 0.8, 0.2] });
    expect(doc.paragraphs.map((p) => [p.key, p.keyNorm])).toEqual([["K-01", "K01"], ["K-02", "K02"]]);
    expect(doc.paragraphs[1].text).toBe("HTJWZ DCZRP A1 EJBC ZYSFM");
  });

  it("LAYOUT list blocks define the columns when present; without them the gutter rule gives the same result", () => {
    const left = [line("1. ZFKMP SNIEV", 0.55, 0.15), line("2. HTJWZ DCZRP", 0.55, 0.16), line("3. EJBC ZYSFM", 0.55, 0.17)];
    const right = [line("4. QTMYBW JHWUL", 0.7, 0.15), line("5. ESEUS LOZC", 0.7, 0.16), line("6. QEISL NEKQKA", 0.7, 0.17)];
    const lines = [...left, ...right];
    const bbox: BboxMinMax = [0.54, 0.14, 0.85, 0.19];
    const layout: EngineLayoutBlock[] = [
      { k: "list", b: [0.55, 0.15, 0.62, 0.18] },
      { k: "list", b: [0.7, 0.15, 0.78, 0.18] },
      { k: "title", b: [0.1, 0.05, 0.3, 0.06] },
    ];
    const withLayout = segmentParagraphsDetailed({ lines, bbox, layout });
    const without = segmentParagraphsDetailed({ lines, bbox });
    expect(withLayout.columns).toHaveLength(2);
    expect(without.columns).toHaveLength(2);
    expect(withLayout.doc.paragraphs.map((p) => p.key)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(without.doc.paragraphs.map((p) => [p.key, p.text])).toEqual(withLayout.doc.paragraphs.map((p) => [p.key, p.text]));
    expect(withLayout.doc.sources.segment).toEqual(["ocr-lines", "layout"]);
    expect(withLayout.doc.quality.flags).toContain("layout-columns");
    expect(without.doc.sources.segment).toEqual(["ocr-lines"]);
    // a single list block does not split
    expect(segmentParagraphsDetailed({ lines: left, bbox, layout: [layout[0]] }).columns).toHaveLength(1);
  });

  it("a gutter needs lines on both sides: a ragged right edge inside one column is not a column break", () => {
    const lines = [line("1. ZFKMP SNIEV HTJWZ DCZRP EJBC ZYSFM", 0.55, 0.15), line("QTMYBW", 0.566, 0.16), line("2. JHWUL ESEUS LOZC QEISL NEKQKA KXBDUU", 0.55, 0.17), line("NJIUT", 0.566, 0.18)];
    const r = segmentParagraphsDetailed({ lines, bbox: [0.54, 0.14, 0.95, 0.2] });
    expect(r.columns).toHaveLength(1);
    expect(r.doc.paragraphs.map((p) => p.key)).toEqual(["1", "2"]);
  });

  it("an empty box gives an empty, valid document", () => {
    const doc = segmentParagraphs({ lines: [line("ZFKMP", 0.1, 0.1)], bbox: [0.5, 0.5, 0.6, 0.6] });
    expect(doc.blocks).toEqual([]);
    expect(doc.paragraphs).toEqual([]);
    expect(doc.quality).toMatchObject({ conf: 0, flags: expect.arrayContaining(["empty"]) });
    expect(zStructureParagraphDoc.parse(doc)).toEqual(doc);
  });

  it("mode kv forces key/value pairing; mode keyed never pairs", () => {
    const lines = [line("ABV", 0.55, 0.15), line("ZFKMP SNIEV", 0.6, 0.15), line("BLW", 0.55, 0.16), line("HTJWZ", 0.6, 0.16), line("CLG", 0.55, 0.17), line("DCZRP EJBC", 0.6, 0.17)];
    const bbox: BboxMinMax = [0.54, 0.14, 0.8, 0.18];
    expect(segmentParagraphs({ lines, bbox, mode: "kv" }).paragraphs.map((p) => [p.key, p.text])).toEqual([["ABV", "ZFKMP SNIEV"], ["BLW", "HTJWZ"], ["CLG", "DCZRP EJBC"]]);
    const keyedOnly = segmentParagraphs({ lines, bbox, mode: "keyed" });
    expect(keyedOnly.paragraphs.every((p) => p.key === null)).toBe(true);
  });

  it("linesFromEvidence attaches each line's words from the page evidence", () => {
    const ev: Pick<EnginePageEvidence, "words" | "lines"> = {
      words: [
        { t: "1.", b: [0.55, 0.15, 0.56, 0.157], conf: 0.99, lineId: 0 },
        { t: "ZFKMP", b: [0.565, 0.15, 0.59, 0.157], conf: 0.99, lineId: 0 },
        { t: "SNIEV", b: [0.565, 0.16, 0.59, 0.167], conf: 0.99, lineId: 1 },
      ],
      lines: [
        { text: "1. ZFKMP", b: [0.55, 0.15, 0.59, 0.157], wordIdx: [0, 1] },
        { text: "SNIEV", b: [0.565, 0.16, 0.59, 0.167], wordIdx: [2] },
      ],
    };
    const lines = linesFromEvidence(ev);
    expect(lines.map((l) => l.words?.map((w) => w.t))).toEqual([["1.", "ZFKMP"], ["SNIEV"]]);
    const doc = segmentParagraphs({ lines, bbox: [0.5, 0.1, 0.7, 0.2] });
    expect(doc.paragraphs).toEqual([expect.objectContaining({ key: "1", text: "ZFKMP SNIEV", lineCount: 2 })]);
  });

  it("caps: more than 1,000 paragraphs are truncated with the flag", () => {
    const lines: SegmentLine[] = [];
    for (let i = 0; i < 1_050; i++) lines.push(line(`${(i % 500) + 1}. ZFKMP`, 0.1, 0.0005 * i, 0.0004));
    const req: SegmentRequest = { lines, bbox: [0, 0, 1, 1] };
    const doc = segmentParagraphs(req);
    expect(doc.paragraphs).toHaveLength(1_000);
    expect(doc.quality.flags).toContain("truncated");
    expect(zStructureParagraphDoc.parse(doc)).toEqual(doc);
  });
});
