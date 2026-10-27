// @vitest-environment node
// [table pipeline WP-3.E] The parse-engine run service, with every side effect injected (no DB, no S3,
// no Textract): the budget gate, the per-caller in-flight cap, the crop cache policy (paid results
// always cached for signed-in callers, standard ones under the `cropCache` flag, demo / signed-out
// calls never write), the commit's cache-only mode, the Textract crop remap, and the engine handoff.
// Synthetic evidence only (rule 12).
import { afterEach, describe, expect, it, vi } from "vitest";

// run.ts reaches lib/auth through demo-features → api-utils; no session is read in these tests.
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
import { ParseEngineNotImplementedError, type ParseEngineFlags, type ParseRequest, type ParseResult } from "@/lib/parse-engine/types";
import type { EnginePageEvidenceWithCrops } from "@/lib/parse-engine/types-crop";
import { ApiError } from "@/server/api/envelope";
import { buildPageEvidence, type LoadedPageEvidence } from "@/server/services/parse-engine/evidence";
import { resetParseSlotsForTest, parseSlotsInUseForTest } from "@/server/services/parse-engine/concurrency";
import { cropCacheKey, type CropCacheStore } from "@/server/services/parse-engine/crop-cache";
import {
  PaidCropExpiredError,
  cropCachePolicy,
  isDemoCall,
  remapTextractCrop,
  runParse,
  textractCropRunner,
  type CropRunner,
  type ParseCaller,
  type ParseProject,
  type RunParseDeps,
  type RunParseInput,
  type TextractCropIo,
} from "@/server/services/parse-engine/run";

const FLAGS: ParseEngineFlags = {
  killSwitch: false,
  tools: { tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy", notesAuto: "legacy", specAuto: "legacy", workspace: "engine" },
  cropCache: true,
};

const PROJECT: ParseProject = { id: 7, companyId: 3, isDemo: false, dataUrl: "co/abc" };
const DEMO: ParseProject = { ...PROJECT, isDemo: true };
const MEMBER: ParseCaller = { userId: 11, isRoot: false, ip: "198.51.100.1" };
const OTHER: ParseCaller = { userId: 12, isRoot: false, ip: "198.51.100.1" };
const ANON: ParseCaller = { userId: null, isRoot: false, ip: "198.51.100.9" };
const BOX: [number, number, number, number] = [0.2, 0.2, 0.6, 0.6];

function evidence(): LoadedPageEvidence {
  return buildPageEvidence({
    pageNumber: 2, drawingNumber: "X-1", keynotes: null, csiCodes: null,
    words: [{ text: "QQ", confidence: 90, bbox: [0.25, 0.25, 0.05, 0.02] }], tables: null, layout: null,
    pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
  }, { recompute: true });
}

const RESULT = { model: { v: 1 }, alternatives: [], evidence: { words: 0, lines: 0, paidCropAvailable: false }, words: [], stamp: {} } as unknown as ParseResult;

function memStore() {
  const objects = new Map<string, string>();
  const store: CropCacheStore & { puts: string[]; gets: string[] } = {
    puts: [], gets: [],
    async getObject(key) { store.gets.push(key); return objects.get(key) ?? null; },
    async putObject(key, body) { store.puts.push(key); objects.set(key, body); },
  };
  return { store, objects };
}

/** A fake Textract crop io that returns one word in crop coordinates. */
function fakeTextractIo() {
  const io = {
    analyzed: 0,
    downloadPagePng: vi.fn(async () => Buffer.from("png")),
    crop: vi.fn(async (png: Buffer, _box: [number, number, number, number]) => png),
    analyze: vi.fn(async (_png: Buffer): Promise<Awaited<ReturnType<TextractCropIo["analyze"]>>> => {
      io.analyzed += 1;
      return {
        words: [{ text: "AB", confidence: 80, bbox: [0, 0, 0.5, 0.5] as [number, number, number, number] }],
        tables: [{ bbox: [0, 0, 1, 1] as [number, number, number, number], rowCount: 1, colCount: 1, cells: [{ row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "AB", bbox: [0, 0, 1, 1] as [number, number, number, number], confidence: 80 }] }],
      };
    }),
  };
  return io;
}

function standardRunner(run: CropRunner["run"] = async () => ({ rows: [0.3] })): CropRunner & { calls: number } {
  const r = { method: "rulings" as const, budget: "standard" as const, paid: false, wanted: () => true, calls: 0, run: async (ctx: Parameters<CropRunner["run"]>[0]) => { r.calls += 1; return run(ctx); } };
  return r;
}

function deps(over: Partial<RunParseDeps> = {}) {
  const { store } = memStore();
  const engine = vi.fn(async (_ev: EnginePageEvidenceWithCrops, _req: ParseRequest) => RESULT);
  const chargePaid = vi.fn(async () => true);
  const d: RunParseDeps = {
    readFlags: async () => FLAGS,
    loadEvidence: async () => evidence(),
    runEngine: engine,
    cache: store,
    runners: [],
    chargePaid,
    now: () => 1_000_000,
    ...over,
  };
  return { d, engine, chargePaid, store: d.cache as typeof store };
}

const req = (over: Partial<ParseRequest> = {}): ParseRequest => ({ page: 2, bbox: BOX, budget: "instant", ...over });
const input = (over: Partial<RunParseInput> = {}): RunParseInput => ({ project: PROJECT, caller: MEMBER, scope: "member", request: req(), ...over });

afterEach(() => resetParseSlotsForTest());

async function expectApiError(p: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  if (code) expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

describe("policy (pure)", () => {
  it("a demo call is a demo project, a demo-scoped access, or a signed-out caller", () => {
    expect(isDemoCall(PROJECT, MEMBER, "member")).toBe(false);
    expect(isDemoCall(DEMO, MEMBER, "member")).toBe(true);
    expect(isDemoCall(PROJECT, MEMBER, "demo")).toBe(true);
    expect(isDemoCall(PROJECT, ANON, null)).toBe(true);
  });
  it("reads are open; writes only off-demo; paid writes ignore the cropCache flag, standard ones obey it", () => {
    expect(cropCachePolicy(false, { cropCache: true })).toEqual({ readStandard: true, readPaid: true, writeStandard: true, writePaid: true });
    expect(cropCachePolicy(false, { cropCache: false })).toEqual({ readStandard: false, readPaid: true, writeStandard: false, writePaid: true });
    expect(cropCachePolicy(true, { cropCache: true })).toEqual({ readStandard: true, readPaid: true, writeStandard: false, writePaid: false });
  });
});

describe("budget gate (E-3)", () => {
  it("demo thorough → 403, signed-out thorough → 403, and nothing runs", async () => {
    const io = fakeTextractIo();
    const { d, engine } = deps({ runners: [textractCropRunner(io)] });
    const thorough = req({ budget: "thorough", hints: { allowPaidTextract: true } });
    await expectApiError(runParse(input({ project: DEMO, request: thorough }), d), 403, "FORBIDDEN");
    await expectApiError(runParse(input({ caller: ANON, scope: "demo", request: thorough }), d), 403, "FORBIDDEN");
    expect(io.analyzed).toBe(0);
    expect(engine).not.toHaveBeenCalled();
  });
  it("thorough without its tick → 400; a zero-area box or part → 400", async () => {
    const { d } = deps();
    await expectApiError(runParse(input({ request: req({ budget: "thorough" }) }), d), 400, "VALIDATION");
    await expectApiError(runParse(input({ request: req({ bbox: [0.2, 0.2, 0.2, 0.6] }) }), d), 400, "VALIDATION");
    await expectApiError(runParse(input({ request: req({ parts: [[0.1, 0.5, 0.4, 0.5]] }) }), d), 400, "VALIDATION");
  });
});

describe("the paid Textract crop through the cache", () => {
  it("a cache hit on the second paid crop: one Textract call, one charge, one write; the second outcome is cached", async () => {
    const io = fakeTextractIo();
    const { d, engine, chargePaid, store } = deps({ runners: [textractCropRunner(io)] });
    const thorough = req({ budget: "thorough", hints: { allowPaidTextract: true } });
    await runParse(input({ request: thorough }), d);
    await runParse(input({ request: thorough }), d);
    expect(io.analyzed).toBe(1);
    expect(chargePaid).toHaveBeenCalledTimes(1);
    expect(store.puts).toEqual([cropCacheKey("co/abc", 2, BOX, "textract")]);
    expect(store.puts[0]).toBe("co/abc/cache/parse-engine/2/0.200_0.200_0.600_0.600.textract.json");
    const [first, second] = engine.mock.calls.map((c) => c[0].crops?.textract);
    expect(first).toMatchObject({ method: "textract", paid: true, cached: false, box: BOX });
    expect(second).toMatchObject({ method: "textract", paid: true, cached: true, box: BOX });
    // the engine gets the crop in its own coordinates: words mapped back onto the page, MinMax
    expect(second?.value).toEqual(first?.value);
    const view = second?.value as { words: { t: string; b: number[] }[]; tables: { cells: { r: number; c: number }[] }[] };
    expect(view.words.map((w) => w.t)).toEqual(["AB"]);
    view.words[0].b.forEach((v, i) => expect(v).toBeCloseTo([0.2, 0.2, 0.4, 0.4][i], 9));
    expect(view.tables[0].cells[0]).toMatchObject({ r: 0, c: 0 });
  });

  it("the cache key rounds the box to 3 dp, and the crop runs on the rounded box", async () => {
    const io = fakeTextractIo();
    const { d, store } = deps({ runners: [textractCropRunner(io)] });
    await runParse(input({ request: req({ bbox: [0.20004, 0.2, 0.6, 0.59996], budget: "thorough", hints: { allowPaidTextract: true } }) }), d);
    await runParse(input({ request: req({ budget: "thorough", hints: { allowPaidTextract: true } }) }), d);
    expect(io.analyzed).toBe(1);
    expect(store.puts).toHaveLength(1);
    expect(io.crop.mock.calls[0][1]).toEqual(BOX);
  });

  it("another signed-in member of the same project reads the paid result for free (cache reads are open)", async () => {
    const io = fakeTextractIo();
    const { d } = deps({ runners: [textractCropRunner(io)] });
    const thorough = req({ budget: "thorough", hints: { allowPaidTextract: true } });
    await runParse(input({ request: thorough }), d);
    await runParse(input({ caller: OTHER, request: thorough }), d);
    expect(io.analyzed).toBe(1);
  });

  it("over the company cap the paid method is skipped (no Textract call, error recorded) and the engine still runs", async () => {
    const io = fakeTextractIo();
    const { d, engine, store } = deps({ runners: [textractCropRunner(io)], chargePaid: vi.fn(async () => false) });
    await runParse(input({ request: req({ budget: "thorough", hints: { allowPaidTextract: true } }) }), d);
    expect(io.analyzed).toBe(0);
    expect(store.puts).toEqual([]);
    expect(engine.mock.calls[0][0].crops?.textract).toMatchObject({ error: "cap-reached", cached: false });
  });

  it("cache-only (the commit re-run): a paid miss throws PaidCropExpiredError (409) and pays nothing; a hit is served", async () => {
    const io = fakeTextractIo();
    const { d, chargePaid } = deps({ runners: [textractCropRunner(io)] });
    const thorough = req({ budget: "thorough", hints: { allowPaidTextract: true } });
    const err = await expectApiError(runParse(input({ request: thorough, mode: "cache-only" }), d), 409, "CONFLICT");
    expect(err).toBeInstanceOf(PaidCropExpiredError);
    expect((err as PaidCropExpiredError).methods).toEqual(["textract"]);
    expect(io.analyzed).toBe(0);
    expect(chargePaid).not.toHaveBeenCalled();
    await runParse(input({ request: thorough }), d); // the workspace paid once
    await runParse(input({ request: thorough, mode: "cache-only" }), d);
    expect(io.analyzed).toBe(1);
    expect(parseSlotsInUseForTest("user:11")).toBe(0);
  });

  it("a failed crop casts no vote (error 'failed', nothing cached) and the engine still runs", async () => {
    const io = fakeTextractIo();
    io.analyze.mockRejectedValueOnce(new Error("throttled"));
    const { d, engine, store } = deps({ runners: [textractCropRunner(io)] });
    await runParse(input({ request: req({ budget: "thorough", hints: { allowPaidTextract: true } }) }), d);
    expect(store.puts).toEqual([]);
    expect(engine.mock.calls[0][0].crops?.textract).toMatchObject({ error: "failed" });
  });

  it("TATR asked for with no runner yet is reported, not dropped", async () => {
    const { d, engine } = deps();
    await runParse(input({ request: req({ budget: "thorough", hints: { tatr: true } }) }), d);
    expect(engine.mock.calls[0][0].crops?.tatr).toMatchObject({ method: "tatr", error: "unavailable" });
  });
});

describe("standard crop results", () => {
  it("a demo standard call runs the method but writes no cache object", async () => {
    const r = standardRunner();
    const { d, engine, store } = deps({ runners: [r] });
    await runParse(input({ project: DEMO, request: req({ budget: "standard" }) }), d);
    await runParse(input({ caller: ANON, scope: "demo", request: req({ budget: "standard" }) }), d);
    expect(r.calls).toBe(2);
    expect(store.puts).toEqual([]);
    expect(engine.mock.calls[0][0].crops?.rulings).toMatchObject({ cached: false, value: { rows: [0.3] } });
  });
  it("a signed-in standard call writes; the next call hits; with cropCache off it neither reads nor writes", async () => {
    const r = standardRunner();
    const { d, store } = deps({ runners: [r] });
    await runParse(input({ request: req({ budget: "standard" }) }), d);
    await runParse(input({ request: req({ budget: "standard" }) }), d);
    expect(r.calls).toBe(1);
    expect(store.puts).toHaveLength(1);
    const off = { ...FLAGS, cropCache: false };
    await runParse(input({ request: req({ budget: "standard" }), flags: off }), d);
    expect(r.calls).toBe(2);
    expect(store.puts).toHaveLength(1);
  });
  it("instant runs no crop method and hands the engine no `crops` key", async () => {
    const r = standardRunner();
    const { d, engine } = deps({ runners: [r] });
    await runParse(input(), d);
    expect(r.calls).toBe(0);
    expect(engine.mock.calls[0][0]).not.toHaveProperty("crops");
  });
});

describe("per-caller in-flight cap", () => {
  it("a 3rd concurrent standard call from one user → 429; another user is unaffected; a finished call frees its slot", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const r = standardRunner(async () => { await gate; return {}; });
    const { d } = deps({ runners: [r] });
    const std = input({ request: req({ budget: "standard" }) });
    const a = runParse(std, d);
    const b = runParse(std, d);
    await expectApiError(runParse(std, d), 429, "RATE_LIMITED");
    const c = runParse({ ...std, caller: OTHER }, d); // a different caller has its own slots
    expect(parseSlotsInUseForTest("user:11", "standard")).toBe(2);
    open();
    await Promise.all([a, b, c]);
    expect(parseSlotsInUseForTest("user:11")).toBe(0);
    await runParse(std, d); // admitted again
  });
  it("thorough holds one slot; signed-out callers are keyed by address, not shared with users", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const io = fakeTextractIo();
    io.analyze.mockImplementationOnce(async () => { await gate; return { words: [], tables: [] }; });
    const { d } = deps({ runners: [textractCropRunner(io)] });
    const t = input({ request: req({ budget: "thorough", hints: { allowPaidTextract: true } }) });
    const first = runParse(t, d);
    await expectApiError(runParse({ ...t, request: req({ bbox: [0.1, 0.1, 0.3, 0.3], budget: "thorough", hints: { allowPaidTextract: true } }) }, d), 429);
    open();
    await first;
    const s = input({ caller: ANON, scope: "demo", request: req({ budget: "standard" }) });
    let release!: () => void;
    const g2 = new Promise<void>((resolve) => { release = resolve; });
    const d2 = deps({ runners: [standardRunner(async () => { await g2; return {}; })] }).d;
    const x = runParse(s, d2);
    const y = runParse(s, d2);
    await expectApiError(runParse(s, d2), 429);
    expect(parseSlotsInUseForTest("ip:198.51.100.9", "standard")).toBe(2);
    expect(parseSlotsInUseForTest("user:11")).toBe(0);
    release();
    await Promise.all([x, y]);
  });
  it("the slot is released when the engine throws", async () => {
    const { d } = deps({ runners: [standardRunner()], runEngine: async () => { throw new Error("boom"); } });
    await expect(runParse(input({ request: req({ budget: "standard" }) }), d)).rejects.toThrow("boom");
    expect(parseSlotsInUseForTest("user:11")).toBe(0);
  });
});

describe("engine handoff", () => {
  it("the engine gets the page evidence without the raw `sources` slices, and the request verbatim", async () => {
    const { d, engine } = deps();
    const r = req({ kind: "schedule", hints: { proposalId: "p1" } });
    const out = await runParse(input({ request: r }), d);
    expect(out).toBe(RESULT);
    const [ev, sent] = engine.mock.calls[0];
    expect(ev).not.toHaveProperty("sources");
    expect(ev.words.map((w) => w.t)).toEqual(["QQ"]);
    expect(sent).toBe(r);
  });
  it("the WP-2.E engine stub (NotImplemented) answers 501; a missing page answers 404", async () => {
    const stub = deps({ runEngine: async () => { throw new ParseEngineNotImplementedError("runParseEngine"); } }).d;
    await expectApiError(runParse(input(), stub), 501);
    const missing = deps({ loadEvidence: async () => null }).d;
    await expectApiError(runParse(input(), missing), 404, "NOT_FOUND");
  });
});

describe("remapTextractCrop", () => {
  it("maps crop-relative LTWH words, tables and cells back onto the page", () => {
    const out = remapTextractCrop({
      words: [{ text: "W", confidence: 1, bbox: [0.5, 0.5, 0.5, 0.5] }],
      tables: [{ bbox: [0, 0, 1, 1], rowCount: 1, colCount: 1, cells: [{ row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "W", confidence: 1, bbox: [0, 0.5, 1, 0.5] }] }],
    }, [0.1, 0.2, 0.5, 0.6]);
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
    close(out.words[0].bbox, [0.3, 0.4, 0.2, 0.2]);
    close(out.tables[0].bbox, [0.1, 0.2, 0.4, 0.4]);
    close(out.tables[0].cells[0].bbox, [0.1, 0.4, 0.4, 0.2]);
  });
});
