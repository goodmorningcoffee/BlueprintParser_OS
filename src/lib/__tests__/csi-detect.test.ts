/**
 * csi-detect.test.ts — the `detectCsiCodes` / `detectCsiFromGrid` ADAPTER over the v2 tagger.
 *
 * [csi-v2 S6] Rewritten for the v2 engine (IMPLEMENTATION §II S6). The pre-v2 freeze-first pins
 * (3-tier code sets, threshold-0 blowup, tier1WeightByWordCount spread semantics) described the
 * legacy engine, which now lives byte-identical in `csi-detect-legacy.ts` and is pinned by
 * `eval/csi/baseline-old-engine.json` + csi-baseline-freshness.test.ts. Kept contracts:
 *   - `rawText` under 10 characters → [];
 *   - the 4th `db` param: the builtin bundle ≡ omitted; a custom bundle ADDS codes (per-tenant
 *     overlay, csi-kb-overlay.ts): the builtin rows come back unchanged and first (the overlay KB
 *     alone CAN move them — pinned below — so the adapter merges two runs);
 *   - `detectCsiFromGrid` forwards config + db and reads CELLS (header + value), never one string.
 * Every expected code/confidence below was MEASURED on kb-v2.4 (sha256 5110a515…) before pinning.
 *
 * KB-backed: `skipIf` when `src/data/csi-kb.json` is absent (fresh clone / GitHub CI);
 * `scripts/bp-suite` sets BP_REQUIRE_CSI_KB=1, which turns a skip into a failed run.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectCsiCodes, detectCsiFromGrid, csiKbFor, CSI_MIN_TEXT_CHARS } from "@/lib/csi-detect";
import { loadBuiltinCsiDatabase, parseCsiTsv } from "@/lib/csi-database";
import { buildCsiOverlayKb, OVERLAY_FILLER_FACTOR, overlayCode, overlayLevelOf, overlayParentOf } from "@/lib/csi-kb-overlay";
import { CSI_KB_FILLER_FACTOR } from "@/lib/csi-kb";
import { pickCsiV2Config, CSI_V2_LOWEST_EMITTED_CONFIDENCE, DEFAULT_CSI_V2_CONFIG } from "@/lib/csi-v2-config";
import { DEFAULT_CSI_V2_PAGE_CONFIG, REPETITION_BASE, REPETITION_STEP, STRONG_SPAN_MIN, detectCsiV2 } from "@/lib/csi-page";

const HAS_KB = existsSync(join(process.cwd(), "src/data/csi-kb.json"));

const INPUT = "Provide cast in place concrete for all foundation walls and footings.";
const codesOf = (rows: { code: string }[]) => rows.map((r) => r.code).sort();
const confs = (rows: { code: string; confidence?: number }[]) => rows.map((r) => `${r.code}@${r.confidence}`);

const FAKE_TSV = [
  "col0\tcol1\tcode\tdescription\ttrade\tdivision",
  "x\tx\t99 99 99\tzebra fixture widget\tFixture Trade\t99 00 00",
].join("\n");

describe("detectCsiCodes — contracts that need no KB", () => {
  it("returns [] for short input (< 10 chars)", () => {
    expect(CSI_MIN_TEXT_CHARS).toBe(10);
    expect(detectCsiCodes("abc")).toEqual([]);
    expect(detectCsiCodes("")).toEqual([]);
    expect(detectCsiCodes("123456789")).toEqual([]); // 9 chars — under the gate
  });

  it("detectCsiFromGrid keeps the gate over the joined headers + values", () => {
    expect(detectCsiFromGrid(["A"], [{ A: "GWB" }])).toEqual([]); // "A GWB" = 5 chars
  });
});

describe.skipIf(!HAS_KB)("detectCsiCodes — default config (builtin KB)", () => {
  it("detects a stable code set for a fixed concrete/foundation input", () => {
    expect(confs(detectCsiCodes(INPUT))).toEqual(["31 66 16@0.88", "03 30 00@0.88"]);
  });

  it("returns the v2 CsiCode row: spaced code, 2018 title, trade, NN 00 00 division, confidence, level", () => {
    const row = detectCsiCodes(INPUT).find((r) => r.code === "03 30 00");
    expect(row).toEqual({
      code: "03 30 00",
      description: "Cast-in-Place Concrete",
      trade: "Concrete",
      division: "03 00 00",
      confidence: 0.88,
      level: 3,
    });
  });

  it("bare text carries no geometry, so the `triggers` key is absent", () => {
    for (const r of detectCsiCodes(INPUT)) expect("triggers" in r).toBe(false);
  });

  it("a 3-token Division 00 title in TEXT still auto-fills (annotation-groups contract)", () => {
    expect(codesOf(detectCsiCodes("list of drawing sheets"))).toEqual(["00 01 15"]);
  });
});

describe.skipIf(!HAS_KB)("detectCsiCodes — config levers {tau, maxCodesPerPage}", () => {
  it("tau 0.99 yields a subset of the default result (empty here: one occurrence scores 0.88)", () => {
    const strict = detectCsiCodes(INPUT, undefined, { tau: 0.99 });
    const defaults = new Set(codesOf(detectCsiCodes(INPUT)));
    for (const r of strict) expect(defaults.has(r.code)).toBe(true);
    expect(strict).toEqual([]);
  });

  it("maxCodesPerPage 1 keeps the top code (equal confidence → deeper level first)", () => {
    expect(confs(detectCsiCodes(INPUT, undefined, { maxCodesPerPage: 1 }))).toEqual(["31 66 16@0.88"]);
  });

  it("undefined, {} and the explicit defaults are the same run", () => {
    const a = detectCsiCodes(INPUT);
    expect(detectCsiCodes(INPUT, undefined, {})).toEqual(a);
    expect(detectCsiCodes(INPUT, undefined, { ...DEFAULT_CSI_V2_CONFIG })).toEqual(a);
  });
});

describe("pickCsiV2Config — stored config reader (shared by the resolver and CsiTab)", () => {
  it("reads tau and maxCodesPerPage; a pre-v2 matchingConfidenceThreshold is read as tau only above 0.704", () => {
    expect(pickCsiV2Config({ tau: 0.8, maxCodesPerPage: 12 })).toEqual({ tau: 0.8, maxCodesPerPage: 12 });
    expect(pickCsiV2Config({ matchingConfidenceThreshold: 0.85, tier2Weight: 0.75 })).toEqual({ tau: 0.85 });
    expect(pickCsiV2Config({ tau: 0.9, matchingConfidenceThreshold: 0.85 })).toEqual({ tau: 0.9 }); // tau wins
    // the pre-v2 admin's DEFAULT 0.4 rode along on every pre-v2 save; on the old scale it must not
    // lower the v2 default (review fix round 1: 3,070 → 3,459 corpus codes if read as tau)
    expect(pickCsiV2Config({ matchingConfidenceThreshold: 0.4, tier2Weight: 0.75 })).toBeUndefined();
    expect(pickCsiV2Config({ matchingConfidenceThreshold: CSI_V2_LOWEST_EMITTED_CONFIDENCE })).toBeUndefined();
  });

  it("client-safe defaults and the admin explainer's floor agree with the engine's constants", () => {
    expect(DEFAULT_CSI_V2_CONFIG).toEqual(DEFAULT_CSI_V2_PAGE_CONFIG);
    expect(CSI_V2_LOWEST_EMITTED_CONFIDENCE).toBeCloseTo(STRONG_SPAN_MIN * (REPETITION_BASE + REPETITION_STEP), 12);
  });

  it("drops out-of-range / wrong-typed values (I-10: tau must be in (0, 1])", () => {
    for (const bad of [0, -0.5, 1.01, NaN, Infinity, "0.8"]) expect(pickCsiV2Config({ tau: bad })).toBeUndefined();
    for (const bad of [0, 201, 2.5, "40", -1]) expect(pickCsiV2Config({ maxCodesPerPage: bad })).toBeUndefined();
    for (const junk of [null, undefined, 5, [1], "x"]) expect(pickCsiV2Config(junk)).toBeUndefined();
  });
});

describe.skipIf(!HAS_KB)("detectCsiCodes — context (drawing number → discipline)", () => {
  it("a civil sheet opens the facility gate; other sheets keep it shut (PLAN §6.7)", () => {
    const t = "DUCTILE IRON UTILITY PIPING";
    expect(confs(detectCsiCodes(t))).toEqual([]);
    expect(confs(detectCsiCodes(t, { context: { drawingNumber: "C-101" } }))).toEqual(["33 05 19@0.88"]);
    expect(confs(detectCsiCodes(t, { context: { drawingNumber: "A-101" } }))).toEqual([]);
  });

  it("the discipline decides a cross-division tie (PLAN §6.5)", () => {
    const t = "BALL VALVE SCHEDULE NOTES";
    expect(codesOf(detectCsiCodes(t))).toEqual([]);
    expect(codesOf(detectCsiCodes(t, { context: { drawingNumber: "P-201" } }))).toEqual(["22 05 23"]);
    expect(codesOf(detectCsiCodes(t, { context: { drawingNumber: "M-201" } }))).toEqual(["23 05 23"]);
    // an explicit discipline outranks the drawing-number prefix; a null drawing number is no context
    expect(codesOf(detectCsiCodes(t, { context: { drawingNumber: "M-201", discipline: "P" } }))).toEqual(["22 05 23"]);
    expect(codesOf(detectCsiCodes(t, { context: { drawingNumber: null } }))).toEqual([]);
  });
});

describe.skipIf(!HAS_KB)("detectCsiCodes — explicit db param (company overlay)", () => {
  it("4-arg call with loadBuiltinCsiDatabase() deep-equals the 3-arg call", () => {
    expect(detectCsiCodes(INPUT, undefined, undefined, loadBuiltinCsiDatabase()))
      .toEqual(detectCsiCodes(INPUT, undefined, undefined));
    expect(csiKbFor(loadBuiltinCsiDatabase())).toBe(csiKbFor());
  });

  it("a synthetic parseCsiTsv bundle is detected via the db param; builtin run does not detect it", () => {
    const bundle = parseCsiTsv(FAKE_TSV);
    const input = "Furnish the zebra fixture widget assembly per plan detail.";
    const viaDb = detectCsiCodes(input, undefined, undefined, bundle);
    expect(viaDb.find((r) => r.code === "99 99 99")).toEqual({
      code: "99 99 99",
      description: "zebra fixture widget",
      trade: "Fixture Trade",
      division: "99 00 00",
      confidence: 0.88,
      level: 4,
    });
    expect(codesOf(detectCsiCodes(input))).not.toContain("99 99 99");
  });

  it("the overlay is memoised per bundle; builtin patterns and IDF are frozen in it", () => {
    const bundle = parseCsiTsv(FAKE_TSV);
    const kb = csiKbFor(bundle);
    expect(csiKbFor(bundle)).toBe(kb); // built once per bundle
    expect(detectCsiCodes(INPUT, undefined, undefined, bundle)).toEqual(detectCsiCodes(INPUT));
    const base = csiKbFor();
    if (!base || !kb) throw new Error("KB missing");
    expect(kb.patterns.slice(0, base.patterns.length)).toEqual(base.patterns);
    for (const [t, v] of base.idf) expect(kb.idf.get(t)).toBe(v);
  });

  // Review fix round 1: frozen IDF/anchors do NOT keep builtin results fixed — overlay patterns take
  // part in dominance/ownership. The adapter therefore returns the builtin run's rows unchanged and
  // first, plus the codes the custom list names that the builtin run did not emit (measured, kb-v2.4).
  const H = "c0\tc1\tcode\tdescription\ttrade\tdivision";
  const PAINTED = parseCsiTsv([H, "x\tx\t081313\thollow metal doors painted\tDoors\t08 00 00"].join("\n"));
  const ACME = parseCsiTsv([H, "x\tx\t089901\thollow metal doors acme\tDoors\t08 00 00"].join("\n"));

  it("the overlay KB ALONE can move builtin results (why the adapter merges two runs)", () => {
    const ov = csiKbFor(PAINTED);
    if (!ov) throw new Error("KB missing");
    const t = "HOLLOW METAL DOORS PAINTED AND HOLLOW METAL DOORS AND FRAMES.";
    expect(confs(detectCsiCodes(t))).toEqual(["08 11 13@0.88", "08 13 13@0.88", "09 91 00@0.88"]);
    expect(confs(detectCsiV2({ text: t }, {}, ov).codes)).toEqual(["08 10 00@0.792"]); // all three builtin codes lost
    expect(detectCsiCodes(t, undefined, undefined, PAINTED)).toEqual(detectCsiCodes(t)); // adapter: unchanged
  });

  it("a custom list never moves a builtin row: builtin rows come back unchanged and first, overlay codes are added", () => {
    const pages = [
      "PROVIDE HOLLOW METAL DOORS ACME AT ALL STAIRS.",
      "PROVIDE HOLLOW METAL DOORS AT ALL STAIRS.",
      "HOLLOW METAL DOORS PAINTED AND HOLLOW METAL DOORS AND FRAMES.",
      "HOLLOW METAL FRAMES; HOLLOW METAL DOORS PAINTED",
      "HOLLOW METAL DOORS PAINTED, HOLLOW METAL FRAMES",
      INPUT,
    ];
    for (const bundle of [PAINTED, ACME]) {
      for (const t of pages) {
        const builtin = detectCsiCodes(t);
        expect(detectCsiCodes(t, undefined, undefined, bundle).slice(0, builtin.length)).toEqual(builtin);
      }
    }
    // a NEW tenant code on a phrase that extends a builtin title: both are listed (the overlay KB alone
    // would have replaced 08 13 13 with 08 99 01)
    expect(confs(detectCsiCodes(pages[0], undefined, undefined, ACME))).toEqual(["08 13 13@0.88", "08 99 01@0.88"]);
    // a tenant phrase for a BUILTIN code adds that code where the builtin run missed it
    expect(confs(detectCsiCodes(pages[4]))).toEqual(["09 91 00@0.88"]);
    expect(confs(detectCsiCodes(pages[4], undefined, undefined, PAINTED))).toEqual(["09 91 00@0.88", "08 13 13@0.88"]);
  });

  it("additions only fill the slots left under maxCodesPerPage", () => {
    const t = "PROVIDE HOLLOW METAL DOORS ACME AT ALL STAIRS.";
    expect(codesOf(detectCsiCodes(t, undefined, { maxCodesPerPage: 1 }, ACME))).toEqual(["08 13 13"]);
    expect(codesOf(detectCsiCodes(t, undefined, { maxCodesPerPage: 2 }, ACME))).toEqual(["08 13 13", "08 99 01"]);
  });

  it("the cap holds when the overlay run ranks two custom codes above a builtin one (fix round 2)", () => {
    // Both custom codes sort before 08 13 13 at equal confidence/level, so the overlay run's own cap
    // keeps them both and pushes 08 13 13 out: without the adapter's `.slice(0, room)` this returns 3
    // codes under a cap of 2 (measured on the mutant: 08 13 13, 01 99 97 and 01 99 98).
    const TWO = parseCsiTsv([H, "x\tx\t01 99 98\tzebra fixture widget\tFixture Trade\t01 00 00",
      "x\tx\t01 99 97\tquokka harness rig\tRig Trade\t01 00 00"].join("\n"));
    const t = "PROVIDE HOLLOW METAL DOORS AT ALL STAIRS. FURNISH THE ZEBRA FIXTURE WIDGET AND THE QUOKKA HARNESS RIG PER PLAN.";
    expect(confs(detectCsiCodes(t))).toEqual(["08 13 13@0.88"]);
    expect(confs(detectCsiCodes(t, undefined, { maxCodesPerPage: 2 }, TWO))).toEqual(["08 13 13@0.88", "01 99 97@0.88"]);
    expect(confs(detectCsiCodes(t, undefined, { maxCodesPerPage: 3 }, TWO)))
      .toEqual(["08 13 13@0.88", "01 99 97@0.88", "01 99 98@0.88"]);
  });
});

describe.skipIf(!HAS_KB)("buildCsiOverlayKb — custom rows become title patterns", () => {
  const TSV = [
    "c0\tc1\tcode\tdescription\ttrade\tdivision",
    "x\tx\t99 99 99\tzebra fixture widget\tFixture Trade\t99 00 00",
    "x\tx\t998877\tGypsum Board\tT\t99", // same token set as a builtin title → skipped
    "x\tx\tABC-1\tquokka harness rig\tT\tZZ", // not a MasterFormat code → skipped
    "x\tx\t99 99 98\tquokka\tT\t99", // one word → hint only
    "x\tx\t09 29 00\tquokka drywall partition\tFinishes\t09", // a builtin code gains a pattern
  ].join("\n");

  it("measured stats, patterns and frozen base", () => {
    const base = csiKbFor();
    if (!base) throw new Error("KB missing");
    const before = base.byCode.get("09 29 00")?.patternIds.length;
    const ov = buildCsiOverlayKb(base, parseCsiTsv(TSV));
    expect(ov.stats).toEqual({
      rows: 5, patternsAdded: 3, codesAdded: 2, skippedBadCode: 1, skippedNoTokens: 0, skippedTooLong: 0,
      skippedBuiltinDuplicate: 1, skippedOverlayDuplicate: 0,
    });
    expect(ov.defaultIdf).toBeCloseTo(Math.max(...base.idf.values()), 4);
    const added = ov.kb.patterns.slice(base.patterns.length);
    expect(added.map((p) => [p.code, p.tokens.join(" "), p.anchor, p.diff.join(","), p.hintOnly === true])).toEqual([
      ["99 99 99", "zebra fixture widget", 0, "0", false],
      ["99 99 98", "quokka", 0, "0", true],
      ["09 29 00", "quokka drywall partition", 0, "0,1,2", false],
    ]);
    // the builtin token keeps its builtin idf; an overlay-only token gets the default idf
    expect(added[0].mass[1]).toBe(Math.round((base.idf.get("fixture") ?? -1) * 1e4) / 1e4);
    expect(added[0].mass[0]).toBe(ov.defaultIdf);
    // the base KB object is untouched; the overlay holds a COPY of the extended code
    expect(base.byCode.get("09 29 00")?.patternIds.length).toBe(before);
    expect(ov.kb.byCode.get("09 29 00")?.patternIds.length).toBe((before ?? 0) + 1);
    expect(ov.kb.byCode.get("99 99 99")).toMatchObject({ level: 4, parent: null, division: "99 00 00", trade: "Fixture Trade" });
    expect(OVERLAY_FILLER_FACTOR).toBe(CSI_KB_FILLER_FACTOR);
  });

  it("overlay rows match at runtime; a one-word row only hints", () => {
    const bundle = parseCsiTsv(TSV);
    expect(codesOf(detectCsiCodes("QUOKKA DRYWALL PARTITION TYPE A", undefined, undefined, bundle))).toEqual(["09 29 00"]);
    expect(detectCsiCodes("QUOKKA ONLY HERE TODAY", undefined, undefined, bundle)).toEqual([]);
  });

  it("code helpers: shape normalisation, level, nearest existing parent", () => {
    expect(overlayCode("092900")).toBe("09 29 00");
    expect(overlayCode("08111313")).toBe("08 11 13.13");
    expect(overlayCode("09")).toBe("09 00 00");
    expect(overlayCode("0929")).toBe("09 29 00");
    expect(overlayCode("ABC-1")).toBeNull();
    expect([overlayLevelOf("09 00 00"), overlayLevelOf("09 20 00"), overlayLevelOf("09 29 00"), overlayLevelOf("09 29 13"), overlayLevelOf("08 11 13.13")])
      .toEqual([2, 3, 3, 4, 5]); // MasterFormat: 'NN NN 00' is level 3 like 'NN N0 00'
    const known = new Set(["09 00 00", "09 20 00"]);
    expect(overlayParentOf("09 29 77", (c) => known.has(c))).toBe("09 20 00");
    expect(overlayParentOf("99 99 99", (c) => known.has(c))).toBeNull();
  });
});

describe.skipIf(!HAS_KB)("detectCsiFromGrid — cells, config and db forwarding", () => {
  it("forwards the db bundle", () => {
    const bundle = parseCsiTsv(FAKE_TSV);
    const result = detectCsiFromGrid(
      ["Item", "Description"],
      [{ Item: "A1", Description: "zebra fixture widget assembly" }],
      undefined,
      bundle,
    );
    expect(codesOf(result)).toContain("99 99 99");
  });

  it("reads each value as ONE cell with its header — never one string joined across cells", () => {
    // joined, the words read "HOLLOW METAL DOORS" → 08 13 13; as cells they never meet
    expect(codesOf(detectCsiCodes("MATERIAL TYPE HOLLOW METAL DOORS"))).toEqual(["08 13 13"]);
    expect(codesOf(detectCsiFromGrid(["MATERIAL", "TYPE"], [{ MATERIAL: "HOLLOW METAL", TYPE: "DOORS" }]))).toEqual(["08 11 13"]);
  });

  it("forwards config; a grid with headers but no values is read header by header; no triggers", () => {
    expect(detectCsiFromGrid(["HOLLOW METAL DOORS"], [], { tau: 0.99 })).toEqual([]);
    const rows = detectCsiFromGrid(["HOLLOW METAL DOORS"], []);
    expect(codesOf(rows)).toEqual(["08 13 13"]);
    for (const r of rows) expect("triggers" in r).toBe(false);
  });
});
