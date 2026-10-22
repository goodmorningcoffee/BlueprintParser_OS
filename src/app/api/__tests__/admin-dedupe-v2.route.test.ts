// @vitest-environment node
// Dedupe v2 (2026-10-22): duplicate pages apply-selection (lower tiers by explicit selection,
// lone near/possible pairs) and duplicate PROJECTS scan / dry run / delete (root only).
// S3 is mocked: HeadObject / GetObject behavior was never exercised against real S3 here.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({
  heads: new Map<string, { size: number; eTag: string }>(),
  bodies: new Map<string, Uint8Array>(),
  headCalls: [] as string[],
  getCalls: [] as string[],
}));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...actual,
    headS3Object: async (key: string) => {
      s3.headCalls.push(key);
      const h = s3.heads.get(key);
      return h ? { exists: true, size: h.size, eTag: h.eTag } : { exists: false };
    },
    getS3ObjectStream: async (key: string) => {
      s3.getCalls.push(key);
      const bytes = s3.bodies.get(key) ?? new Uint8Array();
      return { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) };
    },
  };
});
// Storage purge after commit is out of scope here (and slow against dummy credentials).
vi.mock("@/lib/project-asset-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-asset-deletion")>()),
  reconcileProjectAssetDeletion: async () => undefined,
}));

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { POST as scanPOST } from "@/app/api/admin/duplicates/scan/route";
import { POST as selectPOST } from "@/app/api/admin/duplicates/apply-selection/route";
import { POST as projScanPOST } from "@/app/api/admin/project-duplicates/scan/route";
import { POST as projDeletePOST } from "@/app/api/admin/project-duplicates/delete/route";
import { db } from "@/lib/db";
import { annotations, auditLog, labelingSessions, labelStudioProjectIntents, pages, projects } from "@/lib/db/schema";
import { body, page, tweak } from "@/lib/__tests__/page-dedup-fixtures";
import {
  ageProjectForPublication, asUser, createCompany, createPage, createProject, createUser, makeReq, publishDemoFixture, readJson, signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function world() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, root };
}

type Line = { t: string } & Record<string, any>;
async function pageScan(publicId: string) {
  const res = await scanPOST(makeReq("/api/admin/duplicates/scan", { body: { projectPublicIds: [publicId] } }));
  const lines: Line[] = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((l) => l.t === "project")!;
}
const select = async (b: unknown, qs = "") => readJson(await selectPOST(makeReq(`/api/admin/duplicates/apply-selection${qs}`, { body: b })));
const projScan = async (b: unknown, qs = "") => readJson(await projScanPOST(makeReq(`/api/admin/project-duplicates/scan${qs}`, { body: b })));
const projDelete = async (b: unknown, qs = "") => readJson(await projDeletePOST(makeReq(`/api/admin/project-duplicates/delete${qs}`, { body: b })));

async function hiddenPages(projectId: number): Promise<number[]> {
  const rows = await db.select({ n: pages.pageNumber, pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, projectId));
  return rows.filter((r) => (r.pi as any)?.duplicateOf?.hiddenAt).map((r) => r.n).sort((a, b) => a - b);
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  s3.heads.clear();
  s3.bodies.clear();
  s3.headCalls.length = 0;
  s3.getCalls.length = 0;
});

describe.skipIf(!dbUp)("duplicate pages — apply-selection", () => {
  it("hides an explicitly selected near block (keep latest) and lone near / possible pairs; exact untouched unless selected", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    // Permit set p1-3, IFC re-issue p4-6 with one changed line on every sheet → a near block.
    for (let i = 0; i < 3; i++) {
      const lines = body(500 + i);
      const a = page(i + 1, `A-${301 + i}`, lines);
      const b = page(i + 4, `A-${301 + i}`, tweak(lines, 2, "ifc"));
      await createPage(p.id, a.pageNumber, { rawText: a.rawText, drawingNumber: a.drawingNumber });
      await createPage(p.id, b.pageNumber, { rawText: b.rawText, drawingNumber: b.drawingNumber });
    }
    asUser(admin);
    const line = await pageScan(p.publicId);
    const nearBlock = line.blocks.find((b: any) => b.tier === "near");
    expect(nearBlock).toBeTruthy();
    const { status, body: res } = await select({
      selections: [{ projectPublicId: p.publicId, reportDigest: line.reportDigest, blocks: [{ id: nearBlock.id, keep: "latest" }] }],
    });
    expect(status).toBe(200);
    expect(res.results[0].hidden.map((h: any) => h.page)).toEqual([1, 2, 3]);
    expect(await hiddenPages(p.id)).toEqual([1, 2, 3]);
  });

  it("lone pair selection: a block page is refused (400); a stale digest is 409 for one project and 'changed since scan' in a batch", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    const q = await createProject(company.id, admin.id);
    for (const proj of [p, q]) {
      for (let i = 0; i < 3; i++) {
        const x = page(i + 1, `A-${401 + i}`, body(700 + i + proj.id));
        await createPage(proj.id, i + 1, { rawText: x.rawText, drawingNumber: x.drawingNumber });
        await createPage(proj.id, i + 4, { rawText: x.rawText, drawingNumber: x.drawingNumber });
      }
    }
    asUser(admin);
    const line = await pageScan(p.publicId);
    const blockPage = line.pairs.find((x: any) => x.blockId !== null).page;
    expect((await select({ selections: [{ projectPublicId: p.publicId, reportDigest: line.reportDigest, pairs: [{ page: blockPage, keep: "earliest" }] }] })).status).toBe(400);
    const stale = { projectPublicId: p.publicId, reportDigest: "0".repeat(64), blocks: [{ id: line.blocks[0].id, keep: "earliest" as const }] };
    expect((await select({ selections: [stale] })).status).toBe(409);
    const qLine = await pageScan(q.publicId);
    const batch = await select({ selections: [stale, { projectPublicId: q.publicId, reportDigest: qLine.reportDigest, blocks: [{ id: qLine.blocks[0].id, keep: "earliest" }] }] });
    expect(batch.status).toBe(200);
    expect(batch.body.results[0]).toEqual({ projectPublicId: p.publicId, skipped: "changed since scan" });
    expect(batch.body.results[1].hidden.map((h: any) => h.page)).toEqual([4, 5, 6]);
    expect(await hiddenPages(p.id)).toEqual([]);
  });

  it("a foreign project fails the whole request closed (404) and hides nothing", async () => {
    const a = await world();
    const b = await world();
    const foreign = await createProject(b.company.id, b.admin.id);
    asUser(a.admin);
    const r = await select({ selections: [{ projectPublicId: foreign.publicId, reportDigest: "0".repeat(64), pairs: [{ page: 2, keep: "latest" }] }] });
    expect(r.status).toBe(404);
  });
});

const PDF = (dataUrl: string) => `${dataUrl}/original.pdf`;

async function seedText(projectId: number, texts: string[]) {
  for (const [i, t] of texts.entries()) await createPage(projectId, i + 1, { rawText: t });
}
const TEXT = ["GENERAL NOTES floor plan level one walls doors", "SECOND FLOOR plan with stair and elevator core", "ROOF plan drains and parapet details"];

async function seedLabeling(projectId: number, companyId: number) {
  const [project] = await db.select({ lifecycleEpoch: projects.lifecycleEpoch }).from(projects).where(eq(projects.id, projectId));
  const intentId = randomUUID();
  const lsId = 90000 + Math.floor(Math.random() * 9999);
  await db.insert(labelStudioProjectIntents).values({
    id: intentId, projectId, companyId, lifecycleEpoch: project.lifecycleEpoch, marker: `bp-labeling-intent:${intentId}`,
    providerProjectId: lsId, providerBaseUrl: "http://ls.test", providerInstanceId: "ls-test", state: "cleanup_pending",
  } as never);
  await db.insert(labelingSessions).values({
    projectId, companyId, labelStudioProjectId: lsId, providerBaseUrl: "http://ls.test", providerInstanceId: "ls-test",
    labelStudioUrl: `http://ls.test/projects/${lsId}`, taskType: "generic", pageRange: "1-3", status: "active", provisioningIntentId: intentId,
  } as never);
}

describe.skipIf(!dbUp)("duplicate projects — root only", () => {
  it("signed-out 401; company admin 403 on scan and delete", async () => {
    const { admin } = await world();
    const any = { groups: [{ keeper: randomUUID(), remove: [randomUUID()] }], dryRun: true };
    expect((await projScan({})).status).toBe(401);
    expect((await projDelete(any)).status).toBe(401);
    asUser(admin);
    expect((await projScan({})).status).toBe(403);
    expect((await projDelete(any)).status).toBe(403);
  });
});

describe.skipIf(!dbUp)("duplicate projects — scan tiers", () => {
  it("groups by name, normalized name and text; byte tier only for candidates; demo never; keeper = most user work", async () => {
    const { company, root, admin } = await world();
    const a = await createProject(company.id, admin.id, { name: "Tower A" });
    const b = await createProject(company.id, admin.id, { name: "Tower A" });
    const c = await createProject(company.id, admin.id, { name: "tower   a" });
    const d = await createProject(company.id, admin.id, { name: "Renamed upload" });
    const lone = await createProject(company.id, admin.id, { name: "Unrelated" });
    const demo = await createProject(company.id, admin.id, { name: "Tower A" });
    await publishDemoFixture(demo.id);
    await seedText(b.id, TEXT);
    await seedText(d.id, TEXT);
    await seedText(lone.id, ["completely different sheet text about site utilities and grading"]);
    await db.insert(annotations).values({ projectId: c.id, pageNumber: 1, name: "mark", minX: 0, maxX: 1, minY: 0, maxY: 1, source: "user" });
    s3.heads.set(PDF(a.dataUrl), { size: 1000, eTag: '"same"' });
    s3.heads.set(PDF(b.dataUrl), { size: 1000, eTag: '"same"' });
    s3.heads.set(PDF(d.dataUrl), { size: 2000, eTag: '"other"' });
    s3.heads.set(PDF(lone.dataUrl), { size: 1000, eTag: '"same"' });
    asUser(root);
    const { status, body: res } = await projScan({}, `?companyId=${company.id}`);
    expect(status).toBe(200);
    expect(res.companies).toHaveLength(1);
    const [group] = res.companies[0].groups;
    expect(group.members.map((m: any) => m.publicId).sort()).toEqual([a.publicId, b.publicId, c.publicId, d.publicId].sort());
    expect(group.defaultKeeper).toBe(c.publicId);
    const byId = Object.fromEntries(group.members.map((m: any) => [m.publicId, m]));
    expect(byId[a.publicId].fileKey).toBeTruthy();
    expect(byId[a.publicId].fileKey).toBe(byId[b.publicId].fileKey);
    expect(byId[d.publicId].fileKey).toBeNull(); // lone size → never identical, nothing read
    expect(byId[b.publicId].textHash).toBe(byId[d.publicId].textHash);
    expect(byId[c.publicId].userAnnotations).toBe(1);
    expect(byId[a.publicId]).not.toHaveProperty("dataUrl");
    // Candidates only: the unrelated project's file and the demo's are never touched.
    expect(s3.headCalls).not.toContain(PDF(lone.dataUrl));
    expect(s3.headCalls).not.toContain(PDF(demo.dataUrl));
    expect(s3.getCalls).toEqual([]);
  });

  it("multipart ETags with different part counts fall back to a streamed SHA-256 of just those files", async () => {
    const { company, root, admin } = await world();
    const a = await createProject(company.id, admin.id, { name: "Hospital" });
    const b = await createProject(company.id, admin.id, { name: "Hospital" });
    s3.heads.set(PDF(a.dataUrl), { size: 5, eTag: '"x-2"' });
    s3.heads.set(PDF(b.dataUrl), { size: 5, eTag: '"y-3"' });
    s3.bodies.set(PDF(a.dataUrl), new Uint8Array([1, 2, 3, 4, 5]));
    s3.bodies.set(PDF(b.dataUrl), new Uint8Array([1, 2, 3, 4, 5]));
    asUser(root);
    const { body: res } = await projScan({}, `?companyId=${company.id}`);
    const members = res.companies[0].groups[0].members;
    expect(members[0].fileKey).toMatch(/^sha256:5:[0-9a-f]{64}$/);
    expect(members[0].fileKey).toBe(members[1].fileKey);
    expect(s3.getCalls.sort()).toEqual([PDF(a.dataUrl), PDF(b.dataUrl)].sort());
    expect(res.files).toMatchObject({ checked: 2, hashed: 2 });
  });
});

describe.skipIf(!dbUp)("duplicate projects — dry run and delete", () => {
  async function setup() {
    const w = await world();
    const keeper = await createProject(w.company.id, w.admin.id, { name: "Clinic" });
    const copy = await createProject(w.company.id, w.admin.id, { name: "Clinic" });
    const locked = await createProject(w.company.id, w.admin.id, { name: "clinic" });
    const stranger = await createProject(w.company.id, w.admin.id, { name: "Different job" });
    for (const p of [keeper, copy, locked, stranger]) await ageProjectForPublication(p.id);
    await createPage(copy.id, 1, { rawText: "x" });
    await seedLabeling(locked.id, w.company.id);
    return { ...w, keeper, copy, locked, stranger };
  }

  it("dry run writes nothing and reports delete / blocked: labeling session / refused (no signal)", async () => {
    const { company, root, keeper, copy, locked, stranger } = await setup();
    asUser(root);
    const req = { groups: [{ keeper: keeper.publicId, remove: [copy.publicId, locked.publicId, stranger.publicId] }], dryRun: true };
    const { status, body: res } = await projDelete(req, `?companyId=${company.id}`);
    expect(status).toBe(200);
    expect(res.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.summary).toEqual({ delete: 1, blocked: 1, refused: 1 });
    const items = Object.fromEntries(res.groups[0].items.map((i: any) => [i.publicId, i]));
    expect(items[copy.publicId]).toMatchObject({ action: "delete", level: "same-name" });
    expect(items[locked.publicId]).toMatchObject({ action: "blocked", reason: "labeling session", level: "similar-name" });
    expect(items[stranger.publicId]).toMatchObject({ action: "refused", level: null });
    const left = await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, [keeper.id, copy.id, locked.id, stranger.id]));
    expect(left).toHaveLength(4);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "project_deleted"));
    expect(audits.some((r) => (r.details as any)?.keeper === keeper.publicId)).toBe(false);
  });

  it("real run: needs DELETE + the dry run's digest; deletes only the non-keeper duplicates; reports the rest per project", async () => {
    const { company, root, keeper, copy, locked, stranger } = await setup();
    asUser(root);
    const qs = `?companyId=${company.id}`;
    const groups = [{ keeper: keeper.publicId, remove: [copy.publicId, locked.publicId, stranger.publicId] }];
    const dry = await projDelete({ groups, dryRun: true }, qs);
    expect((await projDelete({ groups, dryRun: false, planDigest: dry.body.planDigest, confirm: "delete" }, qs)).status).toBe(400);
    expect((await projDelete({ groups, dryRun: false, confirm: "DELETE" }, qs)).status).toBe(400);
    expect((await projDelete({ groups, dryRun: false, planDigest: "a".repeat(64), confirm: "DELETE" }, qs)).status).toBe(409);
    // A change after the dry run (new user work on a copy) invalidates the digest.
    await db.insert(annotations).values({ projectId: copy.id, pageNumber: 1, name: "late", minX: 0, maxX: 1, minY: 0, maxY: 1, source: "user" });
    expect((await projDelete({ groups, dryRun: false, planDigest: dry.body.planDigest, confirm: "DELETE" }, qs)).status).toBe(409);
    const dry2 = await projDelete({ groups, dryRun: true }, qs);
    const { status, body: res } = await projDelete({ groups, dryRun: false, planDigest: dry2.body.planDigest, confirm: "DELETE" }, qs);
    expect(status).toBe(200);
    const results = Object.fromEntries(res.results.map((r: any) => [r.publicId, r]));
    expect(results[copy.publicId]).toMatchObject({ result: "deleted" });
    expect(results[locked.publicId]).toMatchObject({ result: "blocked", reason: "labeling session" });
    expect(results[stranger.publicId]).toMatchObject({ result: "refused" });
    const left = (await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, [keeper.id, copy.id, locked.id, stranger.id]))).map((r) => r.id);
    expect(left.sort()).toEqual([keeper.id, locked.id, stranger.id].sort());
  }, 30000);

  it("the keeper can never be removed; demo projects are out of scope (404)", async () => {
    const { company, root, admin, keeper } = await setup();
    const demo = await createProject(company.id, admin.id, { name: "Clinic" });
    await publishDemoFixture(demo.id);
    asUser(root);
    const qs = `?companyId=${company.id}`;
    expect((await projDelete({ groups: [{ keeper: keeper.publicId, remove: [keeper.publicId] }], dryRun: true }, qs)).status).toBe(400);
    expect((await projDelete({ groups: [{ keeper: keeper.publicId, remove: [demo.publicId] }], dryRun: true }, qs)).status).toBe(404);
  });
});
