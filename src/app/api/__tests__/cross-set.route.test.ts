// @vitest-environment node
// [cross-set F3 2026-10-24] DB-backed proof for the cross-set pass and its read API, with S3 replaced by
// an in-memory map: POST /api/admin/reprocess?scope=cross-set links two sets of the admin's company
// (identical text → twin_of), NEVER a set of another company that carries the same page, writes the
// file under a key DERIVED from projects.data_url and ONLY the `crossSetLinks` key into
// project_intelligence; GET /api/projects/[id]/cross-set names the target for a member, 404s a stranger,
// and reports built:false before any pass.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3 = new Map<string, Buffer>();
vi.mock("@/lib/s3", () => ({
  S3_BUCKET: "test-bucket",
  uploadToS3: async (key: string, body: Buffer) => { s3.set(key, body); },
  downloadFromS3: async (key: string) => {
    const hit = s3.get(key);
    if (!hit) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    return hit;
  },
}));

import { POST as reprocessPOST } from "@/app/api/admin/reprocess/route";
import { GET as crossSetGET } from "@/app/api/projects/[id]/cross-set/route";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { crossSetObjectKey } from "@/lib/knowledge-graph";
import { asUser, createCompany, createPage, createProject, createUser, createWorld, makeReq, params, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function drain(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const get = (publicId: string, qs = "") => crossSetGET(makeReq(`/api/projects/${publicId}/cross-set${qs}`, { method: "GET" }), params({ id: publicId }));
const text = (seed: number) => Array.from({ length: 40 }, (_, i) => `line${seed} ${i} alpha${seed} beta${seed} gamma${seed} delta${seed}`).join("\n");

describe.skipIf(!dbUp)("cross-set links: scope=cross-set + GET /api/projects/[id]/cross-set", () => {
  it("links the company's two sets, never the other company's, under derived keys and one jsonb key", async () => {
    const { company, project: older, user } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const member = await createUser(company.id, { role: "user" });
    const newer = await createProject(company.id, user.id, { createdAt: new Date(Date.now() + 60_000) });
    const other = await createCompany();
    const otherUser = await createUser(other.id, { role: "admin" });
    const foreign = await createProject(other.id, otherUser.id);
    for (const [p, n] of [[older, 1], [newer, 4], [foreign, 1]] as const) {
      await createPage(p.id, n, { drawingNumber: "A-101", rawText: text(1) });
      await createPage(p.id, n + 1, { drawingNumber: "A-102", rawText: text(100 + p.id) });
    }
    const userKeys = { classCsiOverrides: { door: "08 11 13" }, someFutureKey: true };
    await db.update(projects).set({ projectIntelligence: userKeys as any }).where(eq(projects.id, newer.id));

    asUser(admin);
    const lines = await drain(await reprocessPOST(makeReq("/api/admin/reprocess?scope=cross-set", { method: "POST" })));
    expect(lines.at(-1)).toMatchObject({ type: "done", updated: 2, skipped: 0, errors: 0, total: 2, companyProjects: 2, links: { twin: 1, revision: 0, copy: 0 } });

    const [row] = await db.select({ dataUrl: projects.dataUrl, pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, newer.id));
    const pi = row.pi as Record<string, any>;
    expect(Object.keys(pi).sort()).toEqual(["classCsiOverrides", "crossSetLinks", "someFutureKey"]);
    expect(pi.classCsiOverrides).toEqual(userKeys.classCsiOverrides);
    expect(pi.crossSetLinks).toMatchObject({ v: 1, linkedProjects: [{ publicId: older.publicId, twins: 1, revisions: 0, copy: null }] });
    expect(JSON.stringify(pi)).not.toContain(row.dataUrl!);
    expect(JSON.stringify(pi)).not.toContain(older.name);
    expect([...s3.keys()].sort()).toEqual([crossSetObjectKey(older.dataUrl), crossSetObjectKey(newer.dataUrl)].sort());
    expect(s3.has(crossSetObjectKey(foreign.dataUrl))).toBe(false);
    expect(JSON.stringify([...s3.values()].map(String))).not.toContain(foreign.publicId);

    asUser(member);
    const { status, body } = await readJson(await get(newer.publicId));
    expect(status).toBe(200);
    expect(body.built).toBe(true);
    expect(body.pages["4"]).toEqual([{ kind: "twin_of", project: { publicId: older.publicId, name: older.name }, page: 1, sheet: "A-101", confidence: 1, direction: "older" }]);
    expect(body.pages["5"]).toBeUndefined(); // A-102: different content → no link on the number alone
    const one = (await readJson(await get(older.publicId, "?page=1"))).body;
    expect(one).toMatchObject({ built: true, page: 1 });
    expect(one.links[0]).toMatchObject({ project: { publicId: newer.publicId }, direction: "newer" });

    // the other company's admin: tenancy 404 on the project itself; its own project has no pass and no links
    asUser(otherUser);
    expect((await get(newer.publicId)).status).toBe(404);
    expect(await readJson(await get(foreign.publicId))).toEqual({ status: 200, body: { built: false } });
  });

  it("built:false with no pass; a stranger gets the tenancy 404; signed out gets 401", async () => {
    const { company, project } = await createWorld();
    const member = await createUser(company.id, { role: "user" });
    asUser(member);
    expect(await readJson(await get(project.publicId))).toEqual({ status: 200, body: { built: false } });
    const other = await createCompany();
    asUser(await createUser(other.id, { role: "admin" }));
    expect((await get(project.publicId)).status).toBe(404);
    signedOut();
    expect((await get(project.publicId)).status).toBe(401);
  });
});
