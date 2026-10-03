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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbbreviations, significant } from "../../../eval/csi/build-lexicon";

const ABBR_SRC = join(process.cwd(), "src/lib/detectors/abbreviations.ts");

// The S6 "lexicon gap findings" block that read eval/csi/lexicon-gap.json is gone with that
// file: the gap analysis was computed over a client corpus and stays private (eval/csi/README.md).

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
