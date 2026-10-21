/**
 * csi-compare.test.ts — arithmetic of the CSI v2 S5 comparison harness (PLAN §8).
 *
 * `eval/csi/compare.ts` decides OLD vs NEW, so its flat cells must equal score.ts exactly and its
 * hierarchy-aware cells must credit only what lies on a gold code's chain. Synthetic fixtures only
 * (generic codes, no page text). One describe re-scores the real OLD baseline and is gated on the
 * private gold file, which is absent in CI.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scorePage, aggregate, type GoldPage } from "../../../eval/csi/score";
import {
  chainKey, chainLevel, relation, goldFor, scorePageH, aggregateH, dedupe, weightFn, codesPerPage,
  integrity, perTermTable, checkAgainstScore, scoreEngine, parseArgs, type Group, type CapturePage, type Mode,
} from "../../../eval/csi/compare";
import { deriveAtTau, captureAtTau, checkDerived, matchOld, type SweepRow } from "../../../eval/csi/sweep-tau";

const G = (id: string, codes: string[], tier: Group["tier"] = "primary"): Group => ({ id, tier, division: codes[0].slice(0, 2), codes });
const gp = (over: Partial<GoldPage> = {}): GoldPage => ({ bundle: "b", page: 1, reviewed_by: null, ...over });
const cp = (page: number, codes: string[], over: Partial<CapturePage> = {}): CapturePage => ({ bundle: "b", page, codes, ...over });

describe("chainKey / relation — MasterFormat ancestry by digit shape", () => {
  it("maps each level to its significant prefix, any separator style", () => {
    expect(chainKey("08 00 00", "exact")).toBe("08");
    expect(chainKey("08 10 00", "exact")).toBe("081");
    expect(chainKey("08 11 00", "exact")).toBe("0811");
    expect(chainKey("08-11-13", "exact")).toBe("081113");
    expect(chainKey("08 11 13.13", "exact")).toBe("08111313");
    expect(chainKey("081113.00", "exact")).toBe("081113");
    expect([2, 3, 4, 6, 8].map(n => chainLevel("0".repeat(n)))).toEqual([1, 2, 3, 4, 5]);
  });

  it("section mode truncates to 4 digits and accepts a flat score key", () => {
    expect(chainKey("08 11 13.13", "section")).toBe("0811");
    expect(chainKey("0810", "section")).toBe("081");
    expect(chainKey("0800", "section")).toBe("08");
  });

  it("prefix order is the parent() chain: L2 08 10 00 is an ancestor of L3 08 11 00", () => {
    expect(relation("081", "0811")).toBe("ancestor");
    expect(relation("08111313", "081113")).toBe("descendant");
    expect(relation("0811", "0811")).toBe("equal");
    expect(relation("0812", "081113")).toBeNull();
  });
});

describe("goldFor — strict = shared systems, generous = union", () => {
  const p = gp({
    passA: { groups: [G("a1", ["08 11 13"]), G("a2", ["09 29 00"])] },
    passB: { groups: [G("b1", ["08 11 16"]), G("b2", ["26 51 00"])] },
  });
  it("strict keeps A's groups sharing a section with any B group", () => {
    expect(goldFor(p, "strict")!.map(g => g.id)).toEqual(["a1"]);
  });
  it("generous unions by section signature (b1 08 11 16 shares a1's section 08 11 → dropped)", () => {
    expect(goldFor(p, "generous")!.map(g => g.id)).toEqual(["a1", "a2", "b2"]);
  });
  it("adjudicated expected_groups win; a missing pass is unusable", () => {
    expect(goldFor(gp({ expected_groups: [G("x", ["03 30 00"])] }), "strict")!.map(g => g.id)).toEqual(["x"]);
    expect(goldFor(gp({ passA: { groups: [] }, passB: null }), "generous")).toBeNull();
  });
});

describe("scorePageH — flat classes plus chain credit", () => {
  const gold = [G("door", ["08 11 13"]), G("gwb", ["09 29 00"], "secondary")];
  const emitted = ["08 11 13", "08 11 00", "08 00 00", "09 29 13", "26 00 00"];

  it("exact: one TP, one descendant; the TP's parent is redundant, division hit NOT credited at minLevel 2", () => {
    const s = scorePageH(gold, gp(), emitted, "exact", 1);
    expect([s.emitted, s.tp, s.fpUnadj, s.fpHard]).toEqual([5, 1, 4, 0]);
    expect([s.tpAncestor, s.tpDescendant, s.divisionOnChain, s.tpChainEqual, s.onChainRedundant]).toEqual([0, 1, 1, 0, 1]);
    expect([s.groupsHit, s.hierGroupsHit, s.primaryHit, s.hierPrimaryHit]).toEqual([1, 2, 1, 1]);
  });

  it("an L3 ancestor of an un-hit gold code is credited", () => {
    const s = scorePageH(gold, gp(), ["08 11 00"], "exact", 1);
    expect([s.tp, s.tpAncestor, s.onChainRedundant, s.hierGroupsHit]).toEqual([0, 1, 0, 1]);
  });

  it("minLevel 1 credits the bare division as an ancestor; minLevel 2 counts it as divisionOnChain", () => {
    expect([1, 2].map(m => { const s = scorePageH(gold, gp(), ["08 00 00"], "exact", 1, m); return [s.tpAncestor, s.divisionOnChain]; }))
      .toEqual([[1, 0], [0, 1]]);
  });

  it("sibling spray under one gold code earns ONE descendant credit (one fact → one TP)", () => {
    const s = scorePageH([G("door", ["08 11 00"])], gp(), ["08 11 13", "08 11 16", "08 11 19"], "exact", 1);
    expect([s.tp, s.tpDescendant, s.onChainRedundant, s.fpUnadj, s.hierGroupsHit]).toEqual([0, 1, 2, 3, 1]);
    const c = aggregateH([s]);
    expect([c.hier.precision, c.hier.tpDescendant, c.hier.onChainRedundant]).toEqual([0.3333, 1, 2]);
  });

  it("one credit per gold chain: two gold codes absorb two descendants; ancestors of both chains are redundant after", () => {
    const g2 = [G("a", ["08 11 00"]), G("b", ["08 12 00"])];
    const s = scorePageH(g2, gp(), ["08 10 00", "08 11 13", "08 12 13", "08 12 16"], "exact", 1);
    expect([s.tpDescendant, s.tpAncestor, s.onChainRedundant]).toEqual([2, 0, 2]);
  });

  it("a chain-equal duplicate of a flat TP earns nothing", () => {
    const s = scorePageH(gold, gp(), ["08 11 13", "081113.00"], "exact", 1);
    expect([s.tp, s.tpChainEqual, s.onChainRedundant]).toEqual([1, 0, 1]);
  });

  it("section: siblings collapse before precision, 09 29 13 becomes a flat TP", () => {
    const s = scorePageH(gold, gp(), emitted, "section", 1);
    expect([s.emitted, s.tp, s.fpUnadj, s.divisionOnChain, s.tpDescendant]).toEqual([4, 2, 2, 1, 0]);
  });

  it("a should_not code stays a HARD FP even when it is on the chain", () => {
    const s = scorePageH(gold, gp({ should_not_codes: ["08 11 00"] }), ["08 11 00"], "exact", 1);
    expect([s.fpHard, s.tpAncestor]).toEqual([1, 0]);
  });

  it("a different flat key with the same chain key is a chain-equal TP (08 11 13.00)", () => {
    const s = scorePageH(gold, gp(), ["081113.00"], "exact", 1);
    expect([s.tp, s.tpChainEqual, s.hierGroupsHit]).toEqual([0, 1, 1]);
  });

  it("acceptable_divisions route out-of-set FPs to crossDivision", () => {
    const s = scorePageH(gold, gp({ acceptable_divisions: ["08", "09"] }), ["26 51 00", "09 91 00"], "exact", 1);
    expect([s.fpCross, s.fpUnadj]).toEqual([1, 1]);
  });
});

describe("aggregateH — weighted micro-average", () => {
  it("hand-computed cell", () => {
    const g = [G("d", ["08 11 13"])];
    const a = scorePageH(g, gp(), ["08 11 13", "26 00 00"], "exact", 2);     // tp 1, fp 1, hit
    const b = scorePageH(g, gp(), ["08 11 00", "26 05 00"], "exact", 1);     // fp 2 (1 ancestor), miss flat, hier hit
    const c = aggregateH([a, b]);
    // emitted = 2*2 + 2*1 = 6; tp = 2 → P = 1/3; groups 3, hit 2 → R = 2/3
    expect(c.precision).toBe(0.3333);
    expect(c.recall).toBe(0.6667);
    expect(c.f05).toBe(+((1.25 * (1 / 3) * (2 / 3)) / (0.25 * (1 / 3) + 2 / 3)).toFixed(4));
    expect(c.precisionBracket).toEqual({ floor: 0.3333, ceiling: 1, unadjudicatedShare: 0.6667 });
    // hier: tp 2 + ancestor 1 → 3/6; groups hit 3/3
    expect([c.hier.precision, c.hier.recall, c.hier.tpAncestor]).toEqual([0.5, 1, 1]);
  });

  it("no emissions ⇒ precision null, never 0", () => {
    const c = aggregateH([scorePageH([G("d", ["08 11 13"])], gp(), [], "exact", 1)]);
    expect([c.precision, c.f05, c.recall, c.precisionBracket]).toEqual([null, null, 0, null]);
  });

  it("flat cells equal score.ts aggregate(scorePage) on 200 seeded random pages", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pool = ["08 11 13", "08 11 00", "08 00 00", "09 29 00", "09 29 13", "26 51 00", "07 21 16", "07 21 00", "03 30 00", "22 05 23"];
    const pick = (n: number) => Array.from({ length: n }, () => pool[Math.floor(rnd() * pool.length)]);
    for (const mode of ["section", "exact"] as Mode[]) {
      const ours = [], theirs = [];
      for (let i = 0; i < 200; i++) {
        const gold = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, j) => G(`g${j}`, pick(1 + Math.floor(rnd() * 2)), rnd() < 0.5 ? "primary" : "secondary"));
        const page = gp({ should_not_codes: rnd() < 0.3 ? pick(1) : [], acceptable_divisions: rnd() < 0.3 ? ["08", "09"] : [] });
        const em = pick(Math.floor(rnd() * 6));
        const w = 0.5 + rnd() * 3;
        ours.push(scorePageH(gold, page, em, mode, w));
        theirs.push(scorePage(gold, page, em, mode, w));
      }
      const a = aggregateH(ours), b = aggregate(theirs);
      const r4 = (x: number | null) => (x === null ? null : +x.toFixed(4));
      expect([a.precision, a.recall, a.primaryRecall, a.f05]).toEqual([r4(b.precision), r4(b.recall), r4(b.primaryRecall), r4(b.f05)]);
      expect(a.truePositives).toBe(+b.tp.toFixed(1));
    }
  });
});

describe("dedupe, weights, codes/page", () => {
  it("dedupe keeps the first page per key, in order", () => {
    const d = dedupe([cp(1, []), cp(2, []), cp(3, [])], p => (p.page === 3 ? "x" : p.page === 1 ? "x" : "y"));
    expect(d.kept.map(p => p.page)).toEqual([1, 2]);
    expect(d.dropped).toBe(1);
  });

  it("weightFn fails LOUD on a missing or unknown stratum and on an empty frame", () => {
    const w = weightFn({ strata: [{ stratum: "A|0", weight: 1.5 }] });
    expect(w("A|0", "b:1")).toBe(1.5);
    expect(() => w("Z|9", "b:1")).toThrow(/UNKNOWN STRATA/);
    expect(() => w(undefined, "b:1")).toThrow(/UNKNOWN STRATA/);
    expect(() => weightFn({ strata: [] })).toThrow(/NO stratum weights/);
    expect(() => weightFn({ strata: [{ stratum: "A", weight: 0 }] })).toThrow(/non-positive/);
  });

  it("codesPerPage counts distinct codes per page", () => {
    const s = codesPerPage([cp(1, ["08 11 13", "08 11 13"]), cp(2, []), cp(3, ["a", "b", "c"]), cp(4, ["a", "b", "c", "d", "e"])]);
    expect([s.pages, s.pagesWithCodes, s.mean, s.median, s.p90]).toEqual([4, 3, 2.25, 2, 5]);
  });
});

describe("integrity counters", () => {
  const info = (disc: string | null) => () => ({ textSha: "", text: "", discipline: disc });
  it("parent beside descendant counts every chain pair on a page", () => {
    const ig = integrity([cp(1, ["08 00 00", "08 11 00", "08 11 13", "09 29 00"])], info("A"));
    expect(ig.counters.parentBesideDescendant).toBe(3); // 08⊃0811, 08⊃081113, 0811⊃081113
    expect(ig.counters.pagesWithParentBesideDescendant).toBe(1);
  });
  it("civil divisions on non-civil sheets; civil sheets exempt; unknown discipline separate", () => {
    const pages = [cp(1, ["33 11 00", "40 05 00", "08 11 13"]), cp(2, ["33 11 00"]), cp(3, ["48 00 00"])];
    const disc = new Map([[1, "M"], [2, "C"], [3, null]]);
    const ig = integrity(pages, p => ({ textSha: "", text: "", discipline: disc.get(p.page) ?? null }));
    expect([ig.counters.civilDivOnNonCivilSheet, ig.counters.civilDivOnUnknownDiscipline]).toEqual([2, 1]);
  });
  it("fan-out needs codeDetails: null without, counted with", () => {
    expect(integrity([cp(1, ["08 11 13"])], info("A")).counters.emitsWithoutOwnedSpan).toBeNull();
    const ig = integrity([cp(1, ["08 11 13", "09 29 00", "26 51 00"], {
      codeDetails: [
        { code: "08 11 13", triggers: [{ emitted: true, pattern: "p1" }] },
        { code: "09 29 00", triggers: [{ emitted: false }] },
      ],
    })], info("A"));
    expect(ig.counters.emitsWithoutOwnedSpan).toBe(2); // 09 29 00 unowned + 26 51 00 has no detail
    expect(ig.topPairs).toEqual([{ code: "08 11 13", pattern: "p1", n: 1 }]);
  });
});

describe("per-term table", () => {
  it("non-4-digit targets match by digit PREFIX, not by section (HM→081, ACT→095113, FLASHING→076)", () => {
    const text = new Map([[1, "H.M. DOOR"], [2, "HM FRAME"], [3, "ACT CEILING"], [4, "ACT TYP"], [5, "METAL FLASHING"]]);
    const pages = [cp(1, ["08 11 13"]), cp(2, ["08 21 00"]), cp(3, ["09 51 13"]), cp(4, ["09 51 23"]), cp(5, ["07 62 00"])];
    const by = Object.fromEntries(perTermTable(pages, p => text.get(p.page) ?? null).map(r => [r.term, r]));
    expect([by["HM"].pagesWithTerm, by["HM"].pagesHit]).toEqual([2, 1]);          // 0811 ⊂ 081; 0821 ⊄ 081
    expect([by["ACT/lay-in"].pagesWithTerm, by["ACT/lay-in"].pagesHit]).toEqual([2, 1]); // 095113 only
    expect([by["FLASHING"].pagesWithTerm, by["FLASHING"].pagesHit]).toEqual([1, 1]);
  });

  it("abbreviations are case-sensitive; a hit is any emitted code under the target prefix", () => {
    const text = new Map([[1, "PTD GWB PARTITION"], [2, "act now and paint it"], [3, "GYP. BD. TYP"]]);
    const pages = [cp(1, ["09 29 00", "09 91 23"]), cp(2, ["09 51 13"]), cp(3, [])];
    const rows = perTermTable(pages, p => text.get(p.page) ?? null);
    const by = Object.fromEntries(rows.map(r => [r.term, r]));
    expect([by["GWB/GYP BD"].pagesWithTerm, by["GWB/GYP BD"].pagesHit]).toEqual([2, 1]);
    expect([by["PTD/PAINT"].pagesWithTerm, by["PTD/PAINT"].pagesHit, by["PTD/PAINT"].recall]).toEqual([2, 1, 0.5]);
    expect(by["ACT/lay-in"].pagesWithTerm).toBe(0); // lower-case "act" is English
    expect(by["CMU"].recall).toBeNull();
  });
});

describe("cross-check and CLI parsing", () => {
  it("checkAgainstScore names each differing field", () => {
    const g = [gp({ stratum: "s", expected_groups: [G("d", ["08 11 13"])] })];
    const r = scoreEngine(g, new Map([["b:1", ["08 11 13"]]]), () => 1, ["certified"], 2).cells;
    const fake = { results: { certified: { section: { ...r.certified.section, recall: 0.5 }, exact: { ...r.certified.exact } } } };
    expect(checkAgainstScore(r, fake as never)).toEqual(["certified/section.recall: compare=1 score=0.5"]);
  });
  it("checkAgainstScore flags a precisionBracket-only difference", () => {
    const g = [gp({ stratum: "s", expected_groups: [G("d", ["08 11 13"])] })];
    const r = scoreEngine(g, new Map([["b:1", ["08 11 13", "26 51 00"]]]), () => 1, ["certified"], 2).cells;
    const pb = { ...r.certified.exact.precisionBracket!, ceiling: 0.75 };
    const fake = { results: { certified: { section: { ...r.certified.section }, exact: { ...r.certified.exact, precisionBracket: pb } } } };
    expect(checkAgainstScore(r, fake as never)).toEqual(["certified/exact.precisionBracket differs"]);
  });
  it("label=path pairs keep '=' inside the path", () => {
    const a = parseArgs(["--engine=old=a=b.json", "--gold=g", "--min-level=1"]);
    expect(a.engines).toEqual([{ label: "old", path: "a=b.json" }]);
    expect(a.minLevel).toBe(1);
  });
});

describe("sweep-tau", () => {
  const page = cp(1, [], { codeDetails: [
    { code: "09 29 00", confidence: 0.9 }, { code: "08 11 13", confidence: 0.9 },
    { code: "26 51 00", confidence: 0.6 }, { code: "07 21 16" },
  ] });
  it("filters ≥ τ, sorts confidence desc then code asc, caps", () => {
    expect(deriveAtTau(page, 0.5, 40)).toEqual(["08 11 13", "09 29 00", "26 51 00"]);
    expect(deriveAtTau(page, 0.9, 1)).toEqual(["08 11 13"]);
    expect(deriveAtTau(page, 0.95, 40)).toEqual([]);
    expect(() => deriveAtTau(cp(2, ["x"]), 0.5, 40)).toThrow(/codeDetails/);
  });
  it("checkDerived flags pages whose set differs from a direct run", () => {
    const d = captureAtTau({ pages: [page] }, 0.75, 40);
    expect(checkDerived(d, { pages: [cp(1, ["09 29 00", "08 11 13"])] })).toEqual([]);
    expect(checkDerived(d, { pages: [cp(1, ["08 11 13"])] })).toEqual(["b:1"]);
  });
  it("matchOld takes the HIGHEST τ that still reaches OLD recall", () => {
    const row = (tau: number, recall: number, precision: number): SweepRow =>
      ({ tau, codesPerPage: 1, cells: { strict: { section: { recall, precision } } } } as never);
    const m = matchOld([row(0.5, 0.4, 0.05), row(0.7, 0.25, 0.09), row(0.9, 0.1, 0.2)], "strict", 0.2, 0.04);
    expect(m).toEqual({ tau: 0.7, precision: 0.09, recall: 0.25, meets2xOld: true, target: 0.08 });
    expect(matchOld([row(0.5, 0.1, 0.1)], "strict", 0.2, 0.04).tau).toBeNull();
  });
});

// ── Gated: the real OLD baseline must reproduce score-old-engine.json (private gold; skipped in CI) ──
const GOLD = "/workspaces/projects/gitignore/projects/csi_private_eval/gold-pilot.json";
const EVAL = resolve(process.cwd(), "eval/csi");
describe.skipIf(!existsSync(GOLD))("OLD baseline reproduces score-old-engine.json (flat cells)", () => {
  it("strict/generous × section/exact agree with score.ts to 4 decimals", () => {
    const gold = (JSON.parse(readFileSync(GOLD, "utf-8")) as { pages: GoldPage[] }).pages;
    const frame = JSON.parse(readFileSync(resolve(EVAL, "gold-frame.json"), "utf-8"));
    const base = JSON.parse(readFileSync(resolve(EVAL, "baseline-old-engine.json"), "utf-8")) as { pages: CapturePage[] };
    const score = JSON.parse(readFileSync(resolve(EVAL, "score-old-engine.json"), "utf-8"));
    const r = scoreEngine(gold, new Map(base.pages.map(p => [`${p.bundle}:${p.page}`, p.codes])), weightFn(frame), ["strict", "generous"], 2);
    expect(checkAgainstScore(r.cells, score)).toEqual([]);
    expect(r.cells.strict.section.recall).toBe(0.2253);
  });
});
