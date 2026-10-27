// [table-pipeline WP-2.B] K09: key/value pairing on one visual line (`paragraphs/kv-pairs.ts`) and the
// two binders that use it (`bindKeyValueGrid`, reached by the notes catch-all and by the classifier's
// `notes-key-value` grids). All text is synthetic pseudo-words (rule 12).
import { describe, expect, it } from "vitest";
import { groupLinesByYOverlap, kvPairs, type KvLine } from "../paragraphs/kv-pairs";
import { bindKeyValueGrid, buildLineFeatures } from "@/lib/specnote-parser";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import type { TextractLine, TextractPageData, TextractWord } from "@/types";

type Ltwh = [number, number, number, number];

/** One OCR LINE (LTWH), its words laid out left to right with a 0.002 gap (the C04 probe builder). */
function ocrLine(text: string, x: number, y: number, w: number, h = 0.006): TextractLine {
  const parts = text.split(/\s+/).filter(Boolean);
  let c = x;
  const words: TextractWord[] = parts.map((p) => {
    const ww = (w * p.length) / text.length;
    const o: TextractWord = { text: p, confidence: 95, bbox: [c, y, ww, h] as Ltwh };
    c += ww + 0.002;
    return o;
  });
  return { text, confidence: 95, bbox: [x, y, w, h] as Ltwh, words } as TextractLine;
}

const page = (lines: TextractLine[]): TextractPageData =>
  ({ lines, words: lines.flatMap((l) => l.words ?? []), tables: [] }) as unknown as TextractPageData;

// The C04-04 probe, pseudo-words: 6 legend entries, key and value as SEPARATE LINEs at the same height.
const ENTRIES: [string, string][] = [
  ["QZV", "QZOVL"],
  ["QFF", "QZOVL FRMQSHED FLXXR"],
  ["QCT", "QCXUSTRCAL CERLRNG TRLE"],
  ["QLUM", "QLUMRNUM"],
  ["BLDQ", "BURLDRNQ"],
  ["CLQ", "CERLRNQ"],
];
function legendLines(withHeader: boolean): TextractLine[] {
  const out: TextractLine[] = [];
  if (withHeader) out.push(ocrLine("QBBREVRQTRONS", 0.6, 0.1, 0.1, 0.009));
  ENTRIES.forEach(([k, v], i) => {
    out.push(ocrLine(k, 0.6, 0.115 + i * 0.01, 0.025));
    out.push(ocrLine(v, 0.66, 0.115 + i * 0.01, 0.09));
  });
  return out;
}

const toKvLines = (lines: TextractLine[]): KvLine[] =>
  lines.map((l) => ({
    text: l.text,
    b: [l.bbox[0], l.bbox[1], l.bbox[0] + l.bbox[2], l.bbox[1] + l.bbox[3]],
    words: (l.words ?? []).map((w) => ({ t: w.text, b: [w.bbox[0], w.bbox[1], w.bbox[0] + w.bbox[2], w.bbox[1] + w.bbox[3]] as const })),
  }));

describe("kvPairs (K09)", () => {
  it("pairs a key LINE with the value LINE beside it: 6 entries → 6 rows", () => {
    const { pairs, medianSplitX } = kvPairs(toKvLines(legendLines(false)), { minGapRatio: 0.05 });
    expect(pairs.map((p) => [p.key, p.value])).toEqual(ENTRIES);
    expect(medianSplitX).not.toBeNull();
    expect(medianSplitX!).toBeGreaterThan(0.625);
    expect(medianSplitX!).toBeLessThan(0.66);
  });

  it("keeps a lone heading as a key-only row", () => {
    const { pairs } = kvPairs(toKvLines(legendLines(true)), { minGapRatio: 0.05 });
    expect(pairs.map((p) => [p.key, p.value])).toEqual([["QBBREVRQTRONS", ""], ...ENTRIES]);
  });

  it("conserves words: every input word lands in exactly one key or value", () => {
    const lines = toKvLines(legendLines(true));
    const { pairs } = kvPairs(lines, { minGapRatio: 0.05 });
    const out = pairs.flatMap((p) => `${p.key} ${p.value}`.split(/\s+/).filter(Boolean)).sort();
    const inp = lines.flatMap((l) => l.words!.map((w) => w.t)).sort();
    expect(out).toEqual(inp);
    expect(pairs.flatMap((p) => p.lineIdx).sort((a, b) => a - b)).toEqual(lines.map((_, i) => i));
  });

  it("is deterministic under input order (E-7)", () => {
    const lines = toKvLines(legendLines(true));
    const base = JSON.stringify(kvPairs(lines, { minGapRatio: 0.05 }).pairs.map((p) => [p.key, p.value, p.top]));
    const rev = [...lines].reverse();
    expect(JSON.stringify(kvPairs(rev, { minGapRatio: 0.05 }).pairs.map((p) => [p.key, p.value, p.top]))).toBe(base);
  });

  it("groups by vertical overlap only: stacked lines stay separate rows", () => {
    const lines = toKvLines([ocrLine("QQ RR", 0.1, 0.1, 0.05), ocrLine("SS TT", 0.1, 0.108, 0.05)]);
    expect(groupLinesByYOverlap(lines)).toEqual([[0], [1]]);
    const side = toKvLines([ocrLine("QQ", 0.1, 0.1, 0.02), ocrLine("SS TT", 0.2, 0.1012, 0.05)]);
    expect(groupLinesByYOverlap(side)).toEqual([[0, 1]]);
  });

  it("appends a wrapped value line to the previous pair only with mergeContinuations", () => {
    const lines = legendLines(false);
    // wrap the second entry's value onto a second line in the value column
    const wrapped = [...lines.slice(0, 4), ocrLine("CXNTRNUQTRXN", 0.66, 0.135, 0.05), ...lines.slice(4)].map((l, i) =>
      i > 4 ? ocrLine(l.text, l.bbox[0], l.bbox[1] + 0.01, l.bbox[2]) : l,
    );
    const plain = kvPairs(toKvLines(wrapped), { minGapRatio: 0.05 }).pairs;
    expect(plain).toHaveLength(7);
    expect(plain[2]).toMatchObject({ key: "CXNTRNUQTRXN", value: "" });
    const merged = kvPairs(toKvLines(wrapped), { minGapRatio: 0.05, mergeContinuations: true }).pairs;
    expect(merged.map((p) => [p.key, p.value])).toEqual([
      ENTRIES[0],
      [ENTRIES[1][0], `${ENTRIES[1][1]} CXNTRNUQTRXN`],
      ...ENTRIES.slice(2),
    ]);
  });

  it("a long key still splits but does not move the median column (maxKeyLen)", () => {
    const lines = toKvLines([ocrLine("QQ", 0.1, 0.1, 0.02), ocrLine("VV", 0.2, 0.1, 0.02), ocrLine("LXNQKEYLXNQKEYLXNQKEY", 0.1, 0.12, 0.05), ocrLine("WW", 0.3, 0.12, 0.02)]);
    const r = kvPairs(lines, { minGapRatio: 0.05, maxKeyLen: 20 });
    expect(r.pairs.map((p) => [p.key, p.value])).toEqual([["QQ", "VV"], ["LXNQKEYLXNQKEYLXNQKEY", "WW"]]);
    expect(r.medianSplitX).toBeCloseTo((0.12 + 0.2) / 2, 10);
  });
});

describe("bindKeyValueGrid on kv-pairs (K09)", () => {
  it("the C04 probe binds 6 rows {Key, Value} with a 3-edge column split", () => {
    const g = bindKeyValueGrid(buildLineFeatures(legendLines(false)));
    expect(g?.headers).toEqual(["Key", "Value"]);
    expect(g?.rows).toEqual(ENTRIES.map(([Key, Value]) => ({ Key, Value })));
    expect(g?.rowBoundaries).toHaveLength(6);
    expect(g?.colBoundaries).toHaveLength(3);
  });

  it("a legend printed on one LINE per entry still binds as before", () => {
    const lines = ENTRIES.map(([k, v], i) => {
      const key = ocrLine(k, 0.6, 0.115 + i * 0.01, 0.025);
      const val = ocrLine(v, 0.66, 0.115 + i * 0.01, 0.09);
      return { ...key, text: `${k} ${v}`, bbox: [0.6, key.bbox[1], 0.15, 0.006] as Ltwh, words: [...key.words!, ...val.words!] } as TextractLine;
    });
    expect(bindKeyValueGrid(buildLineFeatures(lines))?.rows).toEqual(ENTRIES.map(([Key, Value]) => ({ Key, Value })));
  });

  it("the classifier's notes-key-value grid holds one row per entry (was key-only + value-only rows)", () => {
    const regions = classifyTextRegions(page(legendLines(true)), []);
    const kv = regions.find((r) => r.type === "notes-key-value");
    expect(kv, "the probe classifies as notes-key-value").toBeDefined();
    expect(kv!.grid?.rows).toEqual([{ Key: "QBBREVRQTRONS", Value: "" }, ...ENTRIES.map(([Key, Value]) => ({ Key, Value }))]);
  });
});
