// @vitest-environment node
// [table pipeline WP-3.E] POST /api/projects/[id]/parse-engine/parse through the real route shell, the
// real project resolver, the real page-evidence loader (Postgres) and run.ts. The engine is mocked until
// WP-3.D fills it; S3 and Textract are in-memory fakes (no network); the flags read is controlled here
// (the DB row is owned by parse-engine-flags.route.test.ts). Synthetic page data only (rule 12).
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  uploads: [] as string[],
  analyzed: 0,
  flags: null as null | Record<string, unknown>,
  engineCalls: [] as unknown[][],
}));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/s3", async (orig) => {
  const m = await orig<typeof import("@/lib/s3")>();
  return {
    ...m,
    downloadFromS3: vi.fn(async (key: string) => {
      const v = h.objects.get(key);
      if (!v) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return v;
    }),
    uploadToS3: vi.fn(async (key: string, body: Buffer) => {
      h.uploads.push(key);
      h.objects.set(key, body);
    }),
  };
});
vi.mock("@/lib/textract", async (orig) => {
  const m = await orig<typeof import("@/lib/textract")>();
  return {
    ...m,
    analyzePageImage: vi.fn(async () => {
      h.analyzed += 1;
      return { lines: [], words: [{ text: "Z9", confidence: 90, bbox: [0.1, 0.1, 0.2, 0.2] }], tables: [] };
    }),
  };
});
vi.mock("@/server/services/parse-engine/flags", async (orig) => {
  const m = await orig<typeof import("@/server/services/parse-engine/flags")>();
  return { ...m, readParseEngineFlags: async () => m.resolveParseEngineFlags(h.flags ?? undefined).flags };
});
vi.mock("@/lib/parse-engine/engine", () => ({
  runParseEngine: vi.fn(async (evidence: unknown, request: unknown) => {
    h.engineCalls.push([evidence, request]);
    return { model: { v: 1, kind: "schedule" }, alternatives: [], evidence: { words: 1, lines: 1, paidCropAvailable: false }, words: [], stamp: { engine: "mock" } };
  }),
}));

import sharp from "sharp";
import { POST } from "@/app/api/projects/[id]/parse-engine/parse/route";
import { runParseEngine } from "@/lib/parse-engine/engine";
import { ParseEngineNotImplementedError } from "@/lib/parse-engine/types";
import { resetParseSlotsForTest } from "@/server/services/parse-engine/concurrency";
import { asUser, createPage, createUser, createWorld, makeReq, params, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const TEXTRACT = {
  lines: [],
  words: [
    { text: "QX", confidence: 99, bbox: [0.21, 0.21, 0.05, 0.02] },
    { text: "Q2", confidence: 95, bbox: [0.8, 0.8, 0.05, 0.02] },
  ],
  tables: [],
};

async function world(opts: { demo?: boolean } = {}) {
  const w = await createWorld();
  await createPage(w.project.id, 1, { textractData: TEXTRACT as never });
  if (opts.demo) await publishDemoFixture(w.project.id);
  const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  h.objects.set(`${w.project.dataUrl}/pages/page_0001.png`, png);
  return w;
}

const parse = (publicId: string, body: unknown) =>
  POST(makeReq(`/api/projects/${publicId}/parse-engine/parse`, { body, headers: { "x-forwarded-for": "198.51.100.3" } }), params({ id: publicId }));

const BOX = [0.2, 0.2, 0.6, 0.6];

beforeEach(() => {
  h.uploads.length = 0;
  h.analyzed = 0;
  h.flags = null;
  h.engineCalls.length = 0;
  resetParseSlotsForTest();
  signedOut();
});
afterEach(() => vi.mocked(runParseEngine).mockClear());

describe.skipIf(!dbUp)("POST /api/projects/[id]/parse-engine/parse", () => {
  it("a member's instant parse runs the (mocked) engine through run.ts on the stored page evidence", async () => {
    const { user, project } = await world();
    asUser(user);
    const r = await readJson(await parse(project.publicId, { page: 1, bbox: BOX, budget: "instant", kind: "schedule" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ model: { v: 1, kind: "schedule" }, stamp: { engine: "mock" } });
    expect(h.engineCalls).toHaveLength(1);
    const [ev, req] = h.engineCalls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(req).toEqual({ page: 1, bbox: BOX, budget: "instant", kind: "schedule" });
    expect(ev).not.toHaveProperty("sources");
    expect(ev).not.toHaveProperty("crops");
    expect((ev.words as { t: string }[]).map((w) => w.t)).toEqual(["QX", "Q2"]);
    expect(h.uploads).toEqual([]);
  });

  it("a cache hit on the second paid crop: Textract runs once, the result is cached under the project root", async () => {
    const { user, project } = await world();
    asUser(user);
    const body = { page: 1, bbox: BOX, budget: "thorough", hints: { allowPaidTextract: true } };
    expect((await parse(project.publicId, body)).status).toBe(200);
    expect((await parse(project.publicId, body)).status).toBe(200);
    expect(h.analyzed).toBe(1);
    expect(h.uploads).toEqual([`${project.dataUrl}/cache/parse-engine/1/0.200_0.200_0.600_0.600.textract.json`]);
    const crops = h.engineCalls.map((c) => (c[0] as { crops: { textract: { cached: boolean } } }).crops.textract.cached);
    expect(crops).toEqual([false, true]);
  });

  it("demo: thorough → 403 for a signed-out viewer; standard is computed and writes no cache object", async () => {
    const { project } = await world({ demo: true });
    signedOut();
    let r = await readJson(await parse(project.publicId, { page: 1, bbox: BOX, budget: "thorough", hints: { allowPaidTextract: true } }));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN");
    r = await readJson(await parse(project.publicId, { page: 1, bbox: BOX, budget: "standard" }));
    expect(r.status).toBe(200);
    expect(h.uploads).toEqual([]);
    expect(h.analyzed).toBe(0);
  });

  it("the kill switch (or workspace=legacy) turns the route off", async () => {
    const { user, project } = await world();
    asUser(user);
    h.flags = { killSwitch: true };
    let r = await readJson(await parse(project.publicId, { page: 1, bbox: BOX, budget: "instant" }));
    expect(r.status).toBe(403);
    h.flags = { tools: { workspace: "legacy" } };
    r = await readJson(await parse(project.publicId, { page: 1, bbox: BOX, budget: "instant" }));
    expect(r.status).toBe(403);
    expect(h.engineCalls).toHaveLength(0);
  });

  it("validation: strict body, MinMax box, a known budget; a missing page → 404", async () => {
    const { user, project } = await world();
    asUser(user);
    for (const bad of [
      { page: 1, bbox: BOX, budget: "instant", extra: 1 },
      { page: 1, bbox: [0.6, 0.2, 0.2, 0.6], budget: "instant" },
      { page: 1, bbox: BOX, budget: "fast" },
      { page: 1, bbox: BOX, budget: "thorough" },
    ]) {
      const r = await readJson(await parse(project.publicId, bad));
      expect(r.status).toBe(400);
    }
    const r = await readJson(await parse(project.publicId, { page: 2, bbox: BOX, budget: "instant" }));
    expect(r.status).toBe(404);
  });

  it("access: a private project signed out → 401; another company → 404", async () => {
    const { project } = await world();
    expect((await parse(project.publicId, { page: 1, bbox: BOX, budget: "instant" })).status).toBe(401);
    const outsider = await createUser((await createWorld()).company.id);
    asUser(outsider);
    expect((await parse(project.publicId, { page: 1, bbox: BOX, budget: "instant" })).status).toBe(404);
  });

  it("the WP-2.E engine stub answers 501 (not a generic 500)", async () => {
    const { user, project } = await world();
    asUser(user);
    vi.mocked(runParseEngine).mockImplementationOnce(async () => { throw new ParseEngineNotImplementedError("runParseEngine"); });
    const r = await readJson(await parse(project.publicId, { page: 1, bbox: BOX, budget: "instant" }));
    expect(r.status).toBe(501);
    expect(r.body.error.message).toMatch(/not available yet/);
  });
});
