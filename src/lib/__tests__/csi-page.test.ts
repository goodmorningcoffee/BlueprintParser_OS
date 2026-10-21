// @vitest-environment node
/**
 * csi-page.test.ts — CSI tagger v2, S4: page rules (`src/lib/csi-page.ts`) over the REAL KB.
 *
 * The KB is gitignored by design (owner ruling D1, 2026-10-20), so every describe here is
 * `skipIf(!HAS_KB)`; under BP_REQUIRE_CSI_KB=1 (scripts/bp-suite's default) src/test/global-setup.ts
 * fails the run instead of letting it go green on skips.
 *
 * Spec: IMPLEMENTATION §II S4 (the test list), §I (pinned interfaces and rules), PLAN §6.1, §6.7, §6.8.
 * EVERY page expectation below was MEASURED with the real engine before it was pinned
 * (2026-10-21, kb-v2.4) by a probe that prints codes / spans / hints for the same synthetic pages
 * (log: gitignore/projects/csi_tagger_v2/logs/s4-20261021T0305Z-probe.txt). Generic trade phrases only.
 * Mutation check (each gate / sort key / repetition rule disabled in turn; every mutant fails ≥ 1 test):
 * gitignore/projects/csi_tagger_v2/logs/s4-20261021T0305Z-mutations.txt and …/s4-20261021T0330Z-mutations.txt;
 * the boundary-pin blocks close the 8 + 5 + 2 survivors found in review (…/s4-20261021T0330Z-fix1-mutations.txt, …-fix2-mutations.txt,
 * …/s4-fix3-mutations.txt).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCsiKbFromFile } from "@/lib/csi-kb";
import type { LoadedKb } from "@/lib/csi-kb-types";
import type { BboxLTWH, TextractLine } from "@/types";
import { zCsiCode } from "@/types/shapes/csi";
import {
  DEFAULT_CSI_V2_PAGE_CONFIG, codeUniquePatterns, confidenceOf, detectCsiV2, inputKindOf, isFacilityDivision,
  isProjectDivision, resolveV2Config, tierOf, unionBbox, unitFromLine, type V2Cell, type V2Code, type V2Input, type V2Result,
} from "@/lib/csi-page";

const root = process.cwd();
const KB_REL = "src/data/csi-kb.json";
/** Absent on a fresh clone by design (D1, 2026-10-20) — see the file header. */
const HAS_KB = existsSync(join(root, KB_REL));
if (!HAS_KB) {
  console.warn(
    `[csi-page] SKIPPING the KB-backed tests in this file: ${KB_REL} is absent (gitignored by design, owner ruling D1). ` +
      "Rebuild it from the MasterFormat PDF — see the header of eval/csi/build-kb-v2.ts.",
  );
}

let kb: LoadedKb;
beforeAll(() => {
  if (!HAS_KB) return;
  kb = loadCsiKbFromFile(join(root, KB_REL));
});

/** A synthetic Textract line: words split on whitespace, word i at x = 0.1 + 0.01·i, width 0.009. */
function line(text: string, y = 0.1): TextractLine {
  const ws = text.split(/\s+/).filter(Boolean);
  return {
    text, confidence: 99, bbox: [0.1, y, 0.01 * ws.length, 0.01],
    words: ws.map((w, i) => ({ text: w, confidence: 99, bbox: [0.1 + 0.01 * i, y, 0.009, 0.01] as BboxLTWH })),
  };
}
const lines = (...ts: string[]): V2Input => ({ lines: ts.map((t, i) => line(t, 0.05 * (i + 1))) });
const run = (inp: V2Input, cfg: Parameters<typeof detectCsiV2>[1] = {}): V2Result => detectCsiV2(inp, cfg, kb);
const codesOf = (r: V2Result) => r.codes.map((c) => c.code);
const confs = (r: V2Result) => r.codes.map((c) => `${c.code}@${c.confidence.toFixed(4)}`);
const drops = (r: V2Result) => r.spans.map((s) => `${s.code}:${s.emitted ? "emitted" : s.drop}`);
/** Order-free view of the code list: everything but the trigger records (which carry line numbers). */
const codeView = (cs: V2Code[]) => cs.map((c) => [c.code, c.confidence, c.level, c.ancestors.join("|"), (c.alternatives ?? []).join("|"), c.description, c.trade, c.division]);

/** A six-code page used by the sort / cap / determinism tests (MEASURED: 09 29 00 twice, the rest once). */
const SIX = ["GYPSUM BOARD", "CARPET", "HOLLOW METAL DOORS AND FRAMES", "WOOD DOORS", "PTD GWB", "CMU"];

// ── pure helpers (no KB) ────────────────────────────────────────────────────
describe("csi-page helpers (§6.8 arithmetic, §6.7 division sets, config)", () => {
  it("confidenceOf = clamp(s × (0.85 + 0.03·min(n, 5)), 0, 1)", () => {
    expect(confidenceOf(1, 1)).toBeCloseTo(0.88, 12);
    expect(confidenceOf(1, 2)).toBeCloseTo(0.91, 12);
    expect(confidenceOf(0.9, 1)).toBeCloseTo(0.792, 12);
    expect(confidenceOf(0.8, 5)).toBeCloseTo(0.8, 12);
    expect(confidenceOf(0.8, 9)).toBeCloseTo(0.8, 12); // repetition caps at 5
    expect(confidenceOf(1.2, 5)).toBe(1); // clamp high
    expect(confidenceOf(-1, 1)).toBe(0); // clamp low
  });
  it("tierOf: ≥ 0.8 → 1, ≥ 0.6 → 2, else 3", () => {
    expect([tierOf(1), tierOf(0.8), tierOf(0.79), tierOf(0.6), tierOf(0.59), tierOf(0)]).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it("division sets: 00/01 project, 33–35 and 40–48 facility", () => {
    expect(["00 01 15", "01 33 00", "02 41 00", "10 00 00"].map(isProjectDivision)).toEqual([true, true, false, false]);
    expect(["32 00 00", "33 05 19", "35 00 00", "36 00 00", "39 00 00", "40 05 00", "48 00 00", "49 00 00"].map(isFacilityDivision))
      .toEqual([false, true, true, false, false, true, true, false]);
  });
  it("resolveV2Config: defaults per §I, partial override, bad values fall back, cap floored at 0", () => {
    expect(DEFAULT_CSI_V2_PAGE_CONFIG).toEqual({ tau: 0.75, maxCodesPerPage: 40 });
    expect(resolveV2Config({})).toEqual({ tau: 0.75, maxCodesPerPage: 40 });
    expect(resolveV2Config({ tau: 0.5 })).toEqual({ tau: 0.5, maxCodesPerPage: 40 });
    expect(resolveV2Config({ tau: Number.NaN, maxCodesPerPage: -3 })).toEqual({ tau: 0.75, maxCodesPerPage: 0 });
    expect(resolveV2Config({ maxCodesPerPage: 7.9 })).toEqual({ tau: 0.75, maxCodesPerPage: 7 });
  });
  it("inputKindOf: lines, else cells, else text; empty arrays fall through", () => {
    expect(inputKindOf({ lines: [line("A")], text: "B" })).toBe("lines");
    expect(inputKindOf({ lines: [], cells: [{ text: "A" }], text: "B" })).toBe("cells");
    expect(inputKindOf({ lines: [], cells: [], text: "B" })).toBe("text");
    expect(inputKindOf({ text: "  " })).toBe("none");
  });
  it("unionBbox unions LTWH boxes", () => {
    const u = unionBbox([[0.1, 0.2, 0.1, 0.1], [0.15, 0.1, 0.2, 0.05]]);
    expect(u.map((v) => +v.toFixed(12))).toEqual([0.1, 0.1, 0.25, 0.2]);
    const one: BboxLTWH = [0.3, 0.4, 0.05, 0.02];
    expect(unionBbox([one])).toEqual(one); // exact: no l/t/r/b round trip
    expect(unionBbox([one])).not.toBe(one);
  });
});

describe.skipIf(!HAS_KB)("csi-page: units (§6.1, E1)", () => {
  it("unitFromLine: one unit per line; every token carries the bbox of its Textract word (words[pos])", () => {
    const l = line("METALLIC NON-SHRINK GROUTING");
    const u = unitFromLine(l, kb, 3);
    expect(u.kind).toBe("line");
    expect(u.lineIndex).toBe(3);
    expect(u.bbox).toEqual(l.bbox);
    expect(u.tokens.length).toBeGreaterThan(l.words.length); // NON-SHRINK splits into two tokens of one word
    for (const t of u.tokens) expect(t.bbox).toBe(l.words[t.pos].bbox);
  });
  it("unitFromLine: a line with no words falls back to its text, every token taking the line bbox", () => {
    const l: TextractLine = { text: "GYPSUM BOARD", confidence: 99, bbox: [0.2, 0.2, 0.1, 0.01], words: [] };
    const u = unitFromLine(l, kb, 0);
    expect(u.tokens.map((t) => t.t)).toEqual(["gypsum", "board"]);
    for (const t of u.tokens) expect(t.bbox).toEqual(l.bbox);
  });
  it("lines win over text when both are given; an empty lines array falls through to text", () => {
    const both = run({ lines: [line("LIST OF DRAWING SHEETS")], text: "GYPSUM BOARD" });
    expect(both.spans.map((s) => s.code)).toEqual(["00 01 15"]);
    expect(codesOf(run({ lines: [], text: "GYPSUM BOARD" }))).toEqual(["09 29 00"]);
  });
  it("empty input → the empty result", () => {
    expect(run({})).toEqual({ codes: [], spans: [], divisionHints: [] });
    expect(run({ lines: [], cells: [], text: "" })).toEqual({ codes: [], spans: [], divisionHints: [] });
  });
});

describe.skipIf(!HAS_KB)("csi-page: §6.7 gates per input kind", () => {
  it("`list of drawing sheets` as TEXT → 00 01 15 emitted (3-token title pattern)", () => {
    const r = run({ text: "LIST OF DRAWING SHEETS" });
    expect(confs(r)).toEqual(["00 01 15@0.8800"]);
    expect(r.divisionHints).toEqual([]);
  });
  it("`list of drawing sheets` as a LINE → hint only (project_geometry), the division joins the hints", () => {
    const r = run(lines("LIST OF DRAWING SHEETS"));
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(["00 01 15:project_geometry"]);
    expect(r.divisionHints).toEqual(["00 00 00"]);
  });
  it("division 00/01 in a CELL → hint only, like lines", () => {
    const r = run({ cells: [{ header: "NOTES", text: "LIST OF DRAWING SHEETS" }] });
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(["00 01 15:project_geometry"]);
    expect(r.divisionHints).toEqual(["00 00 00"]);
  });
  it("division 00/01 from a 2-token pattern in TEXT → project_short + hint", () => {
    const r = run({ text: "SUBMITTAL PROCEDURES\nSHOP DRAWINGS" });
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(["01 33 00:project_short", "01 33 23:project_short"]);
    expect(r.divisionHints).toEqual(["01 00 00"]);
  });
  it("title-block-only synthetic page (PROJECT NAME, SCALE, DATE) → codes [] as lines and as text", () => {
    const asLines = run(lines("PROJECT NAME", "SCALE", "DATE"));
    expect(asLines.codes).toEqual([]);
    expect(drops(asLines)).toEqual(["00 01 01:project_geometry"]);
    expect(asLines.divisionHints).toEqual(["00 00 00", "10 00 00"]);
    const asText = run({ text: "PROJECT NAME\nSCALE\nDATE" });
    expect(asText.codes).toEqual([]);
    expect(drops(asText)).toEqual(["00 01 01:project_short"]);
  });
  it("facility division (33): one range → dropped; two code-unique ranges → emitted; ctx C → emitted", () => {
    const one = run(lines("DUCTILE IRON UTILITY PIPING"));
    expect(one.codes).toEqual([]);
    expect(drops(one)).toEqual(["33 05 19:facility"]);
    expect(one.divisionHints).toEqual([]); // the facility gate adds no hint
    expect(confs(run(lines("DUCTILE IRON UTILITY PIPING", "DUCTILE IRON UTILITY PIPING")))).toEqual(["33 05 19@0.9100"]);
    expect(confs(run({ ...lines("DUCTILE IRON UTILITY PIPING"), context: { discipline: "C" } }))).toEqual(["33 05 19@0.8800"]);
    expect(confs(run({ text: "DUCTILE IRON UTILITY PIPING", context: { discipline: "C" } }))).toEqual(["33 05 19@0.8800"]);
  });
  it("facility gate counts only CODE-UNIQUE patterns: two ranges of a shared token set stay dropped", () => {
    // `footing drains` is an alt of 33 41 00 and a `see` of 33 41 13 (same token set) — measured
    const u = codeUniquePatterns(kb);
    const shared = kb.patterns.filter((p) => p.kind !== "regex" && p.tokens.slice().sort().join(" ") === "drain footing");
    expect(shared.map((p) => p.code).sort()).toEqual(["33 41 00", "33 41 13"]);
    for (const p of shared) expect(u[p.id]).toBe(0);
    const r = run(lines("FOOTING DRAINS", "FOOTING DRAINS"));
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(["33 41 13:facility", "33 41 13:facility"]);
    expect(codesOf(run({ ...lines("FOOTING DRAINS"), context: { discipline: "C" } }))).toEqual(["33 41 13"]);
  });
  it("codeUniquePatterns: the 08 11 13 title is unique; most of the KB is", () => {
    const u = codeUniquePatterns(kb);
    const t = kb.patterns.find((p) => p.code === "08 11 13" && p.source === "title");
    expect(t && u[t.id]).toBe(1);
    let n = 0;
    for (let i = 0; i < u.length; i++) n += u[i];
    expect(n / u.length).toBeGreaterThan(0.9);
  });
});

describe.skipIf(!HAS_KB)("csi-page: §6.8 confidence, emission, sort, cap", () => {
  it("single span s = 1 → conf 0.88 (tier 1); s = 0.884 single → 0.778 (emitted, tier 2)", () => {
    const r = run(lines("GYPSUM BOARD"));
    expect(confs(r)).toEqual(["09 29 00@0.8800"]);
    expect(r.codes[0].triggers?.map((t) => t.tier)).toEqual([1]);
    const p = run(lines("AUTOCLAVED AERATED UNIT MASONRY"));
    expect(confs(p)).toEqual(["04 22 26@0.7780"]);
    expect(p.codes[0].triggers?.map((t) => t.tier)).toEqual([2]);
  });
  it("repetition: 1, 2, 5 and 7 distinct ranges of s = 0.884 → 0.778, 0.805, 0.884, 0.884 (cap at 5)", () => {
    const at = (n: number) => run(lines(...Array.from({ length: n }, () => "AUTOCLAVED AERATED UNIT MASONRY"))).codes[0].confidence;
    const s = 0.8841; // measured span s (4 of 5 title tokens, contiguous)
    expect(at(1)).toBeCloseTo(s * 0.88, 4);
    expect(at(2)).toBeCloseTo(s * 0.91, 4);
    expect(at(5)).toBeCloseTo(s * 1.0, 4);
    expect(at(7)).toBe(at(5));
    expect(run(lines(...Array.from({ length: 7 }, () => "GYPSUM BOARD"))).codes[0].confidence).toBe(1);
  });
  it("emission needs s ≥ 0.8: a 0.707 span is dropped as weak", () => {
    const r = run(lines("GYPSUM QQQ ZZZ XXX BOARD"));
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(["09 21 16:weak"]);
    expect(r.spans[0].score).toBeCloseTo(0.7065, 4);
  });
  it("emission needs conf ≥ τ: s = 0.85 once → 0.748 below τ; two columns → 0.7735 emitted; τ = 0.7 emits one", () => {
    const one = run({ cells: [{ header: "DOOR MATERIAL", text: "HM" }] });
    expect(one.codes).toEqual([]);
    expect(drops(one)).toEqual(["08 13 13:below_tau"]);
    // E9: two cells of the SAME (table, column) are one range; two columns are two
    expect(run({ cells: [{ header: "DOOR MATERIAL", text: "HM" }, { header: "DOOR MATERIAL", text: "HM" }] }).codes).toEqual([]);
    expect(confs(run({ cells: [{ header: "DOOR MATERIAL", text: "HM" }, { header: "DOOR TYPE", text: "HM" }] }))).toEqual(["08 13 13@0.7735"]);
    expect(confs(run({ cells: [{ header: "DOOR MATERIAL", text: "HM" }] }, { tau: 0.7 }))).toEqual(["08 13 13@0.7480"]);
  });
  it("sort: conf desc, then deeper level, then code", () => {
    const r = run(lines(...SIX));
    expect(confs(r)).toEqual([
      "09 29 00@0.9100", // two ranges (GYPSUM BOARD, GWB)
      "08 11 13@0.8800", // level 4 before the level-3 ties
      "04 22 00@0.8800", "08 14 00@0.8800", "09 68 00@0.8800", "09 91 00@0.8800",
    ]);
    expect(r.codes.map((c) => c.level)).toEqual([3, 4, 3, 3, 3, 3]);
  });
  it("cap: maxCodesPerPage keeps the first N of the sort; the rest stay as `cap` spans", () => {
    const r = run(lines(...SIX), { maxCodesPerPage: 3 });
    expect(codesOf(r)).toEqual(["09 29 00", "08 11 13", "04 22 00"]);
    expect(r.spans.filter((s) => s.drop === "cap").map((s) => s.code).sort()).toEqual(["08 14 00", "09 68 00", "09 91 00"]);
    expect(run(lines(...SIX), { maxCodesPerPage: 0 }).codes).toEqual([]);
  });
});

describe.skipIf(!HAS_KB)("csi-page: output contract (§I, §6.8)", () => {
  it("every emitted code passes zCsiCode and its triggers carry bbox (union of the word boxes)", () => {
    const r = run(lines(...SIX, "METALLIC NON-SHRINK GROUTING"));
    expect(r.codes.length).toBe(7);
    for (const c of r.codes) {
      expect(zCsiCode.safeParse(c).success).toBe(true);
      expect(c.triggers?.length).toBeGreaterThan(0);
      for (const t of c.triggers ?? []) expect(t.bbox).toHaveLength(4);
    }
    const gyp = r.codes[0].triggers?.[0];
    expect(gyp?.text).toBe("gypsum board");
    expect(gyp?.bboxes).toHaveLength(2);
    expect(gyp?.bbox.map((v) => +v.toFixed(12))).toEqual([0.1, 0.05, 0.019, 0.01]);
    expect(gyp && { line: gyp.line, tokenStart: gyp.tokenStart, tokenEnd: gyp.tokenEnd, pattern: gyp.pattern, source: gyp.source, score: gyp.score, emitted: gyp.emitted })
      .toEqual({ line: 0, tokenStart: 0, tokenEnd: 1, pattern: "Gypsum Board", source: "title", score: 1, emitted: true });
  });
  it("bare-text input → triggers undefined, spans on the result (no bbox)", () => {
    const r = run({ text: "GYPSUM BOARD\nHOLLOW METAL DOORS AND FRAMES" });
    expect(codesOf(r)).toEqual(["08 11 13", "09 29 00"]);
    for (const c of r.codes) { expect(c.triggers).toBeUndefined(); expect(zCsiCode.safeParse(c).success).toBe(true); }
    expect(r.spans.map((s) => [s.code, s.text, s.bbox, s.emitted])).toEqual([
      ["09 29 00", "gypsum board", undefined, true], ["08 11 13", "hollow metal doors and frames", undefined, true],
    ]);
  });
  it("cells: without bbox → triggers undefined; with bbox → triggers carry the cell bbox", () => {
    const cells: V2Cell[] = [{ header: "FINISH", text: "GWB" }];
    expect(run({ cells }).codes[0].triggers).toBeUndefined();
    const box: BboxLTWH = [0.3, 0.4, 0.05, 0.02];
    const r = run({ cells: [{ ...cells[0], bbox: box }] });
    expect(r.codes[0].code).toBe("09 29 00");
    expect(r.codes[0].triggers?.map((t) => t.bbox)).toEqual([box]);
    expect(r.divisionHints).toEqual(["09 00 00"]); // S3: FINISH is a hint-only token outside the GWB span
  });
  it("family owner emits with alternatives (s × 0.9 = 0.9 → conf 0.792)", () => {
    const r = run(lines("METALLIC NON-SHRINK GROUTING"));
    expect(confs(r)).toEqual(["03 62 00@0.7920"]);
    expect(r.codes[0].alternatives).toEqual(["03 62 13", "03 62 16"]);
    expect(r.codes[0].triggers?.[0].score).toBeCloseTo(0.9, 12);
    expect(run(lines("GYPSUM BOARD")).codes[0].alternatives).toBeUndefined();
  });
  it("ancestors: nearest first, equal to the KB parent chain; division 'NN 00 00'", () => {
    const r = run(lines("HOLLOW METAL DOORS AND FRAMES", "GYPSUM BOARD"));
    const hm = r.codes.find((c) => c.code === "08 11 13");
    expect(hm?.ancestors).toEqual(["08 11 00", "08 10 00", "08 00 00"]);
    expect(hm?.division).toBe("08 00 00");
    expect(hm?.description).toBe("Hollow Metal Doors and Frames");
    for (const c of r.codes) {
      const chain: string[] = [];
      for (let p = kb.byCode.get(c.code)?.parent ?? null; p !== null; p = kb.byCode.get(p)?.parent ?? null) chain.push(p);
      expect(c.ancestors).toEqual(chain);
      expect(c.division).toBe(`${c.code.slice(0, 2)} 00 00`);
    }
  });
  it("by_others spans: excluded from codes, kept as emitted:false triggers", () => {
    const only = run(lines("DOOR HARDWARE BY OTHERS"));
    expect(only.codes).toEqual([]);
    expect(only.spans.map((s) => [s.code, s.scope, s.emitted, s.drop])).toEqual([["08 71 00", "by_others", false, "by_others"]]);
    const mixed = run(lines("DOOR HARDWARE", "DOOR HARDWARE BY OTHERS"));
    expect(confs(mixed)).toEqual(["08 71 00@0.8800"]); // the by_others range does not count as repetition
    expect(mixed.codes[0].triggers?.map((t) => [t.line, t.emitted, t.scope])).toEqual([[0, true, undefined], [1, false, "by_others"]]);
    expect(drops(run(lines("DUCTILE IRON UTILITY PIPING NIC")))).toEqual(["33 05 19:by_others"]);
  });
  it("divisionHints: deduped and sorted across units", () => {
    expect(run(lines("BALL VALVE", "CONCRETE", "BALL VALVE", "ELEVATORS")).divisionHints).toEqual(["03 00 00", "14 00 00", "22 00 00", "23 00 00"]);
    expect(confs(run({ ...lines("BALL VALVE"), context: { discipline: "P" } }))).toEqual(["22 05 23@0.8800"]);
  });
});

describe.skipIf(!HAS_KB)("csi-page: boundary pins (fix round 1 — each kills a mutant the 36 above let live)", () => {
  // MEASURED 2026-10-21 on kb-v2.4 by the S4 review's scratch killers, re-run here under bp-suite.
  const rep = (t: string, n: number) => Array.from({ length: n }, () => t);
  it("§6.8 s ≥ 0.8 from below: s = 0.765 × 5 ranges → conf 0.765 ≥ τ, still dropped as weak", () => {
    const r = run(lines(...rep("RESIDENTIAL CLOSETS, URINALS, AND BIDETS", 5)));
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(rep("22 41 13:weak", 5));
    expect(r.spans[0].score).toBeCloseTo(0.765, 4);
  });
  it("§6.8 s ≥ 0.8 from above: s = 0.8032 × 3 ranges → emitted at 0.755", () => {
    const r = run(lines(...rep("CORE DRILLING", 3)));
    expect(confs(r)).toEqual(["03 82 13@0.7550"]);
    expect(r.spans[0].score).toBeCloseTo(0.8032, 4);
  });
  it("§6.8 conf uses the BEST owned s: s = 0.8032 and s = 1 → 1 × 0.91, not 0.8032 × 0.91", () => {
    expect(confs(run(lines("CORE DRILLING", "CONCRETE CORE DRILLING")))).toEqual(["03 82 13@0.9100"]);
  });
  it("§6.7 text exception counts PATTERN tokens: a ≥3-token pattern matched on 2 words emits", () => {
    expect(confs(run({ text: "SALES TAX\nSALES TAX\nSALES TAX" }))).toEqual(["00 62 76.13@0.7524"]);
  });
  it("E9 cell key is (table, column): one header under two table titles = two ranges", () => {
    const cells: V2Cell[] = [{ title: "T1", header: "DOOR MATERIAL", text: "HM" }, { title: "T2", header: "DOOR MATERIAL", text: "HM" }];
    expect(confs(run({ cells }))).toEqual(["08 13 13@0.7735"]);
  });
  it("distinct ranges within ONE line count separately: GYPSUM BOARD twice on a line → 0.91", () => {
    expect(confs(run(lines("GYPSUM BOARD GYPSUM BOARD")))).toEqual(["09 29 00@0.9100"]);
  });
  it("§6.7 facility gate counts DISTINCT ranges: two spans in one column are one range → dropped", () => {
    const cells: V2Cell[] = [0, 1].map(() => ({ header: "PIPE", text: "DUCTILE IRON UTILITY PIPING" }));
    expect(drops(run({ cells }))).toEqual(["33 05 19:facility", "33 05 19:facility"]);
  });
});

describe.skipIf(!HAS_KB)("csi-page: boundary pins (fix round 2 — each kills a mutant the 43 above let live)", () => {
  // MEASURED 2026-10-21 on kb-v2.4 by the S4 review's scratch killers, re-run here under bp-suite.
  const PIPE = "DUCTILE IRON UTILITY PIPING";
  it("§6.7 facility gate is unlocked by discipline C ONLY: P and M do not unlock it", () => {
    for (const discipline of ["P", "M"]) {
      const r = run({ ...lines(PIPE), context: { discipline } });
      expect(r.codes).toEqual([]);
      expect(drops(r)).toEqual(["33 05 19:facility"]);
    }
    expect(confs(run({ ...lines(PIPE), context: { discipline: "C" } }))).toEqual(["33 05 19@0.8800"]);
  });
  it("§6.7 facility gate ignores by_others ranges: one real range + one NIC range → dropped", () => {
    const r = run(lines(PIPE, `${PIPE} NIC`));
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(["33 05 19:facility", "33 05 19:by_others"]);
  });
  it("§6.8 s ≥ 0.8 judged on the BEST owned span: s = 1 beside s = 0.765 still emits", () => {
    const r = run(lines("RESIDENTIAL WATER CLOSETS, URINALS, AND BIDETS", "RESIDENTIAL CLOSETS, URINALS, AND BIDETS"));
    expect(confs(r)).toEqual(["22 41 13@0.9100"]);
    expect(r.spans.map((s) => (s.score ?? Number.NaN).toFixed(4))).toEqual(["1.0000", "0.7650"]);
  });
  it("§6.8 τ is inclusive: conf exactly τ (0.88) emits", () => {
    expect(confs(run(lines("GYPSUM BOARD"), { tau: 0.88 }))).toEqual(["09 29 00@0.8800"]);
  });
  it("§6.8 sort is conf-first at fine grain: 0.7550 (L4) before 0.7524 (L5)", () => {
    const text = [...Array(3).fill("CORE DRILLING"), ...Array(3).fill("SALES TAX")].join("\n");
    expect(confs(run({ text }))).toEqual(["03 82 13@0.7550", "00 62 76.13@0.7524"]);
    expect(run({ text }).codes.map((c) => c.level)).toEqual([4, 5]);
  });
});

describe.skipIf(!HAS_KB)("csi-page: boundary pins (fix round 3 — each kills a mutant the 48 above let live)", () => {
  // MEASURED 2026-10-21 on kb-v2.4 with the unmutated engine (probe log: …/logs/s4-fix3-probe.txt).
  const rep = (t: string, n: number) => Array.from({ length: n }, () => t);
  const WEAK = "RESIDENTIAL CLOSETS, URINALS, AND BIDETS"; // s = 0.765
  const STRONG = "RESIDENTIAL WATER CLOSETS, URINALS, AND BIDETS"; // s = 1
  it("§6.8 s ≥ 0.8 is judged over LIVE owned spans only: a strong by_others span does not lift 5 weak ranges", () => {
    // conf over the live spans = 0.765 × 1.0 ≥ τ, so only the strong-span rule stops it; the s = 1 span is by_others
    const r = run(lines(...rep(WEAK, 5), `${STRONG} BY OTHERS`));
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual([...rep("22 41 13:weak", 5), "22 41 13:by_others"]);
    expect(r.spans.map((s) => (s.score ?? Number.NaN).toFixed(4))).toEqual([...rep("0.7650", 5), "1.0000"]);
  });
  it("§6.7 facility gate does not count a FAMILY-owned range, even from a code-unique pattern", () => {
    // line 2 is owned by 33 34 00 as the family owner of {33 34 00, 33 34 53} via the unique `Distribution Chambers` title
    const FAM = "DRAINAGE FIELD DISTRIBUTION CHAMBERS", OWN = "ONSITE WASTEWATER DISPOSAL";
    const u = codeUniquePatterns(kb);
    const t = kb.patterns.find((p) => p.code === "33 34 53" && p.source === "title");
    expect(t && u[t.id]).toBe(1);
    const r = run(lines(OWN, FAM));
    expect(r.codes).toEqual([]);
    expect(drops(r)).toEqual(["33 34 00:facility", "33 34 00:facility"]);
    expect(r.spans.map((s) => (s.score ?? Number.NaN).toFixed(4))).toEqual(["1.0000", "0.9000"]);
    expect(confs(run(lines(OWN, OWN)))).toEqual(["33 34 00@0.9100"]); // two OWN ranges pass the gate
    const c = run({ ...lines(OWN, FAM), context: { discipline: "C" } });
    expect(confs(c)).toEqual(["33 34 00@0.9100"]);
    expect(c.codes[0].alternatives).toEqual(["33 34 00", "33 34 53"]);
  });
});

describe.skipIf(!HAS_KB)("csi-page: determinism", () => {
  it("same input twice → identical output", () => {
    const inp = lines(...SIX, "DOOR HARDWARE BY OTHERS", "LIST OF DRAWING SHEETS", "BALL VALVE");
    expect(JSON.stringify(run(inp))).toBe(JSON.stringify(run(inp)));
    const t = { text: [...SIX, "LIST OF DRAWING SHEETS"].join("\n") };
    expect(JSON.stringify(run(t))).toBe(JSON.stringify(run(t)));
  });
  it("line order independence: reversed lines → the same codes, confidences and hints", () => {
    const fwd = lines(...SIX, "DOOR HARDWARE BY OTHERS", "AUTOCLAVED AERATED UNIT MASONRY", "BALL VALVE", "GYPSUM BOARD");
    const rev: V2Input = { lines: (fwd.lines ?? []).slice().reverse() };
    const a = run(fwd), b = run(rev);
    expect(codeView(b.codes)).toEqual(codeView(a.codes));
    expect(b.divisionHints).toEqual(a.divisionHints);
    expect(b.spans.map((s) => `${s.code}:${s.drop ?? ""}`).sort()).toEqual(a.spans.map((s) => `${s.code}:${s.drop ?? ""}`).sort());
  });
  it("line order independence under several permutations (the sort is a total order; ties at the cap included)", () => {
    const page = [...SIX, "DOOR HARDWARE", "DOOR HARDWARE BY OTHERS", "CARPET", "SEALANT", "BALL VALVE", "LIST OF DRAWING SHEETS"];
    const base = lines(...page).lines ?? [];
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; }; // MINSTD, exact in doubles
    const ref = run({ lines: base }, { maxCodesPerPage: 4 });
    for (let k = 0; k < 6; k++) {
      const perm = base.slice();
      for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      const r = run({ lines: perm }, { maxCodesPerPage: 4 });
      expect(codeView(r.codes)).toEqual(codeView(ref.codes));
      expect(r.divisionHints).toEqual(ref.divisionHints);
    }
  });
  it("span records agree with the code list: emitted ⇔ the code is emitted and the span has no drop", () => {
    const r = run(lines(...SIX, "DOOR HARDWARE BY OTHERS", "LIST OF DRAWING SHEETS", "GYPSUM QQQ ZZZ XXX BOARD", "DUCTILE IRON UTILITY PIPING"), { maxCodesPerPage: 4 });
    const emitted = new Set(codesOf(r));
    for (const s of r.spans) {
      expect(s.emitted).toBe(s.drop === undefined);
      if (s.emitted) expect(emitted.has(s.code)).toBe(true);
    }
    for (const c of r.codes) {
      expect(r.spans.some((s) => s.code === c.code && s.emitted)).toBe(true);
      expect((c.triggers ?? []).length).toBe(r.spans.filter((s) => s.code === c.code).length);
    }
  });
  it("cell order independence", () => {
    const cells: V2Cell[] = [{ header: "DOOR MATERIAL", text: "HM" }, { header: "DOOR TYPE", text: "HM" }, { header: "FINISH", text: "GWB" }, { text: "CARPET" }];
    expect(codeView(run({ cells: cells.slice().reverse() }).codes)).toEqual(codeView(run({ cells }).codes));
  });
});
