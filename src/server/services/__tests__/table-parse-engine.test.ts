// @vitest-environment node
// [table pipeline WP-3.I] The classic `/api/table-parse` on the parse engine (`tablesRoute = engine`), with every side
// effect injected (no DB, no S3, no Textract): the response grid IS the projection of `structure`, a keynote box with a
// column of aligned shapes is cut at the shape centres (K27), the proposal hint reaches the anchor prior, the paid crop
// runs only when the stored tables miss the box and is read through the crop cache (K17), demo calls never pay, the
// kind is always a table kind, CSI comes from the company context (K15) and the history entry is written.
// Synthetic evidence only (rule 12).
import { afterEach, describe, expect, it, vi } from "vitest";

// run.ts reaches lib/auth through demo-features → api-utils; no session is read here.
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
import type { AuthSession } from "@/lib/api-utils";
import { runParseEngine } from "@/lib/parse-engine/engine";
import { legacyView, legacyPart } from "@/lib/parse-engine/legacy-view";
import type { EnginePageEvidence, EngineShape, ParseEngineFlags, ParseRequest, StructureTableModel } from "@/lib/parse-engine/types";
import type { EnginePageEvidenceWithCrops } from "@/lib/parse-engine/types-crop";
import { regionCsi } from "@/server/services/parse-engine/commit";
import { resetParseSlotsForTest } from "@/server/services/parse-engine/concurrency";
import type { CropCacheStore } from "@/server/services/parse-engine/crop-cache";
import { buildPageEvidence, type LoadedPageEvidence } from "@/server/services/parse-engine/evidence";
import type { CropRunner, ParseProject, RunParseDeps } from "@/server/services/parse-engine/run";
import { classicTableKind, tableParseOnEngine, type ClassicEngineDeps, type ClassicEngineInput } from "@/server/services/table-parse-engine";
import { AT, fixture, fixtureEvidence } from "@/lib/parse-engine/__tests__/engine-helpers";
import { proposalWithAnchors, shape } from "@/lib/parse-engine/__tests__/rows-evidence-helpers";

const FLAGS: ParseEngineFlags = {
  killSwitch: false,
  tools: { tablesRoute: "engine", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy", notesAuto: "legacy", specAuto: "legacy", workspace: "engine" },
  cropCache: true,
};
const PROJECT: ParseProject = { id: 7, companyId: 3, isDemo: false, dataUrl: "co/abc" };
const DEMO: ParseProject = { ...PROJECT, isDemo: true };
const MEMBER = { user: { dbId: 11, isRootAdmin: false } } as unknown as AuthSession;

afterEach(() => resetParseSlotsForTest());

function memStore(): CropCacheStore & { puts: string[] } {
  const objects = new Map<string, string>();
  const store: CropCacheStore & { puts: string[] } = {
    puts: [],
    async getObject(key) { return objects.get(key) ?? null; },
    async putObject(key, body) { store.puts.push(key); objects.set(key, body); },
  };
  return store;
}

/** A paid Textract crop runner that counts its calls and returns the crop's words as nothing new (no tables). */
function paidRunner(): CropRunner & { calls: number } {
  const r = { method: "textract" as const, budget: "thorough" as const, paid: true, calls: 0,
    wanted: (q: ParseRequest) => q.hints?.allowPaidTextract === true,
    run: async () => { r.calls += 1; return { words: [], tables: [] }; } };
  return r;
}

function withSources(ev: EnginePageEvidence): LoadedPageEvidence {
  return { ...ev, sources: {} as LoadedPageEvidence["sources"] };
}

function harness(ev: EnginePageEvidence, over: Partial<RunParseDeps> = {}) {
  const engineCalls: ParseRequest[] = [];
  const chargePaid = vi.fn(async () => true);
  const history = vi.fn(async () => {});
  const run: RunParseDeps = {
    readFlags: async () => FLAGS,
    loadEvidence: async () => withSources(ev),
    runEngine: async (e: EnginePageEvidenceWithCrops, q: ParseRequest) => { engineCalls.push(q); return runParseEngine(e, q, { at: AT }); },
    cache: memStore(),
    runners: [],
    chargePaid,
    now: () => 1_000_000,
    ...over,
  };
  const deps: ClassicEngineDeps = { run, addToHistory: history, now: () => 1_000_000 };
  return { deps, engineCalls, chargePaid, history, cache: run.cache as ReturnType<typeof memStore> };
}

function input(region: [number, number, number, number], over: Partial<ClassicEngineInput> = {}): ClassicEngineInput {
  return {
    project: PROJECT, session: MEMBER, scope: "member", ip: "198.51.100.1", pageNumber: 1, regionBbox: region,
    storedTableCovers: true, proposalId: undefined, csiCtx: null, flags: FLAGS, debugMode: false, requestDebugMode: false,
    ...over,
  };
}

/** The response's legacy grid: every key the classic response never carried removed. */
const ENGINE_ONLY = ["confidence", "methods", "disagreements", "csiTags", "infraErrors", "structure", "engine", "alternatives", "evidence", "infraStages", "totalDurationMs"];
function gridPart(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([k]) => !ENGINE_ONLY.includes(k)));
}

describe("the response grid is the projection of `structure`", () => {
  for (const id of ["syn-sched-basic", "syn-keynote-shapes", "syn-sched-dup-headers", "syn-sched-shapes-hex"]) {
    it(`${id}: data = legacyView(structure); csiTags = regionCsi over it; summary rows lead with the fused result`, async () => {
      const f = fixture(id);
      const { deps, history } = harness(fixtureEvidence(f));
      const body = await tableParseOnEngine(input(f.region), deps);
      const model = body.structure as StructureTableModel;
      expect(model.v).toBe(1);
      expect(gridPart(body)).toEqual(legacyView(model));
      expect(legacyPart(gridPart(body))).toEqual(legacyView(model));
      expect(body.csiTags).toEqual(regionCsi(model, legacyView(model) as never, null).map((c) => ({ code: c.code, description: c.description })));
      expect(body.infraErrors).toEqual([]);
      expect(body.disagreements).toEqual([]);
      const methods = body.methods as { name: string; confidence: number; gridShape: [number, number] }[];
      expect(methods[0]).toEqual({ name: "engine", confidence: model.quality.conf, gridShape: [body.rowCount, body.columnCount] });
      expect(methods.slice(1).map((m) => m.name)).toEqual((body.engine as { methods: { id: string }[] }).methods.map((m) => m.id));
      // default (non-debug) response carries no debug keys; history gets one entry, no methodResults
      for (const k of ["alternatives", "evidence", "infraStages", "totalDurationMs"]) expect(k in body).toBe(false);
      expect(history).toHaveBeenCalledTimes(1);
      const entry = (history.mock.calls[0] as unknown as [{ request: { options: Record<string, unknown> }; response: { methodResults: unknown[]; headers: string[] } }])[0];
      expect(entry.response.methodResults).toEqual([]);
      expect(entry.response.headers).toEqual(body.headers);
      expect(entry.request.options).toMatchObject({ route: "engine", budget: "standard", kind: model.kind });
    });
  }

  it("is deterministic: the same request twice gives the same body (stamp time pinned)", async () => {
    const f = fixture("syn-sched-basic");
    const a = await tableParseOnEngine(input(f.region), harness(fixtureEvidence(f)).deps);
    const b = await tableParseOnEngine(input(f.region), harness(fixtureEvidence(f)).deps);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("debug adds alternatives, evidence, infraStages and totalDurationMs", async () => {
    const f = fixture("syn-sched-basic");
    const body = await tableParseOnEngine(input(f.region, { debugMode: true }), harness(fixtureEvidence(f)).deps);
    expect(Array.isArray(body.alternatives)).toBe(true);
    expect(body.evidence).toMatchObject({ paidCropAvailable: expect.any(Boolean) });
    expect(body.infraStages).toEqual([]);
    expect(body.totalDurationMs).toBe(0);
  });

  it("a failed history write is logged, never a 500", async () => {
    const f = fixture("syn-sched-basic");
    const h = harness(fixtureEvidence(f));
    h.history.mockRejectedValueOnce(new Error("op_log down"));
    const body = await tableParseOnEngine(input(f.region), h.deps);
    expect(body.structure).toBeDefined();
  });
});

describe("K27: a keynote box with ≥ 3 aligned shapes is cut at the shape centres", () => {
  it("syn-keynote-shapes: the shape-centres method is used and every row is keyed by its shape", async () => {
    const f = fixture("syn-keynote-shapes");
    expect(f.shapes.length).toBeGreaterThanOrEqual(3);
    const body = await tableParseOnEngine(input(f.region), harness(fixtureEvidence(f)).deps);
    const stamp = body.engine as { methods: { id: string; used: boolean }[] };
    expect(stamp.methods.find((m) => m.id === "shape-centres")?.used).toBe(true);
    const model = body.structure as StructureTableModel;
    expect(model.sources.rows).toContain("shape-centres");
    const truth = f.truth as { type: "grid"; rows: string[][] };
    expect(body.rowCount).toBe(truth.rows.length);
    expect(model.rows.filter((r) => r.role === "body").map((r) => r.key?.kind)).toEqual(truth.rows.map(() => "shape-text"));
    const tag = body.tagColumn as string;
    expect((body.rows as Record<string, string>[]).map((r) => r[tag])).toEqual(truth.rows.map((r) => r[0]));
  });

  it("the same box without its shapes is not cut at shape centres (the method casts no vote)", async () => {
    const f = fixture("syn-keynote-shapes");
    const body = await tableParseOnEngine(input(f.region), harness({ ...fixtureEvidence(f), shapes: [] }).deps);
    const model = body.structure as StructureTableModel;
    expect(model.sources.rows).not.toContain("shape-centres");
  });
});

describe("the proposal path uses the anchor prior (R6)", () => {
  // A shape-tag schedule (pseudo-text): a header line, then one 3-line description per centre; keys inside the shapes.
  const REGION: [number, number, number, number] = [0.1, 0.1, 0.6, 0.6];
  const CENTRES = [0.2, 0.25, 0.3, 0.35, 0.4];
  const D = 0.012;
  function page(missing: number | null): EnginePageEvidence {
    const words: { text: string; confidence: number; bbox: [number, number, number, number] }[] = [];
    const w = (text: string, x: number, cy: number, h = 0.008) => words.push({ text, confidence: 99, bbox: [x, cy - h / 2, 0.006 * text.length, h] });
    w("KEY", 0.105, 0.15); w("DESC", 0.2, 0.15);
    CENTRES.forEach((c, i) => { w(`D-10${i + 1}`, 0.105, c); w(`R${i}A`, 0.2, c - D); w(`R${i}B QX`, 0.2, c); w(`R${i}C`, 0.2, c + D); });
    const loaded = buildPageEvidence({
      pageNumber: 1, drawingNumber: null, keynotes: null, csiCodes: null, words, tables: null, layout: null,
      pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
    }, { recompute: true });
    const { sources: _s, ...ev } = loaded;
    void _s;
    const shapes: EngineShape[] = CENTRES.filter((c) => c !== missing).map((c) => shape(c));
    // The proposal's box is the whole page (IoU with the region < .5), so only the HINT names it as the owner.
    const anchors = CENTRES.map((c, i) => ({ b: shape(c).b, tag: `D-10${i + 1}` }));
    return { ...ev, shapes, proposals: [proposalWithAnchors("pX", [0, 0, 1, 1], anchors)] };
  }
  const keysOf = (m: StructureTableModel) => m.rows.filter((r) => r.role === "body").map((r) => (r.key && r.key.kind !== "symbol" ? r.key.text : null));

  it("with the request's proposalId the missing shape's row is restored from the stored anchor; without it, not", async () => {
    const full = (await tableParseOnEngine(input(REGION), harness(page(null)).deps)).structure as StructureTableModel;
    expect(keysOf(full)).toEqual(["D-101", "D-102", "D-103", "D-104", "D-105"]);
    const h = harness(page(0.3));
    const hinted = (await tableParseOnEngine(input(REGION, { proposalId: "pX" }), h.deps)).structure as StructureTableModel;
    expect(h.engineCalls[0].hints?.proposalId).toBe("pX");
    expect(keysOf(hinted)).toEqual(keysOf(full));
    expect(hinted.rows.map((r) => [r.y0, r.y1])).toEqual(full.rows.map((r) => [r.y0, r.y1]));
    const bare = (await tableParseOnEngine(input(REGION), harness(page(0.3)).deps)).structure as StructureTableModel;
    expect(bare.rows.map((r) => [r.y0, r.y1])).not.toEqual(full.rows.map((r) => [r.y0, r.y1]));
  });

  it("a non-string or over-long proposalId is not forwarded", async () => {
    for (const bad of [42, "", "x".repeat(301), { id: "pX" }]) {
      const h = harness(page(null));
      await tableParseOnEngine(input(REGION, { proposalId: bad }), h.deps);
      expect(h.engineCalls[0].hints?.proposalId).toBeUndefined();
    }
  });
});

describe("kind: always a table kind for the classic grid callers", () => {
  it("the owning proposal's keynote / legend class is kept; notes, spec and no proposal read as a schedule", () => {
    const box: [number, number, number, number] = [0.1, 0.1, 0.5, 0.5];
    const p = (classId: string | null) => [{ id: "q", b: box, classId, p: 0.9 }];
    expect(classicTableKind(p("keynotes"), box)).toBe("keynote");
    expect(classicTableKind(p("symbol-legend"), box)).toBe("legend");
    expect(classicTableKind(p("general-notes"), box)).toBe("schedule");
    expect(classicTableKind(p("door-schedule"), box)).toBe("schedule");
    expect(classicTableKind([], box)).toBe("schedule");
    // the hinted id wins over geometry
    expect(classicTableKind([{ id: "far", b: [0.8, 0.8, 0.9, 0.9], classId: "keynotes", p: 0.5 }], box, "far")).toBe("keynote");
  });

  it("a keyed notes box is still returned as a grid (the engine is asked for a schedule)", async () => {
    const f = fixture("syn-notes-lettered");
    const h = harness(fixtureEvidence(f));
    const body = await tableParseOnEngine(input(f.region), h.deps);
    expect(h.engineCalls[0].kind).toBe("schedule");
    expect((body.structure as StructureTableModel).kind).toBe("schedule");
    expect(Array.isArray(body.headers)).toBe(true);
    expect(Array.isArray(body.colBoundaries)).toBe(true);
  });

  it("a stored keynote proposal over the box gives the keynote projection (keynotes[] + isPageSpecific)", async () => {
    const f = fixture("syn-keynote-basic");
    const ev = fixtureEvidence(f, { proposals: [{ id: "k1", b: f.region, classId: "keynotes", p: 0.9 }] });
    const body = await tableParseOnEngine(input(f.region), harness(ev).deps);
    expect((body.structure as StructureTableModel).kind).toBe("keynote");
    expect(Array.isArray(body.keynotes)).toBe(true);
    expect(gridPart(body)).toEqual(legacyView(body.structure as StructureTableModel));
  });
});

describe("budget and the paid crop (E-3, K17)", () => {
  it("stored tables cover the box → standard, no paid hint, nothing charged", async () => {
    const f = fixture("syn-sched-basic");
    const paid = paidRunner();
    const h = harness(fixtureEvidence(f), { runners: [paid] });
    await tableParseOnEngine(input(f.region, { storedTableCovers: true }), h.deps);
    expect(h.engineCalls[0].budget).toBe("standard");
    expect(h.engineCalls[0].hints?.allowPaidTextract).toBeUndefined();
    expect(paid.calls).toBe(0);
    expect(h.chargePaid).not.toHaveBeenCalled();
  });

  it("a miss → thorough + the paid crop, charged once; the second parse of the same box reads the crop cache (free)", async () => {
    const f = fixture("syn-sched-basic");
    const paid = paidRunner();
    const h = harness(fixtureEvidence(f), { runners: [paid] });
    await tableParseOnEngine(input(f.region, { storedTableCovers: false }), h.deps);
    expect(h.engineCalls[0].budget).toBe("thorough");
    expect(h.engineCalls[0].hints?.allowPaidTextract).toBe(true);
    expect(paid.calls).toBe(1);
    expect(h.chargePaid).toHaveBeenCalledTimes(1);
    expect(h.cache.puts).toHaveLength(1);
    const body = await tableParseOnEngine(input(f.region, { storedTableCovers: false }), h.deps);
    expect(paid.calls).toBe(1);
    expect(h.chargePaid).toHaveBeenCalledTimes(1);
    expect((body.engine as { methods: { id: string; cached?: true }[] }).methods.find((m) => m.id === "textract-cells")).toBeDefined();
  });

  it("demo project, demo scope or a signed-out caller: never thorough, never charged, never a cache write", async () => {
    const f = fixture("syn-sched-basic");
    for (const over of [{ project: DEMO }, { scope: "demo" as const }, { session: null }]) {
      const paid = paidRunner();
      const h = harness(fixtureEvidence(f), { runners: [paid] });
      await tableParseOnEngine(input(f.region, { storedTableCovers: false, ...over }), h.deps);
      expect(h.engineCalls[0].budget).toBe("standard");
      expect(paid.calls).toBe(0);
      expect(h.chargePaid).not.toHaveBeenCalled();
      expect(h.cache.puts).toEqual([]);
    }
  });
});
