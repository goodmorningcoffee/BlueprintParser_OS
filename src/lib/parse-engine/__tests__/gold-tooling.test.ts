// [table-pipeline WP-2.G] Gold and measurement tooling (scripts/gold/*, scripts/parse-engine-measure.ts,
// scripts/lib/parse-measure.ts) and the K79 corpus loader fix (scripts/lib/corpus-v2-marks.ts). Every text here is
// synthetic pseudo-text (PLAN §1.6 rule 12); the private dirs are fresh temp dirs outside the repository.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalJson, insideBp2Checkout, mulberry32, privateDirOf, refuseWrite, toJsonl, validateRecords, writePrivate, type GoldLine,
} from "../../../../scripts/gold/gold-lib";
import { main as validateMain, validateFiles } from "../../../../scripts/gold/validate";
import { main as labelPackMain } from "../../../../scripts/gold/label-pack";
import { main as prefillMain } from "../../../../scripts/gold/prefill";
import { drawSample, guessParaStratum, main as selectMain, type Candidate } from "../../../../scripts/gold/select-sample";
import { assign } from "../../../../scripts/gold/label-pack";
import { agreement, cohenKappa, compare, ignoredDecisions, main as adjudicateMain, mergeBatch } from "../../../../scripts/gold/adjudicate";
import { tabTruthFrom } from "../../../../scripts/gold/prefill";
import {
  HEADLINE_GAPS, bootstrapMean, legacyPrediction, measure, pairedBootstrap, paraMetrics, promotionVerdict, tabMetrics, type Unit,
} from "../../../../scripts/lib/parse-measure";
import { run as measureRun, syntheticUnits } from "../../../../scripts/parse-engine-measure";
import { classicalKeynotes, type Mark } from "../../../../scripts/lib/corpus-v2-marks";

const REPO = resolve(__dirname, "../../../..");
const tmps: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "bp-gold-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const base = { schema: "bp-gold/1" as const, page: 3, adjudicated: false, protocol: "v1" as const, labellers: ["agent-a"] };
const TAB: GoldLine = {
  ...base, gold: "G-TAB", goldId: "tab-t1-0001", setId: "set-7", stratum: "shape-tag-schedule", sheet: null, sliceId: "prv-tab-t1-0001",
  region: [0.1, 0.1, 0.5, 0.4],
  truth: { headerRows: [["MARK", "DESCRIPTION", "SIZE"]], rows: [{ cells: ["QX-1", "ZFKMP SNIEV", "3'-0\""] }, { cells: ["DCZRP"], section: true }, { cells: ["QX-2", "NEKQKA KXBDUU", "4'-0\""] }], colEdges: [0.1, 0.2, 0.4, 0.5], rowEdges: [0.1, 0.15, 0.2, 0.25, 0.3], tagColumn: 0 },
};
const PARA: GoldLine = {
  ...base, gold: "G-PARA", goldId: "para-t1-0001", setId: "set-8", stratum: "notes", region: [0.55, 0.1, 0.9, 0.5],
  truth: { items: [{ key: "", text: "GENERAL NOTES", header: true }, { key: "1.", text: "DZGMP EWFTV ZFKMP" }, { key: "2.", text: "LOZC QEISL NEKQKA" }] },
};
const TAGMAP: GoldLine = {
  ...base, gold: "G-TAGMAP", goldId: "tagmap-t1-0001", setId: "set-7", stratum: "schedule-project", region: [0.1, 0.1, 0.5, 0.4],
  truth: { table: "tab-t1-0001", scope: "project", tags: [{ tag: "QX-1", qty: 2, instances: [{ page: 4, bbox: [0.3, 0.3, 0.32, 0.32] }, { page: 5, bbox: [0.6, 0.2, 0.62, 0.22] }] }] },
};

describe("gold line contract and validate.ts", () => {
  it("round-trips a synthetic gold file byte-equal and validates it clean", () => {
    const dir = tmp();
    const file = join(dir, "gold", "G-TAB.v1.jsonl");
    writePrivate(file, toJsonl([TAB, PARA, TAGMAP]), dir);
    const text = readFileSync(file, "utf8");
    const reparsed = text.trim().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(toJsonl(reparsed)).toBe(text);
    expect(validateFiles([file], { privateDir: dir, roundtrip: true, checkSlices: false }).problems).toEqual([]);
    expect(validateMain(["--private-dir", dir, "--roundtrip", "--no-slices"])).toBe(0);
    // the slice check fires when the slice is missing, and passes once it exists
    expect(validateFiles([file], { privateDir: dir }).problems.join("\n")).toMatch(/slice prv-tab-t1-0001 not found/);
    writePrivate(join(dir, "slices", "prv-tab-t1-0001.json"), "{}\n", dir);
    expect(validateFiles([file], { privateDir: dir }).problems).toEqual([]);
  });

  it("canonical JSON sorts keys, so a reordered line still round-trips to the same bytes", () => {
    const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const shuffled = reverseKeys(TAB);
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(TAB));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(TAB));
  });

  it("reports schema, semantic, uniqueness and reference problems", () => {
    const bad = [
      { ...TAB, goldId: "tab-t1-0002", truth: { ...TAB.truth, rows: [{ cells: ["QX-1", "ZFKMP"] }] } }, // 2 cells, 3 columns
      { ...TAB, goldId: "tab-t1-0003", stratum: "made-up" },
      { ...PARA, goldId: "para-t1-0001" }, { ...PARA },                                                 // duplicate id
      { ...TAGMAP, truth: { ...(TAGMAP as Extract<GoldLine, { gold: "G-TAGMAP" }>).truth, table: "tab-nope" } },
      { ...TAB, goldId: "tab-t1-0004", region: [0.5, 0.1, 0.1, 0.4] },                                  // x0 > x1
      { ...TAB, goldId: "tab-t1-0005", adjudicated: true },                                             // one labeller
      { ...TAB, goldId: "tab-t1-0006", truth: { ...TAB.truth, rowEdges: [0.1, 0.2] } },                 // edge count
      { ...TAB, goldId: "tab-t1-0007", extra: 1 },                                                      // unknown key
    ];
    const msgs = validateRecords(bad).problems.join("\n");
    for (const re of [/rows\[0\] has 2 cells/, /stratum "made-up"/, /duplicate goldId para-t1-0001/, /tab-nope names no G-TAB/, /x0 < x1/, /adjudicated needs two labellers/, /rowEdges has 2 edges/, /extra/]) {
      expect(msgs).toMatch(re);
    }
  });

  it("two labellers' files share goldIds (--file mode); gold files may not", () => {
    const dir = tmp();
    const a = join(dir, "gold", "batches", "t1", "labels", "agent-a.jsonl");
    const b = join(dir, "gold", "batches", "t1", "labels", "agent-b.jsonl");
    writePrivate(a, toJsonl([TAB, TAGMAP]), dir);
    writePrivate(b, toJsonl([{ ...TAGMAP, labellers: ["agent-b"] }]), dir); // its table is labelled only in A's file
    expect(validateFiles([a, b], { privateDir: dir, checkSlices: false, uniqueAcrossFiles: false }).problems).toEqual([]);
    expect(validateMain(["--private-dir", dir, "--no-slices", "--file", a, "--file", b])).toBe(0);
    expect(validateFiles([a, b], { privateDir: dir, checkSlices: false }).problems.join("\n")).toMatch(/goldId tagmap-t1-0001 also in/);
  });

  it("a non-canonical file fails --roundtrip", () => {
    const dir = tmp();
    const file = join(dir, "gold", "G-PARA.v1.jsonl");
    writePrivate(file, JSON.stringify(PARA, null, 0) + "\n", dir); // insertion order, not sorted keys
    expect(validateFiles([file], { privateDir: dir, roundtrip: true, checkSlices: false }).problems.join("\n")).toMatch(/not canonical/);
  });
});

describe("the gold tools never write inside the BP2 tree", () => {
  it("refuseWrite / writePrivate refuse targets in this checkout and a private dir inside it", () => {
    const dir = tmp();
    expect(insideBp2Checkout(join(REPO, "eval", "gold.jsonl"))).toBe(true);
    expect(insideBp2Checkout(join(dir, "gold", "x.jsonl"))).toBe(false);
    expect(refuseWrite(join(REPO, "eval", "G-TAB.v1.jsonl"), dir)).toMatch(/inside a BP2 checkout/);
    expect(refuseWrite(join(REPO, "x", "y.jsonl"), join(REPO, "x"))).toMatch(/private dir .* is inside a BP2 checkout/);
    expect(refuseWrite(join(tmp(), "elsewhere.jsonl"), dir)).toMatch(/outside the private dir/);
    expect(refuseWrite(join(dir, "gold", "ok.jsonl"), dir)).toBeNull();
    expect(() => writePrivate(join(REPO, "src", "gold-leak.jsonl"), "x", dir)).toThrow(/refused/);
    expect(existsSync(join(REPO, "src", "gold-leak.jsonl"))).toBe(false);
  });

  it("there is no compiled-in private dir: unset is a clear error, --private-dir beats $BP_PRIVATE_GOLD_DIR", () => {
    expect(() => privateDirOf(undefined, {})).toThrow(/no private gold dir: pass --private-dir/);
    expect(privateDirOf(undefined, { BP_PRIVATE_GOLD_DIR: "/x/env" })).toBe(resolve("/x/env"));
    expect(privateDirOf("/x/arg", { BP_PRIVATE_GOLD_DIR: "/x/env" })).toBe(resolve("/x/arg"));
  });

  it("select-sample, validate and the measure refuse a BP2 private dir / output", () => {
    const cands = join(tmp(), "c.jsonl");
    writeFileSync(cands, toJsonl([{ gold: "G-PARA", stratum: "notes", pid: "p1", setId: "set-1", page: 1, region: [0.1, 0.1, 0.2, 0.2], source: "t" }]));
    expect(() => selectMain(["--batch", "zz", "--candidates", cands, "--private-dir", join(REPO, "tmp-gold-private")])).toThrow(/inside a BP2 checkout/);
    expect(existsSync(join(REPO, "tmp-gold-private"))).toBe(false);
    expect(validateMain(["--file", join(REPO, "package.json"), "--private-dir", tmp()])).toBe(2);
    expect(() => measureRun(["--synthetic", "--sets", "all", "--resamples", "10", "--json", join(REPO, "measure-report.json")])).toThrow(/refused/);
    expect(existsSync(join(REPO, "measure-report.json"))).toBe(false);
  });
});

describe("bootstrap and the §6.4 verdict", () => {
  const rand = mulberry32(42);
  const baseScores = Array.from({ length: 60 }, () => rand());
  const legScores = baseScores.map((v) => Math.min(1, v + 0.05 + (rand() - 0.5) * 0.02));

  it("a seeded paired bootstrap is reproducible, and a new seed changes only the interval", () => {
    const a = pairedBootstrap(baseScores, legScores, { seed: 7, resamples: 2000 });
    expect(pairedBootstrap(baseScores, legScores, { seed: 7, resamples: 2000 })).toEqual(a);
    const b = pairedBootstrap(baseScores, legScores, { seed: 8, resamples: 2000 });
    expect(b.diff).toBe(a.diff);
    expect([b.lo, b.hi]).not.toEqual([a.lo, a.hi]);
    expect(a.lo).toBeLessThanOrEqual(a.diff);
    expect(a.hi).toBeGreaterThanOrEqual(a.diff);
    expect(a.diff).toBeGreaterThan(0.03);
    expect(a.lo).toBeGreaterThan(0);
  });

  it("degenerate cases are exact", () => {
    expect(pairedBootstrap([0.5, 0.5], [0.5, 0.5])).toMatchObject({ diff: 0, lo: 0, hi: 0 });
    expect(bootstrapMean([1, 1, 1])).toMatchObject({ mean: 1, lo: 1, hi: 1 });
    expect(Number.isNaN(bootstrapMean([]).mean)).toBe(true);
    expect(() => pairedBootstrap([1], [1, 2])).toThrow(/equal lengths/);
  });

  it("promotes, holds and stays undecided as §6.4 says", () => {
    const ci = (diff: number, lo: number, hi: number) => ({ n: 50, meanBase: 0.5, meanLeg: 0.5 + diff, diff, lo, hi });
    expect(promotionVerdict({ a: ci(0.05, 0.02, 0.08), b: ci(0, -0.005, 0.006) }).verdict).toBe("promote");
    expect(promotionVerdict({ a: ci(0.05, 0.02, 0.08), b: ci(-0.05, -0.08, -0.02) }).verdict).toBe("hold");
    expect(promotionVerdict({ a: ci(0.01, -0.005, 0.02) }).verdict).toBe("hold");
    const u = promotionVerdict({ a: ci(0.05, 0.02, 0.08), b: ci(0.01, -0.03, 0.05) });
    expect(u.verdict).toBe("undecided");
    expect(u.needUnits).toBe(Math.ceil(50 * (0.04 / 0.02) ** 2));
  });

  it("never promotes over an unmeasured §6.3 headline unless the narrowed set is accepted (WP-2.G fix, MED-3)", () => {
    const ci = (diff: number, lo: number, hi: number, n = 50) => ({ n, meanBase: 0.5, meanLeg: 0.5 + diff, diff, lo, hi });
    const pass = { a: ci(0.05, 0.02, 0.08), b: ci(0, -0.005, 0.006) };
    const gated = promotionVerdict(pass, { gaps: HEADLINE_GAPS["G-TAB"] });
    expect(gated.verdict).toBe("undecided");
    expect(gated.reason).toMatch(/shapeCentreRows/);
    const accepted = promotionVerdict(pass, { gaps: HEADLINE_GAPS["G-TAB"], acceptGaps: true });
    expect(accepted).toMatchObject({ verdict: "promote" });
    expect(accepted.reason).toMatch(/MEASURED/);
    // a measured headline with no applicable unit is a gap too
    expect(promotionVerdict({ ...pass, c: ci(Number.NaN, Number.NaN, Number.NaN, 0) }).verdict).toBe("undecided");
    // a sure loss still holds, gaps or not
    expect(promotionVerdict({ ...pass, b: ci(-0.05, -0.08, -0.02) }, { gaps: ["x"], acceptGaps: true }).verdict).toBe("hold");
  });

  it("a leg that throws scores as empty and is counted; metrics that do not apply drop out of n", () => {
    const units = syntheticUnits().filter((u) => u.gold === "G-TAB").slice(0, 4);
    const ok = { id: "ok", applies: () => true, run: (u: Unit) => ({ grid: u.gold === "G-TAB" ? u.truth.rows.map((r) => r.cells) : null }) };
    const boom = { id: "boom", applies: () => true, run: () => { throw new Error("x"); } };
    const r = measure(units, [ok, boom], { resamples: 50, baseline: { "G-TAB": "ok" } });
    expect(r.skipped["G-TAB: boom threw (scored as empty)"]).toBe(4);
    expect(r.legs["G-TAB"].boom.metrics.cellExact.mean).toBe(0);
    const withTag = units.filter((u) => u.gold === "G-TAB" && u.truth.tagColumn != null).length;
    expect(r.legs["G-TAB"].ok.metrics.tagKeyExact.n).toBe(withTag);
    expect(r.headlineGaps["G-TAB"]).toEqual({ missing: [...HEADLINE_GAPS["G-TAB"]], accepted: false });
  });
});

describe("metrics", () => {
  const t = (TAB as Extract<GoldLine, { gold: "G-TAB" }>).truth;
  it("a perfect grid scores 1 everywhere; a split row and a column split are seen", () => {
    expect(tabMetrics(t, t.rows.map((r) => r.cells))).toEqual({ rowCountExact: 1, rowTextF1: 1, wordRowAcc: 1, cellExact: 1, tagKeyExact: 1, sectionRowRecall: 1 });
    // the tag column and section rows are scored on their own; without them the metric does not apply (NaN)
    expect(tabMetrics(t, [["QX-1", "ZFKMP SNIEV", "3'-0\""], ["QX-2 DCZRP", "NEKQKA KXBDUU", "4'-0\""]])).toMatchObject({ sectionRowRecall: 0 });
    expect(tabMetrics(t, [["QX 1", "ZFKMP SNIEV", "3'-0\""], ["DCZRP"], ["QX 2", "NEKQKA KXBDUU", "4'-0\""]]).tagKeyExact).toBe(0);
    const plain = tabMetrics({ headerRows: [], rows: [{ cells: ["QX-1", "ZFKMP"] }] }, [["QX-1", "ZFKMP"]]);
    expect(Number.isNaN(plain.tagKeyExact) && Number.isNaN(plain.sectionRowRecall)).toBe(true);
    const split = [["QX-1", "ZFKMP", "3'-0\""], ["", "SNIEV", ""], ["DCZRP"], ["QX-2", "NEKQKA KXBDUU", "4'-0\""]];
    const m = tabMetrics(t, split);
    expect(m.rowCountExact).toBe(0);
    expect(m.rowTextF1).toBeCloseTo(4 / 7, 5);
    expect(m.wordRowAcc).toBeLessThan(1);
    // an extra empty column (ocr-positions' "Column 2") does not cost a cell: the mapping skips it
    expect(tabMetrics(t, [["QX-1", "", "ZFKMP SNIEV", "3'-0\""], ["DCZRP"], ["QX-2", "", "NEKQKA KXBDUU", "4'-0\""]]).cellExact).toBe(1);
    expect(tabMetrics(t, null)).toMatchObject({ rowCountExact: 0, rowTextF1: 0, wordRowAcc: 0, cellExact: 0 });
  });

  it("paragraph keys normalise (1. = 1 = (1)) and text similarity is 1 − CER", () => {
    const p = (PARA as Extract<GoldLine, { gold: "G-PARA" }>).truth;
    expect(paraMetrics(p, [{ key: "", text: "GENERAL NOTES" }, { key: "1", text: "DZGMP EWFTV ZFKMP" }, { key: "(2)", text: "LOZC QEISL NEKQKA" }])).toEqual({ itemF1: 1, keyExact: 1, textSim: 1 });
    const merged = paraMetrics(p, [{ key: "", text: "GENERAL NOTES 1. DZGMP EWFTV ZFKMP 2. LOZC QEISL NEKQKA" }]);
    expect(merged.itemF1).toBe(0);
    expect(merged.textSim).toBeLessThan(0.5);
  });

  it("legacy outputs map to grids and items per path", () => {
    expect(legacyPrediction("keynote-manual", [{ key: "1", description: "ZFKMP" }])).toEqual({ grid: [["1", "ZFKMP"]], items: [{ key: "1", text: "ZFKMP" }] });
    expect(legacyPrediction("ocr-positions", { headers: ["A", "A", "B"], rows: [{ A: "x", B: "y" }] }).grid).toEqual([["x", "y"]]);
    expect(legacyPrediction("spec-auto", { plain: null, withSubSections: { sections: [{ sectionHeader: "PART 1", body: "ZFKMP" }] } }).items).toEqual([{ key: "PART 1", text: "ZFKMP" }]);
    expect(legacyPrediction("notes-paragraph", [{ rowText: { Key: "1.", Note: "QEISL" } }]).items).toEqual([{ key: "1.", text: "QEISL" }]);
    expect(legacyPrediction("manual", null)).toEqual({ grid: null, items: null });
  });
});

describe("parse-engine-measure dry run on the synthetic fixtures", () => {
  it("produces a deterministic report with every headline, per stratum and paired", () => {
    const units = syntheticUnits();
    expect(units.filter((u) => u.gold === "G-TAB").length).toBeGreaterThanOrEqual(25);
    expect(units.filter((u) => u.gold === "G-PARA").length).toBeGreaterThanOrEqual(10);
    const a = measureRun(["--synthetic", "--sets", "all", "--resamples", "200"]);
    const b = measureRun(["--synthetic", "--sets", "all", "--resamples", "200"]);
    expect(a.report).toEqual(b.report);
    const tab = a.report.legs["G-TAB"]["legacy:merger"];
    expect(Object.keys(tab.metrics)).toEqual(["rowCountExact", "rowTextF1", "wordRowAcc", "cellExact", "tagKeyExact", "sectionRowRecall"]);
    expect(a.markdown).toMatch(/§6\.3 headlines not measured: rowBandF1/);
    expect(tab.metrics.rowTextF1.lo).toBeLessThanOrEqual(tab.metrics.rowTextF1.mean);
    expect(Object.keys(tab.byStratum)).toContain("shape-tag-schedule");
    expect(a.report.paired["G-TAB"].baseline).toBe("legacy:merger");
    expect(a.report.paired["G-TAB"].legs["legacy:manual"].metrics.cellExact.n).toBe(a.report.gold["G-TAB"].units);
    expect(a.report.legs["G-PARA"]["legacy:notes-auto"].metrics.keyExact.n).toBe(a.report.gold["G-PARA"].units);
    expect(a.markdown).toMatch(/## G-TAB: \d+ units/);
    // the report carries numbers and ids, never fixture text
    expect(JSON.stringify(a.report)).not.toMatch(/ZFKMP|NEKQKA|DZGMP/);
  });

  it("splits by set parity and writes the JSON + markdown only where allowed", () => {
    const odd = measureRun(["--synthetic", "--sets", "odd", "--resamples", "50"]).report;
    const even = measureRun(["--synthetic", "--sets", "even", "--resamples", "50"]).report;
    const all = syntheticUnits().length;
    const n = (r: typeof odd) => Object.values(r.gold).reduce((s, g) => s + g.units, 0);
    expect(n(odd) + n(even)).toBe(all);
    const out = join(tmp(), "logs", "measure.json");
    const { written } = measureRun(["--synthetic", "--sets", "even", "--resamples", "50", "--json", out, "--private-dir", tmp()]);
    expect(written).toEqual([out, out.replace(/\.json$/, ".md")]);
    expect(JSON.parse(readFileSync(out, "utf8")).schema).toBe("bp-parse-measure/1");
  });

  it("reads private gold through its slices, and counts the units it cannot run", () => {
    const dir = tmp();
    const fx = JSON.parse(readFileSync(join(REPO, "src/lib/parse-engine/__fixtures__/syn-sched-basic.synthetic.json"), "utf8")) as { region: number[]; truth: { headers: string[]; rows: string[][] } };
    writePrivate(join(dir, "slices", "syn-sched-basic.json"), JSON.stringify(fx), dir);
    const line = { ...TAB, goldId: "tab-t1-0009", setId: "set-2", sliceId: "syn-sched-basic", region: fx.region, stratum: "unruled",
      truth: { headerRows: [fx.truth.headers], rows: fx.truth.rows.map((cells) => ({ cells })) } };
    const orphan = { ...line, goldId: "tab-t1-0010", sliceId: "prv-missing" };
    writePrivate(join(dir, "gold", "G-TAB.v1.jsonl"), toJsonl([line, orphan]), dir);
    const r = measureRun(["--private-dir", dir, "--sets", "even", "--gold", "G-TAB", "--resamples", "50"]).report;
    expect(r.gold["G-TAB"].units).toBe(1);
    expect(r.skipped["G-TAB: slice file missing"]).toBe(1);
    expect(r.legs["G-TAB"]["legacy:manual"].metrics.cellExact.mean).toBeGreaterThan(0.9);
  });
});

describe("sampling, packs and adjudication", () => {
  const cand = (i: number, stratum = "shape-tag-schedule"): Candidate => ({ gold: "G-TAB", stratum, pid: `p${i % 7}`, setId: `set-${(i % 7) + 1}`, page: i, region: [0.1, 0.1, 0.3, 0.3], source: "t" });
  const cands = Array.from({ length: 40 }, (_, i) => cand(i)).concat(Array.from({ length: 10 }, (_, i) => cand(100 + i, "kv-legend")));

  it("drawSample is seeded, order-free, balanced by parity and capped per set", () => {
    const q = { "G-TAB:shape-tag-schedule": 10, "G-TAB:kv-legend": 4, "G-TAGMAP:schedule-project": 3 };
    const s = drawSample(cands, q, "t1", 5);
    expect(drawSample(cands.slice().reverse(), q, "t1", 5)).toEqual(s);
    const tabs = s.items.filter((x) => x.stratum === "shape-tag-schedule");
    expect(tabs).toHaveLength(10);
    const perSet = new Map<string, number>();
    for (const x of tabs) perSet.set(x.setId, (perSet.get(x.setId) ?? 0) + 1);
    expect(Math.max(...perSet.values())).toBeLessThanOrEqual(2);
    const odd = tabs.filter((x) => Number(x.setId.slice(4)) % 2 === 1).length;
    expect(Math.abs(odd - (10 - odd))).toBeLessThanOrEqual(2);
    const maps = s.items.filter((x) => x.gold === "G-TAGMAP");
    expect(maps).toHaveLength(3);
    expect(maps.every((m) => m.table && tabs.some((t) => t.goldId === m.table))).toBe(true);
    expect(s.items.every((x) => /^(tab|tagmap)-t1-\d{4}$/.test(x.goldId))).toBe(true);
  });

  it("guesses paragraph strata from the block's own lines", () => {
    const L = (text: string, x: number) => ({ text, b: [x, 0, x + 0.1, 0.01] });
    expect(guessParaStratum([L("PART 1 GENERAL", 0), L("1.01 ZFKMP", 0)], [0, 0, 1, 1])).toBe("spec-hierarchy");
    expect(guessParaStratum([L("1. A", 0), L("2. B", 0), L("7. C", 0.6), L("8. D", 0.6)], [0, 0, 1, 1])).toBe("multi-column-notes");
    expect(guessParaStratum([L("1. A", 0), L("2. B", 0)], [0, 0, 1, 1])).toBe("notes");
  });

  it("assign: B labels the scratch tables round-robin over strata, then the double share of the rest", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ ...TAB, goldId: `tab-t1-${String(i).padStart(4, "0")}`, stratum: i % 2 ? "kv-legend" : "shape-tag-schedule" })) as GoldLine[];
    const a = assign(lines, { batch: "t1", a: "x", b: "y", scratch: 6, double: 0.15, seed: 3 });
    expect(a.aUnits).toHaveLength(20);
    expect(a.bScratch).toHaveLength(6);
    expect(lines.filter((l) => a.bScratch.includes(l.goldId) && l.stratum === "kv-legend")).toHaveLength(3);
    expect(a.bPrefill).toHaveLength(Math.ceil(14 * 0.15));
    expect(a.bPrefill.some((id) => a.bScratch.includes(id))).toBe(false);
    expect(assign(lines, { batch: "t1", a: "x", b: "y", scratch: 6, double: 0.15, seed: 3 })).toEqual(a);
  });

  it("agreement, κ and the merge rule", () => {
    const tabB = { ...TAB, labellers: ["agent-b"] } as GoldLine;
    expect(agreement(TAB, tabB)).toEqual({ agree: true, score: 1 });
    const t = (TAB as Extract<GoldLine, { gold: "G-TAB" }>).truth;
    const off = { ...tabB, truth: { ...t, rows: [t.rows[0], t.rows[1], { cells: ["QX-2", "NEKQKA", "4'-0\""] }] } } as GoldLine;
    const ag = agreement(TAB, off);
    expect(ag.agree).toBe(false);
    expect(ag.score).toBeGreaterThan(0.5);
    expect(cohenKappa(["a", "b", "a", "b"], ["a", "b", "a", "b"])).toBe(1);
    expect(cohenKappa(["a", "a", "b", "b"], ["a", "b", "a", "b"])).toBe(0);
    const ids = ["tab-t1-0001", "tab-t1-0002", "tab-t1-0003"];
    const A = new Map(ids.map((id) => [id, { ...TAB, goldId: id } as GoldLine]));
    const B = new Map([[ids[0], { ...tabB, goldId: ids[0] } as GoldLine], [ids[1], { ...off, goldId: ids[1] } as GoldLine]]);
    const asg = { schema: "bp-gold-assignment/1" as const, batch: "t1", seed: 1, a: "agent-a", b: "agent-b", aUnits: ids, bScratch: [ids[0]], bPrefill: [ids[1]] };
    const { report, queue, agreed } = compare(asg, A, B);
    expect(report.double).toMatchObject({ n: 2, agree: 0.5 });
    expect(report.prefillVsScratch).toMatchObject({ n: 1, agree: 1 });
    expect(queue.map((q) => [q.goldId, q.to])).toEqual([[ids[1], "owner"]]);
    const undecided = mergeBatch(asg, A, B, agreed, []);
    expect(undecided.map((l) => [l.goldId, l.adjudicated, l.labellers])).toEqual([[ids[0], true, ["agent-a", "agent-b"]], [ids[1], false, ["agent-a"]], [ids[2], false, ["agent-a"]]]);
    const decided = mergeBatch(asg, A, B, agreed, [{ goldId: ids[1], pick: "b" }]);
    expect(decided[1]).toMatchObject({ adjudicated: true, labellers: ["agent-a", "agent-b", "owner"], truth: (off as Extract<GoldLine, { gold: "G-TAB" }>).truth });
    expect(validateRecords(decided).problems).toEqual([]);
    // decisions it ignores are reported; a third labeller's decision carries its name
    expect(ignoredDecisions(asg, A, B, agreed, [{ goldId: ids[0], pick: "b" }, { goldId: ids[2], pick: "b" }, { goldId: "tab-zz-0001", pick: "a" }]))
      .toEqual([`${ids[0]}: the labellers agree`, `${ids[2]}: single-labelled (B has no label)`, "tab-zz-0001: not a unit of this batch"]);
    expect(mergeBatch(asg, A, B, agreed, [{ goldId: ids[1], pick: "a", by: "agent-c" }])[1].labellers).toEqual(["agent-a", "agent-b", "agent-c"]);
  });

  it("adjudicate --decisions refuses an existing gold file with any problem, and keeps a .bak when it merges (MED-1)", () => {
    const dir = tmp(), b = join(dir, "gold", "batches", "b1");
    const tab = (id: string) => ({ ...TAB, goldId: id }) as GoldLine;
    writePrivate(join(b, "packs", "assignment.json"), JSON.stringify({ schema: "bp-gold-assignment/1", batch: "b1", seed: 1, a: "agent-a", b: "agent-b", aUnits: ["tab-b1-0001"], bScratch: [], bPrefill: [] }), dir);
    writePrivate(join(b, "labels", "agent-a.jsonl"), toJsonl([tab("tab-b1-0001")]), dir);
    const gf = join(dir, "gold", "G-TAB.v1.jsonl");
    const bad = toJsonl([tab("tab-b0-0001"), { ...tab("tab-b0-0002"), note: "hand edit" }]);
    writePrivate(gf, bad, dir);
    const dec = join(dir, "dec.json");
    writeFileSync(dec, "[]");
    expect(adjudicateMain(["--batch", "b1", "--private-dir", dir, "--decisions", dec])).toBe(1);
    expect(readFileSync(gf, "utf8")).toBe(bad);
    expect(existsSync(join(b, "adjudication", "final.jsonl"))).toBe(false);
    const good = toJsonl([tab("tab-b0-0001")]);
    writePrivate(gf, good, dir);
    expect(adjudicateMain(["--batch", "b1", "--private-dir", dir, "--decisions", dec])).toBe(0);
    expect(readFileSync(`${gf}.bak`, "utf8")).toBe(good);
    expect(readFileSync(gf, "utf8")).toMatch(/tab-b0-0001[\s\S]*tab-b1-0001/);
  });

  it("prefill skips a tag map whose table had no page evidence instead of aborting the batch (MED-2)", () => {
    const dir = tmp(), corpus = tmp();
    mkdirSync(join(corpus, "data", "bundles"), { recursive: true });
    writeFileSync(join(corpus, "data", "bundles", "p1.json"), JSON.stringify({ pages: [], annotations: [] }));
    const items = [
      { gold: "G-TAB", stratum: "shape-tag-schedule", pid: "p1", setId: "set-1", page: 1, region: [0.1, 0.1, 0.3, 0.3], source: "t", goldId: "tab-b1-0001" },
      { gold: "G-TAGMAP", stratum: "schedule-project", pid: "p1", setId: "set-1", page: 1, region: [0.1, 0.1, 0.3, 0.3], source: "table:tab-b1-0001", goldId: "tagmap-b1-0001", table: "tab-b1-0001" },
    ];
    writePrivate(join(dir, "gold", "batches", "b1", "sample.json"), JSON.stringify({ schema: "bp-gold-sample/1", batch: "b1", seed: 1, perSet: 2, quota: {}, taken: {}, items }), dir);
    expect(prefillMain(["--batch", "b1", "--private-dir", dir, "--corpus", corpus])).toBe(0);
    expect(readFileSync(join(dir, "gold", "batches", "b1", "prefill.jsonl"), "utf8")).not.toMatch(/tagmap-b1-0001/);
  });

  it("validate --known-tables resolves tag maps without the prefill; label-pack will not re-pack a labelled batch", () => {
    const dir = tmp();
    const labels = join(dir, "gold", "batches", "b1", "labels", "agent-b.jsonl");
    writePrivate(labels, toJsonl([TAGMAP]), dir);
    expect(validateMain(["--private-dir", dir, "--file", labels, "--no-slices"])).toBe(1);
    const kt = join(dir, "gold", "batches", "b1", "packs", "tables.json");
    writePrivate(kt, JSON.stringify(["tab-t1-0001"]), dir);
    expect(validateMain(["--private-dir", dir, "--file", labels, "--known-tables", kt, "--no-slices"])).toBe(0);
    writePrivate(join(dir, "gold", "batches", "b1", "packs", "assignment.json"), "{}", dir);
    expect(labelPackMain(["--batch", "b1", "--private-dir", dir])).toBe(1);
  });

  it("prefill turns a method result into a valid table (placeholder headers dropped, edges kept only when they fit)", () => {
    const t = tabTruthFrom({ headers: ["Column 1", "Column 2"], rows: [{ "Column 1": "QX-1", "Column 2": "ZFKMP" }, { "Column 1": "", "Column 2": "" }], colBoundaries: [0.1, 0.2, 0.3], rowBoundaries: [0.1, 0.2] }, "ocr-positions");
    expect(t).toEqual({ headerRows: [], rows: [{ cells: ["QX-1", "ZFKMP"] }], colEdges: [0.1, 0.2, 0.3], rowEdges: [0.1, 0.2] });
    expect(tabTruthFrom({ headers: [], rows: [] }, "textract")).toBeNull();
  });
});

describe("K79: the corpus loader's classical keynotes", () => {
  it("takes the crop read from the bundle annotation, never the shape name, and drops non-classical shape marks", () => {
    const corpus = tmp();
    mkdirSync(join(corpus, "data", "bundles"), { recursive: true });
    writeFileSync(join(corpus, "data", "bundles", "pid1.json"), JSON.stringify({ pages: [], annotations: [{ id: 11, source: "shape-parse", data: { text: "QX-4" } }, { id: 12, source: "shape-parse", data: {} }, { id: 13, source: "shape-parse", data: { text: "  " } }] }));
    const m = (over: Partial<Mark>): Mark => ({ channel: "shape", label: "circle", bbox: [0.1, 0.1, 0.12, 0.12], center: [0.11, 0.11], provenance: "raster.opencv.shape:circle", text: "circle", ...over });
    const marks = [
      m({ meta: { annotationId: 11 } }),                                              // annotation: crop read from the bundle
      m({ meta: { annotationId: 12 } }),                                              // annotation with no crop read → ""
      m({ meta: { annotationId: 99 } }),                                              // not in the bundle, text is the name → ""
      m({ text: "QX-7" }),                                                            // cut from pages.keynotes: kept
      m({ provenance: "raster.opencv.template:circle", text: "QX-9" }),               // symbol-search: not a keynote
      m({ channel: "ocr", provenance: "raster.ocr:word", text: "ZFKMP" }),
    ];
    expect(classicalKeynotes("pid1", marks, corpus).map((k) => k.text)).toEqual(["QX-4", "", "", "QX-7"]);
    expect(classicalKeynotes("absent", [m({ meta: { annotationId: 11 } })], corpus).map((k) => k.text)).toEqual([""]);
    // an empty / blank crop read is unknown: a re-ingested mark's own text survives it, the shape name never does
    expect(classicalKeynotes("pid1", [m({ meta: { annotationId: 12 }, text: "QX-5" }), m({ meta: { annotationId: 13 }, text: "QX-6" }), m({ meta: { annotationId: 13 } })], corpus).map((k) => k.text)).toEqual(["QX-5", "QX-6", ""]);
  });
});
