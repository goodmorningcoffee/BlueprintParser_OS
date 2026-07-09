/**
 * csi-detect.test.ts — CSI detection engine FREEZE-FIRST baselines.
 *
 * [refactor jul9 P2-A C1] Commit C0 of the CSI Option C1 server-half arc
 * (SPEC_FINAL §6.2-1). These tests pin CURRENT engine behavior against the
 * builtin masterformat DB BEFORE the C1 mechanical refactor (csi-database
 * module extraction + optional `db` param). They must stay green, untouched,
 * through C1 — that green-through IS the "byte-identical refactor" proof.
 *
 * All expected values below are characterization pins captured at HEAD
 * 1bfc328 against src/data/csi-masterformat.tsv (8,951 data rows).
 */
import { describe, it, expect } from "vitest";
import { detectCsiCodes } from "@/lib/csi-detect";

// Fixed input: fires Tier 1 ("cast in place concrete" — the TSV description
// "cast-in-place concrete" is hyphen-normalized on the DB side, so the
// spaced form subphrase-matches) plus Tier 2 bag-of-words hits
// (foundation/walls/concrete overlap entries).
const INPUT =
  "Provide cast in place concrete for all foundation walls and footings.";

// The full default-config detection set for INPUT (sorted by code).
// Characterization pin — captured, not designed.
const DEFAULT_CODES = [
  "030130",
  "030130.51",
  "030130.61",
  "030130.71",
  "030130.72",
  "030630",
  "033000",
  "033053",
  "316213.13",
  "316616.23",
  "323213",
];

// Builtin DB scale: unique codes with >= 1 significant word. With a zero
// threshold EVERY such entry passes the confidence gate (bestConf >= 0 is
// always true), so the engine returns the entire database. See the
// "threshold-0 blowup" pin below.
const FULL_PASSTHROUGH_SCALE = 8951;

const codesOf = (results: { code: string }[]) =>
  results.map((r) => r.code).sort();

describe("detectCsiCodes — default-config baselines (builtin DB)", () => {
  it("detects a stable code set for a fixed concrete/foundation input", () => {
    const result = detectCsiCodes(INPUT);
    expect(codesOf(result)).toEqual(DEFAULT_CODES);
  });

  it("returns full CsiCode shape (code/description/trade/division)", () => {
    const result = detectCsiCodes(INPUT);
    const exact = result.find((r) => r.code === "033000");
    expect(exact).toEqual({
      code: "033000",
      description: "cast-in-place concrete",
      trade: "Concrete",
      division: "03 00 00",
    });
  });

  it("returns [] for short input (< 10 chars)", () => {
    expect(detectCsiCodes("abc")).toEqual([]);
    expect(detectCsiCodes("")).toEqual([]);
    expect(detectCsiCodes("123456789")).toEqual([]); // 9 chars — under the gate
  });
});

describe("detectCsiCodes — threshold lever", () => {
  it("matchingConfidenceThreshold: 0.99 yields a subset of the default result (empty here — max tier conf is 0.95*0.8)", () => {
    const strict = detectCsiCodes(INPUT, undefined, {
      matchingConfidenceThreshold: 0.99,
    });
    const defaults = new Set(codesOf(detectCsiCodes(INPUT)));
    for (const r of strict) expect(defaults.has(r.code)).toBe(true); // subset
    expect(strict).toEqual([]); // nothing can reach 0.99 confidence
  });

  it("threshold-0 blowup pin: {matchingConfidenceThreshold: 0} returns the ENTIRE builtin DB", () => {
    // [refactor jul9 P2-A C1] This pin documents WHY invariant I-10 exists
    // (SPEC_FINAL §0, C3-F-2): a non-positive threshold makes the gate
    // `bestConf < threshold` unpassable-to-fail, so every entry with at
    // least one significant word is returned — whole-DB output per call,
    // O(entries × pageWords) work on the ingest hot path. C3's
    // pickEngineConfig drops non-positive STORED thresholds and C5's zod
    // `.positive()` rejects them at the PUT, making this unreachable via
    // company config. The engine-level behavior itself is pinned here and
    // deliberately NOT "fixed" — direct callers passing an explicit config
    // keep byte-identical behavior.
    const all = detectCsiCodes(INPUT, undefined, {
      matchingConfidenceThreshold: 0,
    });
    expect(all.length).toBe(FULL_PASSTHROUGH_SCALE);
  });
});

describe("detectCsiCodes — tier1WeightByWordCount all-or-nothing spread semantics", () => {
  // "gypsum sheathing" (code 061643) has exactly 2 significant words. Under
  // the default weights [0, 0.01, 0.19, 0.80, 0.80, 0.80] its Tier 1 conf is
  // 0.95 * 0.19 = 0.1805 < 0.4 threshold, and Tier 2/3 word-count gates
  // (>= 3 / >= 5) skip it entirely — so it is NOT detected by default.
  const GYPSUM_INPUT = "Install gypsum sheathing on exterior stud walls.";

  it("default: 2-significant-word entries are down-weighted below threshold", () => {
    expect(codesOf(detectCsiCodes(GYPSUM_INPUT))).toEqual([]);
  });

  it("a partial array REPLACES the whole default array (shallow config spread), with last-value fallback", () => {
    // [refactor jul9 P2-A C1] All-or-nothing pin (SPEC_FINAL §6.2-1): the
    // engine merges config with `{...DEFAULT_CONFIG, ...config}` — a partial
    // tier1WeightByWordCount array replaces the ENTIRE default array, it is
    // never index-merged. With [0, 0.9], wordCount 2 >= array length so the
    // LAST value (0.9) applies: 0.95 * 0.9 = 0.855 >= 0.4 → detected.
    // If the array were index-merged with the default, index 2 would have
    // stayed 0.19 and this input would still detect nothing.
    const partial = detectCsiCodes(GYPSUM_INPUT, undefined, {
      tier1WeightByWordCount: [0, 0.9],
    });
    expect(codesOf(partial)).toEqual(["061600", "061643"]);

    // Equivalence with the explicit full-length array — proves the partial
    // array's last-value fallback covers all higher word counts.
    const explicitFull = detectCsiCodes(GYPSUM_INPUT, undefined, {
      tier1WeightByWordCount: [0, 0.9, 0.9, 0.9, 0.9, 0.9],
    });
    expect(partial).toEqual(explicitFull);
  });
});

describe("detectCsiCodes — pathological weights are blowup-free (weights stay type-only in the PUT schema)", () => {
  // [refactor jul9 P2-A C1] SPEC_FINAL §6.2-1 / C3-F-2 / §9 R-3: these pins
  // prove that zero/negative WEIGHTS are safe (empty-or-reduced results, no
  // throw, no whole-DB blowup) — which is why C5's zod schema constrains only
  // matchingConfidenceThreshold (.positive(), I-10) and leaves the weights
  // type-only (the admin UI sliders legitimately emit 0).

  it("tier2Weight: 0 — tier 2 disabled, result reduced to the pure Tier-1 hit, no throw", () => {
    const result = detectCsiCodes(INPUT, undefined, { tier2Weight: 0 });
    expect(codesOf(result)).toEqual(["033000"]);
  });

  it("tier3Weight: -1 — tier 3 disabled, no throw; this input never relied on tier 3", () => {
    const result = detectCsiCodes(INPUT, undefined, { tier3Weight: -1 });
    expect(codesOf(result)).toEqual(DEFAULT_CODES);
  });

  it("tier1WeightByWordCount all zeros — tier 1 suppressed, tier 2 still rescues, no throw", () => {
    const result = detectCsiCodes(INPUT, undefined, {
      tier1WeightByWordCount: [0, 0, 0, 0, 0],
    });
    expect(codesOf(result)).toEqual(DEFAULT_CODES);
  });

  it("all three pathological weights combined — empty result, no throw", () => {
    const result = detectCsiCodes(INPUT, undefined, {
      tier2Weight: 0,
      tier3Weight: -1,
      tier1WeightByWordCount: [0, 0, 0, 0, 0],
    });
    expect(result).toEqual([]);
  });
});
