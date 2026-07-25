/**
 * csi-reachability.test.ts — how much of MasterFormat the engine can NEVER emit.
 *
 * [csi-rebuild P1.2a] This pins a DEFECT, not a desired property. At default
 * config a code fires Tier 1 at `0.95 × tier1WeightByWordCount[n]`, and Tiers 2
 * and 3 are gated at `wordCount >= 3` / `>= 5`. So an entry whose title has
 * fewer than 3 significant words scores at most `0.95 × 0.19 = 0.1805` against a
 * `0.4` threshold and clears no other tier — it is unreachable for ANY input.
 *
 * Plan 2 §1 called this BRITTLE-1 and gave three examples. This is the census,
 * computed from the live database through the live parser rather than restated
 * from a document.
 *
 * WHY IT IS A TEST: `eval/csi/GRANULARITY_RUBRIC.md` §2.1 tells the gold-set
 * labeler this blind spot exists and how big it is, and the labeler is
 * instructed to label TRUE content regardless. A number quoted in a markdown
 * file and verified nowhere would drift away from the code the first time
 * anyone touches the weights.
 *
 * P2 MUST BREAK THIS TEST. Making these codes reachable is the point of the
 * rebuild. When it does, update the numbers here in the same commit and record
 * the new census — the delta is the headline result.
 */
import { describe, it, expect } from "vitest";
import { loadBuiltinCsiDatabase } from "@/lib/csi-database";
import { DEFAULT_CSI_DETECT_CONFIG } from "@/lib/csi-detect-defs";

/**
 * Can this entry clear the confidence threshold under ANY input?
 *
 * Mirrors the gates in detectCsiCodes: best case is every word present, so
 * Tier 2 reaches `1² × tier2Weight` and Tier 3 reaches `1 × tier3Weight`, each
 * behind its own word-count gate; Tier 1's ceiling is the weight for that word
 * count. If none clears the threshold, no page can ever surface the code.
 */
function isReachable(wordCount: number): boolean {
  const cfg = DEFAULT_CSI_DETECT_CONFIG;
  const w = cfg.tier1WeightByWordCount;
  const tier1 = 0.95 * (wordCount < w.length ? w[wordCount] : w[w.length - 1]);
  const tier2 = wordCount >= cfg.tier2MinWords ? cfg.tier2Weight : 0;
  const tier3 = wordCount >= cfg.tier3MinWords ? cfg.tier3Weight : 0;
  // The multi-tier boost only applies once something already scored, so the
  // ceiling is the max of the three.
  return Math.max(tier1, tier2, tier3) >= cfg.matchingConfidenceThreshold;
}

describe("MasterFormat reachability under the default config", () => {
  it("a quarter of the database can never be emitted, for any input", () => {
    const db = loadBuiltinCsiDatabase();
    expect(db.entries.length).toBe(8951);

    const unreachable = db.entries.filter(e => !isReachable(e.wordCount));
    expect(unreachable).toHaveLength(2362);
    expect(unreachable.length / db.entries.length).toBeCloseTo(0.264, 3);
  });

  it("the boundary is exactly 'fewer than 3 significant words'", () => {
    const db = loadBuiltinCsiDatabase();
    for (const e of db.entries) {
      expect(isReachable(e.wordCount), `${e.code} "${e.description}" (${e.wordCount} words)`).toBe(
        e.wordCount >= 3,
      );
    }
  });

  it("everyday interior systems are among the unreachable", () => {
    const db = loadBuiltinCsiDatabase();
    const byCode = new Map(db.entries.map(e => [e.code, e]));
    // The codes GRANULARITY_RUBRIC.md §2.1 quotes. If any becomes reachable,
    // the rubric's worked example A is out of date too.
    for (const code of ["099100", "099123", "092900", "095100", "093000", "062200", "061000"]) {
      const e = byCode.get(code);
      expect(e, `${code} missing from the builtin DB`).toBeDefined();
      expect(isReachable(e!.wordCount), `${code} "${e!.description}" is now reachable`).toBe(false);
    }
  });

  it("the blind spot is division-skewed, which is what makes misses biased", () => {
    // plan 2 §0 requires misses be division-UNBIASED. They are not: the share of
    // unreachable codes ranges from ~10% to 60% across divisions, so the engine's
    // recall failures concentrate in specific trades. This is the measured basis
    // for the gold set's stratification rule (LABELING_PROTOCOL §3.1).
    const db = loadBuiltinCsiDatabase();
    const tally = new Map<string, { total: number; unreachable: number }>();
    for (const e of db.entries) {
      const d = e.code.slice(0, 2);
      const t = tally.get(d) ?? { total: 0, unreachable: 0 };
      t.total++;
      if (!isReachable(e.wordCount)) t.unreachable++;
      tally.set(d, t);
    }

    const furnishings = tally.get("12")!;
    expect(furnishings.total).toBe(280);
    expect(furnishings.unreachable).toBe(169);
    expect(furnishings.unreachable / furnishings.total).toBeGreaterThan(0.55);

    // The spread across substantial divisions is what "biased" means here.
    const shares = [...tally.values()]
      .filter(t => t.total >= 50)
      .map(t => t.unreachable / t.total);
    expect(Math.max(...shares) - Math.min(...shares)).toBeGreaterThan(0.3);
  });
});
