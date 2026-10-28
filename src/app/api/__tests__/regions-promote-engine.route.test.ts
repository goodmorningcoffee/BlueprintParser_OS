// @vitest-environment node
// [table pipeline WP-3.J] The classic notes/spec tools on the paragraph engine, through the real routes and the test
// DB: Classic Accept (`POST /api/regions/promote` + `sourceTextRegionId`) under notesClassifier / specClassifier,
// Notes Auto / Spec Auto (`/api/notes-parse`, `/api/spec-parse`) under notesAuto / specAuto. The flag reader is
// mocked (the app_settings row is shared by parallel test files); `legacy` keeps the frozen behaviour, which
// regions-promote.route.test.ts and parse-region.route.test.ts pin. Synthetic fixtures only (rule 12).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ tools: {} as Record<string, "legacy" | "engine"> }));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/project-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/project-analysis")>();
  return { ...orig, computeProjectSummaries: vi.fn() };
});
vi.mock("@/lib/csi-detect", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-detect")>();
  return { ...orig, detectCsiFromGrid: vi.fn(), detectCsiCodes: vi.fn() };
});
vi.mock("@/server/services/parse-engine/flags", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/parse-engine/flags")>();
  return {
    ...orig,
    readParseEngineFlags: vi.fn(async () => orig.resolveParseEngineFlags({ tools: h.tools }).flags),
  };
});

import { POST as promotePOST } from "@/app/api/regions/promote/route";
import { POST as notesPOST } from "@/app/api/notes-parse/route";
import { POST as specPOST } from "@/app/api/spec-parse/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { detectCsiCodes, detectCsiFromGrid } from "@/lib/csi-detect";
import { readStructure } from "@/lib/parse-engine/read";
import { readParseEngineFlags } from "@/server/services/parse-engine/flags";
import { asUser, createPage, createWorld, makeReq, readJson } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

type Box = [number, number, number, number];
const FIXTURES = join(process.cwd(), "src/lib/parse-engine/__fixtures__");
function fixture(id: string): { page: unknown; region: Box; ltwh: Box; truth: { key: string; text: string }[] } {
  const f = JSON.parse(readFileSync(join(FIXTURES, `${id}.synthetic.json`), "utf8"));
  const r = f.region as Box;
  return { page: f.page, region: r, ltwh: [r[0], r[1], r[2] - r[0], r[3] - r[1]], truth: f.truth.items };
}
const keyedTruth = (truth: { key: string; text: string }[]) =>
  truth.filter((i) => i.key !== "").map((i) => [i.key.replace(/^\(|[.)]$/g, ""), i.text]);

const promote = (body: unknown) => promotePOST(makeReq("/api/regions/promote", { method: "POST", body }));

async function seed(id: string, textRegion: Record<string, unknown>) {
  const f = fixture(id);
  const { user, project } = await createWorld();
  const page = await createPage(project.id, 1, {
    textractData: f.page as never,
    pageIntelligence: { textRegions: [{ id: "region-0", bbox: f.ltwh, confidence: 0.8, ...textRegion }] } as never,
  });
  asUser(user);
  return { f, user, project, page };
}

beforeEach(() => {
  h.tools = {};
  vi.mocked(readParseEngineFlags).mockClear();
  vi.mocked(computeProjectSummaries).mockReset().mockResolvedValue(null as never);
  vi.mocked(detectCsiFromGrid).mockReset().mockReturnValue([]);
  vi.mocked(detectCsiCodes).mockReset().mockReturnValue([]);
});

describe.skipIf(!dbUp)("Classic Accept on the engine (POST /api/regions/promote)", () => {
  it("notesClassifier = engine: a key-value region's stored key-only grid is replaced by the segmenter's pairs (C04-04)", async () => {
    h.tools = { notesClassifier: "engine" };
    const garbage = { headers: ["Key", "Value"], rows: [{ Key: "BZC", Value: "" }, { Key: "ZFKMP SNIEV", Value: "" }] };
    const { f, project, page } = await seed("syn-kv-abbrev", { type: "notes-key-value", headerText: "ABBREVIATIONS", grid: garbage });
    const { status, body } = await readJson(await promote({ publicId: project.publicId, pageNumber: 1, type: "notes", sourceTextRegionId: "region-0", overrides: { regionId: "acc-1" } }));
    expect(status).toBe(200);
    const region = body.parsedRegion;
    expect(region).toMatchObject({ id: "acc-1", type: "notes", bbox: f.region, source: "user", confidence: 0.85, sourceTextRegionId: "region-0", category: "abbreviations" });
    expect(region.data.rows.map((r: { Key: string; Note: string }) => [r.Key, r.Note])).toEqual(keyedTruth(f.truth));
    expect(region.data.tableName).toBe("ABBREVIATIONS");
    expect(region.data.links).toMatchObject({ origin: "classic-engine", revision: 1, textRegionKey: expect.stringMatching(/^tr:notes-key-value:/) });
    expect(region.data.recipe).toMatchObject({ origin: "text-region", request: { kind: "notes", budget: "instant", page: 1 } });
    expect(readStructure(region)).toMatchObject({ origin: "workspace", editedInClassic: false });
    const [row] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, page.id));
    const stored = (row.pi as { parsedRegions: { id: string; data: unknown }[] }).parsedRegions;
    expect(stored).toHaveLength(1);
    expect(stored[0].data).toEqual(region.data); // the window serialiser keeps the engine keys on the response
    expect(readParseEngineFlags).toHaveBeenCalledTimes(1);
  });

  it("notesClassifier = engine: wrapped numbered notes and a sub-block header (C04-06 / C04-10)", async () => {
    h.tools = { notesClassifier: "engine" };
    const { project } = await seed("syn-notes-subblocks", { type: "paragraph" });
    const { status, body } = await readJson(await promote({ publicId: project.publicId, pageNumber: 1, type: "notes", sourceTextRegionId: "region-0" }));
    expect(status).toBe(200);
    expect(body.parsedRegion.data.rows.map((r: { Key: string }) => r.Key)).toEqual(["1", "2", "3", "4", "5", "1", "2", "3"]);
    expect(body.parsedRegion.data.structure.blocks.map((b: { header: string }) => b.header)).toEqual(["GENERAL NOTES", "ELECTRICAL NOTES"]);
    expect(body.parsedRegion.data.tableName).toBe("Notes p.1"); // no headerText → defaultTableName, as legacy
  });

  it("specClassifier = engine: the spec hierarchy reaches sections + structure; CSI merged into the page", async () => {
    h.tools = { specClassifier: "engine" };
    const code = { code: "09 21 16", description: "Gypsum board" };
    vi.mocked(detectCsiCodes).mockReturnValue([code] as never);
    const { project } = await seed("syn-spec-section", { type: "spec-text", headerText: "Spec" });
    const { status, body } = await readJson(await promote({ publicId: project.publicId, pageNumber: 1, type: "spec", sourceTextRegionId: "region-0" }));
    expect(status).toBe(200);
    const data = body.parsedRegion.data;
    expect(data.sections.map((s: { sectionHeader: string }) => s.sectionHeader)).toEqual(["SECTION 09 21 16 - ZFKMP ZYSFM", "PART 1 GENERAL", "PART 2 PRODUCTS"]);
    expect(data.structure.paragraphs.map((p: { keyPath: string[] }) => p.keyPath.join(" › "))).toContain("1.01 › A");
    expect(data.csiTags).toEqual([code]);
    expect(body.parsedRegion.csiTags).toEqual([code]);
  });

  it("specClassifier = engine: refusals keep the legacy messages (no OCR → 400)", async () => {
    h.tools = { specClassifier: "engine" };
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [{ id: "region-0", type: "spec-text", bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.8 }] } as never });
    asUser(user);
    const { status, body } = await readJson(await promote({ publicId: project.publicId, pageNumber: 1, type: "spec", sourceTextRegionId: "region-0" }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Page has no OCR data for spec binding" });
  });

  it("legacy (the default): the stored grid is promoted verbatim, no engine keys", async () => {
    const grid = { headers: ["Key", "Value"], rows: [{ Key: "BZC", Value: "" }] };
    const { project } = await seed("syn-kv-abbrev", { type: "notes-key-value", grid });
    const { status, body } = await readJson(await promote({ publicId: project.publicId, pageNumber: 1, type: "notes", sourceTextRegionId: "region-0" }));
    expect(status).toBe(200);
    expect(body.parsedRegion.data.rows).toEqual(grid.rows);
    expect(body.parsedRegion.data.structure).toBeUndefined();
    expect(readParseEngineFlags).toHaveBeenCalledTimes(1);
  });

  it("the flag is read only on the notes/spec Classifier Accept path (Parser Save and other types never read it)", async () => {
    h.tools = { notesClassifier: "engine", specClassifier: "engine" };
    const { project } = await seed("syn-kv-abbrev", { type: "schedule-table", grid: { headers: ["A"], rows: [{ A: "1" }] } });
    expect((await promote({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: { bbox: [0, 0, 1, 1], data: { a: 1 } } })).status).toBe(200);
    expect((await promote({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "region-0" })).status).toBe(200);
    expect(readParseEngineFlags).not.toHaveBeenCalled();
  });
});

describe.skipIf(!dbUp)("Notes Auto / Spec Auto on the engine", () => {
  async function world(id: string) {
    const f = fixture(id);
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { textractData: f.page as never });
    asUser(user);
    return { f, project };
  }

  it("notesAuto = engine: /api/notes-parse returns the legacy shape + structure", async () => {
    h.tools = { notesAuto: "engine" };
    const { f, project } = await world("syn-notes-two-column");
    const { status, body } = await readJson(await notesPOST(makeReq("/api/notes-parse", { method: "POST", body: { projectId: project.id, pageNumber: 1, regionBbox: f.region } })));
    expect(status).toBe(200);
    expect(body.headers).toEqual(["Key", "Note"]);
    expect(body.rows.map((r: { Key: string; Note: string }) => [r.Key, r.Note])).toEqual(keyedTruth(f.truth)); // C04-08
    expect(body.structure.kind).toBe("notes");
    expect(body.engine.budget).toBe("instant");
  });

  it("notesAuto = legacy: no structure in the response", async () => {
    const { f, project } = await world("syn-notes-two-column");
    const { status, body } = await readJson(await notesPOST(makeReq("/api/notes-parse", { method: "POST", body: { projectId: project.id, pageNumber: 1, regionBbox: f.region } })));
    expect(status).toBe(200);
    expect(body.structure).toBeUndefined();
  });

  it("specAuto = engine: /api/spec-parse returns sections + structure, CSI with pageKind spec", async () => {
    h.tools = { specAuto: "engine" };
    const { f, project } = await world("syn-spec-section");
    const { status, body } = await readJson(await specPOST(makeReq("/api/spec-parse", { method: "POST", body: { projectId: project.id, pageNumber: 1, regionBbox: f.region } })));
    expect(status).toBe(200);
    expect(body.sections).toHaveLength(3);
    expect(body.structure.kind).toBe("spec");
    expect(vi.mocked(detectCsiCodes).mock.calls[0][1]).toEqual({ context: { pageKind: "spec" } });
  });
});
