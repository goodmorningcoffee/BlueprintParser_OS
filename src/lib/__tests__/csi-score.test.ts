/**
 * csi-score.test.ts — the scorer is the instrument; these are its calibration checks.
 *
 * [csi-rebuild S2] `eval/csi/score.ts` decides whether the rebuilt tagger beats the
 * old one. Every property below is one where a silent error would produce a
 * plausible-looking number that is wrong in a specific, motivated direction.
 *
 * Written as unit tests on the exported pure functions rather than on the CLI,
 * because the failure modes are arithmetic, not plumbing.
 */
import { describe, it, expect } from "vitest";
import {
  section, exact, division, fbeta, scorePage, aggregate, perDivisionRollup, isCertifiedPage,
} from "../../../eval/csi/score";

const G = (id: string, div: string, codes: string[], tier: "primary" | "secondary" | "tertiary" = "primary") => ({
  id,
  tier,
  division: div,
  codes,
});
const page = (over: Record<string, unknown> = {}) => ({ bundle: "b", page: 1, reviewed_by: null, ...over });

describe("code canonicalization (§5.2)", () => {
  it("collapses every separator style to the same key", () => {
    for (const variant of ["08 71 00", "087100", "08-71-00", "08.71.00"]) {
      expect(exact(variant)).toBe("087100");
      expect(section(variant)).toBe("0871");
      expect(division(variant)).toBe("08");
    }
  });

  it("SECTION keeps siblings together, EXACT keeps them apart", () => {
    expect(section("07 42 13")).toBe(section("07 42 13.16"));
    expect(exact("07 42 13")).not.toBe(exact("07 42 13.16"));
  });
});

describe("F-beta (§11.1, beta=0.5)", () => {
  it("weights PRECISION above recall — if this inverts, the whole target inverts", () => {
    expect(fbeta(0.9, 0.1, 0.5)).toBeGreaterThan(fbeta(0.1, 0.9, 0.5));
  });

  it("is symmetric at beta=1 and recall-weighted at beta=2 (direction sanity)", () => {
    expect(fbeta(0.9, 0.1, 1)).toBeCloseTo(fbeta(0.1, 0.9, 1), 10);
    expect(fbeta(0.1, 0.9, 2)).toBeGreaterThan(fbeta(0.9, 0.1, 2));
  });

  it("is 0 when both inputs are 0 rather than NaN", () => {
    expect(fbeta(0, 0, 0.5)).toBe(0);
  });
});

describe("TP/FP classification (§5.0)", () => {
  const gold = [G("door_hardware", "08", ["08 71 00"])];

  it("a section match is a true positive", () => {
    const s = scorePage(gold, page(), ["08 71 13"], "section", 1);
    expect(s.tp).toEqual(["0871"]);
    expect(s.fpUnadjudicated).toEqual([]);
  });

  it("an unmatched code in an acceptable division is UNADJUDICATED, not a hard FP", () => {
    // This distinction is the point of §5.0's fourth row: gold incompleteness,
    // not the tagger, may be at fault. Collapsing it into `hard` would blame the
    // engine for codes no labeler happened to consider.
    const s = scorePage(gold, page({ acceptable_divisions: ["08", "09"] }), ["09 29 00"], "section", 1);
    expect(s.fpUnadjudicated).toEqual(["0929"]);
    expect(s.fpHard).toEqual([]);
    expect(s.fpCrossDivision).toEqual([]);
  });

  it("a code outside acceptable_divisions is a cross-division FP", () => {
    const s = scorePage(gold, page({ acceptable_divisions: ["08"] }), ["04 22 00"], "section", 1);
    expect(s.fpCrossDivision).toEqual(["0422"]);
  });

  it("should_not_codes and should_not_divisions both produce hard FPs", () => {
    const byCode = scorePage(gold, page({ should_not_codes: ["04 42 00"] }), ["04 42 00"], "section", 1);
    expect(byCode.fpHard).toEqual(["0442"]);
    const byDiv = scorePage(gold, page({ should_not_divisions: ["01"] }), ["01 50 00"], "section", 1);
    expect(byDiv.fpHard).toEqual(["0150"]);
  });

  it("a group match beats a should_not listing — gold contradicting itself favours the positive", () => {
    const s = scorePage(gold, page({ should_not_codes: ["08 71 00"] }), ["08 71 00"], "section", 1);
    expect(s.tp).toEqual(["0871"]);
    expect(s.fpHard).toEqual([]);
  });
});

describe("section dedupe (§5.1.1) — sibling-spraying must not inflate precision", () => {
  const gold = [G("door_hardware", "08", ["08 71 00"])];

  it("three siblings of one section count once, not three times", () => {
    const s = scorePage(gold, page(), ["08 71 00", "08 71 13", "08 71 13.16"], "section", 1);
    expect(s.tp).toEqual(["0871"]);
    const a = aggregate([s]);
    expect(a.precision).toBe(1); // 1 TP, 0 FP — not 3 TP
    expect(a.tp).toBe(1);
  });

  it("EXACT mode keeps them distinct, so the same input scores differently", () => {
    const s = scorePage(gold, page(), ["08 71 00", "08 71 13", "08 71 13.16"], "exact", 1);
    // Only the literal 087100 matches gold; the other two become unadjudicated FPs.
    expect(s.tp).toEqual(["087100"]);
    expect(s.fpUnadjudicated.length).toBe(2);
    expect(aggregate([s]).precision).toBeCloseTo(1 / 3, 6);
  });
});

describe("recall is over GROUPS, not codes (§4.1)", () => {
  it("a group is hit by ANY of its alternative codes", () => {
    const gold = [G("casework", "12", ["12 32 00", "06 41 00"])];
    const viaSecond = scorePage(gold, page(), ["06 41 00"], "section", 1);
    expect(viaSecond.groupsHit).toBe(1);
    expect(viaSecond.groupsTotal).toBe(1);
  });

  it("emitting three codes of one group still hits exactly one group", () => {
    const gold = [G("casework", "12", ["12 32 00", "06 41 00"])];
    const s = scorePage(gold, page(), ["12 32 00", "06 41 00", "12 32 13"], "section", 1);
    expect(s.groupsHit).toBe(1);
  });
});

describe("weighted micro-average (§11.1)", () => {
  it("a page with weight 2 counts twice as much as one with weight 1", () => {
    const gold = [G("g", "08", ["08 71 00"])];
    const hit = scorePage(gold, page(), ["08 71 00"], "section", 2); // weight 2, perfect
    const miss = scorePage(gold, page(), ["04 22 00"], "section", 1); // weight 1, all wrong

    const a = aggregate([hit, miss]);
    // TP = 1*2 = 2; FP = 1*1 = 1  →  P = 2/3
    expect(a.precision).toBeCloseTo(2 / 3, 6);
    // groupsHit = 1*2 = 2; groupsTotal = 1*2 + 1*1 = 3  →  R = 2/3
    expect(a.recall).toBeCloseTo(2 / 3, 6);
  });

  it("equal weights reduce to a plain micro-average", () => {
    const gold = [G("g", "08", ["08 71 00"])];
    const a = aggregate([
      scorePage(gold, page(), ["08 71 00"], "section", 1),
      scorePage(gold, page(), ["04 22 00"], "section", 1),
    ]);
    expect(a.precision).toBeCloseTo(0.5, 6);
  });
});

describe("powered gate (§11.2) — thin divisions must never read as passed", () => {
  it("a division below the unit floor is marked not powered", () => {
    const gold = [G("thin", "25", ["25 10 00"])];
    const s = scorePage(gold, page(), ["25 10 00"], "section", 1);
    const rows = perDivisionRollup([s], 50);
    const d25 = rows.find(r => r.division === "25")!;
    expect(d25.powered).toBe(false);
    // It still reports P/R — being unpowered is about whether you may GATE on it,
    // not about hiding the number.
    expect(d25.precision).toBe(1);
  });

  it("the floor is honoured: enough GOLD groups flips powered to true", () => {
    const gold = Array.from({ length: 55 }, (_, i) => G(`g${i}`, "09", [`09 ${String(i).padStart(2, "0")} 00`]));
    const emitted = gold.flatMap(g => g.codes);
    const s = scorePage(gold, page(), emitted, "section", 1);
    const d09 = perDivisionRollup([s], 50).find(r => r.division === "09")!;
    expect(d09.goldUnits).toBeGreaterThanOrEqual(50);
    expect(d09.powered).toBe(true);
  });
});

describe("empty and degenerate inputs do not fabricate numbers", () => {
  it("an empty gold page reports recall NULL, not 0 — no evidence is not a measured zero", () => {
    const s = scorePage([], page(), ["08 71 00"], "section", 1);
    expect(s.groupsTotal).toBe(0);
    expect(aggregate([s]).recall).toBeNull();
  });

  it("an engine emitting nothing reports precision NULL, not 0", () => {
    const s = scorePage([G("g", "08", ["08 71 00"])], page(), [], "section", 1);
    const a = aggregate([s]);
    expect(a.precision).toBeNull();
    expect(a.f05).toBeNull();
    expect(s.groupsHit).toBe(0);
  });

  it("power comes from UNWEIGHTED GOLD groups — an engine cannot manufacture it", () => {
    // The original bug: units = emitted + groupsTotal, weighted. A division with
    // no gold at all read as powered purely on false-positive volume.
    const noGold = scorePage([], page(), Array.from({ length: 200 }, (_, i) => `00 ${i} 00`), "section", 12);
    const row = perDivisionRollup([noGold], 50).find(r => r.division === "00");
    expect(row?.powered ?? false).toBe(false);
    expect(row?.goldUnits ?? 0).toBe(0);
  });

  it("weighting cannot inflate power either", () => {
    const gold = Array.from({ length: 5 }, (_, i) => G(`g${i}`, "09", [`09 0${i} 00`]));
    const s = scorePage(gold, page(), [], "section", 12); // weight 12 x 5 groups = 60 weighted
    const row = perDivisionRollup([s], 50).find(r => r.division === "09")!;
    expect(row.goldUnits).toBe(5); // raw, not 60
    expect(row.powered).toBe(false);
  });

  it("primary-only recall is computed separately (§4.2)", () => {
    const gold = [G("p1", "08", ["08 71 00"], "primary"), G("t1", "09", ["09 91 00"], "tertiary")];
    const s = scorePage(gold, page(), ["09 91 00"], "section", 1); // hits only the tertiary
    const a = aggregate([s]);
    expect(a.recall).toBeCloseTo(0.5, 6);
    expect(a.primaryRecall).toBe(0); // the one that matters: primary was missed
  });
});

describe("certification cannot be forged (§9)", () => {
  const certified = { bundle: "b", page: 1, reviewed_by: "chris", expected_groups: [G("g", "08", ["08 71 00"])] };

  it("accepts a genuinely adjudicated page", () => {
    expect(isCertifiedPage(certified)).toBe(true);
  });

  it("rejects every near-miss that merely fails `reviewed_by === null`", () => {
    // Each of these passes a naive `!== null` check and would have produced a
    // real-looking acceptance number from unadjudicated LLM labels.
    for (const bad of [null, "", "   ", 0, false, undefined]) {
      expect(isCertifiedPage({ ...certified, reviewed_by: bad as never }), `reviewed_by=${JSON.stringify(bad)}`).toBe(
        false,
      );
    }
  });

  it("rejects a page marked reviewed that has no adjudicated groups", () => {
    // A page still carrying only the two raw labeler opinions has not been
    // adjudicated, whatever reviewed_by claims.
    expect(isCertifiedPage({ ...certified, expected_groups: [] })).toBe(false);
    expect(isCertifiedPage({ bundle: "b", page: 1, reviewed_by: "chris" })).toBe(false);
  });
});
