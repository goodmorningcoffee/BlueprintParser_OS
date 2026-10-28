// @vitest-environment node
// [table pipeline WP-3.I] POST /api/table-parse with `tablesRoute = engine`, through the real route shell, the real
// project resolver, the real page-evidence loader (Postgres), run.ts and the REAL engine. S3, Textract, the crop
// rulings script and the op_log history are in-memory fakes; the flags read is controlled here (the DB row is owned by
// parse-engine-flags.route.test.ts). The legacy leg (`tablesRoute = legacy`, the shipped default) is pinned byte-equal
// by table-parse.route.test.ts. Synthetic page data only (rule 12): the committed `syn-keynote-shapes` fixture.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  uploads: [] as string[],
  analyzed: 0,
  flags: null as null | Record<string, unknown>,
  history: [] as unknown[],
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
  return { ...m, analyzePageImage: vi.fn(async () => { h.analyzed += 1; return { lines: [], words: [], tables: [] }; }) };
});
vi.mock("@/server/services/parse-engine/rulings", async (orig) => {
  const m = await orig<typeof import("@/server/services/parse-engine/rulings")>();
  return { ...m, detectCropRulings: vi.fn(async () => ({ rows: [], cols: [], confidence: 0 })) };
});
vi.mock("@/server/services/parse-engine/flags", async (orig) => {
  const m = await orig<typeof import("@/server/services/parse-engine/flags")>();
  return { ...m, readParseEngineFlags: async () => m.resolveParseEngineFlags(h.flags ?? undefined).flags };
});
vi.mock("@/lib/parse-history", () => ({ addToHistory: vi.fn(async (e: unknown) => { h.history.push(e); }) }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { POST } from "@/app/api/table-parse/route";
import { legacyView } from "@/lib/parse-engine/legacy-view";
import type { StructureTableModel } from "@/lib/parse-engine/types";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import { resetParseSlotsForTest } from "@/server/services/parse-engine/concurrency";
import { asUser, createWorld, createPage, makeReq, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

interface Fx { region: [number, number, number, number]; page: { words: unknown[] }; shapes: { bbox: [number, number, number, number]; label: string }[]; truth: { rows: string[][] } }
const FX = JSON.parse(readFileSync(join(process.cwd(), "src/lib/parse-engine/__fixtures__/syn-keynote-shapes.synthetic.json"), "utf8")) as Fx;
const ENGINE_ONLY = ["confidence", "methods", "disagreements", "csiTags", "infraErrors", "structure", "engine"];

async function world(opts: { demo?: boolean; storedTable?: boolean } = {}) {
  const w = await createWorld();
  const [x0, y0, x1, y1] = FX.region;
  const tables = opts.storedTable ? [{ bbox: [x0, y0, x1 - x0, y1 - y0], rowCount: 0, colCount: 0, cells: [] }] : [];
  await createPage(w.project.id, 1, { textractData: { lines: [], words: FX.page.words, tables } as never });
  await db.insert(annotations).values(FX.shapes.map((s) => ({
    projectId: w.project.id, pageNumber: 1, name: s.label, source: "yolo", minX: s.bbox[0], minY: s.bbox[1], maxX: s.bbox[2], maxY: s.bbox[3],
    data: { modelName: "yolo_primitive", confidence: 0.9 } as never,
  })));
  if (opts.demo) await publishDemoFixture(w.project.id);
  const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  h.objects.set(`${w.project.dataUrl}/pages/page_0001.png`, png);
  return w;
}

const call = (body: unknown) => POST(makeReq("/api/table-parse", { body, headers: { "x-forwarded-for": "198.51.100.4" } }));

beforeEach(() => {
  h.uploads.length = 0;
  h.analyzed = 0;
  h.history.length = 0;
  h.flags = { tools: { tablesRoute: "engine" } };
  resetParseSlotsForTest();
  signedOut();
});

describe.skipIf(!dbUp)("POST /api/table-parse — tablesRoute = engine", () => {
  it("the response grid is the projection of `structure`; the keynote shapes cut the rows (K27); history is written", async () => {
    const { user, project } = await world({ storedTable: true });
    asUser(user);
    const r = await readJson(await call({ projectId: project.id, pageNumber: 1, regionBbox: FX.region }));
    expect(r.status).toBe(200);
    const model = r.body.structure as StructureTableModel;
    const grid = Object.fromEntries(Object.entries(r.body).filter(([k]) => !ENGINE_ONLY.includes(k)));
    expect(grid).toEqual(JSON.parse(JSON.stringify(legacyView(model))));
    expect(model.sources.rows).toContain("shape-centres");
    expect(r.body.rowCount).toBe(FX.truth.rows.length);
    expect((r.body.rows as Record<string, string>[]).map((row) => row[r.body.tagColumn as string])).toEqual(FX.truth.rows.map((row) => row[0]));
    expect(Array.isArray(r.body.csiTags)).toBe(true);
    expect(r.body.engine).toMatchObject({ budget: "standard" });
    expect(h.analyzed).toBe(0); // stored tables cover the box → no paid crop
    expect(h.history).toHaveLength(1);
  });

  it("stored tables miss the box (member): the paid crop runs once, is cached, and the re-parse is free (K17)", async () => {
    const { user, project } = await world();
    asUser(user);
    const body = { projectId: project.id, pageNumber: 1, regionBbox: FX.region };
    expect((await call(body)).status).toBe(200);
    const r = await readJson(await call(body));
    expect(r.status).toBe(200);
    expect(h.analyzed).toBe(1);
    expect(h.uploads.filter((k) => k.endsWith(".textract.json"))).toHaveLength(1);
    expect(r.body.engine).toMatchObject({ budget: "thorough" });
  });

  it("demo (signed-out): computed at standard, never pays, never writes a cache object", async () => {
    const { project } = await world({ demo: true });
    signedOut();
    const r = await readJson(await call({ projectId: project.id, pageNumber: 1, regionBbox: FX.region }));
    expect(r.status).toBe(200);
    expect(r.body.engine).toMatchObject({ budget: "standard" });
    expect(h.analyzed).toBe(0);
    expect(h.uploads).toEqual([]);
  });

  it("the kill switch puts the route back on the classic pipeline (no `structure` in the response)", async () => {
    const { user, project } = await world({ storedTable: true });
    asUser(user);
    h.flags = { killSwitch: true, tools: { tablesRoute: "engine" } };
    const r = await readJson(await call({ projectId: project.id, pageNumber: 1, regionBbox: FX.region }));
    expect(r.status).toBe(200);
    expect("structure" in r.body).toBe(false);
    expect("engine" in r.body).toBe(false);
  });

  it("validation, access and the OCR check run before the engine (unchanged order)", async () => {
    const { project } = await world();
    let r = await readJson(await call({ projectId: project.id, pageNumber: 1, regionBbox: [0.5, 0.1, 0.1, 0.5] }));
    expect(r.status).toBe(400);
    r = await readJson(await call({ projectId: project.id, pageNumber: 1, regionBbox: FX.region }));
    expect(r.status).toBe(401);
    const w2 = await createWorld();
    await createPage(w2.project.id, 1, {});
    asUser(w2.user);
    r = await readJson(await call({ projectId: w2.project.id, pageNumber: 1, regionBbox: FX.region }));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Page has no OCR data" } });
  });
});
