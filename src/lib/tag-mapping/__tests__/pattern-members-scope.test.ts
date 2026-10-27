/**
 * [table pipeline WP-2.C] K10 — the inferred tag pattern never hard-zeroes the schedule's own members;
 * K37 — the "Unnumbered" scope chip (prefix "") selects the unnumbered pages, not every numbered one.
 * Synthetic tags only (rule 12).
 */
import { describe, expect, it } from "vitest";
import type { ClassifiedPageRegions, TextractPageData } from "@/types";
import { findOccurrences } from "../find-occurrences";
import { inferTagPattern, patternAccepts } from "../primitives/pattern-infer";
import { allPagesScope, buildScope } from "../primitives/scope";
import type { CountableItem, MatchContext, PageMeta } from "../types";

const EF = Array.from({ length: 12 }, (_, i) => `EF-${i + 1}`);

function mkWord(text: string, x: number, y: number) {
  return { text, confidence: 0.99, bbox: [x, y, 0.03, 0.015] as [number, number, number, number] };
}

const drawings = (): ClassifiedPageRegions => ({
  drawings: [{ kind: "drawings", bbox: [0.05, 0.05, 0.95, 0.95], confidence: 0.9, sources: ["yolo:drawings"], pageNumber: 1 }],
  tables: [],
  titleBlocks: [],
});

describe("K10: the schedule's own minority-format tags are never pattern-zeroed", () => {
  it("EF-1…EF-9 + EF-10…EF-12 infers the single-digit majority pattern, which accepts every member", () => {
    const p = inferTagPattern(EF)!;
    expect(p.strength).toBe("strong");
    expect(p.pattern.test("EF-10")).toBe(false); // the majority format alone would reject the minority members
    for (const t of EF) expect(patternAccepts(p, t), t).toBe(true);
    expect(patternAccepts(p, " ef-11 ")).toBe(true); // normalised like the caller's item text
    expect(patternAccepts(p, "EF-13")).toBe(false); // a non-member still has to fit the pattern
    expect(patternAccepts(p, "EF-7")).toBe(true);
    expect(patternAccepts({ pattern: /^Q\d$/, strength: "strong" }, "Q4")).toBe(true); // a pattern without members
  });

  it("EF-1…EF-12 all map under the strong pattern; a non-member that misses it is still hard-zeroed", () => {
    const words = EF.map((t, i) => mkWord(t, 0.1 + (i % 6) * 0.12, 0.2 + Math.floor(i / 6) * 0.2));
    words.push(mkWord("EF-123", 0.5, 0.8));
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: { 1: { words, lines: [] } as TextractPageData },
      classifiedRegionsByPage: { 1: drawings() },
      pattern: inferTagPattern(EF),
    };
    for (const tag of EF) {
      const hits = findOccurrences({ itemType: "text-only", label: tag, text: tag } as CountableItem, ctx);
      // fuzzy neighbours (EF-1 ~ EF-10) may add 0.9-confidence hits; the exact one is what K10 zeroed
      const exact = hits.filter((h) => h.confidence === 1);
      expect(exact.length, tag).toBe(1);
      expect(exact[0].dropReason, tag).toBeUndefined();
      expect(exact[0].score, tag).toBeGreaterThan(0);
      expect(hits.some((h) => h.dropReason === "pattern_mismatch"), tag).toBe(false);
    }
    const stray = findOccurrences({ itemType: "text-only", label: "EF-123", text: "EF-123" } as CountableItem, ctx);
    expect(stray.length).toBeGreaterThan(0);
    for (const h of stray) {
      expect(h.score).toBe(0);
      expect(h.dropReason).toBe("pattern_mismatch");
    }
  });
});

describe("K37: drawing-number prefix scope", () => {
  const pages: PageMeta[] = [
    { pageNumber: 1, drawingNumber: "A-101" },
    { pageNumber: 2, drawingNumber: "M-201" },
    { pageNumber: 3, drawingNumber: null },
    { pageNumber: 4, drawingNumber: "" },
    { pageNumber: 5, drawingNumber: "101" },
    { pageNumber: 6, drawingNumber: "a-102" },
  ];
  const allowed = (prefixes: string[]): number[] => buildScope({ drawingNumberPrefixes: prefixes }, pages).filterPageNumbers(pages.map((p) => p.pageNumber));

  it('"Unnumbered" (prefix "") selects the pages the chip groups there: no number, empty, or digit-first', () => {
    expect(allowed([""])).toEqual([3, 4, 5]);
  });

  it("a letter prefix keeps its starts-with rule (case-insensitive) and rejects unnumbered pages", () => {
    expect(allowed(["A-"])).toEqual([1, 6]);
    expect(allowed(["m-"])).toEqual([2]);
  });

  it("chips combine as a union, and explicit pages still intersect", () => {
    expect(allowed(["A-", ""])).toEqual([1, 3, 4, 5, 6]);
    expect(buildScope({ drawingNumberPrefixes: [""], pages: [1, 3] }, pages).filterPageNumbers([1, 2, 3, 4, 5, 6])).toEqual([3]);
    expect(buildScope({}, pages).filterPageNumbers([1, 2])).toEqual([1, 2]);
  });

  it("a page missing from the page metadata is denied by any prefix filter", () => {
    expect(buildScope({ drawingNumberPrefixes: [""] }, pages).allowsPage(99)).toBe(false);
  });
});
