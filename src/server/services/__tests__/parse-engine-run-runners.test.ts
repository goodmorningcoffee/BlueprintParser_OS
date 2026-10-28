// @vitest-environment node
// [table pipeline WP-3.D] The run service's crop runners as the engine assembly registers them: crop rulings at
// `standard` (WP-3.B's server half), the paid Textract crop at `thorough`, and img2table / an unticked-runner TATR
// reported as "unavailable" (never dropped silently). Every side effect is injected; synthetic evidence (rule 12).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
import type { ParseEngineFlags, ParseRequest, ParseResult } from "@/lib/parse-engine/types";
import type { EnginePageEvidenceWithCrops } from "@/lib/parse-engine/types-crop";
import { buildPageEvidence } from "@/server/services/parse-engine/evidence";
import { resetParseSlotsForTest } from "@/server/services/parse-engine/concurrency";
import type { CropCacheStore } from "@/server/services/parse-engine/crop-cache";
import { DEFAULT_CROP_RUNNERS, rulingsCropRunner, runParse, type RunParseDeps, type RulingsCropIo } from "@/server/services/parse-engine/run";

const FLAGS: ParseEngineFlags = {
  killSwitch: false,
  tools: { tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy", notesAuto: "legacy", specAuto: "legacy", workspace: "engine" },
  cropCache: true,
};
const PROJECT = { id: 7, companyId: 3, isDemo: false, dataUrl: "co/abc" };
const MEMBER = { userId: 11, isRoot: false, ip: "198.51.100.1" };
const BOX: [number, number, number, number] = [0.2, 0.2, 0.6, 0.6];
const RESULT = { model: { v: 1 }, alternatives: [], evidence: { words: 0, lines: 0, paidCropAvailable: false }, words: [], stamp: {} } as unknown as ParseResult;

function store(): CropCacheStore & { puts: string[] } {
  const objects = new Map<string, string>();
  const s: CropCacheStore & { puts: string[] } = {
    puts: [],
    async getObject(key) { return objects.get(key) ?? null; },
    async putObject(key, body) { s.puts.push(key); objects.set(key, body); },
  };
  return s;
}

function deps(over: Partial<RunParseDeps> = {}) {
  const engine = vi.fn(async (_ev: EnginePageEvidenceWithCrops, _req: ParseRequest) => RESULT);
  const d: RunParseDeps = {
    readFlags: async () => FLAGS,
    loadEvidence: async () => buildPageEvidence({
      pageNumber: 2, drawingNumber: null, keynotes: null, csiCodes: null,
      words: [{ text: "QQ", confidence: 90, bbox: [0.25, 0.25, 0.05, 0.02] }], tables: null, layout: null,
      pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
    }, { recompute: true }),
    runEngine: engine,
    cache: store(),
    runners: [],
    chargePaid: async () => true,
    now: () => 1_000_000,
    ...over,
  };
  return { d, engine };
}

const input = (budget: ParseRequest["budget"], hints?: ParseRequest["hints"]) => ({ project: PROJECT, caller: MEMBER, scope: "member" as const, request: { page: 2, bbox: BOX, budget, ...(hints ? { hints } : {}) } });

afterEach(() => resetParseSlotsForTest());

describe("crop runners registered by the engine assembly (WP-3.D)", () => {
  it("DEFAULT_CROP_RUNNERS: rulings at standard (free), the Textract crop at thorough (paid)", () => {
    expect(DEFAULT_CROP_RUNNERS.map((r) => [r.method, r.budget, r.paid])).toEqual([["rulings", "standard", false], ["textract", "thorough", true]]);
  });

  it("the rulings runner runs the script on the page image and hands its crop rulings to the engine (cached for a signed-in caller)", async () => {
    const io: RulingsCropIo = { downloadPagePng: vi.fn(async () => Buffer.from("png")), detect: vi.fn(async () => ({ rows: [0, 0.5, 1], cols: [0, 1], confidence: 0.8 })) };
    const { d, engine } = deps({ runners: [rulingsCropRunner(io)] });
    await runParse(input("standard"), d);
    expect(io.downloadPagePng).toHaveBeenCalledWith("co/abc", 2);
    expect(io.detect).toHaveBeenCalledWith(Buffer.from("png"), BOX);
    expect(engine.mock.calls[0][0].crops?.rulings).toMatchObject({ method: "rulings", cached: false, value: { rows: [0, 0.5, 1], cols: [0, 1], confidence: 0.8 } });
    expect((d.cache as ReturnType<typeof store>).puts).toEqual(["co/abc/cache/parse-engine/2/0.200_0.200_0.600_0.600.rulings.json"]);
    await runParse(input("standard"), d);
    expect(engine.mock.calls[1][0].crops?.rulings).toMatchObject({ cached: true });
    expect(io.detect).toHaveBeenCalledTimes(1);
  });

  it("a script error casts no vote and caches nothing; instant runs no runner", async () => {
    const io: RulingsCropIo = { downloadPagePng: async () => Buffer.from("png"), detect: async () => ({ rows: [], cols: [], confidence: 0, error: "no image" }) };
    const { d, engine } = deps({ runners: [rulingsCropRunner(io)] });
    await runParse(input("standard"), d);
    expect(engine.mock.calls[0][0].crops?.rulings).toMatchObject({ cached: false, error: "failed" });
    expect((d.cache as ReturnType<typeof store>).puts).toEqual([]);
    await runParse(input("instant"), d);
    expect(engine.mock.calls[1][0]).not.toHaveProperty("crops");
  });

  it("img2table (no geometry runner yet) is reported unavailable at standard and thorough; a ticked TATR too", async () => {
    const { d, engine } = deps({ runners: [] });
    await runParse(input("standard"), d);
    expect(engine.mock.calls[0][0].crops?.img2table).toMatchObject({ method: "img2table", budget: "standard", paid: false, error: "unavailable" });
    await runParse(input("thorough", { tatr: true }), d);
    expect(engine.mock.calls[1][0].crops?.tatr).toMatchObject({ method: "tatr", paid: true, error: "unavailable" });
    expect(engine.mock.calls[1][0].crops?.img2table).toMatchObject({ error: "unavailable" });
  });
});
