/**
 * csi-detect-triggers.test.ts — the v2 TRIGGER output of `detectCsiCodes` (one trigger per span).
 *
 * [csi-v2 S6] Replaces the pre-v2 freeze of the 3-tier per-WORD trigger labels (whose inversion —
 * the rarest word labelled tier 3, the LOWEST downstream confidence — was the defect the rebuild
 * exists to fix; IMPLEMENTATION §II S6). A v2 trigger is a matched SPAN: `text` (the span as
 * printed, lowercased), `bbox` (union of its words), `bboxes` (one per word), `tier` (from the
 * CODE's confidence: ≥ 0.8 → 1, ≥ 0.6 → 2, else 3), plus provenance (`pattern`, `source`,
 * `score`, `line`, `tokenStart`/`tokenEnd`, `emitted`).
 * Kept contracts: no geometry → the `triggers` key is absent; triggers ride ONLY on emitted codes.
 * Every expected value was MEASURED on kb-v2.4 before pinning. KB-backed tests `skipIf` the KB is
 * absent (scripts/bp-suite makes that a failure).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectCsiCodes, linesFromWordsByGeometry, linesFromWordsByText } from "@/lib/csi-detect";
import type { BboxLTWH, TextractLine, TextractWord } from "@/types";
import { csiTriggerHits } from "@/lib/csi-utils";

const HAS_KB = existsSync(join(process.cwd(), "src/data/csi-kb.json"));

/** Words laid out on rows: y = 0.1 × (row + 1); x steps of 1/8, width 0.1 (gap 0.025 < 1.2 × height,
 *  so the geometric fallback keeps a row together). */
function wordsOf(rows: string[][]): TextractWord[] {
  const out: TextractWord[] = [];
  rows.forEach((row, r) => row.forEach((text, i) => {
    out.push({ text, confidence: 90, bbox: [i / 8, (r + 1) / 10, 0.1, 0.03125] });
  }));
  return out;
}
const textOf = (rows: string[][]) => rows.map((r) => r.join(" ")).join("\n");

const ROWS = [["HOLLOW", "METAL", "DOORS"], ["GYPSUM", "BOARD"]];

describe("words → lines (adapter helpers, no KB)", () => {
  it("character alignment reproduces rawText's lines, whitespace-insensitive", () => {
    const words = wordsOf(ROWS);
    const lines = linesFromWordsByText(textOf(ROWS), words);
    expect(lines?.map((l) => l.text)).toEqual(["HOLLOW METAL DOORS", "GYPSUM BOARD"]);
    expect(lines?.[0].words).toEqual(words.slice(0, 3));
    expect(lines?.[1].bbox).toEqual([0, 0.2, 0.225, 0.03125]);
    // a word Textract split differently from the line text still aligns ("GYP" + "BD" vs "GYPBD")
    expect(linesFromWordsByText("GYPBD", wordsOf([["GYP", "BD"]]))?.map((l) => l.text)).toEqual(["GYP BD"]);
  });

  it("returns null when the words do not spell rawText (then the adapter groups them by geometry)", () => {
    expect(linesFromWordsByText("HOLLOW METAL DOORS", wordsOf([["WOOD", "DOORS"]]))).toBeNull();
    expect(linesFromWordsByText("HOLLOW", wordsOf([["HOLLOW", "EXTRA"]]))).toBeNull(); // words left over
  });

  it("geometric grouping: rows by vertical centre, split at a wide horizontal gap", () => {
    const w: TextractWord[] = [
      { text: "B", confidence: 90, bbox: [0.16, 0.1, 0.05, 0.02] }, // gap 0.01 < 1.2 × 0.02
      { text: "A", confidence: 90, bbox: [0.1, 0.1, 0.05, 0.02] },
      { text: "FAR", confidence: 90, bbox: [0.6, 0.1, 0.05, 0.02] },
      { text: "NEXT", confidence: 90, bbox: [0.1, 0.3, 0.05, 0.02] },
    ];
    expect(linesFromWordsByGeometry(w).map((l: TextractLine) => l.text)).toEqual(["A B", "FAR", "NEXT"]);
  });
});

describe.skipIf(!HAS_KB)("the triggers key itself", () => {
  it("omitting words omits the key entirely — it is absent, not an empty array", () => {
    const r = detectCsiCodes(textOf(ROWS));
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect("triggers" in c).toBe(false);
  });

  it("an EMPTY words array still yields the key (geometry was offered, nothing to place)", () => {
    const r = detectCsiCodes("HOLLOW METAL DOORS", []);
    expect(r.map((c) => [c.code, c.triggers])).toEqual([["08 13 13", []]]);
  });

  it("triggers ride ONLY on emitted codes: a BY OTHERS span emits no code and no trigger", () => {
    const rows = [["GYPSUM", "BOARD"], ["HOLLOW", "METAL", "DOORS", "BY", "OTHERS"]];
    const r = detectCsiCodes(textOf(rows), wordsOf(rows));
    expect(r.map((c) => c.code)).toEqual(["09 29 00"]);
    expect(r[0].triggers?.map((t) => t.text)).toEqual(["gypsum board"]);
  });

  it("an EMITTED code stores only spans that count: its BY OTHERS span is not a trigger (review fix round 1)", () => {
    // csi-page keeps the excluded span on the code as emitted:false; stored, it was highlighted by the
    // viewer search (csiTriggerHits) and counted by the sidebar's "N spans" pill
    const rows = [["PROVIDE", "HOLLOW", "METAL", "DOORS", "AT", "STAIRS"], ["HOLLOW", "METAL", "DOORS", "BY", "OTHERS"]];
    const r = detectCsiCodes(textOf(rows), wordsOf(rows));
    expect(r.map((c) => `${c.code}@${c.confidence}`)).toEqual(["08 13 13@0.88"]);
    expect(r[0].triggers?.map((t) => [t.text, (t as { line?: number }).line, (t as { emitted?: boolean }).emitted]))
      .toEqual([["hollow metal doors", 0, true]]);
    expect(csiTriggerHits(r[0].triggers ?? [])).toHaveLength(3);
  });
});

describe.skipIf(!HAS_KB)("span triggers (v2)", () => {
  const words = wordsOf(ROWS);
  const result = detectCsiCodes(textOf(ROWS), words);

  it("one trigger per span, with provenance; tier comes from the code's confidence", () => {
    expect(result.map((c) => `${c.code}@${c.confidence}`)).toEqual(["08 13 13@0.88", "09 29 00@0.88"]);
    const t = result[0].triggers?.[0];
    expect(t).toMatchObject({
      text: "hollow metal doors", tier: 1, tokenStart: 0, tokenEnd: 2, pattern: "Hollow Metal Doors",
      source: "title", score: 1, emitted: true, line: 0,
    });
    expect(result[1].triggers?.map((x) => [x.text, x.tier])).toEqual([["gypsum board", 1]]);
  });

  it("bboxes are the matched words' own boxes; bbox is their union", () => {
    const t = result[0].triggers?.[0] as { bbox: BboxLTWH; bboxes?: BboxLTWH[] };
    expect(t.bboxes).toEqual(words.slice(0, 3).map((w) => w.bbox));
    expect(t.bbox[0]).toBe(0);
    expect(t.bbox[1]).toBe(0.1);
    expect(t.bbox[2]).toBeCloseTo(0.35, 12);
    expect(t.bbox[3]).toBeCloseTo(0.03125, 12);
  });

  it("Textract lines in, or the same words rebuilt into lines, give the same codes and triggers", () => {
    const lines = linesFromWordsByText(textOf(ROWS), words);
    if (!lines) throw new Error("alignment failed");
    expect(detectCsiCodes(textOf(ROWS), { lines })).toEqual(result);
    expect(detectCsiCodes(textOf(ROWS), { words })).toEqual(result);
  });

  it("words that do not spell rawText fall back to geometric lines (still with triggers)", () => {
    const r = detectCsiCodes("unrelated raw text here", words);
    expect(r.map((c) => c.code)).toEqual(["08 13 13", "09 29 00"]);
    expect(r[0].triggers?.[0].bboxes).toEqual(words.slice(0, 3).map((w) => w.bbox));
  });

  it("repetition: the same phrase on two lines is two triggers and raises confidence (0.88 → 0.91)", () => {
    const rows = [["GYPSUM", "BOARD"], ["GYPSUM", "BOARD"]];
    const r = detectCsiCodes(textOf(rows), wordsOf(rows));
    expect(r.map((c) => [c.code, c.triggers?.length, c.triggers?.map((t) => (t as { line?: number }).line)]))
      .toEqual([["09 29 00", 2, [0, 1]]]);
    expect(r[0].confidence).toBeCloseTo(0.91, 12);
  });
});
