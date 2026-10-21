// Duplicate-page detector goldens (PLAN §2.4). Synthetic text only (page-dedup-fixtures.ts).
import { describe, expect, it } from "vitest";
import {
  blockHides,
  bulkTiers,
  crossProjectReport,
  defaultKeep,
  detectDuplicates,
  getDuplicateOf,
  isHiddenDuplicate,
  lineDiff,
  pageTextKey,
  RUN_BULK_ENABLED,
  type DedupPageInput,
} from "@/lib/page-dedup";
import { reportDigest } from "@/lib/page-dedup/digest";
import { findBlocks, resolveBlockCoverage } from "@/lib/page-dedup/runs";
import { jaccard, shingles } from "@/lib/page-dedup/similarity";
import { boilerplateLines, normalizeLine } from "@/lib/page-dedup/normalize";
import { body, page, tweak } from "./page-dedup-fixtures";

const num = (i: number) => `A-${100 + i}`;

function set(count: number, firstPage: number, seedBase: number, opts: { numbered?: boolean; words?: number } = {}): DedupPageInput[] {
  const out: DedupPageInput[] = [];
  for (let i = 0; i < count; i++) {
    out.push(page(firstPage + i, opts.numbered === false ? null : num(i), body(seedBase + i, opts.words)));
  }
  return out;
}

function copyAt(pages: DedupPageInput[], offset: number): DedupPageInput[] {
  return pages.map((p) => ({ ...p, pageNumber: p.pageNumber + offset }));
}

describe("page-dedup normalize + similarity", () => {
  it("normalizes case, punctuation and whitespace", () => {
    expect(normalizeLine("  Sheet A-101.00:  FLOOR   Plan ")).toBe("sheet a 101 00 floor plan");
  });
  it("jaccard is 1 for identical, 0 for disjoint, symmetric", () => {
    const a = shingles("one two three four five".split(" "));
    const b = shingles("six seven eight nine ten".split(" "));
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, b)).toBe(0);
    const c = shingles("one two three four nine".split(" "));
    expect(jaccard(a, c)).toBe(jaccard(c, a));
  });
  it("boilerplate needs ≥ 5 pages and ≥ 60 % share", () => {
    expect(boilerplateLines([["x"], ["x"]]).size).toBe(0);
    const lines = [["t", "a"], ["t", "b"], ["t", "c"], ["u", "d"], ["u", "e"]];
    expect([...boilerplateLines(lines)]).toEqual(["t"]);
  });
});

describe("page-dedup detector goldens", () => {
  it("exact double set: 10 sheets then the same 10 → one exact block, canonical = first copy", () => {
    const first = set(10, 1, 100);
    const report = detectDuplicates([...first, ...copyAt(first, 10)]);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({ start: 1, offset: 10, length: 10, tier: "exact", label: "repeat set" });
    expect(report.counts).toMatchObject({ pages: 20, exact: 10, run: 0, near: 0, blocks: 1 });
    expect(report.pairs.map((p) => [p.page, p.canonical])).toEqual(first.map((p) => [p.pageNumber + 10, p.pageNumber]));
    expect(bulkTiers()).toContain("exact");
  });

  it("repeat set with OCR-level noise (full ≥ 0.995, same numbers) → run block, not bulk while RUN_BULK_ENABLED=false", () => {
    const first = set(5, 1, 300, { words: 1600 });
    const second = copyAt(first, 5).map((p, i) =>
      i === 2 ? { ...p, rawText: (p.rawText ?? "").replace(/^\S+/, "revised") } : p,
    );
    const report = detectDuplicates([...first, ...second]);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0].tier).toBe("run");
    expect(report.blocks[0].minFull).toBeGreaterThanOrEqual(0.995);
    expect(report.pairs.every((p) => p.tier === "run")).toBe(true);
    expect(RUN_BULK_ENABLED).toBe(false);
    expect(bulkTiers()).not.toContain("run");
  });

  it("permit + IFC revision set (same numbers, changed notes, full ≈ 0.97) → near block, likely revision set, never bulk; keep-latest hides the permit copy", () => {
    const permit = set(6, 1, 500);
    const ifc = copyAt(permit, 6).map((p, i) => {
      if (i % 2 !== 0) return p; // half the sheets re-issued unchanged
      const lines = (p.rawText ?? "").split("\n");
      return { ...p, rawText: tweak(lines, 1, "ifc").join("\n") };
    });
    const report = detectDuplicates([...permit, ...ifc]);
    expect(report.blocks).toHaveLength(1);
    const block = report.blocks[0];
    expect(block).toMatchObject({ start: 1, offset: 6, length: 6, tier: "near", label: "likely revision set" });
    expect(block.minFull).toBeLessThan(0.995);
    expect(block.minFull).toBeGreaterThan(0.9);
    // every pair in the revision set takes the block tier — including the unchanged re-issues
    expect(report.pairs.filter((p) => p.blockId === block.id).every((p) => p.tier === "near")).toBe(true);
    expect(report.counts.exact).toBe(0);
    expect(bulkTiers()).not.toContain("near");
    expect(defaultKeep(block.tier)).toBe("latest");
    expect(blockHides(block, "latest")).toEqual(permit.map((p) => ({ page: p.pageNumber, canonical: p.pageNumber + 6 })));
    expect(blockHides(block, "earliest")[0]).toEqual({ page: 7, canonical: 1 });
  });

  it("typical floors at offset 1 (null numbers, one word apart) → no block, never chained", () => {
    const base = body(700);
    const floors = [3, 4, 5, 6, 7].map((n) => page(n, null, tweak(base, 0, `level${n}`)));
    const pages = [page(1, null, body(701)), page(2, null, body(702)), ...floors, page(8, null, body(703))];
    const report = detectDuplicates(pages);
    expect(report.blocks).toHaveLength(0);
    expect(report.pairs.filter((p) => p.tier === "exact" || p.tier === "run")).toHaveLength(0);
    // review-only lone pairs, each pointing at its own best partner (no chain to the root)
    expect(report.pairs.every((p) => p.blockId === null)).toBe(true);
  });

  it("typical floors with IDENTICAL text at offset 1 form no block (d ≥ L)", () => {
    const base = body(710);
    const pages = [page(1, null, body(711)), ...[2, 3, 4, 5, 6].map((n) => page(n, null, base))];
    expect(detectDuplicates(pages).blocks).toHaveLength(0);
  });

  it("d < L overlap is rejected; d ≥ L accepted", () => {
    const overlap: [number, number][] = [1, 2, 3, 4, 5].map((a) => [a, a + 2]);
    expect(findBlocks(overlap)).toEqual([]);
    const ok: [number, number][] = [1, 2, 3].map((a) => [a, a + 3]);
    expect(findBlocks(ok)).toEqual([{ start: 1, offset: 3, length: 3 }]);
    expect(findBlocks([[1, 4], [2, 5]])).toEqual([]); // L = 2 < 3
  });

  it("differing drawing numbers are never paired, even at high similarity", () => {
    const base = body(800);
    const pages = [page(1, "A-101", base), page(2, "A-102", tweak(base, 0)), ...set(4, 3, 810)];
    const report = detectDuplicates(pages);
    expect(report.pairs.find((p) => p.page === 2)).toBeUndefined();
  });

  it("a lone repeated sheet number with different content → possible (review only)", () => {
    const pages = [...set(5, 1, 900), page(6, num(2), body(950))];
    const report = detectDuplicates(pages);
    const pair = report.pairs.find((p) => p.page === 6);
    expect(pair).toMatchObject({ tier: "possible", canonical: 3, sameNumber: true, blockId: null });
  });

  it("blank / title-block-only pages are ignored", () => {
    const pages = [...set(5, 1, 1000), page(6, null, []), page(7, null, []), page(8, null, ["n.t.s."])];
    const report = detectDuplicates(pages);
    expect(report.counts.blank).toBe(3);
    expect(report.pairs.filter((p) => p.page >= 6)).toHaveLength(0);
  });

  it("a set repeated 3× resolves every copy to the root", () => {
    const first = set(10, 1, 1100);
    const report = detectDuplicates([...first, ...copyAt(first, 10), ...copyAt(first, 20)]);
    expect(report.blocks.map((b) => [b.start, b.offset])).toEqual([[1, 10], [1, 20]]);
    for (const p of report.pairs) expect(p.canonical).toBe(((p.page - 1) % 10) + 1);
    expect(resolveBlockCoverage(findBlocks(first.flatMap((p) => [[p.pageNumber, p.pageNumber + 10], [p.pageNumber + 10, p.pageNumber + 20], [p.pageNumber, p.pageNumber + 20]] as [number, number][])))).toHaveLength(2);
  });

  it("title-block boilerplate does not make different sheets look alike", () => {
    const report = detectDuplicates(set(12, 1, 1200, { words: 40 }));
    expect(report.pairs).toHaveLength(0);
  });

  it("digest is stable and changes with the report", () => {
    const first = set(4, 1, 1300);
    const r1 = detectDuplicates([...first, ...copyAt(first, 4)]);
    const r2 = detectDuplicates([...first, ...copyAt(first, 4)]);
    expect(reportDigest(r1)).toBe(reportDigest(r2));
    const r3 = detectDuplicates([...first, ...copyAt(first, 4).slice(0, 3)]);
    expect(reportDigest(r3)).not.toBe(reportDigest(r1));
  });
});

// verify-r1 regressions: revision sets that the block rule alone let into bulk, the ratio-only
// run gate on dense sheets, and the two tier-rule mutants (M7, M9) no golden used to kill.
describe("page-dedup verify-r1 regressions", () => {
  const bulk = (r: ReturnType<typeof detectDuplicates>) => r.pairs.filter((p) => bulkTiers().includes(p.tier));

  it("revision set split by one rewritten sheet: the unchanged re-issues on both sides are near, nothing bulk", () => {
    const permit = set(10, 1, 2100);
    const ifc = copyAt(permit, 10).map((p, i) => (i === 4 ? page(p.pageNumber, num(i), body(9999)) : p));
    const report = detectDuplicates([...permit, ...ifc]);
    expect(report.blocks.map((b) => [b.id, b.tier, b.label])).toEqual([
      ["b1d10l4", "near", "likely revision set"],
      ["b6d10l5", "near", "likely revision set"],
    ]);
    expect(bulk(report)).toEqual([]);
    expect(report.counts.exact).toBe(0);
    expect(report.pairs.filter((p) => p.page !== 15).every((p) => p.tier === "near")).toBe(true);
    for (const b of report.blocks) expect(defaultKeep(b.tier)).toBe("latest");
  });

  it("short re-issue (2 sheets at the same offset, one changed): the identical one is near, not bulk", () => {
    const s = set(8, 1, 2200);
    const re = [copyAt([s[2]], 6)[0], { ...copyAt([s[3]], 6)[0], rawText: tweak((s[3].rawText ?? "").split("\n"), 3, "rev").join("\n") }];
    const report = detectDuplicates([...s, ...re]);
    expect(report.pairs.map((p) => [p.page, p.canonical, p.tier])).toEqual([[9, 3, "near"], [10, 4, "near"]]);
    expect(bulk(report)).toEqual([]);
  });

  it("identical re-issues with no changed same-offset neighbour stay exact (plan rule; text cannot tell)", () => {
    const s = set(8, 1, 2300);
    const report = detectDuplicates([...s, { ...s[2], pageNumber: 9 }, { ...s[5], pageNumber: 10 }]);
    expect(report.pairs.map((p) => [p.page, p.canonical, p.tier])).toEqual([[9, 3, "exact"], [10, 6, "exact"]]);
  });

  it("dense sheets: the run gate caps changed shingles, not only the ratio; run keeps the latest copy", () => {
    const first = set(4, 1, 2400, { words: 5000 });
    // 3 changed words per sheet: J ≈ 0.9964 ≥ 0.995, but 18 changed shingles > 6 → near
    const three = copyAt(first, 4).map((p) => {
      let lines = (p.rawText ?? "").split("\n");
      for (const at of [10, 200, 400]) lines = tweak(lines, at, "revised");
      return { ...p, rawText: lines.join("\n") };
    });
    const r3 = detectDuplicates([...first, ...three]);
    expect(r3.blocks).toHaveLength(1);
    expect(r3.blocks[0].minFull).toBeGreaterThanOrEqual(0.995);
    expect(r3.blocks[0].tier).toBe("near");
    // 1 changed word per sheet stays within the cap → run, whose default keep is the LATER copy
    const one = copyAt(first, 4).map((p) => ({ ...p, rawText: tweak((p.rawText ?? "").split("\n"), 10, "revised").join("\n") }));
    const r1 = detectDuplicates([...first, ...one]);
    expect(r1.blocks[0].tier).toBe("run");
    expect(defaultKeep("run")).toBe("latest");
    expect(blockHides(r1.blocks[0], defaultKeep("run"))[0]).toEqual({ page: 1, canonical: 5 });
    expect(defaultKeep("exact")).toBe("earliest");
  });

  it("M9: the run gate reads the FULL score — a permit stamp stripped as boilerplate still makes the set near", () => {
    // a one-word stamp on 12 of 20 pages (≥ 60 % → boilerplate): content 1, full ≈ 0.98, and
    // only 5 changed shingles, so the ratio (not the cap) is what must reject it
    const pages: DedupPageInput[] = [];
    for (let i = 0; i < 12; i++) pages.push({ pageNumber: i + 1, drawingNumber: num(i), rawText: [...body(3000 + i, 300), "PERMIT", num(i)].join("\n") });
    for (let i = 0; i < 8; i++) pages.push({ pageNumber: 13 + i, drawingNumber: num(i), rawText: [...body(3000 + i, 300), num(i)].join("\n") });
    const report = detectDuplicates(pages);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({ tier: "near", label: "likely revision set", minContent: 1 });
    expect(report.blocks[0].minFull).toBeLessThan(0.995);
  });

  it("revision context is cut into d-long chunks: a clean double upload stays exact when its third copy is revised", () => {
    const first = set(4, 1, 2600);
    const third = copyAt(first, 8).map((p, i) => (i === 1 ? { ...p, rawText: tweak((p.rawText ?? "").split("\n"), 2, "rev").join("\n") } : p));
    const report = detectDuplicates([...first, ...copyAt(first, 4), ...third]);
    expect(report.blocks.map((b) => [b.id, b.tier])).toEqual([["b1d4l4", "exact"], ["b1d8l4", "near"]]);
    expect(bulk(report).map((p) => p.page)).toEqual([5, 6, 7, 8]);
    expect(report.pairs.filter((p) => p.page > 8).every((p) => p.tier === "near")).toBe(true);
  });

  it("M7: unnumbered near-identical repeats form no block (block links need equal non-null numbers)", () => {
    const first = set(4, 1, 2500, { numbered: false });
    const second = copyAt(first, 4).map((p) => ({ ...p, rawText: tweak((p.rawText ?? "").split("\n"), 2, "rev").join("\n") }));
    const report = detectDuplicates([...first, ...second]);
    expect(report.blocks).toEqual([]);
    expect(report.pairs).toHaveLength(4);
    expect(report.pairs.every((p) => p.blockId === null && p.tier === "near" && p.content >= 0.9)).toBe(true);
    expect(bulk(report)).toEqual([]);
  });
});

describe("page-dedup verify-r2 regressions (changed sheet's number missing or misread)", () => {
  const bulk = (r: ReturnType<typeof detectDuplicates>) => r.pairs.filter((p) => bulkTiers().includes(p.tier));
  // a light revision (one changed word) whose extracted number is `drawingNumber`
  const revised = (p: DedupPageInput, drawingNumber: string | null): DedupPageInput => ({
    ...p,
    drawingNumber,
    rawText: tweak((p.rawText ?? "").split("\n"), 2, "revised").join("\n"),
  });
  const permit = set(10, 1, 2700);
  const ifcWith = (at: number[], dn: (i: number) => string | null) => copyAt(permit, 10).map((p, i) => (at.includes(i) ? revised(p, dn(i)) : p));

  it("changed sheet with a null number: the identical re-issues around it are near, nothing bulk", () => {
    const report = detectDuplicates([...permit, ...ifcWith([4], () => null)]);
    expect(report.blocks.map((b) => [b.id, b.tier])).toEqual([["b1d10l4", "near"], ["b6d10l5", "near"]]);
    expect(bulk(report)).toEqual([]);
  });

  it("changed sheet with a misread number (A-104 → A-1O4): a one-slot gap still bridges the run", () => {
    const report = detectDuplicates([...permit, ...ifcWith([4], () => "A-1O4")]);
    expect(report.blocks.map((b) => b.tier)).toEqual(["near", "near"]);
    expect(bulk(report)).toEqual([]);
  });

  it("a REWRITTEN sheet with a misread number (unscored, unlike): a one-slot gap is a changed sheet", () => {
    const ifc = copyAt(permit, 10).map((p, i) => (i === 4 ? page(p.pageNumber, "A-1O4", body(9997)) : p));
    const report = detectDuplicates([...permit, ...ifc]);
    expect(report.blocks.map((b) => b.tier)).toEqual(["near", "near"]);
    expect(bulk(report)).toEqual([]);
  });

  it("lone re-uploads at one offset with unrelated sheets between stay exact (a wide gap needs alike pages)", () => {
    const s8 = set(8, 1, 3100);
    const report = detectDuplicates([...s8, { ...s8[2], pageNumber: 9 }, page(10, "S-1", body(3150)), page(11, "S-2", body(3151)), { ...s8[5], pageNumber: 12 }]);
    expect(report.pairs.map((p) => [p.page, p.canonical, p.tier])).toEqual([[9, 3, "exact"], [12, 6, "exact"]]);
  });

  it("a complete clean copy never grows into an alike neighbour (growth stops at a multiple of d)", () => {
    // page 1 resembles the set's last sheet (page 6), so slot (1, 6) is alike — growing into it
    // would put a "changed" slot in the first chunk and taint the whole clean copy
    const first = set(5, 2, 3200);
    const alike = page(1, "A-200", tweak((first[4].rawText ?? "").split("\n"), 2, "level2"));
    const report = detectDuplicates([alike, ...first, ...copyAt(first, 5)]);
    expect(report.blocks.map((b) => [b.id, b.tier])).toEqual([["b2d5l5", "exact"]]);
    expect(bulk(report)).toHaveLength(5);
  });

  it("misread numbers on the FIRST or LAST sheet: the run grows at its end by the alike slot", () => {
    for (const at of [0, 9]) {
      const report = detectDuplicates([...permit, ...ifcWith([at], (i) => `${num(i)}Q`)]);
      expect(report.blocks).toHaveLength(1);
      expect(report.blocks[0].tier).toBe("near");
      expect(bulk(report)).toEqual([]);
    }
  });

  it("two adjacent misread changed sheets (a wide gap) bridge only while the pages stay alike", () => {
    const report = detectDuplicates([...permit, ...ifcWith([4, 5], (i) => `${num(i)}Q`)]);
    expect(bulk(report)).toEqual([]);
    expect(report.blocks.every((b) => b.tier === "near")).toBe(true);
  });

  it("unnumbered project (non-standard title block): one or three changed sheets → nothing bulk", () => {
    const un = set(10, 1, 2700, { numbered: false });
    for (const at of [[4], [1, 4, 7], [0], [9]]) {
      const ifc = copyAt(un, 10).map((p, i) => (at.includes(i) ? revised(p, null) : p));
      expect(bulk(detectDuplicates([...un, ...ifc]))).toEqual([]);
    }
  });

  it("short unnumbered set uploaded 3×, revised in copy 2 and again in copy 3: unscored-number pairs align the run", () => {
    // copies 6-7, 8-9, 10-11; sheet A revised in copy 2, sheet B in copy 3. The identical pairs
    // (7,9) and (8,10) straddle two copies; only the alike unnumbered pairs (6,8) and (9,11)
    // put the chunk boundary between them.
    const filler = [1, 2, 3, 4, 5].map((n) => page(n, null, body(2800 + n)));
    const a0 = page(6, null, body(2810));
    const b0 = page(7, null, body(2811));
    const a1 = { ...revised(a0, null), pageNumber: 8 };
    const b1 = { ...revised(b0, null), pageNumber: 11 };
    const report = detectDuplicates([...filler, a0, b0, a1, { ...b0, pageNumber: 9 }, { ...a1, pageNumber: 10 }, b1]);
    // 9 is identical to 7, but copy 2 (8-9) revises copy 1 (6-7): it must not be bulk
    expect(bulk(report).map((p) => p.page)).not.toContain(9);
  });

  it("a blank sheet in both copies neither breaks nor taints the run", () => {
    const withBlank = permit.map((p, i) => (i === 3 ? page(p.pageNumber, num(i), []) : p));
    const clean = detectDuplicates([...withBlank, ...copyAt(withBlank, 10)]);
    expect(bulk(clean)).toHaveLength(9);
    const ifc = copyAt(withBlank, 10).map((p, i) => (i === 0 ? revised(p, null) : p)); // blank at 4, changed at 1
    expect(bulk(detectDuplicates([...withBlank, ...ifc]))).toEqual([]);
  });

  it("a clean set with other sheets between the copies stays exact (no growth into unrelated slots)", () => {
    const first = set(5, 1, 2900);
    const others = [6, 7, 8].map((n) => page(n, `S-${n}`, body(2950 + n)));
    const report = detectDuplicates([...first, ...others, ...copyAt(first, 8)]);
    expect(report.blocks.map((b) => [b.id, b.tier])).toEqual([["b1d8l5", "exact"]]);
    expect(bulk(report)).toHaveLength(5);
  });

  it("RESIDUAL (visible decision): a REWRITTEN first sheet whose number is also missing stays outside the run", () => {
    // its text is unlike its earlier copy and it carries no number, so nothing ties it to the
    // set; an unrelated neighbour looks the same. The identical rest stays exact.
    const ifc = copyAt(permit, 10).map((p, i) => (i === 0 ? page(p.pageNumber, null, body(9998)) : p));
    const report = detectDuplicates([...permit, ...ifc]);
    expect(report.blocks.map((b) => [b.id, b.tier])).toEqual([["b2d10l9", "exact"]]);
  });
});

describe("page-dedup mark + cross-project + diff", () => {
  it("getDuplicateOf validates; isHiddenDuplicate needs hiddenAt", () => {
    expect(getDuplicateOf(null)).toBeNull();
    expect(getDuplicateOf({ duplicateOf: { pageNumber: "2", tier: "exact" } })).toBeNull();
    expect(getDuplicateOf({ duplicateOf: { pageNumber: 2, tier: "bogus" } })).toBeNull();
    const mark = { v: 1, pageNumber: 2, tier: "exact", score: 1, content: 1, full: 1, scannedAt: "t" };
    expect(getDuplicateOf({ duplicateOf: mark })).toMatchObject({ pageNumber: 2, tier: "exact" });
    expect(isHiddenDuplicate({ duplicateOf: mark })).toBe(false);
    expect(isHiddenDuplicate({ duplicateOf: { ...mark, hiddenAt: "t2" } })).toBe(true);
  });

  it("cross-project: B a page-for-page copy of A; unrelated C shares nothing", () => {
    const a = set(10, 1, 1400).map((p) => pageTextKey(p.rawText)!);
    const c = set(10, 1, 1500).map((p) => pageTextKey(p.rawText)!);
    const report = crossProjectReport([
      { project: "A", keys: a },
      { project: "B", keys: [...a] },
      { project: "C", keys: c },
    ]);
    expect(report).toEqual([{ a: "A", b: "B", shared: 10, bPages: 10, aPages: 10, copy: true }]);
    expect(pageTextKey("one two")).toBeNull();
  });

  it("lineDiff returns only changed lines", () => {
    const d = lineDiff("same line\nold note here\nend", "same line\nnew note here\nend");
    expect(d).toEqual([{ op: "-", text: "old note here" }, { op: "+", text: "new note here" }]);
  });
});
