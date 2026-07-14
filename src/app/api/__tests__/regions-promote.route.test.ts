// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION — POST /api/regions/promote (Stage 4 generic commit).
// P1.3 family 7/7 (the LAST core family). No P0.3 char file existed → this file IS the freeze.
//
// Freezes: validate-before-auth ordering + the two field-400 messages; the dual-accept resolution
// (publicId wins) with sanctioned diffs D/E (non-uuid / non-int → 400); the demo-WRITE 403 gate
// (admin/root pass, demo/member blocked); the Parser Save vs Classifier Accept binder dispatch
// (LTWH→MinMax bbox conversion ONLY on the Classifier path; the 3-way grid-present guard; the
// type==="notes" parseNotesFromRegion fallback; the spec branch); the regionCsiTags seed +
// `.length === 0` auto-detect suppression + the two non-fatal CSI try/catches; the `.map`
// replace-in-place upsert; source="user"/confidence=0.85; headerText-wins-over-defaultTableName;
// inferCategory; the UNCONDITIONAL out-of-tx summaries recompute with an inner swallow; and the
// HEADLINE sanctioned diff B — the five functional throws that legacy returned at 500-with-message
// now return TYPED 4xx (NOT_FOUND/VALIDATION) with the message preserved BYTE-EXACT, plus the
// generic leak-drop (an unexpected throw → generic INTERNAL 500, no leak).
//
// The binders + CSI detectors + computeProjectSummaries + mergeCsiCodes are MOCKED so the route's
// WIRING (not their internals) is what's frozen. db.transaction runs against the real test DB.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/project-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/project-analysis")>();
  return { ...orig, computeProjectSummaries: vi.fn() };
});
vi.mock("@/lib/csi-utils", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-utils")>();
  return { ...orig, mergeCsiCodes: vi.fn() };
});
vi.mock("@/lib/text-region-classifier", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/text-region-classifier")>();
  return { ...orig, parseNotesFromRegion: vi.fn() };
});
vi.mock("@/lib/specnote-parser", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/specnote-parser")>();
  return { ...orig, bindSpecSectionsInRegion: vi.fn() };
});
vi.mock("@/lib/csi-detect", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-detect")>();
  return { ...orig, detectCsiFromGrid: vi.fn(), detectCsiCodes: vi.fn() };
});

import { POST } from "@/app/api/regions/promote/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { parseNotesFromRegion } from "@/lib/text-region-classifier";
import { bindSpecSectionsInRegion } from "@/lib/specnote-parser";
import { detectCsiFromGrid, detectCsiCodes } from "@/lib/csi-detect";
import { asUser, createPage, createUser, createWorld, makeReq, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const req = (body: unknown) => POST(makeReq("/api/regions/promote", { method: "POST", body }));

/** Read back the persisted page state (after the tx). */
const pageState = async (pageId: number) => {
  const [r] = await db
    .select({ pi: pages.pageIntelligence, csi: pages.csiCodes })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  const pi = (r?.pi ?? {}) as Record<string, any>;
  return { pi, csi: (r?.csi ?? []) as any[], regions: (pi.parsedRegions ?? []) as any[] };
};

/** A page seeded with one Classifier-detected textRegion (LTWH bbox; populated grid by default). */
const textRegion = (over: Record<string, any> = {}) => ({
  id: "tr-1",
  bbox: [10, 20, 100, 40], // LTWH → MinMax [10,20,110,60]
  headerText: "Door Schedule",
  grid: { headers: ["Mark", "Type"], rows: [{ Mark: "D1", Type: "Door" }], rowBoundaries: [0, 1], colBoundaries: [0, 1] },
  ...over,
});

const PARSER_SAVE = { bbox: [0.1, 0.2, 0.3, 0.4], data: { tableName: "Room Schedule", foo: 1 } };

beforeEach(() => {
  vi.mocked(mergeCsiCodes).mockReset().mockImplementation((e: any, i: any) => [...(e ?? []), ...(i ?? [])]);
  vi.mocked(computeProjectSummaries).mockReset().mockResolvedValue(null as any);
  vi.mocked(parseNotesFromRegion).mockReset();
  vi.mocked(bindSpecSectionsInRegion).mockReset();
  vi.mocked(detectCsiFromGrid).mockReset().mockReturnValue([] as any);
  vi.mocked(detectCsiCodes).mockReset().mockReturnValue([] as any);
});

describe.skipIf(!dbUp)("POST /api/regions/promote", () => {
  // ── happy paths ─────────────────────────────────────────────────────────────
  it("Parser Save: overrides.{data,bbox} + stable regionId → 200, bbox VERBATIM, source/confidence frozen", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { csiCodes: [{ code: "01" }] as any });
    asUser(user);
    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", overrides: { ...PARSER_SAVE, regionId: "r-stable" } }),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summaries).toBeNull();
    expect(body.parsedRegion).toMatchObject({
      id: "r-stable",
      type: "schedule",
      bbox: [0.1, 0.2, 0.3, 0.4], // Parser Save: NO LTWH→MinMax conversion
      source: "user",
      confidence: 0.85,
    });
    expect(body.parsedRegion.sourceTextRegionId).toBeUndefined(); // absent on Parser Save path
    expect(body.parsedRegion.data).toEqual({ tableName: "Room Schedule", foo: 1 }); // opaque data round-trips field-for-field
    expect(body.updatedIntelligence.parsedRegions).toHaveLength(1); // response carries the merged intelligence (the field clients adopt)
    const st = await pageState(page.id);
    expect(st.regions).toHaveLength(1);
    expect(st.regions[0].id).toBe("r-stable");
    expect(st.regions[0].data).toEqual({ tableName: "Room Schedule", foo: 1 });
  });

  it("pageIntelligence sibling fields survive the promote write (the ...currentIntel spread)", async () => {
    const { user, project } = await createWorld();
    // Parser Save path never enters the textRegion lookup → these siblings are pure bystander state.
    const page = await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [{ id: "keep-tr" }], rejectedTextRegionIds: ["x"], customKey: 42 } as any,
    });
    asUser(user);
    await req({ publicId: project.publicId, pageNumber: 1, type: "legend", overrides: { bbox: [0, 0, 1, 1], data: { a: 1 }, regionId: "sib" } });
    const st = await pageState(page.id);
    expect(st.pi.textRegions).toEqual([{ id: "keep-tr" }]); // sibling key preserved
    expect(st.pi.rejectedTextRegionIds).toEqual(["x"]);
    expect(st.pi.customKey).toBe(42);
    expect(st.pi.parsedRegions).toHaveLength(1); // new region added alongside
  });

  it("Classifier Accept (populated grid): LTWH→MinMax bbox, sourceTextRegionId echoed, tagColumn=headers[0], parseNotesFromRegion NOT called", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion()] } as any });
    asUser(user);
    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "r1" } }),
    );
    expect(status).toBe(200);
    expect(body.parsedRegion.bbox).toEqual([10, 20, 110, 60]); // LTWH→MinMax
    expect(body.parsedRegion.sourceTextRegionId).toBe("tr-1");
    expect(body.parsedRegion.data.tagColumn).toBe("Mark");
    expect(body.parsedRegion.data.rowCount).toBe(1);
    expect(body.parsedRegion.data.columnCount).toBe(2);
    expect(parseNotesFromRegion).not.toHaveBeenCalled(); // grid present → no fallback
    expect(body.updatedIntelligence.parsedRegions[0].id).toBe("r1"); // response carries updatedIntelligence
    const st = await pageState(page.id);
    expect(st.regions).toHaveLength(1);
  });

  it("grid guard: empty-HEADERS grid (type=notes) is treated as absent → parseNotesFromRegion fallback", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [textRegion({ grid: { headers: [], rows: [{ a: "1" }] } })] } as any,
      textractData: { lines: [], words: [] } as any,
    });
    vi.mocked(parseNotesFromRegion).mockReturnValue({ headers: ["N"], rows: [{ N: "v" }] } as any);
    asUser(user);
    const { status } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", sourceTextRegionId: "tr-1", overrides: { regionId: "eh" } }));
    expect(status).toBe(200);
    expect(parseNotesFromRegion).toHaveBeenCalledTimes(1); // empty headers ⇒ 3-way guard false ⇒ fallback
  });

  it("grid guard: empty-ROWS grid (type=keynote, no fallback) → 400 'Could not bind grid …'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion({ grid: { headers: ["A"], rows: [] } })] } as any });
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "keynote", sourceTextRegionId: "tr-1" }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Could not bind grid from textRegion — try the Parser Manual mode instead" });
  });

  it("Classifier Accept (notes fallback): type=notes + no grid + textractData → parseNotesFromRegion(td, ORIGINAL LTWH bbox)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [textRegion({ grid: undefined })] } as any,
      textractData: { lines: [], words: [] } as any,
    });
    vi.mocked(parseNotesFromRegion).mockReturnValue({ headers: ["Note"], rows: [{ Note: "x" }] } as any);
    asUser(user);
    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "notes", sourceTextRegionId: "tr-1", overrides: { regionId: "rn" } }),
    );
    expect(status).toBe(200);
    expect(parseNotesFromRegion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(parseNotesFromRegion).mock.calls[0][1]).toEqual([10, 20, 100, 40]); // ORIGINAL LTWH, not converted
    expect(body.parsedRegion.data.headers).toEqual(["Note"]);
  });

  it("Spec branch (happy): bindSpecSectionsInRegion → SpecData {sections}; tableName = headerText (wins over defaultTableName)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [textRegion({ headerText: "Div 23 Specs" })] } as any,
      textractData: { lines: [], words: [] } as any,
    });
    vi.mocked(bindSpecSectionsInRegion).mockReturnValue({ sections: [{ sectionHeader: "23 00 00", body: "HVAC" }] } as any);
    asUser(user);
    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "spec", sourceTextRegionId: "tr-1", overrides: { regionId: "rs" } }),
    );
    expect(status).toBe(200);
    expect(body.parsedRegion.data.sections).toHaveLength(1);
    expect(body.parsedRegion.data.tableName).toBe("Div 23 Specs"); // headerText WINS
  });

  // ── upsert ──────────────────────────────────────────────────────────────────
  it("Upsert: same regionId REPLACES in place (length 1); a new regionId appends (length 2, order preserved)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    await req({ publicId: project.publicId, pageNumber: 1, type: "legend", overrides: { ...PARSER_SAVE, regionId: "r-up", data: { tableName: "v1" } } });
    await req({ publicId: project.publicId, pageNumber: 1, type: "legend", overrides: { ...PARSER_SAVE, regionId: "r-up", data: { tableName: "v2" } } });
    let st = await pageState(page.id);
    expect(st.regions).toHaveLength(1); // replaced, not duplicated
    expect(st.regions[0].data.tableName).toBe("v2");
    await req({ publicId: project.publicId, pageNumber: 1, type: "legend", overrides: { ...PARSER_SAVE, regionId: "r-new", data: { tableName: "v3" } } });
    st = await pageState(page.id);
    expect(st.regions).toHaveLength(2);
    expect(st.regions.map((r) => r.id)).toEqual(["r-up", "r-new"]); // order preserved
  });

  it("Fresh regionId (no overrides.regionId): appended; id startsWith 'parsed-'", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    await req({ publicId: project.publicId, pageNumber: 1, type: "keynote", overrides: { bbox: [0, 0, 1, 1], data: { a: 1 } } });
    const st = await pageState(page.id);
    expect(st.regions).toHaveLength(1);
    expect(st.regions[0].id).toMatch(/^parsed-/);
  });

  // ── CSI seed / suppression / merge / non-fatal ────────────────────────────────
  it("CSI suppression: non-empty overrides.csiTags suppresses auto-detect; explicit [] does NOT", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion()] } as any });
    asUser(user);
    await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "a", csiTags: [{ code: "23", description: "d" }] } });
    expect(detectCsiFromGrid).not.toHaveBeenCalled(); // non-empty seed suppresses

    await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "b", csiTags: [] } });
    expect(detectCsiFromGrid).toHaveBeenCalledTimes(1); // explicit [] does NOT suppress
  });

  it("CSI merge wiring (grid path): mergeCsiCodes(existingCsi, regionCsiTags) → DB csiCodes reflects merge", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [textRegion()] } as any,
      csiCodes: [{ code: "01" }] as any,
    });
    asUser(user);
    const { body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "c", csiTags: [{ code: "23", description: "d" }] } }),
    );
    expect(mergeCsiCodes).toHaveBeenCalledWith([{ code: "01" }], [{ code: "23", description: "d" }]);
    expect(body.parsedRegion.csiTags).toEqual([{ code: "23", description: "d" }]);
    const st = await pageState(page.id);
    expect(st.csi).toEqual([{ code: "01" }, { code: "23", description: "d" }]); // mock concat
  });

  it("CSI auto-detect is NON-FATAL: detectCsiFromGrid throws → tx still commits, 200, csiTags stays []", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion()] } as any });
    vi.mocked(detectCsiFromGrid).mockImplementation(() => {
      throw new Error("csi boom");
    });
    asUser(user);
    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "d" } }),
    );
    expect(status).toBe(200);
    expect(body.parsedRegion.csiTags).toEqual([]);
    expect((await pageState(page.id)).regions).toHaveLength(1); // committed
  });

  it("CSI auto-detect (grid path): detectCsiFromGrid result reaches BOTH parsedRegion.csiTags AND mergeCsiCodes(2nd arg); detectCsiCodes NOT used", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion()] } as any, csiCodes: [{ code: "01" }] as any });
    vi.mocked(detectCsiFromGrid).mockReturnValue([{ code: "09", description: "grid" }] as any);
    asUser(user);
    const { body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "ad" } }), // no csiTags → auto-detect runs
    );
    expect(detectCsiCodes).not.toHaveBeenCalled(); // grid binder = detectCsiFromGrid, NOT detectCsiCodes
    expect(body.parsedRegion.csiTags).toEqual([{ code: "09", description: "grid" }]);
    expect(mergeCsiCodes).toHaveBeenCalledWith([{ code: "01" }], [{ code: "09", description: "grid" }]);
  });

  it("CSI auto-detect (spec path): detectCsiCodes(bodyText) drives tags; regionData.csiTags === parsedRegion.csiTags; detectCsiFromGrid NOT used", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [textRegion()] } as any,
      textractData: { lines: [], words: [] } as any,
      csiCodes: [{ code: "01" }] as any,
    });
    vi.mocked(bindSpecSectionsInRegion).mockReturnValue({ sections: [{ sectionHeader: "23 00 00", body: "HVAC" }] } as any);
    vi.mocked(detectCsiCodes).mockReturnValue([{ code: "23", description: "spec" }] as any);
    asUser(user);
    const { body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, type: "spec", sourceTextRegionId: "tr-1", overrides: { regionId: "sp" } }), // no csiTags → auto-detect runs
    );
    expect(detectCsiFromGrid).not.toHaveBeenCalled(); // spec binder = detectCsiCodes, NOT detectCsiFromGrid
    // [refactor jul9 P2-A C6, C1 approval 2026-07-09] detect is now 4-arg (config, db) — the
    // fixture company stored no csi config ⇒ config === undefined, db === builtin bundle.
    // bodyText join template still frozen (\n per section, \n\n between).
    expect(detectCsiCodes).toHaveBeenCalledWith(
      "23 00 00\nHVAC",
      undefined,
      undefined,
      expect.objectContaining({ entries: expect.any(Array), wordFrequency: expect.any(Map) }),
    );
    expect(body.parsedRegion.csiTags).toEqual([{ code: "23", description: "spec" }]);
    expect(body.parsedRegion.data.csiTags).toEqual([{ code: "23", description: "spec" }]); // SpecData mirrors the top-level tags
    expect(mergeCsiCodes).toHaveBeenCalledWith([{ code: "01" }], [{ code: "23", description: "spec" }]);
  });

  // ── category derivation ───────────────────────────────────────────────────────
  it("inferCategory: data.tableName → lowercase-dashed; absent → '${type}-region'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const a = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", overrides: { bbox: [0, 0, 1, 1], data: { tableName: "Room Schedule" }, regionId: "ca" } }));
    expect(a.body.parsedRegion.category).toBe("room-schedule");
    const b = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", overrides: { bbox: [0, 0, 1, 1], data: { other: 1 }, regionId: "cb" } }));
    expect(b.body.parsedRegion.category).toBe("schedule-region"); // no tableName
  });

  it("Classifier-path category derives from headerText (→ inferCategory via regionData.tableName)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion({ headerText: "Door Schedule" })] } as any });
    asUser(user);
    const { body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "ch" } }));
    expect(body.parsedRegion.data.tableName).toBe("Door Schedule");
    expect(body.parsedRegion.category).toBe("door-schedule");
  });

  it("defaultTableName fallback (Classifier path, NO headerText): notes→'Notes p.N', schedule(passthrough)→'schedule p.N'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion({ headerText: undefined })] } as any });
    asUser(user);
    const n = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", sourceTextRegionId: "tr-1", overrides: { regionId: "dn" } }));
    expect(n.body.parsedRegion.data.tableName).toBe("Notes p.1"); // notes → "Notes"
    const s = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "schedule", sourceTextRegionId: "tr-1", overrides: { regionId: "ds" } }));
    expect(s.body.parsedRegion.data.tableName).toBe("schedule p.1"); // passthrough label (lowercase type)
  });

  it("defaultTableName fallback (spec path, NO headerText) → 'Spec p.N'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion({ headerText: undefined })] } as any, textractData: { lines: [], words: [] } as any });
    vi.mocked(bindSpecSectionsInRegion).mockReturnValue({ sections: [{ sectionHeader: "h", body: "b" }] } as any);
    asUser(user);
    const { body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "spec", sourceTextRegionId: "tr-1", overrides: { regionId: "dsp" } }));
    expect(body.parsedRegion.data.tableName).toBe("Spec p.1"); // spec → "Spec"
  });

  // ── validation 400s (validate-before-auth) ────────────────────────────────────
  it("missing id/pageNumber/type → 400 VALIDATION (exact message)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    for (const bad of [
      { pageNumber: 1, type: "notes", overrides: PARSER_SAVE }, // no id
      { publicId: project.publicId, type: "notes", overrides: PARSER_SAVE }, // no pageNumber
      { publicId: project.publicId, pageNumber: 1, overrides: PARSER_SAVE }, // no type
    ]) {
      const { status, body } = await readJson(await req(bad));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "Missing projectId/publicId, pageNumber, or type" });
    }
  });

  it("missing sourceTextRegionId AND overrides.{data,bbox} → 400 VALIDATION (exact message)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    for (const ov of [undefined, { bbox: [0, 0, 1, 1] }, { data: { a: 1 } }]) {
      const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: ov }));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "Must provide either sourceTextRegionId OR overrides.{data,bbox}" });
    }
  });

  // ── sanctioned diffs D / E ─────────────────────────────────────────────────────
  it("diff D: non-uuid publicId → 400 'Invalid project id'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: "not-a-uuid", pageNumber: 1, type: "notes", overrides: PARSER_SAVE }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  it("diff E: non-integer dbId projectId → 400 'Invalid project id'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: "abc", pageNumber: 1, type: "notes", overrides: PARSER_SAVE }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  it("dual-ID: truthy publicId WINS over a bogus numeric projectId", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const { status } = await readJson(await req({ publicId: project.publicId, projectId: 999999, pageNumber: 1, type: "notes", overrides: PARSER_SAVE }));
    expect(status).toBe(200);
    expect((await pageState(page.id)).regions).toHaveLength(1);
  });

  // ── access matrix ──────────────────────────────────────────────────────────────
  it("signed-out on a REAL project → 401 UNAUTHORIZED", async () => {
    const { project } = await createWorld();
    signedOut();
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: PARSER_SAVE }));
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("cross-tenant → 404 NOT_FOUND (indistinguishable from missing)", async () => {
    const { project } = await createWorld();
    asUser(await createUser((await createWorld()).company.id));
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: PARSER_SAVE }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("L5 freeze: demo promote denies all roles before page or summary side effects", async () => {
    const { company, project } = await createWorld();
    const page = await createPage(project.id, 1);
    await publishDemoFixture(project.id);
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser((await createWorld()).company.id, { role: "admin", isRootAdmin: true });
    const statuses: number[] = [];
    for (const actor of [null, member, admin, root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push(
        (
          await readJson(
            await req({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: PARSER_SAVE }),
          )
        ).status,
      );
    }
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect((await pageState(page.id)).regions).toEqual([]);
    expect(computeProjectSummaries).not.toHaveBeenCalled();
  });

  // ── functional throws (SANCTIONED diff B: 500-with-message → typed 4xx, byte-exact message) ───────
  it("diff B: page-not-found → 404 NOT_FOUND 'Page not found'", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 9, type: "notes", overrides: PARSER_SAVE }));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Page not found" });
  });

  it("diff B: textRegion-not-found → 404 NOT_FOUND, message BYTE-EXACT (incl. U+2014 em-dash + interpolated id)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion()] } as any });
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", sourceTextRegionId: "tr-MISSING" }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("textRegion tr-MISSING not found — reload the page and try again");
  });

  it("diff B: no-grid (type=keynote, no grid, no notes-fallback) → 400 VALIDATION, message BYTE-EXACT", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion({ grid: undefined })] } as any });
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "keynote", sourceTextRegionId: "tr-1" }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Could not bind grid from textRegion — try the Parser Manual mode instead" });
  });

  it("diff B: spec no-OCR (type=spec, textractData null) → 400 VALIDATION 'Page has no OCR data for spec binding'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion()] } as any }); // no textractData
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "spec", sourceTextRegionId: "tr-1" }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Page has no OCR data for spec binding" });
  });

  it("diff B: spec no-headers (bindSpecSectionsInRegion → null) → 400 VALIDATION, message BYTE-EXACT", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [textRegion()] } as any,
      textractData: { lines: [], words: [] } as any,
    });
    vi.mocked(bindSpecSectionsInRegion).mockReturnValue(null as any);
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "spec", sourceTextRegionId: "tr-1" }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Could not detect spec section headers in region — try the Parser Manual mode instead" });
  });

  // ── summaries (UNCONDITIONAL, inner-swallow) ──────────────────────────────────
  it("summaries ALWAYS runs (even Parser Save, no pre-existing regions) and is returned", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    vi.mocked(computeProjectSummaries).mockResolvedValue({ totals: 7 } as any);
    asUser(user);
    const { body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: { ...PARSER_SAVE, regionId: "s1" } }));
    expect(computeProjectSummaries).toHaveBeenCalledWith(project.id, expect.anything());
    expect(body.summaries).toEqual({ totals: 7 });
  });

  it("summaries inner-swallow: computeProjectSummaries rejects → 200 + summaries:null; write still committed", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    vi.mocked(computeProjectSummaries).mockRejectedValue(new Error("recompute boom"));
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: { ...PARSER_SAVE, regionId: "s2" } }));
    expect(status).toBe(200);
    expect(body.summaries).toBeNull();
    expect((await pageState(page.id)).regions).toHaveLength(1); // committed despite the swallow
  });

  // ── leak-drop + body parsing (diffs C / F) ────────────────────────────────────
  it("diff C: an UNEXPECTED throw → generic 500 INTERNAL, no leaked detail", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    vi.mocked(mergeCsiCodes).mockImplementationOnce(() => {
      throw new Error("PG_SECRET constraint detail");
    });
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, type: "notes", overrides: { ...PARSER_SAVE, regionId: "x" } }));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("PG_SECRET");
  });

  it("diff F: malformed JSON body → 400 BAD_REQUEST", async () => {
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/regions/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("diff F: empty body → 400 VALIDATION", async () => {
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/regions/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  it("diff F: well-formed NON-OBJECT body (array / number) → 400 VALIDATION (zLooseBody z.record rejects, distinct from the empty short-circuit)", async () => {
    const { user } = await createWorld();
    asUser(user);
    for (const b of [[1, 2], 42]) {
      const raw = new Request("http://test.local/api/regions/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });
      const { status, body } = await readJson(await POST(raw));
      expect(status).toBe(400);
      expect(body.error.code).toBe("VALIDATION");
    }
  });
});
