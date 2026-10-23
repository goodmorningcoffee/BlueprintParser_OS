// @vitest-environment node
// [feat 2026-10-23 page-permanent-delete] Admin › Data tools › Duplicates › Delete hidden pages
// permanently — DB-backed. Root only; the dry run lists exactly what the real run deletes and
// changes nothing; a page with user work / a twice-stored page / a page whose kept copy is gone
// is skipped; other projects and page numbers are untouched; S3 failures are warnings; the typed
// phrase is enforced server-side; demo projects are never in scope. Also: summaries and the
// project list count VISIBLE pages only (hidden-but-not-deleted pages).
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// S3 boundary: a listing fixture (yolo-output keys) and a delete spy. Nothing talks to AWS.
const s3Mocks = vi.hoisted(() => {
  const listed = { keys: [] as string[] };
  const deleteFromS3 = vi.fn(async (_key: string): Promise<void> => undefined);
  const send = vi.fn(async (cmd: { input: { Prefix?: string } }) => ({
    Contents: listed.keys.filter((k) => k.startsWith(cmd.input.Prefix ?? "")).map((Key) => ({ Key })),
    IsTruncated: false,
  }));
  return { listed, deleteFromS3, send };
});
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return { ...actual, deleteFromS3: s3Mocks.deleteFromS3, s3Client: { send: s3Mocks.send } };
});

import { and, eq } from "drizzle-orm";
import { POST } from "@/app/api/admin/duplicates/delete-hidden/route";
import { GET as flagsGET } from "@/app/api/projects/[id]/page-flags/route";
import { GET as projectsGET } from "@/app/api/projects/route";
import { db } from "@/lib/db";
import {
  annotationGroupMembers, annotationGroups, annotations, auditLog, chatMessages, pages, projects, qtoWorkflows,
} from "@/lib/db/schema";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { assertProjectWritable } from "@/server/api/access";
import {
  asUser, createCompany, createPage, createProject, createUser, makeReq, params, publishDemoFixture, readJson, signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const AT = "2026-10-23T00:00:00.000Z";

const mark = (canonical: number, hidden = true) => ({
  duplicateOf: { v: 1, pageNumber: canonical, tier: "exact", score: 1, content: 1, full: 1, scannedAt: AT, ...(hidden ? { hiddenAt: AT } : {}) },
});
const hiddenPage = (projectId: number, n: number, canonical: number, over: Record<string, unknown> = {}) =>
  createPage(projectId, n, { pageIntelligence: mark(canonical) as never, ...over });

async function seedAnn(projectId: number, page: number, source: string, name = "door") {
  const [row] = await db.insert(annotations).values({
    name, minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2, pageNumber: page, threshold: 0.5, source, projectId, data: {} as never,
  }).returning({ id: annotations.id });
  return row.id;
}
const seedChat = (projectId: number, page: number | null) =>
  db.insert(chatMessages).values({ projectId, pageNumber: page, role: "user", content: "hi" });
async function seedGroup(projectId: number, name: string, memberIds: number[]) {
  const [g] = await db.insert(annotationGroups).values({ projectId, name }).returning({ id: annotationGroups.id });
  await db.insert(annotationGroupMembers).values(memberIds.map((annotationId) => ({ annotationId, groupId: g.id })));
  return g.id;
}
const pageNumbers = async (projectId: number) =>
  (await db.select({ n: pages.pageNumber }).from(pages).where(eq(pages.projectId, projectId)).orderBy(pages.pageNumber)).map((r) => r.n);
const annPages = async (projectId: number) =>
  (await db.select({ n: annotations.pageNumber }).from(annotations).where(eq(annotations.projectId, projectId)).orderBy(annotations.pageNumber)).map((r) => r.n);
const chatPages = async (projectId: number) =>
  (await db.select({ n: chatMessages.pageNumber }).from(chatMessages).where(eq(chatMessages.projectId, projectId)).orderBy(chatMessages.pageNumber)).map((r) => r.n);
const groupIds = async (projectId: number) =>
  (await db.select({ id: annotationGroups.id }).from(annotationGroups).where(eq(annotationGroups.projectId, projectId)).orderBy(annotationGroups.id)).map((r) => r.id);

async function world() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const root = await createUser(company.id, { isRootAdmin: true });
  const p1 = await createProject(company.id, admin.id, { numPages: 4 });
  const p2 = await createProject(company.id, admin.id, { numPages: 3 });
  return { company, admin, root, p1, p2 };
}

const post = (body: Record<string, unknown>, qs = "") =>
  POST(makeReq(`/api/admin/duplicates/delete-hidden${qs}`, { body })).then(readJson);
type PlanPage = { page: number; canonical: number; annotations: number; chats: number; s3Keys: string[] };
type Plan = { publicId: string; pages: PlanPage[]; skipped: { page: number; reason: string }[]; warnings: string[]; skippedReason?: string; error?: string };
const planOf = (body: { projects: Plan[] }, publicId: string) => body.projects.find((p) => p.publicId === publicId)!;

beforeEach(() => {
  vi.clearAllMocks();
  s3Mocks.listed.keys = [];
  s3Mocks.deleteFromS3.mockImplementation(async () => undefined);
  signedOut();
});

describe.skipIf(!dbUp)("admin duplicates — delete hidden pages permanently", () => {
  it("auth: signed-out 401, company admin 403, root 200 (dry run)", async () => {
    const w = await world();
    expect((await post({ all: true, dryRun: true })).status).toBe(401);
    asUser(w.admin);
    expect((await post({ all: true, dryRun: true })).status).toBe(403);
    asUser(w.root);
    expect((await post({ all: true, dryRun: true }, `?companyId=${w.company.id}`)).status).toBe(200);
  });

  it("dry run == real run: the hidden page, its annotations (emptied groups too), its chat and its S3 objects go; everything else stays", async () => {
    const w = await world();
    for (const n of [1, 2]) await createPage(w.p1.id, n);
    await hiddenPage(w.p1.id, 3, 1);
    await hiddenPage(w.p1.id, 4, 2);
    const a1 = await seedAnn(w.p1.id, 1, "yolo");
    await seedAnn(w.p1.id, 2, "yolo");
    const a3a = await seedAnn(w.p1.id, 3, "yolo");
    const a3b = await seedAnn(w.p1.id, 3, "shape-parse");
    const sharedGroup = await seedGroup(w.p1.id, "shared", [a1, a3a]); // keeps a member → stays
    const soleGroup = await seedGroup(w.p1.id, "sole", [a3b]); // emptied by this delete → goes
    await seedChat(w.p1.id, 2);
    await seedChat(w.p1.id, 3);
    await seedChat(w.p1.id, null); // project-wide chat stays
    // other project, same page numbers, also hidden — out of scope by project filter
    for (const n of [1, 2]) await createPage(w.p2.id, n);
    await hiddenPage(w.p2.id, 3, 1);
    await seedAnn(w.p2.id, 3, "yolo");
    const yolo = (model: string, file: string) => `${w.p1.dataUrl}/yolo-output/${model}/${file}`;
    s3Mocks.listed.keys = [
      yolo("modelA", "page_0001.json"), yolo("modelA", "page_0003.json"), yolo("modelA", "_manifest.json"),
      yolo("modelB", "page_0004.json"), `${w.p2.dataUrl}/yolo-output/modelA/page_0003.json`,
    ];
    asUser(w.root);

    const dry = await post({ projectPublicIds: [w.p1.publicId], dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.confirmPhrase).toBe("DELETE");
    expect(dry.body.note).toMatch(/original\.pdf/);
    expect(dry.body.totals).toEqual({ pages: 2, annotations: 2, chats: 1, s3Keys: 6, skipped: 0 });
    const dryPlan = planOf(dry.body, w.p1.publicId);
    expect(dryPlan.pages.map((p) => [p.page, p.canonical, p.annotations, p.chats])).toEqual([[3, 1, 2, 1], [4, 2, 0, 0]]);
    expect(dryPlan.pages[0].s3Keys).toEqual([
      `${w.p1.dataUrl}/pages/page_0003.png`, `${w.p1.dataUrl}/thumbnails/page_0003.png`, yolo("modelA", "page_0003.json"),
    ]);
    expect(dryPlan.pages[1].s3Keys).toEqual([
      `${w.p1.dataUrl}/pages/page_0004.png`, `${w.p1.dataUrl}/thumbnails/page_0004.png`, yolo("modelB", "page_0004.json"),
    ]);
    expect(await pageNumbers(w.p1.id)).toEqual([1, 2, 3, 4]);
    expect(s3Mocks.deleteFromS3).not.toHaveBeenCalled();

    const run = await post({ projectPublicIds: [w.p1.publicId], dryRun: false, confirm: "DELETE" });
    expect(run.status).toBe(200);
    const plan = planOf(run.body, w.p1.publicId);
    expect(plan.pages).toEqual(dryPlan.pages); // what was previewed is what went
    expect(plan.warnings).toEqual([]);
    expect(await pageNumbers(w.p1.id)).toEqual([1, 2]); // numbers kept: a gap, no renumbering
    expect(await annPages(w.p1.id)).toEqual([1, 2]);
    expect(await chatPages(w.p1.id)).toEqual([2, null]); // NULL (project-wide chat) sorts last
    expect(await groupIds(w.p1.id)).toEqual([sharedGroup]);
    expect(soleGroup).not.toBe(sharedGroup);
    expect(s3Mocks.deleteFromS3.mock.calls.map(([k]) => k).sort()).toEqual([...dryPlan.pages.flatMap((p) => p.s3Keys)].sort());
    // the other project is untouched, S3 included
    expect(await pageNumbers(w.p2.id)).toEqual([1, 2, 3]);
    expect(await annPages(w.p2.id)).toEqual([3]);
    const [p1Row] = await db.select({ numPages: projects.numPages, pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, w.p1.id));
    expect(p1Row.numPages).toBe(4); // the max index stays
    expect((p1Row.pi as { summaries?: unknown } | null)?.summaries).toBeDefined(); // summaries refreshed
    const [entry] = await db.select({ details: auditLog.details }).from(auditLog)
      .where(and(eq(auditLog.action, "admin.duplicates.delete-hidden"), eq(auditLog.userId, w.root.id)));
    expect(entry?.details).toMatchObject({ pages: 2, deleted: [[w.p1.publicId, [3, 4]]] });
    // the viewer learns the gaps from page-flags and skips them like hidden pages
    const flags = await readJson(await flagsGET(makeReq(`/api/projects/${w.p1.publicId}/page-flags`, { method: "GET" }), params({ id: w.p1.publicId })));
    expect(flags.status).toBe(200);
    expect(flags.body).toEqual({ hidden: [], missing: [3, 4] });
  });

  it("never deletes a page with user work, a twice-stored page, or a page whose kept copy is missing", async () => {
    const w = await world();
    await createPage(w.p1.id, 1);
    for (let n = 2; n <= 7; n++) await hiddenPage(w.p1.id, n, 1);
    await seedAnn(w.p1.id, 2, "user");
    await seedAnn(w.p1.id, 3, "takeoff");
    await seedAnn(w.p1.id, 4, "symbol-search");
    await db.insert(qtoWorkflows).values({ projectId: w.p1.id, materialType: "doors", schedulePageNumber: 5, lineItems: [{ pages: [], instances: [{ pageNumber: 6 }] }] as never });
    await db.update(pages).set({ pageIntelligence: { ...mark(1), parsedRegions: [{ id: "r1", type: "schedule" }] } as never })
      .where(and(eq(pages.projectId, w.p1.id), eq(pages.pageNumber, 7)));
    await hiddenPage(w.p1.id, 8, 99); // kept copy does not exist
    await createPage(w.p1.id, 9);
    await hiddenPage(w.p1.id, 9, 1); // stored twice
    await hiddenPage(w.p1.id, 10, 1); // the one that may go
    asUser(w.root);
    const dry = await post({ all: true, dryRun: true }, `?companyId=${w.company.id}`);
    expect(dry.status).toBe(200);
    const plan = planOf(dry.body, w.p1.publicId);
    expect(plan.pages.map((p) => p.page)).toEqual([10]);
    expect(Object.fromEntries(plan.skipped.map((s) => [s.page, s.reason]))).toEqual({
      2: "has your work", 3: "has your work", 4: "has your work", 5: "has your work", 6: "has your work", 7: "has your work",
      8: "kept copy (page 99) is missing", 9: "stored twice (duplicate page rows)",
    });
    const run = await post({ all: true, dryRun: false, confirm: "DELETE" }, `?companyId=${w.company.id}`);
    expect(run.status).toBe(200);
    expect(planOf(run.body, w.p1.publicId).pages.map((p) => p.page)).toEqual([10]);
    expect(await pageNumbers(w.p1.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
    expect(await annPages(w.p1.id)).toEqual([2, 3, 4]);
  });

  it("the real run refuses without the exact typed phrase and deletes nothing", async () => {
    const w = await world();
    await createPage(w.p1.id, 1);
    await hiddenPage(w.p1.id, 2, 1);
    asUser(w.root);
    expect((await post({ all: true, dryRun: false })).status).toBe(400);
    expect((await post({ all: true, dryRun: false, confirm: "delete" })).status).toBe(400);
    expect((await post({ dryRun: true })).status).toBe(400); // no scope
    expect(await pageNumbers(w.p1.id)).toEqual([1, 2]);
  });

  it("an S3 delete failure is a warning on a committed delete, not a rollback; the other objects are still attempted", async () => {
    const w = await world();
    await createPage(w.p1.id, 1);
    await hiddenPage(w.p1.id, 2, 1);
    const bad = `${w.p1.dataUrl}/thumbnails/page_0002.png`;
    s3Mocks.deleteFromS3.mockImplementation(async (key: string) => { if (key === bad) throw new Error("AccessDenied"); });
    asUser(w.root);
    const run = await post({ projectPublicIds: [w.p1.publicId], dryRun: false, confirm: "DELETE" });
    expect(run.status).toBe(200);
    const plan = planOf(run.body, w.p1.publicId);
    expect(plan.pages.map((p) => p.page)).toEqual([2]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain(bad);
    expect(plan.warnings[0]).toContain("AccessDenied");
    expect(s3Mocks.deleteFromS3.mock.calls.map(([k]) => k).sort()).toEqual([`${w.p1.dataUrl}/pages/page_0002.png`, bad].sort());
    expect(await pageNumbers(w.p1.id)).toEqual([1]);
  });

  it("demo projects are never in scope; a not-completed project is reported skipped and untouched", async () => {
    const w = await world();
    const demo = await createProject(w.company.id, w.admin.id);
    await createPage(demo.id, 1);
    await hiddenPage(demo.id, 2, 1);
    await publishDemoFixture(demo.id);
    const pending = await createProject(w.company.id, w.admin.id, { status: "processing" });
    await createPage(pending.id, 1);
    await hiddenPage(pending.id, 2, 1);
    asUser(w.root);
    const run = await post({ all: true, dryRun: false, confirm: "DELETE" }, `?companyId=${w.company.id}`);
    expect(run.status).toBe(200);
    expect((run.body.projects as Plan[]).map((p) => p.publicId)).not.toContain(demo.publicId);
    expect(planOf(run.body, pending.publicId).skippedReason).toBe("not completed (processing)");
    expect(await pageNumbers(demo.id)).toEqual([1, 2]);
    expect(await pageNumbers(pending.id)).toEqual([1, 2]);
  });

  it("hidden-but-not-deleted pages: summaries and the project list count visible pages only", async () => {
    const w = await world();
    const csi = (code: string) => [{ code, description: "x", trade: "t", division: code.slice(0, 2) }];
    await createPage(w.p1.id, 1, { csiCodes: csi("03 30 00") });
    await createPage(w.p1.id, 2);
    await hiddenPage(w.p1.id, 3, 1, { csiCodes: csi("08 11 16") });
    await seedAnn(w.p1.id, 1, "yolo", "door");
    await seedAnn(w.p1.id, 3, "yolo", "window");
    const [row] = await db.select().from(projects).where(eq(projects.id, w.p1.id));
    const summaries = await computeProjectSummaries(w.p1.id, assertProjectWritable(row));
    expect(summaries.csiPageIndex).toEqual({ "03 30 00": [1] });
    expect(JSON.stringify(summaries)).not.toContain("window");

    asUser(w.root);
    const { status, body } = await readJson(await projectsGET(makeReq("/api/projects", { method: "GET" })));
    expect(status).toBe(200);
    const listed = (body as { id: string; numPages: number; pagesProcessed: number | null }[]).find((p) => p.id === w.p1.publicId)!;
    expect(listed.numPages).toBe(2);
    expect(listed.pagesProcessed).toBe(2);
  });
});
