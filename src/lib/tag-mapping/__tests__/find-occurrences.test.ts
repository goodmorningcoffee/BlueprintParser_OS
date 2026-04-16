/**
 * find-occurrences.test.ts — integration test for the tag-mapping orchestrator.
 *
 * Verifies end-to-end behavior with fixture Textract + annotations + regions:
 *   - Type 2 (free-floating text) matches inside title_block → tier=low
 *     with dropReason=inside_title_block (NOT missing, so audit can surface)
 *   - Type 2 matches inside drawings → tier=high
 *   - Scope filter blocks matches on out-of-scope pages
 *   - Strong pattern hard-zeros mismatches
 *   - Weak pattern attenuates but keeps
 *   - Legacy findItemOccurrences shim preserves pre-refactor output
 */

import { describe, it, expect } from "vitest";
import type {
  ClientAnnotation,
  TextractPageData,
  ClassifiedPageRegions,
} from "@/types";
import { findOccurrences } from "../find-occurrences";
import { inferTagPattern } from "../primitives/pattern-infer";
import { buildScope, allPagesScope } from "../primitives/scope";
import { findItemOccurrences as legacyFindItemOccurrences } from "@/lib/yolo-tag-engine";
import type { CountableItem, MatchContext } from "../types";

function mkWord(text: string, x: number, y: number, w = 0.03, h = 0.015) {
  return { text, confidence: 0.99, bbox: [x, y, w, h] as [number, number, number, number] };
}

function mkTextract(words: ReturnType<typeof mkWord>[]): TextractPageData {
  return { words, lines: [] };
}

function mkRegions(
  overrides: Partial<{
    drawings: Array<[number, number, number, number]>;
    tables: Array<[number, number, number, number]>;
    titleBlocks: Array<[number, number, number, number]>;
  }> = {},
): ClassifiedPageRegions {
  const make = (bboxes: Array<[number, number, number, number]> | undefined, kind: "table" | "title_block" | "drawings") =>
    (bboxes ?? []).map((b) => ({
      kind,
      bbox: b,
      confidence: 0.9,
      sources: ["yolo:drawings" as const],
      pageNumber: 1,
    }));
  return {
    drawings: make(overrides.drawings, "drawings"),
    tables: make(overrides.tables, "table"),
    titleBlocks: make(overrides.titleBlocks, "title_block"),
  };
}

const item: CountableItem = {
  itemType: "text-only",
  label: "Door D-101",
  text: "D-101",
};

describe("findOccurrences — text-only (Type 2)", () => {
  it("finds a free-floating text match and assigns tier=high in drawings region", () => {
    // Textract splits "D-101" into words. Match via multi-word sliding window.
    // Reality check: Textract may emit "D" + "101" or "D-101" depending on font/spacing.
    // Simulate the single-word path (more common when the tag is compact):
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({ drawings: [[0.1, 0.1, 0.9, 0.9]] }),
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: regions,
      pattern: null,
    };
    const results = findOccurrences(item, ctx);
    expect(results.length).toBe(1);
    expect(results[0].confidenceTier).toBe("high");
    expect(results[0].signals?.regionType).toBe("drawings");
    expect(results[0].dropReason).toBeUndefined();
  });

  it("match inside title_block gets tier=low with inside_title_block reason", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.05, 0.05)]),
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({
        titleBlocks: [[0.0, 0.0, 0.2, 0.2]],
        drawings: [[0.3, 0.3, 0.9, 0.9]],
      }),
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: regions,
      pattern: null,
    };
    const results = findOccurrences(item, ctx);
    expect(results.length).toBe(1);
    expect(results[0].confidenceTier).toBe("low");
    expect(results[0].dropReason).toBe("inside_title_block");
  });

  it("match inside tables gets tier=low with inside_table reason", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.4, 0.4)]),
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({ tables: [[0.3, 0.3, 0.7, 0.7]] }),
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: regions,
      pattern: null,
    };
    const results = findOccurrences(item, ctx);
    expect(results.length).toBe(1);
    expect(results[0].confidenceTier).toBe("low");
    expect(results[0].dropReason).toBe("inside_table");
  });

  it("match inside both tables AND drawings resolves to tables (precedence)", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.4, 0.4)]),
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({
        tables: [[0.0, 0.0, 0.9, 0.9]],
        drawings: [[0.0, 0.0, 0.9, 0.9]],
      }),
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: regions,
      pattern: null,
    };
    const results = findOccurrences(item, ctx);
    expect(results.length).toBe(1);
    expect(results[0].signals?.regionType).toBe("tables");
    expect(results[0].dropReason).toBe("inside_table");
  });

  it("match with no region data gets unclassified tier=medium", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: {},   // no regions
      pattern: null,
    };
    const results = findOccurrences(item, ctx);
    expect(results.length).toBe(1);
    expect(results[0].confidenceTier).toBe("medium");
    expect(results[0].signals?.regionType).toBe("unclassified");
    expect(results[0].dropReason).toBeUndefined();
  });

  it("scope filter blocks matches on out-of-scope pages", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),
      2: mkTextract([mkWord("D-101", 0.5, 0.5)]),
    };
    const scope = buildScope(
      { pages: [2] },   // only page 2 allowed
      [
        { pageNumber: 1, drawingNumber: "A-100" },
        { pageNumber: 2, drawingNumber: "E-100" },
      ],
    );
    const ctx: MatchContext = {
      scope,
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: {},
      pattern: null,
    };
    const results = findOccurrences(item, ctx);
    // Both matches returned, but page 1's has scopeMatch=false → score=0
    const page1 = results.find((r) => r.pageNumber === 1);
    const page2 = results.find((r) => r.pageNumber === 2);
    expect(page1?.dropReason).toBe("outside_scope");
    expect(page1?.score).toBe(0);
    expect(page2?.dropReason).toBeUndefined();
    expect(page2?.score).toBeGreaterThan(0);
  });

  it("strong pattern hard-zeros when item text does not match", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-999", 0.5, 0.5)]),
    };
    // Pattern inferred from column ["D-101","D-102","D-103"] → strong ^D-\d{3}$
    // Item text is "D-999" which MATCHES the pattern → no hard-zero for this.
    // Flip it: item "999" against pattern "^D-\d{3}$" → mismatch
    const pattern = inferTagPattern(["D-101", "D-102", "D-103", "D-104"])!;
    const mismatchedItem: CountableItem = {
      itemType: "text-only",
      label: "tag 999",
      text: "999",   // doesn't match D-\d{3}
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: {},
      pattern,
    };
    const results = findOccurrences(mismatchedItem, ctx);
    // No matches because "999" ≠ Textract word "D-999" anyway, so results=[]
    // Rerun with textract word "999" to exercise the pattern hard-zero
    const textract2: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("999", 0.5, 0.5)]),
    };
    const ctx2 = { ...ctx, textractData: textract2 };
    const results2 = findOccurrences(mismatchedItem, ctx2);
    expect(results2.length).toBe(1);
    expect(results2[0].score).toBe(0);
    expect(results2[0].dropReason).toBe("pattern_mismatch");
  });

  it("weak pattern mismatch attenuates but does not hard-zero", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("XY", 0.5, 0.5)]),
    };
    // Weak pattern from ["01", "02", "03"] → ^\d{2}$
    const pattern = inferTagPattern(["01", "02", "03", "04", "05"])!;
    expect(pattern.strength).toBe("weak");
    const itemWeakMiss: CountableItem = {
      itemType: "text-only",
      label: "XY",
      text: "XY",   // won't match ^\d{2}$
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: {},
      pattern,
    };
    const results = findOccurrences(itemWeakMiss, ctx);
    expect(results.length).toBe(1);
    // Unclassified region weight 0.5 × weakPatternAttenuation 0.7 = 0.35 → medium
    expect(results[0].score).toBeCloseTo(0.35, 2);
    expect(results[0].confidenceTier).toBe("medium");
    expect(results[0].dropReason).toBeUndefined();
  });
});

describe("findOccurrences — ranking", () => {
  it("sorts matches by score descending", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),
      2: mkTextract([mkWord("D-101", 0.1, 0.1)]),
      3: mkTextract([mkWord("D-101", 0.5, 0.5)]),
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({ drawings: [[0.1, 0.1, 0.9, 0.9]] }),
      2: mkRegions({ titleBlocks: [[0.0, 0.0, 0.2, 0.2]] }),
      3: mkRegions({ tables: [[0.3, 0.3, 0.7, 0.7]] }),
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: regions,
      pattern: null,
    };
    const results = findOccurrences(item, ctx);
    expect(results.length).toBe(3);
    // Order: drawings (1.0) > tables (0.3) > title_block (0.05)
    expect(results[0].pageNumber).toBe(1);
    expect(results[1].pageNumber).toBe(3);
    expect(results[2].pageNumber).toBe(2);
  });
});

describe("legacy findItemOccurrences shim", () => {
  it("returns YoloTagInstance[] with narrow fields preserved", () => {
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),
    };
    const annotations: ClientAnnotation[] = [];
    const results = legacyFindItemOccurrences(
      item as CountableItem,
      "project",
      undefined,
      annotations,
      textract,
    );
    expect(results.length).toBe(1);
    expect(results[0].pageNumber).toBe(1);
    expect(results[0].annotationId).toBe(-1);
    expect(results[0].bbox.length).toBe(4);
    expect(results[0].confidence).toBe(1.0);
    // Legacy consumer can still treat this as YoloTagInstance;
    // scoring fields are present but ignored
  });
});
