// @vitest-environment node
// [table pipeline WP-3.D] runParseEngine end to end on the committed synthetic fixtures (rule 12: pseudo-text only):
// schema + caps, determinism (E-7), the stamp, alternatives with geometry (R12), the legacy projection round trip
// (model → ScheduleData → ParseRegionLayer boundary counts), the kind head, continuations (R11), crop evidence,
// prior id re-matching, and the instant-budget latency (WP-3.E acceptance, measured here).
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runParseEngine } from "../engine";
import { CLASS_KINDS, REGION_CLASS_KINDS, kindFromClassId, kindFromBox } from "../engine-kind";
import { OTHER_SCHEDULE, SCHEDULE_KINDS } from "@/lib/classifier-engine/vocabulary";
import regionClasses from "@/data/classifiers/regions.v1.json";
import { legacyView, type LegacyGridView } from "../legacy-view";
import { DEFAULT_PROFILE } from "../profile";
import { zStructureModel } from "../schema";
import { cellTextMatrix } from "../cells";
import { CAPABILITY_VERSIONS } from "../version";
import type { EnginePageEvidence, ParseRequest, ParseResult, StructureParagraphDoc, StructureTableModel } from "../types";
import type { EnginePageEvidenceWithCrops } from "../types-crop";
import { AT, fixture, fixtureEvidence, fixtureIds, fixtureKind, fixtureRequest, type Fixture } from "./engine-helpers";

/** Measurements go to the console and, when `WP3D_MEASURE_FILE` is set, to that file (the suite runner hides stdout). */
function measure(text: string): void {
  console.log(text);
  const out = process.env.WP3D_MEASURE_FILE;
  if (out) appendFileSync(out, `${text}\n`);
}

const run = (ev: EnginePageEvidence, req: ParseRequest): Promise<ParseResult> => runParseEngine(ev, req, { at: AT, profile: DEFAULT_PROFILE });
const isTable = (m: ParseResult["model"]): m is StructureTableModel => m.kind === "schedule" || m.kind === "keynote" || m.kind === "legend";

/** The printed-label / body-text grid of a table model (body = every non-header row; labels as printed, before the K06 dedupe). */
function grid(m: StructureTableModel): { headers: string[]; rows: string[][] } {
  const body = m.rows.filter((r) => r.role !== "header");
  const rows = cellTextMatrix(m.cells, body.map((r) => r.id), m.cols.map((c) => c.id)).map((r) => r.map((t) => t.replace(/\n/g, " ")));
  return { headers: m.cols.map((c) => c.labelRaw || c.label), rows };
}

/** ParseRegionLayer's acceptance of stored boundaries (ParseRegionLayer.tsx:195-207): else it draws a uniform grid. */
function layerAcceptsBoundaries(d: LegacyGridView): { cols: boolean; rows: boolean } {
  const hasHeaderRow = d.rowBoundaries ? d.rowBoundaries.length - 1 > d.rows.length : true;
  const totalRows = hasHeaderRow ? d.rows.length + 1 : d.rows.length;
  return { cols: d.colBoundaries.length === d.headers.length + 1, rows: d.rowBoundaries.length === totalRows + 1 };
}

describe("runParseEngine on every synthetic fixture", () => {
  const ids = fixtureIds();
  it("found the committed fixtures", () => expect(ids.length).toBeGreaterThanOrEqual(40));

  for (const id of ids) {
    it(`${id}: a valid, capped, deterministic model with a full stamp`, async () => {
      const f = fixture(id);
      const ev = fixtureEvidence(f);
      const a = await run(ev, fixtureRequest(f));
      const b = await run(ev, fixtureRequest(f));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a)); // E-7
      expect(zStructureModel.safeParse(a.model).success).toBe(true);
      expect(a.model.kind).toBe(fixtureKind(f));
      expect(a.stamp.engine).toBe("pe/1.0.0");
      expect(a.stamp.at).toBe(AT);
      expect(a.stamp.budget).toBe("instant");
      expect(a.stamp.evidenceHash).toBe(ev.evidenceHash);
      expect(a.stamp.paramsHash).toMatch(/^h1:[0-9a-f]{28}$/);
      for (const [cap, v] of Object.entries(a.stamp.caps)) expect(v).toBe(CAPABILITY_VERSIONS[cap as keyof typeof CAPABILITY_VERSIONS]);
      expect(a.stamp.methods.length).toBeGreaterThan(0);
      expect(a.stamp.methods.some((m) => m.used)).toBe(true);
      expect(a.words.length).toBeGreaterThan(0);
      expect(a.kindSuggestion).toBeUndefined(); // the request named the kind
      if (isTable(a.model)) {
        const m = a.model;
        expect(m.rows.length).toBeGreaterThan(0);
        expect(new Set(m.rows.map((r) => r.id)).size).toBe(m.rows.length);
        expect(new Set(m.cols.map((c) => c.id)).size).toBe(m.cols.length);
        expect(new Set(m.cols.map((c) => c.label)).size).toBe(m.cols.length); // K06
        expect(m.cols[0].x0).toBeCloseTo(f.region[0], 6);
        expect(m.cols[m.cols.length - 1].x1).toBeCloseTo(f.region[2], 6);
        for (const alt of a.alternatives) {
          expect(alt.geometry.rowLines.length === 0 || alt.geometry.rowLines.length >= 2).toBe(true);
          expect(alt.geometry.rowLines.length).toBeLessThanOrEqual(501);
        }
        expect(a.alternatives.some((x) => x.method === "x-starts" && x.geometry.colLines.length >= 2)).toBe(true);
      } else {
        expect(a.model.paragraphs.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("table assembly against the fixtures' truth", () => {
  const tableIds = fixtureIds().filter((id) => fixture(id).truth.type === "grid");

  it("measured: exact header + body grids (logged per fixture; the miss list pins the measurement)", async () => {
    const lines: string[] = [];
    let exact = 0, headersExact = 0, shapeOk = 0;
    const misses: string[] = [];
    for (const id of tableIds) {
      const f = fixture(id);
      if (f.truth.type !== "grid") continue;
      const r = await run(fixtureEvidence(f), fixtureRequest(f));
      const g = grid(r.model as StructureTableModel);
      const hOk = f.truth.headers.length === 0 ? (r.model as StructureTableModel).headerRows === 0 : JSON.stringify(g.headers) === JSON.stringify(f.truth.headers);
      const bOk = JSON.stringify(g.rows) === JSON.stringify(f.truth.rows);
      const dimsOk = g.rows.length === f.truth.rows.length && g.headers.length === f.truth.headers.length;
      if (hOk) headersExact++;
      if (hOk && bOk) exact++;
      else misses.push(id);
      if (dimsOk) shapeOk++;
      lines.push(`${id}: rows ${g.rows.length}/${f.truth.rows.length} cols ${g.headers.length}/${f.truth.headers.length} headers=${hOk} body=${bOk} flags=${(r.model as StructureTableModel).quality.flags.join(",")}`);
    }
    measure(`[WP-3.D grid measure] ${tableIds.length} grid fixtures: exact ${exact}, headers exact ${headersExact}, dims exact ${shapeOk}\n${lines.join("\n")}`);
    expect(tableIds.length).toBeGreaterThan(20);
    // MEASURED 2026-10-28 (WP-3.D): 23 of 27 exact. The four misses are method-level, recorded as open items:
    // a vertically centred key in a multi-line row (rows), key-less section lines in the cluster regime (rows, R5
    // fires only in the shape regime), a two-block table read as ONE box (that is what `parts` is for, tested below),
    // and a one-word group header centred over two columns (headers: `headerSpansFromWords` needs the word to cover
    // both column centres).
    expect(misses).toEqual(["syn-sched-multiline-middle", "syn-sched-section-rows", "syn-sched-two-blocks", "syn-sched-two-tier"]);
  });

  it("syn-sched-basic reads exactly (headers, rows, tag column MARK, projection)", async () => {
    const f = fixture("syn-sched-basic");
    const r = await run(fixtureEvidence(f), fixtureRequest(f));
    const m = r.model as StructureTableModel;
    if (f.truth.type !== "grid") throw new Error("fixture");
    expect(grid(m)).toEqual({ headers: f.truth.headers, rows: f.truth.rows });
    expect(m.headerRows).toBe(1);
    expect(m.tag?.col).toBe(m.cols[0].id);
    expect(m.tag?.scope).toBe("project");
    const v = legacyView(m) as LegacyGridView;
    expect(v.headers).toEqual(f.truth.headers);
    expect(v.tagColumn).toBe("MARK");
    expect(v.rows[0].MARK).toBe(f.truth.rows[0][0]);
  });
});

describe("projection round trip: model → ScheduleData → ParseRegionLayer boundary counts", () => {
  for (const id of ["syn-sched-basic", "syn-sched-no-header", "syn-sched-textract-header-row", "syn-keynote-basic", "syn-sched-shapes-hex"]) {
    it(`${id}: the layer draws the stored boundaries (no uniform-grid fallback)`, async () => {
      const f = fixture(id);
      const r = await run(fixtureEvidence(f), fixtureRequest(f));
      const m = r.model as StructureTableModel;
      const v = legacyView(m) as LegacyGridView;
      expect(v.colBoundaries).toEqual([m.cols[0].x0, ...m.cols.map((c) => c.x1)]);
      expect(v.rowBoundaries.length).toBe(m.rows.length + 1);
      expect(v.rows.length).toBe(m.rows.filter((x) => x.role !== "header").length);
      if (m.headerRows <= 1) expect(layerAcceptsBoundaries(v)).toEqual({ cols: true, rows: true });
      else expect(layerAcceptsBoundaries(v).cols).toBe(true); // ≥ 2 header tiers: the layer's own 1-header assumption (open item)
    });
  }
});

describe("kind head (request ≻ proposal ≻ box)", () => {
  it("reads class ids by name", () => {
    expect(kindFromClassId("keynote-table")).toBe("keynote");
    expect(kindFromClassId("symbol-legend")).toBe("legend");
    expect(kindFromClassId("abbreviations")).toBe("legend");
    expect(kindFromClassId("general-notes")).toBe("notes");
    expect(kindFromClassId("spec-section")).toBe("spec");
    expect(kindFromClassId("door-schedule")).toBe("schedule");
    expect(kindFromClassId(null)).toBeNull();
  });

  it("maps every classifier vocabulary id explicitly; 'specialties' is a schedule, not a spec (verify MED-1)", () => {
    const regionIds = (regionClasses as { classes: { id: string }[] }).classes.map((c) => c.id).sort();
    expect(Object.keys(REGION_CLASS_KINDS).sort()).toEqual(regionIds);
    for (const k of SCHEDULE_KINDS) {
      expect(CLASS_KINDS.has(k.id), k.id).toBe(true);
      expect(kindFromClassId(k.id), k.id).toBe(k.id === "finish-legend" ? "legend" : "schedule");
    }
    expect(kindFromClassId(OTHER_SCHEDULE)).toBe("schedule");
    for (const id of regionIds) expect(CLASS_KINDS.get(id), id).toBe(REGION_CLASS_KINDS[id]);
    expect(regionIds.map((id) => kindFromClassId(id))).not.toContain("spec");
    expect(kindFromClassId("specialties")).toBe("schedule");
    expect(kindFromClassId("Specialties")).toBe("schedule");
    expect(kindFromClassId("specification-section")).toBe("spec");
    expect(kindFromClassId("specs")).toBe("spec");
  });

  it("a schedule box owned by a 'specialties' proposal parses as a schedule (verify MED-1, probe2)", async () => {
    const f = fixture("syn-sched-basic");
    const r = await run(fixtureEvidence(f, { proposals: [{ id: "QX1", b: f.region, classId: "specialties", p: 0.9 }] }), fixtureRequest(f, { kind: undefined }));
    expect(r.model.kind).toBe("schedule");
    expect(r.kindSuggestion).toMatchObject({ kind: "schedule", classId: "specialties" });
  });

  it("no kind + an owning proposal → the proposal's kind, returned as kindSuggestion", async () => {
    const f = fixture("syn-keynote-basic");
    const ev = fixtureEvidence(f, { proposals: [{ id: "QX1", b: f.region, classId: "keynote-table", p: 0.83 }] });
    const r = await run(ev, fixtureRequest(f, { kind: undefined }));
    expect(r.model.kind).toBe("keynote");
    expect(r.kindSuggestion).toMatchObject({ kind: "keynote", classId: "keynote-table", p: 0.83 });
    expect((r.model as StructureTableModel).classId).toBe("keynote-table");
  });

  it("no kind, no proposal: a keyed notes box reads as notes, a schedule box as a schedule", async () => {
    const notes = fixture("syn-notes-lettered");
    const rn = await run(fixtureEvidence(notes), fixtureRequest(notes, { kind: undefined }));
    expect(rn.model.kind).toBe("notes");
    expect(rn.kindSuggestion).toMatchObject({ kind: "notes", classId: null, p: 0.6 });
    const sched = fixture("syn-sched-basic");
    const rs = await run(fixtureEvidence(sched), fixtureRequest(sched, { kind: undefined }));
    expect(rs.model.kind).toBe("schedule");
    expect(rs.kindSuggestion).toMatchObject({ kind: "schedule", p: 0.5 });
  });

  it("kindFromBox: kv-pairs lists and wide tables are not notes", () => {
    const doc = (flags: string[], keyed: number, total: number): Pick<StructureParagraphDoc, "kind" | "paragraphs" | "quality"> => ({
      kind: "notes",
      paragraphs: Array.from({ length: total }, (_, i) => ({ id: `p${i + 1}`, blockId: "b1", key: i < keyed ? String(i + 1) : null, keyPath: [], keyNorm: "", depth: 0, text: "QX", b: [0, 0, 1, 1], lineCount: 1 })),
      quality: { conf: 1, agreement: 1, flags },
    });
    expect(kindFromBox(doc([], 4, 4), 2).kind).toBe("notes");
    expect(kindFromBox(doc([], 4, 4), 3).kind).toBe("schedule");
    expect(kindFromBox(doc(["kv-pairs"], 4, 4), 2).kind).toBe("schedule");
    expect(kindFromBox(doc([], 2, 4), 1).kind).toBe("schedule");
  });
});

describe("continuations (R11) end to end", () => {
  it("a schedule in two side-by-side blocks: part 1's repeated header is dropped, its rows read through part 0's columns", async () => {
    const f = fixture("syn-sched-two-blocks");
    if (f.truth.type !== "grid") throw new Error("fixture");
    const mid = (f.region[0] + f.region[2]) / 2;
    const left: [number, number, number, number] = [f.region[0], f.region[1], mid, f.region[3]];
    const right: [number, number, number, number] = [mid, f.region[1], f.region[2], f.region[3]];
    const r = await run(fixtureEvidence(f), { page: 1, bbox: left, parts: [right], budget: "instant", kind: "schedule" });
    const m = r.model as StructureTableModel;
    expect(m.parts).toEqual([right]);
    expect(m.rows.some((x) => x.part === 1)).toBe(true);
    expect(m.quality.flags.some((fl) => fl.startsWith("parts-headers-dropped:"))).toBe(true);
    const g = grid(m);
    measure(`[WP-3.D parts measure] headers ${JSON.stringify(g.headers)} rows ${g.rows.length}/${f.truth.rows.length}`);
    expect(g.rows.length).toBe(f.truth.rows.length);
    expect(g.rows.map((row) => row[0])).toEqual(f.truth.rows.map((row) => row[0]));
    // part-1 cells sit inside the right box
    const part1 = new Set(m.rows.filter((x) => x.part === 1).map((x) => x.id));
    for (const c of m.cells.filter((x) => part1.has(x.row) && x.b)) expect(c.b![0]).toBeGreaterThanOrEqual(mid - 1e-9);
  });
});

describe("crop evidence (standard / thorough budgets)", () => {
  it("crop rulings vote on both axes; the stamp marks them used and cached", async () => {
    const f = fixture("syn-sched-basic");
    const ev = fixtureEvidence(f);
    const base = await run(ev, fixtureRequest(f));
    const m0 = base.model as StructureTableModel;
    const box = f.region;
    const w = box[2] - box[0], h = box[3] - box[1];
    // the fused grid's own lines, as a crop would report them (normalised to the crop)
    const rows = [m0.rows[0].y0, ...m0.rows.map((r) => r.y1)].map((y) => (y - box[1]) / h);
    const cols = [m0.cols[0].x0, ...m0.cols.map((c) => c.x1)].map((x) => (x - box[0]) / w);
    const withCrops: EnginePageEvidenceWithCrops = { ...ev, crops: { rulings: { method: "rulings", budget: "standard", paid: false, box, cached: true, value: { rows, cols, confidence: 0.9 } } } };
    const r = await run(withCrops, fixtureRequest(f, { budget: "standard" }));
    const line = r.stamp.methods.find((x) => x.id === "rulings");
    expect(line).toMatchObject({ used: true, cached: true });
    expect(r.evidence.rulings).toEqual({ h: rows.length, v: cols.length });
    expect(r.alternatives.find((a) => a.method === "rulings")?.geometry.colLines.length).toBe(cols.length);
    expect(grid(r.model as StructureTableModel)).toEqual(grid(m0));
  });

  it("a paid Textract crop on a page with no words supplies the words; a failed paid method flags paid-evidence-skipped", async () => {
    const f = fixture("syn-sched-basic");
    const full = fixtureEvidence(f);
    const empty: EnginePageEvidence = { ...full, words: [], lines: [] };
    const crop = { words: full.words, lines: full.lines, tables: [] };
    const box = f.region;
    const r = await run({ ...empty, crops: { textract: { method: "textract", budget: "thorough", paid: true, box, cached: false, value: crop } } } as EnginePageEvidenceWithCrops,
      fixtureRequest(f, { budget: "thorough", hints: { allowPaidTextract: true } }));
    expect(r.words.length).toBeGreaterThan(0);
    expect(r.evidence.paidCropAvailable).toBe(false);
    if (f.truth.type !== "grid") throw new Error("fixture");
    expect(grid(r.model as StructureTableModel).rows).toEqual(f.truth.rows);
    expect(r.model.quality.flags).not.toContain("paid-evidence-skipped");
    const failed = await run({ ...full, crops: { textract: { method: "textract", budget: "thorough", paid: true, box, cached: false, error: "cap-reached" } } } as EnginePageEvidenceWithCrops,
      fixtureRequest(f, { budget: "thorough", hints: { allowPaidTextract: true } }));
    expect(failed.model.quality.flags).toContain("paid-evidence-skipped");
    expect(failed.stamp.methods.find((x) => x.id === "textract-cells")?.error).toBe("cap-reached");
  });
});

describe("prior id re-matching (§2.1 Ids)", () => {
  it("a re-parse with prior keeps every id; a row inserted at the top gets a fresh id and the others keep theirs", async () => {
    const f = fixture("syn-sched-basic");
    const ev = fixtureEvidence(f);
    const first = (await run(ev, fixtureRequest(f))).model as StructureTableModel;
    const again = (await run(ev, fixtureRequest(f, { prior: first }))).model as StructureTableModel;
    expect(again.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    expect(again.cols.map((c) => c.id)).toEqual(first.cols.map((c) => c.id));
    // shift the prior's ids so the re-match is visible (r1 → r101 …)
    const shifted: StructureTableModel = { ...first, rows: first.rows.map((r) => ({ ...r, id: `r${Number(r.id.slice(1)) + 100}` })) };
    const re = (await run(ev, fixtureRequest(f, { prior: shifted }))).model as StructureTableModel;
    expect(re.rows.map((r) => r.id)).toEqual(shifted.rows.map((r) => r.id));
  });

  it("paramsHash does not depend on prior (verify LOW-1, M9)", async () => {
    const f = fixture("syn-sched-basic");
    const ev = fixtureEvidence(f);
    const first = await run(ev, fixtureRequest(f));
    const shifted: StructureTableModel = { ...(first.model as StructureTableModel), rows: (first.model as StructureTableModel).rows.map((r) => ({ ...r, id: `r${Number(r.id.slice(1)) + 100}` })) };
    const withPrior = await run(ev, fixtureRequest(f, { prior: shifted }));
    expect(withPrior.stamp.paramsHash).toBe(first.stamp.paramsHash);
  });
});

describe("instant latency (WP-3.E acceptance: p95 ≤ 400 ms at instant, measured here on the synthetic fixtures)", () => {
  it("p95 over every fixture × 3 runs", async () => {
    const times: number[] = [];
    for (const id of fixtureIds()) {
      const f: Fixture = fixture(id);
      const ev = fixtureEvidence(f);
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        await runParseEngine(ev, fixtureRequest(f, { kind: i === 2 ? undefined : fixtureKind(f) }), { at: AT, profile: DEFAULT_PROFILE });
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    const p = (q: number): number => times[Math.min(times.length - 1, Math.floor(q * times.length))];
    measure(`[WP-3.D latency] n=${times.length} p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms`);
    expect(p(0.95)).toBeLessThan(400);
  });
});
