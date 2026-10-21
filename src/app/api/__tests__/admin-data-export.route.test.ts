// @vitest-environment node
// GET /api/admin/data-export — bp-dataset/1 (admin data tools, plan §3). Synthetic fixtures only.
import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3Mocks = vi.hoisted(() => ({ getPresignedGetUrl: vi.fn() }));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/s3")>()),
  getPresignedGetUrl: s3Mocks.getPresignedGetUrl,
}));

// A data blob carrying this marker makes the classifier throw → exercises the per-project
// failure path (error line, next project continues).
vi.mock("@/types/shapes/annotation-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/types/shapes/annotation-data")>();
  return {
    ...actual,
    classifyAnnotationData: (data: unknown) => {
      if (data && typeof data === "object" && "__failExport" in data) throw new Error("forced");
      return actual.classifyAnnotationData(data);
    },
  };
});

import { GET } from "@/app/api/admin/data-export/route";
import { db } from "@/lib/db";
import {
  annotationGroupMembers,
  annotationGroups,
  annotations,
  auditLog,
  chatMessages,
  models,
  projectMutationLeases,
  projects,
  qtoWorkflows,
  takeoffGroups,
  takeoffItems,
  users,
} from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import {
  isExportRunning,
  setExportLimitsForTest,
} from "@/server/services/admin-data-export-stream";
import {
  asUser,
  createCompany,
  createPage,
  createProject,
  createUser,
  makeReq,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

type Line = Record<string, unknown> & { t: string };

const call = (qs = "") => GET(makeReq(`/api/admin/data-export${qs}`, { method: "GET" }));

async function readDataset(res: Response): Promise<{ raw: string; lines: Line[] }> {
  const raw = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
  const lines = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
  return { raw, lines };
}
const ofType = (lines: Line[], t: string) => lines.filter((l) => l.t === t);

async function adminWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const project = await createProject(company.id, admin.id);
  return { company, admin, project };
}

async function insertAnnotation(projectId: number, pageNumber: number, source: string, data: object = {}, creatorId?: number) {
  const [row] = await db
    .insert(annotations)
    .values({ name: `a-${source}`, minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, pageNumber, projectId, source, data: data as never, creatorId })
    .returning();
  return row;
}

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

afterEach(() => setExportLimitsForTest(null));

describe.skipIf(!dbUp)("GET /api/admin/data-export", () => {
  it("auth: signed out 401; member 403; company admin own OK, foreign companyId 403, foreign project 404; presign by company admin 403", async () => {
    const { company, admin, project } = await adminWorld();
    const other = await adminWorld();
    const member = await createUser(company.id);

    signedOut();
    expect((await call()).status).toBe(401);
    asUser(member);
    expect((await call()).status).toBe(403);

    asUser(admin);
    const own = await call();
    expect(own.status).toBe(200);
    const { lines } = await readDataset(own);
    expect(ofType(lines, "project").map((p) => p.publicId)).toEqual([project.publicId]);

    const ownExplicit = await call(`?companyId=${company.publicId}`);
    expect(ownExplicit.status).toBe(200);
    await readDataset(ownExplicit);

    const foreign = await readJson(await call(`?companyId=${other.company.publicId}`));
    expect(foreign.status).toBe(403);
    expect((await readJson(await call(`?companyId=${randomUUID()}`))).status).toBe(403);
    // one foreign id refuses the whole request, even alongside an own project
    const foreignProject = await readJson(await call(`?projects=${project.publicId},${other.project.publicId}`));
    expect(foreignProject.status).toBe(404);
    expect((await readJson(await call(`?projects=not-a-uuid`))).status).toBe(400);
    expect((await readJson(await call(`?presign=1`))).status).toBe(403);
    expect(isExportRunning()).toBe(false);
  });

  it("root exports any company; unknown company 404", async () => {
    const { project, company } = await adminWorld();
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });
    asUser(root);
    const res = await call(`?companyId=${company.publicId}`);
    expect(res.status).toBe(200);
    const { lines } = await readDataset(res);
    expect(ofType(lines, "project").map((p) => p.publicId)).toEqual([project.publicId]);
    expect((await readJson(await call(`?companyId=${randomUUID()}`))).status).toBe(404);
  });

  it("content: headers, header/footer, line order, origins, shape kinds, assets; never emails, S3 keys, s3Path, address or chat", async () => {
    const { company, admin, project } = await adminWorld();
    const other = await adminWorld();
    // PII the export must never carry: creator emails (annotation + group joins), the project's
    // address and coordinates, chat. Distinct synthetic markers so a leak is unambiguous.
    const [adminRow] = await db.select({ publicId: users.publicId }).from(users).where(eq(users.id, admin.id));
    await db.update(projects).set({ address: "PII-ADDR-7c1e", latitude: 12.987654, longitude: -65.123456 }).where(eq(projects.id, project.id));
    await db.insert(chatMessages).values({ projectId: project.id, pageNumber: 1, role: "user", content: "PII-CHAT-4b2d", userId: admin.id });
    // another tenant's model must not reach this company admin's file
    await db.insert(models).values({ companyId: other.company.id, name: "foreign-model-9f3a", type: "yolo", s3Path: "s3://weights/f.pt", config: { foreign: "FOREIGN-CFG-9f3a" } as never });
    await createPage(project.id, 1, {
      drawingNumber: "A-1",
      rawText: "synthetic one",
      textractData: { words: [{ text: "w" }] } as never,
      pageIntelligence: { k: 1 } as never,
    });
    await createPage(project.id, 2);
    await db.insert(models).values({ companyId: company.id, name: "m-1", type: "yolo", s3Path: "s3://weights/m-1.pt", config: { classes: ["c"] } as never });
    const sources = ["yolo", "shape-parse", "user", "takeoff", "takeoff-scale", "symbol-search", "something-else"];
    for (const s of sources) await insertAnnotation(project.id, 1, s, s === "yolo" ? { modelId: 1, classId: 2 } : {}, admin.id);
    await db.insert(annotationGroups).values({ projectId: project.id, name: "grp", createdBy: admin.id });
    const [tg] = await db.insert(takeoffGroups).values({ projectId: project.id, name: "g", kind: "count" }).returning();
    await db.insert(takeoffItems).values({ projectId: project.id, groupId: tg.id, name: "i", shape: "circle", color: "#fff" });
    await db.insert(qtoWorkflows).values({ projectId: project.id, materialType: "doors" });
    asUser(admin);

    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="bp-dataset-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.ndjson\.gz"$/);
    const { raw, lines } = await readDataset(res);

    expect(lines[0]).toMatchObject({ t: "header", schemaVersion: "bp-dataset/1" });
    expect(lines[lines.length - 1].t).toBe("footer");
    expect(lines.map((l) => l.t)).toEqual([
      "header", "model", "project", "page", "page",
      ...sources.map(() => "annotation"),
      "takeoffGroup", "takeoffItem", "qtoWorkflow", "annotationGroup", "footer",
    ]);
    // the creator joins carry the public id, never the email
    expect(ofType(lines, "annotation").map((a) => a.creatorPublicId)).toEqual(sources.map(() => adminRow.publicId));
    expect(ofType(lines, "annotationGroup")[0].creatorPublicId).toBe(adminRow.publicId);
    const proj = ofType(lines, "project")[0];
    expect(proj.assets).toEqual({ pdf: `/api/project-assets/${project.publicId}/original.pdf` });
    const p1 = ofType(lines, "page")[0];
    expect(p1).toMatchObject({ pageNumber: 1, drawingNumber: "A-1", textractData: { words: [{ text: "w" }] }, pageIntelligence: { k: 1 }, duplicateOf: null });
    expect(p1.assets).toEqual({
      png: `/api/project-assets/${project.publicId}/pages/page_0001.png`,
      thumb: `/api/project-assets/${project.publicId}/thumbnails/page_0001.png`,
    });
    expect(ofType(lines, "annotation").map((a) => [a.source, a.origin])).toEqual([
      ["yolo", "machine"], ["shape-parse", "machine"], ["user", "human"], ["takeoff", "human"],
      ["takeoff-scale", "human"], ["symbol-search", "assisted"], ["something-else", "unknown"],
    ]);
    expect(ofType(lines, "annotation")[0]).toMatchObject({ shapeKind: "yolo-detection", bbox: [0.1, 0.2, 0.3, 0.4] });
    // tenant filter: exactly this company's model, never another company's
    expect(ofType(lines, "model")).toEqual([{ t: "model", companyPublicId: company.publicId, name: "m-1", type: "yolo", config: { classes: ["c"] } }]);
    expect(ofType(lines, "takeoffItem")[0]).toMatchObject({ projectPublicId: project.publicId, groupId: tg.id });
    expect(ofType(lines, "takeoffItem")[0]).not.toHaveProperty("projectId");

    for (const forbidden of [
      "s3Path", "s3://", "email", admin.email, "dataUrl", project.dataUrl, "secret",
      "PII-ADDR-7c1e", "12.987654", "65.123456", "address", "latitude", "PII-CHAT-4b2d",
      "foreign-model-9f3a", "FOREIGN-CFG-9f3a", other.company.publicId, other.project.publicId,
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    const footer = lines[lines.length - 1];
    expect(footer.counts).toMatchObject({ project: 1, page: 2, annotation: 7, annotationGroup: 1, model: 1, takeoffGroup: 1, takeoffItem: 1, qtoWorkflow: 1, error: 0 });
    expect(footer.skipped).toEqual({ pages: 0, annotations: 0, groupMembers: 0, projects: 0 });

    expect(
      await waitFor(async () =>
        (await db.select().from(auditLog).where(and(eq(auditLog.action, "admin.data_export"), eq(auditLog.userId, admin.id)))).length > 0,
      ),
    ).toBe(true);
  });

  it("keyset: more pages and annotations than one batch, in id order; omit=textract,intelligence drops the keys", async () => {
    const { admin, project } = await adminWorld();
    for (let n = 1; n <= 30; n++) await createPage(project.id, n, { textractData: { n } as never });
    await db.insert(annotations).values(
      Array.from({ length: 1005 }, (_, i) => ({ name: `a${i}`, minX: 0, minY: 0, maxX: 1, maxY: 1, pageNumber: 1 + (i % 30), projectId: project.id, source: "yolo" })),
    );
    asUser(admin);
    const { lines } = await readDataset(await call());
    expect(ofType(lines, "page")).toHaveLength(30);
    const ids = ofType(lines, "annotation").map((a) => a.id as number);
    expect(ids).toHaveLength(1005);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);

    const slim = await readDataset(await call("?omit=textract,intelligence"));
    const page = ofType(slim.lines, "page")[0];
    expect(page).not.toHaveProperty("textractData");
    expect(page).not.toHaveProperty("pageIntelligence");
    expect(ofType(slim.lines, "project")[0]).not.toHaveProperty("projectIntelligence");
  });

  it("skipDuplicates (default on) drops hidden pages, their annotations and group members; =0 emits them marked", async () => {
    const { admin, project } = await adminWorld();
    const hidden = { pageNumber: 1, tier: "exact", score: 1, scannedAt: "2026-10-21T00:00:00Z", hiddenAt: "2026-10-21T00:00:00Z" };
    const scannedOnly = { pageNumber: 1, tier: "near", score: 0.93, scannedAt: "2026-10-21T00:00:00Z" };
    await createPage(project.id, 1);
    await createPage(project.id, 2, { pageIntelligence: { duplicateOf: hidden } as never });
    await createPage(project.id, 3, { pageIntelligence: { duplicateOf: scannedOnly } as never });
    const keep = await insertAnnotation(project.id, 1, "user");
    const dropA = await insertAnnotation(project.id, 2, "yolo");
    await insertAnnotation(project.id, 2, "user");
    const [group] = await db.insert(annotationGroups).values({ projectId: project.id, name: "grp" }).returning();
    await db.insert(annotationGroupMembers).values([
      { groupId: group.id, annotationId: keep.id },
      { groupId: group.id, annotationId: dropA.id },
    ]);
    asUser(admin);

    const { lines } = await readDataset(await call());
    expect(ofType(lines, "page").map((p) => p.pageNumber)).toEqual([1, 3]);
    expect(ofType(lines, "page")[1].duplicateOf).toEqual(scannedOnly);
    expect(ofType(lines, "annotation").map((a) => a.id)).toEqual([keep.id]);
    expect(ofType(lines, "annotationGroup")[0]).toMatchObject({ id: group.id, memberAnnotationIds: [keep.id] });
    const footer = lines[lines.length - 1];
    expect(footer.skipped).toEqual({ pages: 1, annotations: 2, groupMembers: 1, projects: 0 });

    const all = await readDataset(await call("?skipDuplicates=0"));
    expect(ofType(all.lines, "page").map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(ofType(all.lines, "page")[1].duplicateOf).toEqual(hidden);
    expect(ofType(all.lines, "annotation")).toHaveLength(3);
    expect(ofType(all.lines, "annotationGroup")[0].memberAnnotationIds).toEqual([keep.id, dropA.id]);
  });

  it("scope filters: completed only and no demo by default; includeDemo / status=any widen it", async () => {
    const { company, admin, project } = await adminWorld();
    const processing = await createProject(company.id, admin.id, { status: "processing" });
    const demo = await createProject(company.id, admin.id);
    await publishDemoFixture(demo.id);
    asUser(admin);
    const ids = async (qs: string) => ofType((await readDataset(await call(qs))).lines, "project").map((p) => p.publicId);
    expect(await ids("")).toEqual([project.publicId]);
    expect(await ids("?includeDemo=1")).toEqual([project.publicId, demo.publicId]);
    expect(await ids("?status=any")).toEqual([project.publicId, processing.publicId]);
  });

  it("failures: a leased project and a failing project get error lines; the next project still exports", async () => {
    const { company, admin, project } = await adminWorld();
    const leased = await createProject(company.id, admin.id);
    const failing = await createProject(company.id, admin.id);
    const last = await createProject(company.id, admin.id);
    await db.insert(projectMutationLeases).values({
      token: randomUUID(), projectId: leased.id, lifecycleEpoch: leased.lifecycleEpoch, kind: "yolo-run",
      idempotencyKey: randomUUID(), status: "active", expiresAt: new Date(Date.now() + 60_000),
    });
    await createPage(failing.id, 1);
    await insertAnnotation(failing.id, 1, "user", { __failExport: true });
    await createPage(last.id, 1);
    asUser(admin);

    const { lines } = await readDataset(await call());
    expect(ofType(lines, "project").map((p) => p.publicId)).toEqual([project.publicId, failing.publicId, last.publicId]);
    expect(ofType(lines, "error").map((e) => [e.projectPublicId, e.code])).toEqual([
      [leased.publicId, "BUSY"],
      [failing.publicId, "PROJECT_FAILED"],
    ]);
    expect(ofType(lines, "page").filter((p) => p.projectPublicId === last.publicId)).toHaveLength(1);
    const footer = lines[lines.length - 1];
    expect(footer.t).toBe("footer");
    expect((footer.skipped as { projects: number }).projects).toBe(2);
  });

  it("root presign=1 adds short-lived links; a second concurrent export is 429; cancel frees the slot", async () => {
    const { company, project } = await adminWorld();
    // more than one pull's worth, so the first export is still producing when the second arrives
    for (let n = 1; n <= 6; n++) await createPage(project.id, n, { textractData: { pad: randomBytes(25_000).toString("hex") } as never });
    const root = await createUser(company.id, { isRootAdmin: true });
    s3Mocks.getPresignedGetUrl.mockImplementation(async (key: string, ttl: number) => `https://signed.test/${ttl}/${key}`);
    asUser(root);

    const first = await call(`?companyId=${company.publicId}&presign=1`);
    expect(first.status).toBe(200);
    expect(isExportRunning()).toBe(true);
    const busy = await readJson(await call(`?companyId=${company.publicId}`));
    expect(busy.status).toBe(429);
    expect(busy.body.error.code).toBe("RATE_LIMITED");

    const { lines } = await readDataset(first);
    expect(isExportRunning()).toBe(false);
    expect(ofType(lines, "project")[0].assets).toEqual({
      pdf: `/api/project-assets/${project.publicId}/original.pdf`,
      pdfPresigned: `https://signed.test/3600/${project.dataUrl}/original.pdf`,
    });
    expect(ofType(lines, "page")[0].assets).toMatchObject({ pngPresigned: `https://signed.test/3600/${project.dataUrl}/pages/page_0001.png` });

    const second = await call(`?companyId=${company.publicId}`);
    expect(second.status).toBe(200);
    expect(isExportRunning()).toBe(true);
    const reader = second.body!.getReader();
    await reader.cancel();
    expect(await waitFor(() => !isExportRunning())).toBe(true);
  });

  it("slots are per caller class: a company admin's open export never blocks root; it does block another company admin", async () => {
    const { admin, project } = await adminWorld();
    const other = await adminWorld();
    for (let n = 1; n <= 6; n++) await createPage(project.id, n, { textractData: { pad: randomBytes(25_000).toString("hex") } as never });
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });

    asUser(admin);
    const held = await call();
    expect(held.status).toBe(200);
    try {
      expect(isExportRunning("company")).toBe(true);

      asUser(other.admin);
      const blocked = await readJson(await call());
      expect(blocked.status).toBe(429);

      asUser(root);
      const rootRes = await call(`?companyId=${other.company.publicId}`);
      expect(rootRes.status).toBe(200);
      const { lines } = await readDataset(rootRes);
      expect(ofType(lines, "project").map((p) => p.publicId)).toEqual([other.project.publicId]);
      expect(isExportRunning("root")).toBe(false);
      expect(isExportRunning("company")).toBe(true);
    } finally {
      await held.body?.cancel(); // never leak the slot into the next test, even on failure
    }
    expect(await waitFor(() => !isExportRunning())).toBe(true);
  });

  it("a stalled reader is aborted at the idle cap and frees the slot", async () => {
    const { admin, project } = await adminWorld();
    // incompressible filler, so the gzip transform's buffers fill and back-pressure stops pulls
    for (let n = 1; n <= 30; n++) await createPage(project.id, n, { textractData: { pad: randomBytes(25_000).toString("hex") } as never });
    setExportLimitsForTest({ idleMs: 150, chunkChars: 1024 });
    asUser(admin);
    const res = await call();
    expect(res.status).toBe(200);
    expect(isExportRunning()).toBe(true);
    // never read → no pull() → the idle cap fires
    expect(await waitFor(() => !isExportRunning(), 5000)).toBe(true);
    await expect(res.arrayBuffer()).rejects.toThrow();
    // the next export can start
    const next = await call();
    expect(next.status).toBe(200);
    await readDataset(next);
  });

  it("deadline: a final error line and no footer", async () => {
    const { admin, project } = await adminWorld();
    await createPage(project.id, 1);
    setExportLimitsForTest({ deadlineMs: -1 });
    asUser(admin);
    const { lines } = await readDataset(await call());
    expect(lines.map((l) => [l.t, l.code])).toEqual([["error", "DEADLINE"]]);
    expect(isExportRunning()).toBe(false);
  });
});
