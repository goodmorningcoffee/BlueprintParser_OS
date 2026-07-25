/**
 * csi-kb.test.ts — pins the knowledge base's code-key canonicalization and stats.
 *
 * [csi-rebuild S5] `canonCode` exists because three published numbers in the S4
 * audit were wrong, and all three came from re-improvising key normalization at
 * each call site rather than having one function. The failures were invisible —
 * no error, no crash, just counts that were off by 300.
 *
 * These tests exist so that never recurs silently. If the KB's inputs or the key
 * rule change, the counts move and this file says so.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonCode } from "../../../eval/csi/build-kb";

const STATS = join(process.cwd(), "eval/csi/kb-stats.json");

interface Stats {
  schemaVersion: string;
  vocabulary: {
    entries: number;
    distinctTokens: number;
    codesGainingAlternates: number;
    newSignificantWordsFromAlternates: number;
  };
  reachability: {
    unreachableCanonicalOnly: number;
    unreachableWithAlternates: number;
    rescuedByAlternates: number;
  };
}
const stats = () => JSON.parse(readFileSync(STATS, "utf-8")) as Stats;

describe("canonCode — the single code key", () => {
  it("collapses every separator style", () => {
    for (const v of ["08 71 00", "087100", "08-71-00", "08.71.00"]) expect(canonCode(v)).toBe("087100");
  });

  it("keeps level-4 siblings distinct", () => {
    expect(canonCode("07 42 13")).toBe("074213");
    expect(canonCode("07 42 13.16")).toBe("07421316");
    expect(canonCode("07 42 13.16")).not.toBe(canonCode("07 42 13"));
  });

  it("pads an UNPADDED leading division — csi.tsv has 29 such rows", () => {
    // '7 16 13' is Division 07, not a phantom division 71. Naive space-stripping
    // invented divisions 71/72/81/83/85 and hid real matches.
    expect(canonCode("7 16 13")).toBe("071613");
    expect(canonCode("7 16 13")).toBe(canonCode("07 16 13"));
    expect(canonCode("8 34 63")).toBe("083463");
  });

  it("does not mangle an already-padded code that starts with 0", () => {
    expect(canonCode("07 16 13")).toBe("071613");
    expect(canonCode("00 00 00")).toBe("000000");
  });

  it("leaves a bare single number alone rather than guessing", () => {
    // No separator means no division/section structure to infer.
    expect(canonCode("7")).toBe("7");
  });
});

describe("KB stats", () => {
  it("exists and is the expected schema", () => {
    expect(existsSync(STATS), `missing ${STATS} — run eval/csi/build-kb.ts`).toBe(true);
    expect(stats().schemaVersion).toBe("csi-kb-stats/1");
  });

  it("covers the whole database", () => {
    expect(stats().vocabulary.entries).toBe(8951);
  });

  it("alternates add real vocabulary — the free half of the lexicon work", () => {
    const v = stats().vocabulary;
    expect(v.codesGainingAlternates).toBeGreaterThan(1000);
    expect(v.newSignificantWordsFromAlternates).toBeGreaterThan(1500);
  });

  it("alternates do NOT solve reachability — that is a scoring problem", () => {
    // The load-bearing conclusion of S4/S5. If a future change makes this test
    // fail because `rescued` jumped, the vocabulary story changed and the P2
    // plan needs revisiting — do not just update the number.
    const r = stats().reachability;
    expect(r.unreachableCanonicalOnly).toBe(2362);
    const share = r.rescuedByAlternates / r.unreachableCanonicalOnly;
    expect(share).toBeLessThan(0.15);
    expect(r.unreachableWithAlternates).toBeGreaterThan(2000);
  });
});
