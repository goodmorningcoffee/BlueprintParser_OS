/**
 * csi-lexicon.test.ts — pins what the lexicon analysis established, including
 * the negative result.
 *
 * [csi-rebuild S6] The useful output of S6 is partly a refutation: ranking
 * unknown corpus words by frequency does NOT produce an authoring queue, because
 * the top of that ranking is title-block boilerplate the KB should never learn.
 * That conclusion is worth pinning — the temptation to "just use the frequent
 * words" will recur, and the evidence against it should not have to be
 * rediscovered.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbbreviations, significant } from "../../../eval/csi/build-lexicon";

const GAP = join(process.cwd(), "eval/csi/lexicon-gap.json");
const ABBR_SRC = join(process.cwd(), "src/lib/detectors/abbreviations.ts");

interface Gap {
  schemaVersion: string;
  abbreviations: {
    total: number;
    expansionResolvesToCodes: number;
    tradeIsUseless: { general: number };
  };
  frequencyBands: { band: string; unknownWords: number; sample: string[] }[];
  verdictOnFrequencyRanking: string;
  coverage: { vocabularyCoverage: number };
}
const gap = () => JSON.parse(readFileSync(GAP, "utf-8")) as Gap;

describe("abbreviation parsing", () => {
  it("reads the module-private dictionary out of the detector source", () => {
    // Parsed rather than imported on purpose: exporting a private singleton to
    // serve a measurement would change production code for an analysis.
    const abbrs = parseAbbreviations(readFileSync(ABBR_SRC, "utf-8"));
    expect(abbrs.length).toBeGreaterThan(200);
    const cmu = abbrs.find(a => a.abbr === "CMU");
    expect(cmu?.meaning.toLowerCase()).toContain("masonry");
  });

  it("survives entries with punctuation in the abbreviation", () => {
    const abbrs = parseAbbreviations(readFileSync(ABBR_SRC, "utf-8"));
    expect(abbrs.every(a => a.abbr.length > 0 && a.meaning.length > 0)).toBe(true);
  });

  it("tokenizes expansions the way the KB does", () => {
    expect(significant("Concrete Masonry Unit")).toEqual(["concrete", "masonry", "unit"]);
    // stop words and short tokens dropped, matching csi-database.ts
    expect(significant("Above Finished Floor")).toEqual(["above", "finished", "floor"]);
  });
});

describe("lexicon gap findings", () => {
  it("exists and is the expected schema", () => {
    expect(existsSync(GAP), `missing ${GAP} — run eval/csi/build-lexicon.ts`).toBe(true);
    expect(gap().schemaVersion).toBe("csi-lexicon-gap/1");
  });

  it("confirms plan 2's claim that the abbreviation trade enum cannot drive CSI mapping", () => {
    const a = gap().abbreviations;
    // plan 2 §3 predicted this; it is true — the enum is nearly constant.
    expect(a.tradeIsUseless.general / a.total).toBeGreaterThan(0.7);
  });

  it("a useful minority of abbreviations DO resolve via their expansion", () => {
    const a = gap().abbreviations;
    expect(a.expansionResolvesToCodes).toBeGreaterThan(50);
    expect(a.expansionResolvesToCodes).toBeLessThan(a.total);
  });

  it("PINS THE NEGATIVE RESULT: frequency ranking surfaces boilerplate, not materials", () => {
    // The saturated band must contain title-block words, and it must be tiny —
    // that shape is the whole argument. If a future corpus changes it, the
    // conclusion needs re-deriving rather than the number being edited.
    const g = gap();
    expect(g.verdictOnFrequencyRanking).toMatch(/UNUSABLE/);

    const top = g.frequencyBands.find(b => b.band.startsWith(">=80"))!;
    const next = g.frequencyBands.find(b => b.band === "40-80%")!;
    const boilerplate = [...top.sample, ...next.sample];
    // These are exactly what rubric R6 excludes from scope.
    expect(boilerplate.some(w => ["date", "scale", "issued", "dwg"].includes(w))).toBe(true);

    // And material vocabulary is NOT at the top: the saturated bands are far
    // smaller than the low-frequency ones where real terms live.
    const low = g.frequencyBands.find(b => b.band === "2-5%")!;
    expect(low.unknownWords).toBeGreaterThan(top.unknownWords * 100);
  });

  it("records vocabulary coverage WITH the caveat that makes it readable", () => {
    // 6.5% sounds catastrophic and is not, because the denominator is dominated
    // by OCR noise and boilerplate. The number is kept; so is the warning.
    const g = gap();
    expect(g.coverage.vocabularyCoverage).toBeGreaterThan(0);
    expect(g.coverage.vocabularyCoverage).toBeLessThan(0.2);
  });
});
