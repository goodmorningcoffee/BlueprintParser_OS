// @vitest-environment node
// [table-pipeline WP-3.Q] The label loop: the engine leg of parse-engine-measure, the per-tool §6.4 table, the R8 weight
// fit (odd sets only) and its profile file, the app-label import, and the inbox coverage. Every text here is synthetic
// pseudo-text (PLAN §1.6 rule 12); private dirs are fresh temp dirs outside the repository.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readJsonl, toJsonl, validateRecords, writePrivate, type GoldLine } from "../../../../scripts/gold/gold-lib";
import { assignSets, hasAppLabels, importBundle, main as importMain, readSetMap, regionTruth, type Bundle } from "../../../../scripts/gold/import-app-labels";
import { coverageOf } from "../../../../scripts/lib/inbox-coverage";
import { engineKindOf, engineLeg, enginePrediction, PROMOTION_TOOLS, promotionTable } from "../../../../scripts/lib/parse-engine-leg";
import { legacyLegs, type Leg, type Unit } from "../../../../scripts/lib/parse-measure";
import {
  assertFitUnits, defaultLegFactory, fitWeights, objectiveOf, parseProfileText, profileId, runFit, serializeProfile, type LegFactory,
} from "../../../../scripts/parse-engine-fit";
import { runAsync, syntheticUnits } from "../../../../scripts/parse-engine-measure";
import { regionSnapshot, snapshotHashOf } from "@/server/services/parse-labels";
import { PARSE_ACCEPT_WEIGHT } from "@/lib/classifier-engine/fit";
import { DEFAULT_PROFILE, PROFILE_PATH, resolveParseEngineProfile } from "../profile";
import { PARSE_ENGINE_FLAG_DEFAULTS } from "@/server/services/parse-engine/flags";

const REPO = resolve(__dirname, "../../../..");
const tmps: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "bp-wp3q-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const FIXTURE_TEXT = /ZFKMP|NEKQKA|DZGMP|QEISL/;

const units = syntheticUnits();
const odd = units.filter((u) => Number(u.setId.slice(4)) % 2 === 1);
const even = units.filter((u) => Number(u.setId.slice(4)) % 2 === 0);

describe("engine leg (parse-engine-measure --engine)", () => {
  it("is deterministic, covers every unit, and the report carries numbers and ids only", async () => {
    const a = await runAsync(["--synthetic", "--sets", "all", "--resamples", "100", "--engine", "--promotion"]);
    const b = await runAsync(["--synthetic", "--sets", "all", "--resamples", "100", "--engine", "--promotion"]);
    expect(a.report).toEqual(b.report);
    expect(a.report.legs["G-TAB"].engine.units).toBe(a.report.gold["G-TAB"].units);
    expect(a.report.legs["G-TAB"].engine.coverage).toBeGreaterThan(0.9);
    expect(a.report.legs["G-PARA"].engine.coverage).toBeGreaterThan(0.9);
    expect(Object.keys(a.report.paired["G-TAB"].legs)).toContain("engine");
    expect(a.report.promotion?.map((r) => r.tool)).toEqual(PROMOTION_TOOLS.map((t) => t.tool));
    expect(a.markdown).toMatch(/§6\.4 promotion table/);
    expect(JSON.stringify(a.report)).not.toMatch(FIXTURE_TEXT);
    expect(a.markdown).not.toMatch(FIXTURE_TEXT);
  });

  it("the sync run refuses --engine instead of silently dropping the leg", async () => {
    const { run } = await import("../../../../scripts/parse-engine-measure");
    expect(() => run(["--synthetic", "--engine"])).toThrow(/runAsync/);
  });

  it("kinds follow the strata; a table model becomes body + section rows in column order, paragraphs become items", async () => {
    expect(engineKindOf({ gold: "G-TAB", stratum: "keynote-legend-shapes" })).toBe("keynote");
    expect(engineKindOf({ gold: "G-TAB", stratum: "symbol-legend" })).toBe("legend");
    expect(engineKindOf({ gold: "G-PARA", stratum: "spec-hierarchy" })).toBe("spec");
    const model = {
      v: 1 as const, kind: "schedule" as const, bbox: [0, 0, 1, 1] as [number, number, number, number], headerRows: 1, sources: { rows: [], cols: [] }, quality: { conf: 1, agreement: 1, flags: [] },
      cols: [{ id: "c2", x0: 0.5, x1: 1, label: "B", labelRaw: "B" }, { id: "c1", x0: 0, x1: 0.5, label: "A", labelRaw: "A" }],
      rows: [{ id: "r1", y0: 0, y1: 0.1, role: "header" as const }, { id: "r2", y0: 0.1, y1: 0.2, role: "body" as const }, { id: "r3", y0: 0.2, y1: 0.3, role: "section" as const }],
      cells: [{ row: "r1", col: "c1", text: "A", src: "ocr-lines" as const }, { row: "r2", col: "c1", text: "QX-1", src: "ocr-lines" as const }, { row: "r2", col: "c2", text: "LINE ONE\nLINE TWO", src: "ocr-lines" as const }, { row: "r3", col: "c1", text: "SECTION", src: "ocr-lines" as const }],
    };
    expect(enginePrediction(model).grid).toEqual([["QX-1", "LINE ONE LINE TWO"], ["SECTION"]]);
    const leg = await engineLeg(units.slice(0, 2), { runner: async () => { throw new Error("boom"); } });
    expect(leg.errors).toBe(2);
    expect(leg.run(units[0])).toEqual({ grid: null, items: null });
  });

  it("the promotion table pairs each tool with its own baseline and strata", async () => {
    const leg = await engineLeg(even);
    const rows = promotionTable(even, [...legacyLegs(), leg], "engine", { resamples: 50 });
    const tables = rows.find((r) => r.tool === "tablesRoute")!;
    expect(tables.baseline).toBe("legacy:merger");
    expect(Object.keys(tables.byStratum).every((s) => PROMOTION_TOOLS[0].strata.includes(s))).toBe(true);
    expect(rows.find((r) => r.tool === "keynoteRoute")!.readBy).toBeNull();
    // every §6.3 headline gap withholds a strict promote
    for (const r of rows) expect(r.strict.verdict).not.toBe("promote");
  });
});

describe("parse-engine-fit (R8 weights; odd sets only)", () => {
  it("never reads an even (held-out) set: the fit refuses one, and every scoring call during the fit sees odd units only", async () => {
    expect(() => assertFitUnits(even.slice(0, 1))).toThrow(/even \(held-out\)/);
    await expect(fitWeights(units, async () => 0)).rejects.toThrow(/held-out/);
    const seen: Record<string, Set<string>> = {};
    const spy: LegFactory = async (us, profile, id) => {
      (seen[id] ??= new Set());
      for (const u of us) seen[id].add(u.setId);
      return defaultLegFactory(us, profile, id);
    };
    const report = await runFit(odd, even, { factory: spy, resamples: 50, passes: 1 });
    expect([...seen["engine:trial"]].every((s) => Number(s.slice(4)) % 2 === 1)).toBe(true);
    for (const id of ["engine:default", "engine:fitted"]) if (seen[id]) expect([...seen[id]].every((s) => Number(s.slice(4)) % 2 === 0)).toBe(true);
    expect(report.fit.units).toBe(odd.filter((u) => u.gold === "G-TAB").length);
    await expect(runFit(odd, odd, { resamples: 10, passes: 1 })).rejects.toThrow(/odd-set units/);
  });

  it("a move is kept only when it raises the objective; ties keep R8", async () => {
    const flat = await fitWeights(odd, async () => 0.5, { passes: 2 });
    expect(flat.steps).toEqual([]);
    expect(flat.profile).toBe(DEFAULT_PROFILE);
    const peaked = await fitWeights(odd, async (_u, p) => -Math.abs((p.rows["ocr-lines"] ?? 0) - 1.5), { passes: 2 });
    expect(peaked.profile.rows["ocr-lines"]).toBe(1.5);
    expect(peaked.steps.map((s) => s.method)).toEqual(["ocr-lines"]);
    expect(peaked.profile.id).toBe(profileId(peaked.profile));
  });

  it("the profile file round-trips byte-equal and the shipped file is the R8 default", () => {
    const p = { id: "fit-0123456789", rows: { ...DEFAULT_PROFILE.rows, "ocr-lines": 1.25 }, cols: { ...DEFAULT_PROFILE.cols, "x-starts": 0.5 } };
    const text = serializeProfile(p);
    expect(serializeProfile(parseProfileText(text))).toBe(text);
    expect(parseProfileText(text).rows["ocr-lines"]).toBe(1.25);
    expect(serializeProfile(DEFAULT_PROFILE)).toBe('{\n  "v": 1,\n  "id": "default"\n}\n');
    const shipped = resolveParseEngineProfile(JSON.parse(readFileSync(join(REPO, PROFILE_PATH), "utf8")));
    expect(shipped.error).toBeUndefined();
    expect(shipped.profile).toEqual(DEFAULT_PROFILE);
    expect(() => parseProfileText('{"v":1,"rows":{"nope":1}}')).toThrow(/invalid profile/);
  });

  it("the report is reproducible from a seed", async () => {
    const a = await runFit(odd, even, { seed: 7, resamples: 100, passes: 1 });
    const b = await runFit(odd, even, { seed: 7, resamples: 100, passes: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toMatch(FIXTURE_TEXT);
    expect(["adopt", "keep-default"]).toContain(a.decision);
  });

  it("the objective is the mean of the G-TAB headline means", () => {
    const tab = odd.filter((u) => u.gold === "G-TAB");
    const perfect: Leg = { id: "truth", applies: () => true, run: (u: Unit) => ({ grid: u.gold === "G-TAB" ? u.truth.rows.map((r) => r.cells) : null }) };
    expect(objectiveOf(tab, perfect)).toBeGreaterThan(0.95);
  });
});

describe("flag defaults (§6.4 report did not pass for any tool on batch 1)", () => {
  it("every strangler flag still ships at legacy; the workspace at engine", () => {
    expect(PARSE_ENGINE_FLAG_DEFAULTS.tools).toEqual({ tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy", notesAuto: "legacy", specAuto: "legacy", workspace: "engine" });
  });
});

// ─── import-app-labels ───────────────────────────────────────────────────────

const fx = JSON.parse(readFileSync(join(REPO, "src/lib/parse-engine/__fixtures__/syn-sched-basic.synthetic.json"), "utf8")) as {
  region: [number, number, number, number]; page: { words: unknown[]; lines: unknown[] }; truth: { headers: string[]; rows: string[][] };
};
const sched = (id: string, rows = fx.truth.rows) => ({
  id, type: "schedule", category: "door-schedule", bbox: fx.region, confidence: 1,
  data: { headers: fx.truth.headers, rows: rows.map((r) => Object.fromEntries(fx.truth.headers.map((h, i) => [h, r[i] ?? ""]))), tagColumn: fx.truth.headers[0], rowCount: rows.length, columnCount: fx.truth.headers.length },
});
const label = (region: ReturnType<typeof sched> | null, verdict: string, extra: Record<string, unknown> = {}) => ({
  v: 1, regionId: region?.id ?? "gone", kind: "schedule", source: "verdict-bar", verdict, at: "2026-10-28T00:00:00.000Z",
  snapshotHash: region ? snapshotHashOf(regionSnapshot(region)) : "0", ...extra,
});

function bundle(pid: string): Bundle {
  const r1 = sched("r1"), r2 = sched("r2"), r3 = sched("r3"), r4 = sched("r4");
  const r3Before = sched("r3", fx.truth.rows.slice(1)); // the verdict was given on another snapshot → "corrected"
  return {
    schemaVersion: "bp-export/1",
    project: {
      publicId: pid,
      projectIntelligence: { tagMaps: { r1: { v: 1, regionId: "r1", page: 1, scope: "project", defs: {
        a: { targetId: "row1", text: "QX-1", norm: "QX1", instances: [{ id: "i1", page: 2, b: [0.3, 0.3, 0.32, 0.32], status: "confirmed" }, { id: "i2", page: 3, b: [0.4, 0.4, 0.42, 0.42], status: "auto" }] },
      } } } },
    },
    pages: [{
      pageNumber: 1, drawingNumber: "S-1", textractData: { words: fx.page.words, lines: fx.page.lines },
      pageIntelligence: {
        parsedRegions: [r1, r2, r3, r4],
        parseLabels: { r1: label(r1, "correct"), r2: label(r2, "committed", { source: "workspace" }), r3: label(r3Before, "correct"), r4: label(r4, "wrong"), gone: label(null, "correct") },
        proposalVerdicts: {
          pA: { proposalId: "pA", recipeId: "schedules.v1", recipeVersion: 1, verdict: "accept", via: "parse", features: {}, proposedClassId: "door", userId: 1, at: "t" },
          pB: { proposalId: "pB", recipeId: "schedules.v1", recipeVersion: 1, verdict: "reject", features: {}, proposedClassId: null, userId: 1, at: "t" },
        },
      },
    }],
    annotations: [],
  };
}

describe("import-app-labels (owner actions → private gold)", () => {
  it("✓ and committed → adjudicated truth; inferred `corrected` → unadjudicated + queued; ✗ → negative record only", () => {
    const r = importBundle(bundle("P1"), "set-3", "P1");
    const tab = r.lines.filter((l) => l.gold === "G-TAB");
    expect(tab).toHaveLength(3);
    expect(tab.filter((l) => l.adjudicated)).toHaveLength(2);
    const queued = tab.find((l) => !l.adjudicated)!;
    expect(queued.labellers).toEqual(["app:corrected"]);
    expect(r.queue.map((q) => q.goldId)).toContain(queued.goldId);
    expect(r.labels.find((l) => l.verdict === "wrong")?.goldId).toBeUndefined();
    expect(r.counts["parse: orphan"]).toBe(1);
    expect(validateRecords(r.lines).problems).toEqual([]);
    expect(tab.every((l) => l.setId === "set-3" && l.mode === "import" && l.tags?.includes("import"))).toBe(true);
    const t = tab.find((l) => l.adjudicated)! as Extract<GoldLine, { gold: "G-TAB" }>;
    expect(t.truth.headerRows).toEqual([fx.truth.headers]);
    expect(t.truth.rows.map((x) => x.cells)).toEqual(fx.truth.rows);
    expect(t.truth.tagColumn).toBe(0);
    expect(r.slices.get(t.sliceId!)?.page.words.length).toBeGreaterThan(0);
  });

  it("a `via:\"parse\"` accept is a weak label (the classifier fit's down-weight); a reject is adjudicated", () => {
    const r = importBundle(bundle("P1"), "set-3", "P1");
    const a = r.labels.find((l) => l.proposalId === "pA")!, b = r.labels.find((l) => l.proposalId === "pB")!;
    expect(a).toMatchObject({ weak: true, weight: PARSE_ACCEPT_WEIGHT, adjudicated: false });
    expect(b).toMatchObject({ verdict: "reject", adjudicated: true });
    expect(b.weak).toBeUndefined();
  });

  it("tag reviews → records + a G-TAGMAP line of the confirmed instances, queued while any instance is still auto", () => {
    const r = importBundle(bundle("P1"), "set-3", "P1");
    const map = r.lines.find((l) => l.gold === "G-TAGMAP") as Extract<GoldLine, { gold: "G-TAGMAP" }>;
    expect(map.adjudicated).toBe(false);
    expect(map.truth.tags).toEqual([{ tag: "QX-1", instances: [{ page: 2, bbox: [0.3, 0.3, 0.32, 0.32] }] }]);
    expect(r.lines.some((l) => l.goldId === map.truth.table && l.gold === "G-TAB")).toBe(true);
    expect(r.labels.filter((l) => l.type === "tag-instance").map((l) => l.status)).toEqual(["confirmed"]);
  });

  it("a project keeps its set number across batches; a new project gets the next free number", () => {
    const dir = tmp();
    writePrivate(join(dir, "gold", "batches", "b1", "sample.json"), JSON.stringify({ items: [{ pid: "P1", setId: "set-7" }, { pid: "P0", setId: "set-2" }] }), dir);
    const map = readSetMap(dir, null);
    expect(map.get("P1")).toBe("set-7");
    expect(assignSets(map, ["P9", "P1", "P5"])).toEqual(["P5", "P9"]);
    expect(hasAppLabels(bundle("PX"))).toBe(true);
    expect(hasAppLabels({ schemaVersion: "bp-export/1", project: { publicId: "PY" }, pages: [{ pageNumber: 1, pageIntelligence: { parseLabels: {} } }] })).toBe(false);
    expect([map.get("P5"), map.get("P9")]).toEqual(["set-8", "set-9"]);
  });

  it("the CLI writes the import batch, merges only adjudicated lines, and is idempotent", () => {
    const dir = tmp();
    writePrivate(join(dir, "gold", "batches", "b1", "sample.json"), JSON.stringify({ items: [{ pid: "P1", setId: "set-7" }] }), dir);
    writePrivate(join(dir, "bundles", "p1.json"), JSON.stringify(bundle("P1")), dir);
    writePrivate(join(dir, "bundles", "p2.json"), JSON.stringify(bundle("P2")), dir);
    const args = ["--private-dir", dir, "--batch", "app-1", "--bundles", join(dir, "bundles"), "--merge", "--research", "none"];
    expect(importMain(args)).toBe(0);
    const gold = readJsonl(join(dir, "gold", "G-TAB.v1.jsonl")) as GoldLine[];
    expect(gold).toHaveLength(4); // 2 adjudicated per project
    expect(gold.every((l) => l.adjudicated)).toBe(true);
    expect(new Set(gold.map((l) => l.setId))).toEqual(new Set(["set-7", "set-8"]));
    expect(existsSync(join(dir, "gold", "G-TAGMAP.v1.jsonl"))).toBe(false); // partial review → not merged
    expect((readJsonl(join(dir, "gold", "imports", "app-1", "G-TAB.v1.jsonl")) as GoldLine[]).length).toBe(6);
    expect(JSON.parse(readFileSync(join(dir, "gold", "imports", "set-map.json"), "utf8"))).toEqual({ P2: "set-8" });
    const before = readFileSync(join(dir, "gold", "G-TAB.v1.jsonl"), "utf8");
    expect(importMain(args)).toBe(0);
    expect(readFileSync(join(dir, "gold", "G-TAB.v1.jsonl"), "utf8")).toBe(before);
    expect(toJsonl(gold)).toBe(before);
  });

  it("refuses a private dir inside a BP2 checkout", () => {
    expect(() => importMain(["--private-dir", join(REPO, "tmp-gold"), "--batch", "x", "--research", "none", "--bundles", join(REPO, "src/lib/parse-engine/__fixtures__/syn-sched-basic.synthetic.json")])).toThrow(/BP2 checkout/);
  });

  it("region data of every kind becomes truth (keynote / legend → G-TAB, notes / spec → G-PARA)", () => {
    expect(regionTruth({ type: "keynote", data: { keynotes: [{ key: "1", description: "QX" }] } })).toMatchObject({ gold: "G-TAB", truth: { tagColumn: 0, rows: [{ cells: ["1", "QX"] }] } });
    expect(regionTruth({ type: "legend", data: { symbols: [{ yoloClass: "circle", description: "QX" }] } })).toMatchObject({ gold: "G-TAB", truth: { rows: [{ cells: ["", "QX"] }] } });
    expect(regionTruth({ type: "spec", data: { sections: [{ sectionHeader: "1.01", body: "QX" }] } })).toEqual({ gold: "G-PARA", truth: { items: [{ key: "1.01", text: "QX" }] } });
    expect(regionTruth({ type: "notes", data: { headers: ["Key", "Note"], rows: [{ Key: "1", Note: "QX" }] } })).toEqual({ gold: "G-PARA", truth: { items: [{ key: "1", text: "QX" }] } });
    expect(regionTruth({ type: "schedule", data: {} })).toBeNull();
  });
});

describe("inbox coverage (pure core)", () => {
  it("counts legacy boxes a proposal overlaps, and proposals no legacy box overlaps", () => {
    const c = coverageOf([
      { set: 1, proposals: [[0, 0, 0.5, 0.5], [0.6, 0.6, 0.9, 0.9]], classifiedTables: [[0, 0, 0.5, 0.45], [0.1, 0.6, 0.2, 0.7]], ensembleRegions: [] },
      { set: 2, proposals: [], classifiedTables: [], ensembleRegions: [[0, 0, 1, 1]] },
    ]);
    expect(c.classifiedTables).toMatchObject({ boxes: 2, coveredIou50: 1, coveredIou30: 1 });
    expect(c.ensembleRegions).toMatchObject({ boxes: 1, coveredIou50: 0 });
    expect(c.proposalsOnlyInInbox).toBe(1);
    expect(c.bySet["set-1"]).toEqual({ pages: 1, proposals: 2, legacy: 2, legacyCovered50: 1 });
  });
});
