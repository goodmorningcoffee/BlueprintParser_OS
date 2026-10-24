// @vitest-environment node
// [classifier builder track 3 2026-10-24] /api/admin/classifiers (GET), /overlay (PUT), /preview (POST),
// /run (POST): auth (signed-out 401, member 403, admin / root ok), root company pick vs company-admin
// 403, the catalog from the models table, strict overlay validation (nothing stored on a rejected
// overlay), version bump + sibling pipelineConfig keys kept + audit row, a fitter-shaped overlay
// accepted, preview over a seeded page (proposals with contributions, verdict agreement, NO writes),
// demo refusal, the page cap, and run delegating to the reprocess stream.
import { describe, expect, inject, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/admin/classifiers/route";
import { PUT } from "@/app/api/admin/classifiers/overlay/route";
import { POST as PREVIEW } from "@/app/api/admin/classifiers/preview/route";
import { POST as RUN } from "@/app/api/admin/classifiers/run/route";
import { db } from "@/lib/db";
import { annotations, auditLog, companies, models, pages, projects } from "@/lib/db/schema";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { BUILT_IN_RECIPES, signalKey, type ClassifierProposal, type ClassifierRecipe } from "@/lib/classifier-engine";
import type { TextractWord } from "@/types";
import { asUser, createCompany, createPage, createProject, createUser, makeReq, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const schedules = BUILT_IN_RECIPES.find((r) => r.id === "schedules.v1")!;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const get = async (path = "/api/admin/classifiers") => readJson(await GET(makeReq(path, { method: "GET" })));
const put = async (body: unknown) => readJson(await PUT(makeReq("/api/admin/classifiers/overlay", { method: "PUT", body })));
const preview = async (body: unknown) => readJson(await PREVIEW(makeReq("/api/admin/classifiers/preview", { method: "POST", body })));

async function world(seed: Record<string, unknown> = { __sentinel: { keep: "me" } }) {
  const company = await createCompany({ pipelineConfig: seed as never });
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const project = await createProject(company.id, admin.id, { status: "completed" });
  return { company, admin, member, project };
}

async function pipelineConfig(companyId: number) {
  const [row] = await db.select({ pc: companies.pipelineConfig }).from(companies).where(eq(companies.id, companyId));
  return row.pc as Record<string, any>;
}

const word = (text: string, x: number, y: number, h = 0.012): TextractWord => ({ text, confidence: 99, bbox: [x, y, text.length * 0.007, h] });

/** A door schedule in a detector table box on an A sheet (the engine test's fixture, stored the way yolo/load stores it). */
async function seedDoorPage(projectId: number, pageNumber = 3) {
  const words: TextractWord[] = [word("DOOR", 0.52, 0.19, 0.018), word("SCHEDULE", 0.57, 0.19, 0.018)];
  ["DOOR", "NO", "FRAME", "HDWR", "RATING", "SIZE"].forEach((t, i) => words.push(word(t, 0.51 + i * 0.07, 0.22)));
  for (let r = 0; r < 8; r++) words.push(word(`10${r}`, 0.51, 0.25 + r * 0.02), word("HM", 0.58, 0.25 + r * 0.02), word("WD", 0.65, 0.25 + r * 0.02), word("PR", 0.72, 0.25 + r * 0.02), word("90 MIN", 0.8, 0.25 + r * 0.02));
  const detections = [
    { name: "tables", modelName: "yolo_medium", confidence: 0.9, minX: 0.5, minY: 0.21, maxX: 0.9, maxY: 0.45 },
    { name: "title_block", modelName: "yolo_medium", confidence: 0.9, minX: 0.92, minY: 0.0, maxX: 1, maxY: 1 },
  ];
  const regionsV2 = classifyRegionsV2({ pageNumber, detections, textractData: { words }, csiCodes: [] });
  const page = await createPage(projectId, pageNumber, {
    drawingNumber: "A-601", textractData: { words } as never, csiCodes: [] as never,
    pageIntelligence: { regionsV2, keep: "me" } as never,
  });
  for (const d of detections) {
    await db.insert(annotations).values({ projectId, pageNumber, name: d.name, minX: d.minX, minY: d.minY, maxX: d.maxX, maxY: d.maxY, source: "yolo", data: { confidence: d.confidence, modelName: d.modelName } as never });
  }
  return { page, regionsV2 };
}

describe.skipIf(!dbUp)("GET /api/admin/classifiers", () => {
  it("auth: signed-out 401, member 403, admin 200 with built-ins, effective, overlay and the catalog", async () => {
    const { company, admin, member } = await world();
    signedOut();
    expect((await get()).status).toBe(401);
    asUser(member);
    expect((await get()).status).toBe(403);
    await db.insert(models).values({ companyId: company.id, name: "acme-yolo", type: "yolo", s3Path: "models/acme", config: { classes: ["tables", "door_tag"], confidence: 0.3, iou: 0.5, imageSize: 1024 } as never });
    asUser(admin);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.companyId).toBe(company.id);
    expect(body.builtIns.map((r: ClassifierRecipe) => r.id)).toEqual(BUILT_IN_RECIPES.map((r) => r.id));
    expect(body.effective).toEqual(body.builtIns);
    expect(body.overlay).toBeNull();
    expect(body.catalog.models).toEqual([{ id: expect.any(Number), name: "acme-yolo", classes: ["tables", "door_tag"], shared: false }]);
    expect(body.catalog.signalTypes.map((t: { type: string }) => t.type)).toEqual(["words", "csi", "sheet", "yolo", "structure", "textract-table", "shapes", "zone", "channel"]);
    expect(body.catalog.scopes).toContain("header");
    expect(body.vocabulary.kinds.some((k: { id: string }) => k.id === "door")).toBe(true);
  });

  it("root may pick another company; a company admin naming another company gets 403", async () => {
    const a = await world({ classifiers: { custom: [], patches: { "schedules.v1": { version: 9, classBias: { door: -1 } } } } });
    const b = await world();
    const root = await createUser(b.company.id, { role: "admin", isRootAdmin: true });
    asUser(root);
    const own = await get();
    expect(own.body.companyId).toBe(b.company.id);
    const picked = await get(`/api/admin/classifiers?companyId=${a.company.id}`);
    expect(picked.status).toBe(200);
    expect(picked.body.companyId).toBe(a.company.id);
    expect(picked.body.effective.find((r: ClassifierRecipe) => r.id === "schedules.v1").classes.find((c: { id: string }) => c.id === "door").bias).toBe(-1);
    expect(picked.body.effective[0].version).toBe(9);
    asUser(a.admin);
    expect((await get(`/api/admin/classifiers?companyId=${b.company.id}`)).status).toBe(403);
  });
});

describe.skipIf(!dbUp)("PUT /api/admin/classifiers/overlay", () => {
  it("rejects an invalid overlay with 400 and stores nothing; member 403", async () => {
    const { company, admin, member } = await world();
    asUser(member);
    expect((await put({ overlay: { custom: [], patches: {} } })).status).toBe(403);
    asUser(admin);
    const bad = await put({ overlay: { patches: { "schedules.v1": { version: 1, signals: { "door.nothing": { weight: 2 } } } } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/does not exist/);
    expect((await put({})).status).toBe(400);
    expect((await put({ overlay: { custom: [{ id: "x" }] } })).status).toBe(400);
    const pc = await pipelineConfig(company.id);
    expect(pc.classifiers).toBeUndefined();
    expect(pc.__sentinel).toEqual({ keep: "me" });
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.companyId, company.id), eq(auditLog.action, "admin.classifiers.overlay_put")));
    expect(row).toBeUndefined();
  });

  it("stores a validated overlay with a version bump, keeps sibling keys, audits, and GET reflects it", async () => {
    const { company, admin } = await world();
    asUser(admin);
    const patch = { version: 0, classBias: { door: -2 }, signals: { [signalKey("door", "header")]: { weight: 4, spec: { type: "words", where: "header", terms: { "DOOR SCHEDULE": 2 } } } }, removed: [signalKey("door", "neg")] };
    const first = await put({ overlay: { custom: [], patches: { "schedules.v1": patch } } });
    expect(first.status).toBe(200);
    expect(first.body.versions).toEqual({ "schedules.v1": schedules.version + 1 });
    const pc = await pipelineConfig(company.id);
    expect(pc.__sentinel).toEqual({ keep: "me" });
    expect(pc.classifiers.patches["schedules.v1"]).toMatchObject({ ...patch, version: schedules.version + 1 });
    expect(pc.classifiers.updatedBy).toBe(admin.id);
    const door = first.body.effective.find((r: ClassifierRecipe) => r.id === "schedules.v1").classes.find((c: { id: string }) => c.id === "door");
    expect(door.bias).toBe(-2);
    expect(door.signals.find((s: { id: string }) => s.id === "header")).toMatchObject({ weight: 4, spec: { terms: { "DOOR SCHEDULE": 2 } } });
    expect(door.signals.some((s: { id: string }) => s.id === "neg")).toBe(false);
    // same content again → version unchanged; changed content → +1
    expect((await put({ overlay: { custom: [], patches: { "schedules.v1": { ...patch, version: 42 } } } })).body.versions["schedules.v1"]).toBe(schedules.version + 1);
    expect((await put({ overlay: { custom: [], patches: { "schedules.v1": { ...patch, classBias: { door: -1 } } } } })).body.versions["schedules.v1"]).toBe(schedules.version + 2);
    const shown = await get();
    expect(shown.body.overlay.patches["schedules.v1"].version).toBe(schedules.version + 2);
    expect(shown.body.effective[0].version).toBe(schedules.version + 2);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.companyId, company.id), eq(auditLog.action, "admin.classifiers.overlay_put"))).orderBy(desc(auditLog.id)).limit(1);
    expect(audit).toBeDefined();
    expect(audit.userId).toBe(admin.id);
    expect(audit.details).toMatchObject({ patched: ["schedules.v1"], custom: [] });
  });

  it("accepts a bare fitter-shaped overlay (feature-keyed weights) and a custom recipe", async () => {
    const { company, admin } = await world();
    asUser(admin);
    const custom = { ...clone(schedules), id: "acme.schedules", version: 1, source: "custom" };
    const r = await put({ patches: { "schedules.v1": { version: 1, signals: { "detect.structure": { weight: 5.5 }, "door.csiDiv": { weight: 1.9 } }, classBias: { door: -2.8 } } }, custom: [custom] });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("merge");
    expect(r.body.versions).toEqual({ "schedules.v1": schedules.version + 1, "acme.schedules": 1 });
    const pc = await pipelineConfig(company.id);
    expect(pc.classifiers.patches["schedules.v1"].signals["detect.structure"]).toEqual({ weight: 5.5 });
    expect(pc.classifiers.custom[0]).toMatchObject({ id: "acme.schedules", source: "custom", version: 1 });
    expect(r.body.effective.map((x: ClassifierRecipe) => x.id)).toEqual(["schedules.v1", "regions.v1", "acme.schedules"]);
  });

  it("a bare overlay MERGES by recipe id (other patches and custom recipes survive); { overlay } REPLACES; merge: overrides", async () => {
    const { company, admin } = await world();
    asUser(admin);
    const custom = { ...clone(schedules), id: "acme.schedules", version: 1, source: "custom" };
    expect((await put({ overlay: { custom: [custom], patches: { "schedules.v1": { version: 1, classBias: { door: -2 } }, "regions.v1": { version: 1, enabled: false } } } })).status).toBe(200);
    // fitter: only the recipe it fitted
    const fit = await put({ patches: { "schedules.v1": { version: 1, signals: { "door.header": { weight: 4.4 } } } } });
    expect(fit.status).toBe(200);
    expect(fit.body.mode).toBe("merge");
    let pc = await pipelineConfig(company.id);
    expect(pc.classifiers.patches["schedules.v1"]).toMatchObject({ signals: { "door.header": { weight: 4.4 } }, version: schedules.version + 2 });
    expect(pc.classifiers.patches["schedules.v1"].classBias).toBeUndefined();
    expect(pc.classifiers.patches["regions.v1"]).toMatchObject({ enabled: false });
    expect(pc.classifiers.custom.map((r: ClassifierRecipe) => r.id)).toEqual(["acme.schedules"]);
    // the tab: whole replace
    expect((await put({ overlay: { custom: [], patches: { "regions.v1": { version: 1, enabled: false } } } })).body.mode).toBe("replace");
    pc = await pipelineConfig(company.id);
    expect(pc.classifiers.patches["schedules.v1"]).toBeUndefined();
    expect(pc.classifiers.custom).toEqual([]);
    // explicit merge with the tab shape; explicit replace with the bare shape
    expect((await put({ overlay: { custom: [custom], patches: {} }, merge: true })).body.mode).toBe("merge");
    pc = await pipelineConfig(company.id);
    expect(pc.classifiers.patches["regions.v1"]).toMatchObject({ enabled: false });
    expect(pc.classifiers.custom).toHaveLength(1);
    expect((await put({ patches: {}, merge: false })).body.mode).toBe("replace");
    pc = await pipelineConfig(company.id);
    expect(pc.classifiers).toMatchObject({ custom: [], patches: {} });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.companyId, company.id), eq(auditLog.action, "admin.classifiers.overlay_put"))).orderBy(desc(auditLog.id)).limit(1);
    expect(audit.details).toMatchObject({ mode: "replace" });
  });

  it("rejects a deep spec error (bad scope name) and a custom recipe with a null candidate, storing nothing", async () => {
    const { company, admin } = await world();
    asUser(admin);
    const bad = await put({ overlay: { patches: { "schedules.v1": { version: 1, signals: { "door.header": { spec: { type: "words", where: "nowhere", terms: { DOOR: 1 } } } } } } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/where must be one of/);
    const custom = { ...clone(schedules), id: "acme.schedules", version: 1, candidates: [null] };
    expect((await put({ custom: [custom] })).body.error.message).toMatch(/candidates\[0\]/);
    expect((await pipelineConfig(company.id)).classifiers).toBeUndefined();
  });
});

describe.skipIf(!dbUp)("POST /api/admin/classifiers/preview", () => {
  it("validates, refuses demo and other companies, and writes nothing", async () => {
    const { admin, member, project } = await world();
    const other = await world();
    asUser(member);
    expect((await preview({ projectId: project.publicId, pages: [1], recipe: schedules })).status).toBe(403);
    asUser(admin);
    expect((await preview({ projectId: project.publicId, pages: [], recipe: schedules })).status).toBe(400);
    expect((await preview({ projectId: project.publicId, pages: Array.from({ length: 21 }, (_, i) => i + 1), recipe: schedules })).status).toBe(400);
    expect((await preview({ projectId: project.publicId, pages: [1], recipe: { id: "x" } })).status).toBe(400);
    expect((await preview({ projectId: "nope", pages: [1], recipe: schedules })).status).toBe(404);
    expect((await preview({ projectId: other.project.publicId, pages: [1], recipe: schedules })).status).toBe(404);
    await publishDemoFixture(project.id);
    const demo = await preview({ projectId: project.publicId, pages: [1], recipe: schedules });
    expect(demo.status).toBe(403);
    expect(demo.body.error.message).toBe("Demo projects are read-only");
  });

  it("dry-runs the draft on seeded pages: proposals with contributions, stored-vs-draft counts, verdict agreement, no writes", async () => {
    const { admin, project } = await world();
    asUser(admin);
    const { page, regionsV2 } = await seedDoorPage(project.id, 3);
    const built = await preview({ projectId: project.publicId, pages: [3, 4, 9], recipe: schedules });
    expect(built.status).toBe(200);
    expect(built.body.summary).toMatchObject({ pagesRun: 1, pagesWithYolo: 1, proposals: 1, storedProposals: 0, verdicts: 0 });
    const [pg] = built.body.pages;
    expect(pg.pageNumber).toBe(3);
    expect(pg.errors).toEqual([]);
    const [p] = pg.proposals as ClassifierProposal[];
    expect(p).toMatchObject({ recipeId: "schedules.v1", classId: "door", displayName: "Door schedule", regionId: regionsV2.regions[0].id });
    expect(p.nameWhy.length).toBeGreaterThan(0);
    expect(p.nameWhy[0]).toMatchObject({ signalId: expect.stringMatching(/^door\./), delta: expect.any(Number) });
    expect(built.body.agreement.rows).toEqual([]);

    // a verdict on the stored proposal id: the draft (door disabled → falls back) now disagrees with "accept door"
    const verdict = { proposalId: p.id, recipeId: "schedules.v1", recipeVersion: schedules.version, verdict: "accept", features: p.features, proposedClassId: "door", userId: admin.id, at: "2026-10-24T00:00:00.000Z" };
    await db.update(pages).set({ pageIntelligence: { regionsV2, keep: "me", classifierProposals: { engineVersion: "clf/0.1", recipes: { "schedules.v1": schedules.version }, proposals: [p] }, proposalVerdicts: { [p.id]: verdict } } as never }).where(eq(pages.id, page.id));
    const before = await db.select({ pi: pages.pageIntelligence, td: pages.textractData }).from(pages).where(eq(pages.id, page.id));
    const draft = clone(schedules);
    draft.classes = draft.classes.filter((c) => c.id !== "door");
    const changed = await preview({ projectId: project.publicId, pages: [3], recipe: draft });
    expect(changed.status).toBe(200);
    expect(changed.body.summary).toMatchObject({ storedProposals: 1, verdicts: 1 });
    expect(changed.body.pages[0].storedCount).toBe(1);
    expect(changed.body.agreement.rows).toEqual([{ classId: "door", name: "Door schedule", labeled: 1, agree: 0, disagree: 1, notProposed: 0 }]);
    expect(changed.body.agreement.totals).toEqual({ labeled: 1, agree: 0, disagree: 1, notProposed: 0 });
    const agree = await preview({ projectId: project.publicId, pages: [3], recipe: schedules });
    expect(agree.body.agreement.rows[0]).toMatchObject({ classId: "door", agree: 1, disagree: 0 });
    // a reject label agrees only when the draft no longer proposes the box
    await db.update(pages).set({ pageIntelligence: { regionsV2, keep: "me", proposalVerdicts: { [p.id]: { ...verdict, verdict: "reject" } } } as never }).where(eq(pages.id, page.id));
    expect((await preview({ projectId: project.publicId, pages: [3], recipe: schedules })).body.agreement.rows[0]).toMatchObject({ classId: "rejected", labeled: 1, disagree: 1 });
    const strict = clone(schedules);
    strict.detect.threshold = 0.999;
    expect((await preview({ projectId: project.publicId, pages: [3], recipe: strict })).body.agreement.rows[0]).toMatchObject({ classId: "rejected", agree: 1 });
    // NO writes: page rows and project intelligence are byte-identical to before the previews
    await db.update(pages).set({ pageIntelligence: before[0].pi }).where(eq(pages.id, page.id));
    const snap = await db.select({ pi: pages.pageIntelligence, td: pages.textractData }).from(pages).where(eq(pages.id, page.id));
    await preview({ projectId: project.publicId, pages: [3], recipe: draft });
    const after = await db.select({ pi: pages.pageIntelligence, td: pages.textractData }).from(pages).where(eq(pages.id, page.id));
    expect(after).toEqual(snap);
    const [proj] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
    expect(proj.pi ?? null).toBeNull();
  });
});

describe.skipIf(!dbUp)("POST /api/admin/classifiers/run", () => {
  const run = (body: unknown) => RUN(makeReq("/api/admin/classifiers/run", { method: "POST", body }));

  it("member 403, unknown / other-company 404, demo 403, else the reprocess NDJSON stream for that one project", async () => {
    const { admin, member, project, company } = await world();
    const other = await world();
    asUser(member);
    expect((await run({ projectId: project.publicId })).status).toBe(403);
    asUser(admin);
    expect((await readJson(await run({}))).status).toBe(400);
    expect((await run({ projectId: "nope" })).status).toBe(404);
    expect((await run({ projectId: other.project.publicId })).status).toBe(404);
    expect((await run({ projectId: other.project.publicId, companyId: other.company.id })).status).toBe(403);
    await seedDoorPage(project.id, 1);
    const res = await run({ projectId: project.publicId });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/ndjson/);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "start", projects: 1 });
    expect(lines.at(-1)).toMatchObject({ type: "done", total: 1, updated: 1, proposals: 1 });
    const [pg] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, 1)));
    expect((pg.pi as any).classifierProposals.proposals[0].classId).toBe("door");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.companyId, company.id), eq(auditLog.action, "admin.classifiers.run")));
    expect(audit.details).toMatchObject({ projectPublicId: project.publicId });
    await publishDemoFixture(project.id);
    expect((await run({ projectId: project.publicId })).status).toBe(403);
  });
});
