// @vitest-environment node
// [fix 2026-10-22 annotation-cleanup] Owner 2026-10-22: "when we re-run things from the /admin
// panel we must not get duplicates … make sure they all OVERWRITE and don't bloat the database".
// Every admin rerun button that writes derived data is run TWICE here against the real test DB,
// and the second run must leave row counts and derived arrays exactly as the first left them.
// Audit: gitignore/projects/admin_data_tools/RERUN_AUDIT_2026-10-22.md (workspace, not repo).
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const keynotesMocks = vi.hoisted(() => ({
  extractKeynotes: vi.fn(async () => ({ keynotes: [] as unknown[], warnings: [] as string[] })),
}));
vi.mock("@/lib/keynotes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractKeynotes: keynotesMocks.extractKeynotes,
}));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadFromS3: vi.fn(async () => Buffer.from("fake-bytes")),
  uploadToS3: vi.fn(async () => {}),
}));
vi.mock("@/lib/lambda-cv", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLambdaCvEnabled: vi.fn(() => false),
}));

import { POST as reprocessPOST } from "@/app/api/admin/reprocess/route";
import { POST as reprocessCsiPOST } from "@/app/api/admin/models/reprocess-csi/route";
import { db } from "@/lib/db";
import { annotations, models, pages, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createPage, createUser, createWorld, makeReq } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const drain = async (res: Response) => (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const runScope = (scope: string) =>
  reprocessPOST(makeReq(`/api/admin/reprocess${scope ? `?scope=${scope}` : ""}`, { method: "POST" })).then(drain);

/** Everything a rerun could bloat, for one project. */
async function snapshot(projectId: number) {
  const pageRows = await db.select().from(pages).where(eq(pages.projectId, projectId)).orderBy(pages.id);
  const annRows = await db.select().from(annotations).where(eq(annotations.projectId, projectId)).orderBy(annotations.id);
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  return {
    pageRows: pageRows.length,
    annotationIds: annRows.map((a) => a.id),
    annotationData: annRows.map((a) => a.data),
    csiCodes: pageRows.map((p) => p.csiCodes),
    textAnnotations: pageRows.map((p) => p.textAnnotations),
    pageIntelligenceKeys: pageRows.map((p) => Object.keys((p.pageIntelligence ?? {}) as object).sort()),
    keynotes: pageRows.map((p) => p.keynotes),
    projectIntelligenceKeys: Object.keys((project.projectIntelligence ?? {}) as object).sort(),
  };
}

const KEYNOTE = { shape: "circle", text: "A1", bbox: [0.1, 0.1, 0.2, 0.2], contour: [] };

async function seededWorld() {
  const { company, project } = await createWorld();
  const admin = await createUser(company.id, { role: "admin" });
  const [model] = await db.insert(models).values({
    companyId: company.id, name: `doors-${project.id}`, type: "yolo", s3Path: "models/x.pt",
    config: { classCsiCodes: { door: ["08 11 13"] }, classKeywords: { door: ["door"] } } as never,
  }).returning();
  await db.insert(annotations).values([
    { name: "door", minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2, pageNumber: 1, threshold: 0.5, source: "yolo",
      projectId: project.id, data: { modelId: model.id, modelName: model.name, confidence: 0.9 } as never },
    { name: "my box", minX: 0.3, minY: 0.3, maxX: 0.4, maxY: 0.4, pageNumber: 1, threshold: 1, source: "user",
      projectId: project.id, data: { csiCodes: ["09 91 23"] } as never },
  ]);
  const rawText = "SECTION 08 11 13 HOLLOW METAL DOORS AND FRAMES. SEE 09 91 23 INTERIOR PAINTING. KEYNOTE A1";
  await createPage(project.id, 1, { textractData: { lines: [], words: [] } as never, rawText, drawingNumber: "A-101" });
  await createPage(project.id, 2, { textractData: { lines: [], words: [] } as never, rawText: "GENERAL NOTES", drawingNumber: "A-102" });
  return { company, project, admin, model };
}

beforeEach(() => {
  vi.clearAllMocks();
  keynotesMocks.extractKeynotes.mockResolvedValue({ keynotes: [KEYNOTE], warnings: [] });
});

describe.skipIf(!dbUp)("admin rerun buttons OVERWRITE — a second run changes nothing", () => {
  for (const scope of ["", "intelligence", "page-names", "shape-parse"]) {
    it(`reprocess scope=${scope || "full"} twice → identical rows and derived arrays`, async () => {
      const w = await seededWorld();
      asUser(w.admin);
      const first = await runScope(scope);
      expect(first[first.length - 1].type).toBe("done");
      const after1 = await snapshot(w.project.id);
      const second = await runScope(scope);
      expect(second[second.length - 1].type).toBe("done");
      const after2 = await snapshot(w.project.id);

      expect(after2.pageRows).toBe(2);
      expect(after2.annotationIds.length).toBe(after1.annotationIds.length);
      expect(after2.csiCodes).toEqual(after1.csiCodes);
      expect(after2.textAnnotations).toEqual(after1.textAnnotations);
      expect(after2.pageIntelligenceKeys).toEqual(after1.pageIntelligenceKeys);
      expect(after2.keynotes).toEqual(after1.keynotes);
      expect(after2.projectIntelligenceKeys).toEqual(after1.projectIntelligenceKeys);
      if (scope !== "shape-parse") expect(after2.annotationIds).toEqual(after1.annotationIds);
    }, 60000);
  }

  it("full reprocess run 3x: page CSI code count does not grow and has no duplicate codes", async () => {
    const w = await seededWorld();
    asUser(w.admin);
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await runScope("");
      const [p] = await db.select().from(pages).where(eq(pages.projectId, w.project.id)).orderBy(pages.pageNumber).limit(1);
      const codes = (p.csiCodes ?? []).map((c) => c.code.replace(/[\s.-]/g, ""));
      expect(new Set(codes).size).toBe(codes.length);
      counts.push(codes.length);
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(new Set(counts).size).toBe(1);
  }, 60000);

  it("CSI GROWTH ROOT CAUSE: a YOLO class code no longer in any loaded model's config is dropped by the full rerun", async () => {
    const w = await seededWorld();
    asUser(w.admin);
    await runScope("");
    // Owner edits the class→CSI mapping (CSI tab), then purges an old model's rows: the codes
    // those configs once stamped must not survive every later rerun.
    await db.update(models).set({ config: { classCsiCodes: { door: ["08 14 16"] } } as never }).where(eq(models.id, w.model.id));
    const [p1] = await db.select().from(pages).where(eq(pages.projectId, w.project.id)).orderBy(pages.pageNumber).limit(1);
    await db.update(pages).set({
      csiCodes: [...(p1.csiCodes ?? []), { code: "11 11 11", description: "From YOLO class config", trade: "", division: "11" }] as never,
    }).where(eq(pages.id, p1.id));
    await runScope("");
    await runScope("");
    const [p] = await db.select().from(pages).where(eq(pages.id, p1.id));
    const yoloCodes = (p.csiCodes ?? []).filter((c) => c.description === "From YOLO class config").map((c) => c.code);
    expect(yoloCodes).toEqual(["08 14 16"]);
  }, 60000);

  it("Reprocess YOLO Tags (models/reprocess-csi) twice → same rows, csiCodes not appended", async () => {
    const w = await seededWorld();
    asUser(w.admin);
    for (let i = 0; i < 2; i++) {
      const res = await reprocessCsiPOST(makeReq("/api/admin/models/reprocess-csi", { method: "POST", body: { modelId: w.model.id } }));
      expect(res.status).toBe(200);
    }
    const rows = await db.select().from(annotations).where(eq(annotations.projectId, w.project.id));
    expect(rows).toHaveLength(2);
    const yolo = rows.find((r) => r.source === "yolo")!;
    expect((yolo.data as { csiCodes: string[] }).csiCodes).toEqual(["08 11 13"]);
    expect((yolo.data as { keywords: string[] }).keywords).toEqual(["door"]);
  }, 30000);
});
