// @vitest-environment node
// [feat 2026-10-22 annotation-cleanup] Admin › Data tools › Annotation cleanup — DB-backed.
// Root only; dry run counts and changes nothing; dedupe keeps the lowest id of each identical
// group; delete honours the source + project filters; user-made sources are excluded unless
// named; demo projects are never in scope; the typed phrase is enforced server-side.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { eq, inArray } from "drizzle-orm";
import { GET, POST } from "@/app/api/admin/annotation-cleanup/route";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import {
  asUser, createCompany, createPage, createProject, createUser, makeReq, publishDemoFixture, readJson, signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function world() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const root = await createUser(company.id, { isRootAdmin: true });
  const p1 = await createProject(company.id, admin.id);
  const p2 = await createProject(company.id, admin.id);
  return { company, admin, root, p1, p2 };
}

type Row = { name?: string; source: string; page?: number; box?: [number, number, number, number]; modelId?: number };
async function seed(projectId: number, rows: Row[]) {
  const inserted = await db.insert(annotations).values(rows.map((r) => {
    const [minX, minY, maxX, maxY] = r.box ?? [0.1, 0.1, 0.2, 0.2];
    return {
      name: r.name ?? "door", minX, minY, maxX, maxY, pageNumber: r.page ?? 1, threshold: 0.5,
      source: r.source, projectId, data: (r.modelId === undefined ? {} : { modelId: r.modelId }) as never,
    };
  })).returning({ id: annotations.id });
  return inserted.map((r) => r.id);
}

const rowsOf = (projectId: number) =>
  db.select({ id: annotations.id, source: annotations.source, name: annotations.name })
    .from(annotations).where(eq(annotations.projectId, projectId)).orderBy(annotations.id);

const post = (companyId: number, body: Record<string, unknown>) =>
  POST(makeReq(`/api/admin/annotation-cleanup?companyId=${companyId}`, { body })).then(readJson);

describe.skipIf(!dbUp)("admin annotation cleanup", () => {
  it("auth: signed-out 401, company admin 403 (GET and POST), root 200", async () => {
    const w = await world();
    signedOut();
    expect((await GET(makeReq(`/api/admin/annotation-cleanup?companyId=${w.company.id}`, { method: "GET" }))).status).toBe(401);
    asUser(w.admin);
    expect((await GET(makeReq(`/api/admin/annotation-cleanup?companyId=${w.company.id}`, { method: "GET" }))).status).toBe(403);
    expect((await post(w.company.id, { mode: "delete", all: true, dryRun: true })).status).toBe(403);
    asUser(w.root);
    expect((await GET(makeReq(`/api/admin/annotation-cleanup?companyId=${w.company.id}`, { method: "GET" }))).status).toBe(200);
  });

  it("GET lists non-demo projects with counts and flags user-made sources", async () => {
    const w = await world();
    const demo = await createProject(w.company.id, w.admin.id);
    await seed(w.p1.id, [{ source: "yolo" }, { source: "yolo" }, { source: "user" }, { source: "takeoff" }]);
    await seed(demo.id, [{ source: "yolo" }]);
    await publishDemoFixture(demo.id);
    asUser(w.root);
    const { status, body } = await readJson(await GET(makeReq(`/api/admin/annotation-cleanup?companyId=${w.company.id}`, { method: "GET" })));
    expect(status).toBe(200);
    expect(body.projects.map((p: { publicId: string }) => p.publicId).sort()).toEqual([w.p1.publicId, w.p2.publicId].sort());
    expect(body.projects.find((p: { publicId: string }) => p.publicId === w.p1.publicId).annotations).toBe(4);
    const bySource = Object.fromEntries(body.sources.map((s: { source: string; count: number; userMade: boolean }) => [s.source, s]));
    expect(bySource.yolo).toMatchObject({ count: 2, userMade: false });
    expect(bySource.user).toMatchObject({ count: 1, userMade: true });
    expect(bySource.takeoff).toMatchObject({ count: 1, userMade: true });
  });

  it("dry run counts per project + total and deletes nothing; user-drawn excluded by default", async () => {
    const w = await world();
    await seed(w.p1.id, [{ source: "yolo" }, { source: "shape-parse" }, { source: "user" }]);
    await seed(w.p2.id, [{ source: "yolo" }, { source: "takeoff" }]);
    asUser(w.root);
    const { status, body } = await post(w.company.id, { mode: "delete", all: true, dryRun: true });
    expect(status).toBe(200);
    expect(body.sources).toEqual(["shape-parse", "yolo"]);
    expect(body.total).toBe(3);
    expect(Object.fromEntries(body.projects.map((p: { publicId: string; annotations: number }) => [p.publicId, p.annotations])))
      .toEqual({ [w.p1.publicId]: 2, [w.p2.publicId]: 1 });
    expect(body.confirmPhrase).toBe("DELETE");
    expect(await rowsOf(w.p1.id)).toHaveLength(3);
    expect(await rowsOf(w.p2.id)).toHaveLength(2);
  });

  it("real run refuses without the typed phrase", async () => {
    const w = await world();
    await seed(w.p1.id, [{ source: "yolo" }]);
    asUser(w.root);
    const res = await post(w.company.id, { mode: "delete", all: true, dryRun: false, confirm: "delete" });
    expect(res.status).toBe(400);
    expect(await rowsOf(w.p1.id)).toHaveLength(1);
  });

  it("delete respects the source filter and the project filter; user-drawn survives by default", async () => {
    const w = await world();
    await seed(w.p1.id, [{ source: "yolo" }, { source: "shape-parse" }, { source: "user" }]);
    await seed(w.p2.id, [{ source: "yolo" }, { source: "shape-parse" }]);
    asUser(w.root);
    const res = await post(w.company.id, {
      mode: "delete", projectPublicIds: [w.p1.publicId], sources: ["yolo"], dryRun: false, confirm: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect((await rowsOf(w.p1.id)).map((r) => r.source).sort()).toEqual(["shape-parse", "user"]);
    expect(await rowsOf(w.p2.id)).toHaveLength(2);

    // default sources (none named) → everything except user-made, in every selected project
    const all = await post(w.company.id, { mode: "delete", all: true, dryRun: false, confirm: "DELETE" });
    expect(all.body.total).toBe(3);
    expect((await rowsOf(w.p1.id)).map((r) => r.source)).toEqual(["user"]);
    expect(await rowsOf(w.p2.id)).toHaveLength(0);
  });

  it("dedupe keeps exactly one (the lowest id) of each identical group; near-identical rows survive", async () => {
    const w = await world();
    const ids = await seed(w.p1.id, [
      { source: "yolo", modelId: 7 }, { source: "yolo", modelId: 7 }, { source: "yolo", modelId: 7 }, // 3 identical
      { source: "yolo", modelId: 8 }, // other model
      { source: "yolo", modelId: 7, box: [0.1, 0.1, 0.2, 0.25] }, // other box
      { source: "yolo", modelId: 7, page: 2 }, // other page
      { source: "shape-parse" }, { source: "shape-parse" }, // identical, no modelId
      { source: "user" }, { source: "user" }, // identical but user-drawn: excluded by default
    ]);
    asUser(w.root);
    const dry = await post(w.company.id, { mode: "dedupe", projectPublicIds: [w.p1.publicId], sources: ["yolo", "shape-parse"], dryRun: true });
    expect(dry.body.total).toBe(3);
    expect(dry.body.confirmPhrase).toBe("DEDUPE");
    const run = await post(w.company.id, {
      mode: "dedupe", projectPublicIds: [w.p1.publicId], sources: ["yolo", "shape-parse"], dryRun: false, confirm: "DEDUPE",
    });
    expect(run.body.total).toBe(3);
    const left = (await rowsOf(w.p1.id)).map((r) => r.id);
    expect(left).toEqual([ids[0], ids[3], ids[4], ids[5], ids[6], ids[8], ids[9]]);
    // idempotent: a second run removes nothing
    const again = await post(w.company.id, {
      mode: "dedupe", projectPublicIds: [w.p1.publicId], sources: ["yolo", "shape-parse"], dryRun: false, confirm: "DEDUPE",
    });
    expect(again.body.total).toBe(0);
  });

  it("clearPageCsi (delete mode only) nulls pages.csiCodes of the selected projects only", async () => {
    const w = await world();
    const code = [{ code: "08 11 13", description: "From YOLO class config", trade: "", division: "08" }] as never;
    const a = await createPage(w.p1.id, 1, { csiCodes: code });
    const b = await createPage(w.p2.id, 1, { csiCodes: code });
    await seed(w.p1.id, [{ source: "yolo" }]);
    asUser(w.root);
    const dry = await post(w.company.id, { mode: "delete", projectPublicIds: [w.p1.publicId], clearPageCsi: true, dryRun: true });
    expect(dry.body).toMatchObject({ total: 1, pagesCsiCleared: 1, clearPageCsi: true });
    await post(w.company.id, { mode: "delete", projectPublicIds: [w.p1.publicId], clearPageCsi: true, dryRun: false, confirm: "DELETE" });
    const rows = await db.select({ id: pages.id, csiCodes: pages.csiCodes }).from(pages).where(inArray(pages.id, [a.id, b.id]));
    expect(rows.find((r) => r.id === a.id)?.csiCodes).toBeNull();
    expect(rows.find((r) => r.id === b.id)?.csiCodes).not.toBeNull();
  });

  it("demo projects are never in scope (all → skipped; named → 404)", async () => {
    const w = await world();
    await seed(w.p2.id, [{ source: "yolo" }]);
    await publishDemoFixture(w.p2.id);
    asUser(w.root);
    const all = await post(w.company.id, { mode: "delete", all: true, dryRun: false, confirm: "DELETE" });
    expect(all.status).toBe(200);
    expect(all.body.projects.map((p: { publicId: string }) => p.publicId)).not.toContain(w.p2.publicId);
    expect(await rowsOf(w.p2.id)).toHaveLength(1);
    const named = await post(w.company.id, { mode: "delete", projectPublicIds: [w.p2.publicId], dryRun: true });
    expect(named.status).toBe(404);
  });
});
