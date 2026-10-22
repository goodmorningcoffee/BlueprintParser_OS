// @vitest-environment node
// [fix 2026-10-21 reprocess-persistence] DB-backed proof that the admin reprocess scopes WRITE
// to the database — and that a failure part-way through a project leaves the previous rows
// intact. Owner 2026-10-21: "basicly all the 'reprocess' tools in the admin need to be double
// checked that they write to the data base"; he ran Shape Parse over 40 projects and got
// "Done! 0 pages updated, 0 skipped" while the old code had already deleted every project's
// shape-parse annotations. Companion to the freeze file admin-reprocess.route.test.ts (same
// mock seams: Lambda fan-out, local python engine, S3, rasterizer).
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3Mocks = vi.hoisted(() => ({
  downloadFromS3: vi.fn(async () => Buffer.from("fake-bytes")),
  uploadToS3: vi.fn(async () => {}),
}));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadFromS3: s3Mocks.downloadFromS3,
  uploadToS3: s3Mocks.uploadToS3,
}));

const lambdaMocks = vi.hoisted(() => ({
  isLambdaCvEnabled: vi.fn(() => false),
  fanOutShapeParse: vi.fn(),
}));
vi.mock("@/lib/lambda-cv", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLambdaCvEnabled: lambdaMocks.isLambdaCvEnabled,
  fanOutShapeParse: lambdaMocks.fanOutShapeParse,
}));

type Extraction = { keynotes: unknown[]; warnings: string[]; failed?: true };
const keynotesMocks = vi.hoisted(() => ({
  extractKeynotes: vi.fn(async (): Promise<Extraction> => ({ keynotes: [], warnings: [] })),
}));
vi.mock("@/lib/keynotes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractKeynotes: keynotesMocks.extractKeynotes,
}));

import { POST } from "@/app/api/admin/reprocess/route";
import { db } from "@/lib/db";
import { annotations, models, pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { annotationsFor, asUser, createPage, createUser, createWorld, makeReq } from "@/test/harness";
import type { LambdaInvocationDiag } from "@/lib/lambda-cv";

const dbUp = inject("dbUp") as boolean;

async function drain(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const OLD_KEYNOTE = { shape: "circle", text: "OLD", bbox: [0.1, 0.1, 0.2, 0.2], contour: [] };
const NEW_KEYNOTE = { shape: "hexagon", text: "NEW", bbox: [0.5, 0.5, 0.6, 0.6], contour: [[0.5, 0.5]] };

/** A page that already has shape-parse results in BOTH stores (as upload leaves it). */
async function pageWithOldShapes(projectId: number, pageNumber: number) {
  const page = await createPage(projectId, pageNumber, { keynotes: [OLD_KEYNOTE] as never });
  await db.insert(annotations).values({
    name: "circle", minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2, pageNumber, threshold: 0.9,
    source: "shape-parse", projectId, data: { modelName: "shape-parse", shapeType: "circle", text: "OLD" } as never,
  });
  return page;
}

async function shapeRows(projectId: number, pageNumber: number) {
  return (await annotationsFor(projectId)).filter((a) => a.source === "shape-parse" && a.pageNumber === pageNumber);
}

const runShapeParse = (query = "") =>
  POST(makeReq(`/api/admin/reprocess?scope=shape-parse${query}`, { method: "POST" })).then(drain);

beforeEach(() => {
  vi.clearAllMocks();
  lambdaMocks.isLambdaCvEnabled.mockReturnValue(false);
  keynotesMocks.extractKeynotes.mockResolvedValue({ keynotes: [], warnings: [] });
});

describe.skipIf(!dbUp)("admin reprocess — shape-parse persists (compute-then-swap)", () => {
  it("OWNER SCENARIO: fan-out returns zero results with every page failed → NOT success; local fallback writes the page", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await pageWithOldShapes(project.id, 1);
    const key = `${project.dataUrl}/pages/page_0001.png`;
    lambdaMocks.isLambdaCvEnabled.mockReturnValue(true);
    lambdaMocks.fanOutShapeParse.mockResolvedValueOnce({
      results: [], okPages: [], failedPages: [key],
      pageErrors: { [key]: "AccessDeniedException: not authorized to perform lambda:InvokeFunction" }, warnings: [],
    });
    keynotesMocks.extractKeynotes.mockResolvedValueOnce({ keynotes: [NEW_KEYNOTE], warnings: [] });

    asUser(admin);
    const lines = await runShapeParse();

    const warning = lines.find((l) => l.type === "warning");
    expect(warning?.message).toBe(
      "Lambda could not scan 1/1 pages (first: AccessDeniedException: not authorized to perform lambda:InvokeFunction) — local fallback for those pages only",
    );
    expect(keynotesMocks.extractKeynotes).toHaveBeenCalledTimes(1);
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 0, empty: 0, failed: 0, total: 1 });
    const [row] = await db.select().from(pages).where(eq(pages.projectId, project.id));
    expect(row.keynotes).toEqual([NEW_KEYNOTE]);
    const rows = await shapeRows(project.id, 1);
    expect(rows.map((r) => (r.data as { text?: string }).text)).toEqual(["NEW"]);
  }, 30000);

  it("fan-out AND local fallback both fail → page counted failed, previous keynotes + annotations untouched", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await pageWithOldShapes(project.id, 1);
    const key = `${project.dataUrl}/pages/page_0001.png`;
    lambdaMocks.isLambdaCvEnabled.mockReturnValue(true);
    lambdaMocks.fanOutShapeParse.mockResolvedValueOnce({
      results: [], okPages: [], failedPages: [key], pageErrors: { [key]: "Lambda error: Task timed out after 120.00 seconds" }, warnings: [],
    });
    keynotesMocks.extractKeynotes.mockResolvedValueOnce({ keynotes: [], warnings: ["Extraction failed: python crashed"], failed: true });

    asUser(admin);
    const lines = await runShapeParse();

    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 0, skipped: 1, empty: 0, failed: 1, total: 1 });
    const [row] = await db.select().from(pages).where(eq(pages.projectId, project.id));
    expect(row.keynotes).toEqual([OLD_KEYNOTE]); // NOT nulled
    expect((await shapeRows(project.id, 1)).map((r) => (r.data as { text?: string }).text)).toEqual(["OLD"]); // NOT deleted
  }, 30000);

  it("a failure MID-PROJECT leaves that page's previous rows intact while the other pages are swapped", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await pageWithOldShapes(project.id, 1);
    await pageWithOldShapes(project.id, 2);
    await pageWithOldShapes(project.id, 3);
    keynotesMocks.extractKeynotes
      .mockResolvedValueOnce({ keynotes: [NEW_KEYNOTE], warnings: [] }) // page 1 → new shapes
      .mockResolvedValueOnce({ keynotes: [], warnings: ["Extraction failed: boom"], failed: true }) // page 2 → crash
      .mockResolvedValueOnce({ keynotes: [], warnings: [] }); // page 3 → confirmed empty

    asUser(admin);
    const lines = await runShapeParse();

    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 2, empty: 1, failed: 1, total: 3 });
    const byPage = new Map((await db.select().from(pages).where(eq(pages.projectId, project.id))).map((p) => [p.pageNumber, p]));
    expect(byPage.get(1)!.keynotes).toEqual([NEW_KEYNOTE]);
    expect(byPage.get(2)!.keynotes).toEqual([OLD_KEYNOTE]);
    expect(byPage.get(3)!.keynotes).toBeNull();
    expect((await shapeRows(project.id, 1)).map((r) => (r.data as { text?: string }).text)).toEqual(["NEW"]);
    expect((await shapeRows(project.id, 2)).map((r) => (r.data as { text?: string }).text)).toEqual(["OLD"]);
    expect(await shapeRows(project.id, 3)).toEqual([]);
  }, 30000);

  it("a page the fan-out CONFIRMED scanned with no shapes is cleared (keynotes NULL, rows removed) and counted empty", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await pageWithOldShapes(project.id, 1);
    const key = `${project.dataUrl}/pages/page_0001.png`;
    lambdaMocks.isLambdaCvEnabled.mockReturnValue(true);
    lambdaMocks.fanOutShapeParse.mockResolvedValueOnce({ results: [], okPages: [key], failedPages: [], pageErrors: {}, warnings: [] });

    asUser(admin);
    const lines = await runShapeParse();

    expect(lines.some((l) => l.type === "warning")).toBe(false);
    expect(keynotesMocks.extractKeynotes).not.toHaveBeenCalled();
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 0, skipped: 1, empty: 1, failed: 0, total: 1 });
    const [row] = await db.select().from(pages).where(eq(pages.projectId, project.id));
    expect(row.keynotes).toBeNull();
    expect(await shapeRows(project.id, 1)).toEqual([]);
  }, 30000);

  it("Debug (?trace=1) streams Lambda config, each invocation, and rows written per page; off by default", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, {});
    const key = `${project.dataUrl}/pages/page_0001.png`;
    lambdaMocks.isLambdaCvEnabled.mockReturnValue(true);
    lambdaMocks.fanOutShapeParse.mockImplementation(async (opts: { onInvocation?: (d: LambdaInvocationDiag) => void }) => {
      opts.onInvocation?.({
        action: "shape_parse", functionName: "beaver-cv-pipeline", batchIdx: 0, attempt: "batch",
        pages: ["page_0001.png"], ok: true, durationMs: 1234, lambdaStatus: "success",
        resultKey: "tmp/cv-jobs/j/results/batch_0.json", resultFound: true, resultCount: 1, reportedCount: 1,
        okPages: 1, failedPages: 0,
      });
      return {
        results: [{ ...NEW_KEYNOTE, pageS3Key: key }], okPages: [key], failedPages: [], pageErrors: {}, warnings: [],
      };
    });

    asUser(admin);
    const traced = await runShapeParse("&trace=1");
    const steps = traced.filter((l) => l.type === "debug").map((l) => l.step);
    expect(steps).toEqual(expect.arrayContaining(["run.start", "lambda.config", "lambda.fanout.start", "lambda.invoke", "lambda.fanout.done", "page.written"]));
    expect(traced.find((l) => l.step === "lambda.invoke")).toMatchObject({
      scope: "shape-parse", functionName: "beaver-cv-pipeline", lambdaStatus: "success", durationMs: 1234, resultFound: true,
    });
    expect(traced.find((l) => l.step === "page.written")).toMatchObject({ page: 1, engine: "lambda", shapes: 1, rowsInserted: 1 });
    expect(traced.some((l) => l.type === "heartbeat")).toBe(true); // keep-alive is always on
    expect(JSON.stringify(traced)).not.toContain(project.dataUrl); // no storage paths printed

    const plain = await runShapeParse();
    expect(plain.some((l) => l.type === "debug")).toBe(false);
  }, 30000);
});

describe.skipIf(!dbUp)("admin reprocess — other scopes persist", () => {
  it("full: CSI write re-applies the loaded models' CURRENT class config and drops stale YOLO-class codes", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const [model] = await db.insert(models).values({
      companyId: company.id, name: `doors-${project.id}`, type: "yolo", s3Path: "models/x.pt",
      config: { classCsiCodes: { door: ["08 11 13"] } } as never,
    }).returning();
    await db.insert(annotations).values({
      name: "door", minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2, pageNumber: 1, threshold: 0.5,
      source: "yolo", projectId: project.id, data: { modelId: model.id, modelName: model.name, confidence: 0.9 } as never,
    });
    const page = await createPage(project.id, 1, {
      textractData: { lines: [], words: [] } as never,
      rawText: "",
      csiCodes: [
        { code: "99 99 99", description: "stale text detection", trade: "t", division: "99" },
        { code: "08 71 00", description: "From YOLO class config", trade: "", division: "08" },
      ] as never,
    });

    asUser(admin);
    const lines = await drain(await POST(makeReq("/api/admin/reprocess", { method: "POST" })));
    expect(lines[lines.length - 1]).toMatchObject({ type: "done", updated: 1 });

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    const codes = (row.csiCodes ?? []).map((c) => c.code).sort();
    // [fix 2026-10-22 rerun-overwrite] "08 71 00" was stamped by a class config no loaded model
    // has any more: a rerun REPLACES, so it goes (it used to be kept forever — the CSI ratchet).
    expect(codes).toEqual(["08 11 13"]); // stale text code re-detected away; current YOLO codes applied
  }, 30000);

  it("page-names: a user-typed page name survives; the drawing number is still refreshed", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const page = await createPage(project.id, 1, {
      name: "Owner's renamed sheet", drawingNumber: "X-9", textractData: { lines: [], words: [] } as never,
    });

    asUser(admin);
    const lines = await drain(await POST(makeReq("/api/admin/reprocess?scope=page-names&trace=1", { method: "POST" })));
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 0, total: 1 });
    expect(lines.find((l) => l.step === "page.written")).toMatchObject({ page: 1, manualNameKept: true });

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect(row.name).toBe("Owner's renamed sheet");
    expect(row.drawingNumber).toBeNull();
  }, 30000);

  it("intelligence: writes pageIntelligence per page and the debug stream reports the keys written", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const page = await createPage(project.id, 1, { textractData: { lines: [], words: [] } as never, rawText: "" });

    asUser(admin);
    const lines = await drain(await POST(makeReq("/api/admin/reprocess?scope=intelligence&trace=1", { method: "POST" })));
    expect(lines[lines.length - 1]).toMatchObject({ type: "done", updated: 1 });
    expect(lines.find((l) => l.step === "page.written")).toMatchObject({ page: 1 });
    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect(row.pageIntelligence).not.toBeNull();
  }, 30000);
});
