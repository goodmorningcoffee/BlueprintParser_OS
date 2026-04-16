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

describe("strictness-mode tier filtering (simulates route behavior)", () => {
  /**
   * The map-tags-batch route applies tier-based post-filter:
   *   strict    → keep tier === "high"
   *   balanced  → keep tier !== "low"
   *   lenient   → keep everything
   * Auto-QTO passes "strict" to reproduce applyExclusionFilter behavior.
   * These tests simulate that filter over findOccurrences output.
   */
  const mkCase = () => {
    // Scatter one match per page at different regions → tiers h/m/l
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),   // drawings → high
      2: mkTextract([mkWord("D-101", 0.5, 0.5)]),   // unclassified → medium
      3: mkTextract([mkWord("D-101", 0.5, 0.5)]),   // tables → low
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({ drawings: [[0.1, 0.1, 0.9, 0.9]] }),
      // page 2: no regions → unclassified
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
    return findOccurrences(item, ctx);
  };

  it("strict mode keeps only tier=high", () => {
    const all = mkCase();
    const strict = all.filter((m) => (m.confidenceTier ?? "high") === "high");
    expect(strict.length).toBe(1);
    expect(strict[0].pageNumber).toBe(1);
    expect(strict[0].signals?.regionType).toBe("drawings");
  });

  it("balanced mode keeps tier != low", () => {
    const all = mkCase();
    const balanced = all.filter((m) => (m.confidenceTier ?? "high") !== "low");
    expect(balanced.length).toBe(2);
    const pages = balanced.map((m) => m.pageNumber).sort();
    expect(pages).toEqual([1, 2]);
  });

  it("lenient mode keeps everything including low-tier", () => {
    const all = mkCase();
    expect(all.length).toBe(3);
    // Low-tier match should carry its dropReason
    const low = all.find((m) => m.confidenceTier === "low");
    expect(low).toBeDefined();
    expect(low!.dropReason).toBe("inside_table");
  });

  it("Auto-QTO parity: strict drops inside_table, inside_title_block, outside_drawings", () => {
    // Scatter 4 matches: one high (drawings), one low (tables),
    // one low (title_block), one low (unclassified but page has drawings).
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),
      2: mkTextract([mkWord("D-101", 0.4, 0.4)]),
      3: mkTextract([mkWord("D-101", 0.05, 0.05)]),
      4: mkTextract([mkWord("D-101", 0.95, 0.95)]),
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({ drawings: [[0.1, 0.1, 0.9, 0.9]] }),
      2: mkRegions({ tables: [[0.3, 0.3, 0.7, 0.7]] }),
      3: mkRegions({
        titleBlocks: [[0.0, 0.0, 0.2, 0.2]],
        drawings: [[0.3, 0.3, 0.9, 0.9]],
      }),
      4: mkRegions({ drawings: [[0.1, 0.1, 0.9, 0.9]] }),
      // Page 4's match at (0.95, 0.95) is OUTSIDE its drawings region (0.1-0.9).
    };
    const ctx: MatchContext = {
      scope: allPagesScope(),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: regions,
      pattern: null,
    };
    const all = findOccurrences(item, ctx);
    expect(all.length).toBe(4);

    // Under strict (tier === "high"), only page 1 survives.
    const strict = all.filter((m) => (m.confidenceTier ?? "high") === "high");
    expect(strict.length).toBe(1);
    expect(strict[0].pageNumber).toBe(1);

    // The three dropped matches carry reasons that aggregate to the same
    // drop categories applyExclusionFilter used to produce.
    const dropped = all.filter((m) => (m.confidenceTier ?? "high") !== "high");
    const reasons = dropped.map((m) => m.dropReason).sort();
    expect(reasons).toContain("inside_table");
    expect(reasons).toContain("inside_title_block");
    expect(reasons).toContain("outside_drawings");
  });
});

describe("Phase 3 — pattern + scope combined", () => {
  it("hard-zeros pattern-mismatch matches when a strong pattern is inferred", () => {
    // Schedule values produce strong pattern D-\d{3}
    const pattern = inferTagPattern(["D-101", "D-102", "D-103", "D-104"]);
    expect(pattern?.strength).toBe("strong");

    // Page 1 has "01" free-floating — the kind of phone-number-like digit
    // that used to over-match when searching for raw "01". With the strong
    // D-\d{3} pattern, searching for the bare "01" label should hard-zero.
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("01", 0.5, 0.5)]),
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
      pattern,
    };
    const results = findOccurrences(
      { itemType: "text-only", label: "01", text: "01" } as CountableItem,
      ctx,
    );
    // itemText "01" doesn't match D-\d{3} → composeScore hard-zeros.
    // findOccurrences still returns the raw match, but tier=low + dropReason.
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.confidenceTier).toBe("low");
      expect(r.dropReason).toBe("pattern_mismatch");
    }
  });

  it("drawing-number-prefix scope drops matches on out-of-scope pages", () => {
    // Same tag present on both pages; scope keeps only E- pages.
    const pattern = inferTagPattern(["D-101", "D-102", "D-103", "D-104"]);
    const textract: Record<number, TextractPageData> = {
      1: mkTextract([mkWord("D-101", 0.5, 0.5)]),
      2: mkTextract([mkWord("D-101", 0.5, 0.5)]),
    };
    const regions: Record<number, ClassifiedPageRegions> = {
      1: mkRegions({ drawings: [[0.1, 0.1, 0.9, 0.9]] }),
      2: mkRegions({ drawings: [[0.1, 0.1, 0.9, 0.9]] }),
    };
    const pageMeta = [
      { pageNumber: 1, drawingNumber: "A-501" },  // excluded
      { pageNumber: 2, drawingNumber: "E-201" },  // allowed
    ];

    const ctx: MatchContext = {
      scope: buildScope({ drawingNumberPrefixes: ["E-"] }, pageMeta),
      isPageScoped: false,
      annotations: [],
      textractData: textract,
      classifiedRegionsByPage: regions,
      pattern,
    };
    const results = findOccurrences(
      { itemType: "text-only", label: "D-101", text: "D-101" } as CountableItem,
      ctx,
    );

    const hi = results.filter((r) => r.confidenceTier === "high");
    expect(hi.length).toBe(1);
    expect(hi[0].pageNumber).toBe(2);

    const pg1 = results.filter((r) => r.pageNumber === 1);
    expect(pg1.length).toBe(1);
    expect(pg1[0].confidenceTier).toBe("low");
    expect(pg1[0].dropReason).toBe("outside_scope");
  });

  it("empty drawingNumberPrefixes (undefined) == no prefix filter, all pages allowed", () => {
    const pageMeta = [
      { pageNumber: 1, drawingNumber: "A-501" },
      { pageNumber: 2, drawingNumber: null },
    ];
    // Phase 3 route passes `undefined` when the UI array is empty.
    const scope = buildScope({ drawingNumberPrefixes: undefined }, pageMeta);
    expect(scope.allowsPage(1)).toBe(true);
    expect(scope.allowsPage(2)).toBe(true);
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
