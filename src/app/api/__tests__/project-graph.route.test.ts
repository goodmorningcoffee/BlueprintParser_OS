// @vitest-environment node
// [graph T8 2026-10-24] DB-backed proof for the knowledge graph's storage and read API, with S3
// replaced by an in-memory map: POST /api/admin/reprocess?scope=graph writes the graph + index under
// keys DERIVED from projects.data_url and ONLY the `knowledgeGraph` key into project_intelligence
// (user keys byte-identical); GET /api/projects/[id]/graph serves the index to a member, 404s a
// stranger, reports built:false for a project with no graph, and keeps view=full for admins.
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
import { GET as graphGET } from "@/app/api/projects/[id]/graph/route";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { graphIndexObjectKey, graphObjectKey } from "@/lib/knowledge-graph";
import { asUser, createCompany, createPage, createUser, createWorld, makeReq, params, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function drain(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const get = (publicId: string, qs = "") => graphGET(makeReq(`/api/projects/${publicId}/graph${qs}`, { method: "GET" }), params({ id: publicId }));

describe.skipIf(!dbUp)("knowledge graph: scope=graph + GET /api/projects/[id]/graph", () => {
  it("builds from stored rows into derived S3 keys and one jsonb key; members read the index", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const member = await createUser(company.id, { role: "user" });
    const userKeys = { classCsiOverrides: { door: "08 11 13" }, yoloTags: [{ a: 1 }], someFutureKey: true };
    await db.update(projects).set({ projectIntelligence: userKeys as any }).where(eq(projects.id, project.id));
    await createPage(project.id, 1, {
      drawingNumber: "G-001",
      pageIntelligence: { crossRefs: [
        { sourceText: "SEE SHEET A-101", targetDrawing: "A-101", refType: "sheet", bbox: [0.1, 0.1, 0.02, 0.01], confidence: 0.85 },
        { sourceText: "SEE SHEET Z-1", targetDrawing: "Z-1", refType: "sheet", bbox: [0.1, 0.2, 0.02, 0.01], confidence: 0.85 },
      ] } as any,
    });
    await createPage(project.id, 2, { drawingNumber: "A-101", textractData: { lines: [{ text: "3 WALL SECTION", bbox: [0.1, 0.9, 0.2, 0.01], confidence: 90, words: [] }], words: [] } as any });

    asUser(admin);
    const lines = await drain(await reprocessPOST(makeReq("/api/admin/reprocess?scope=graph", { method: "POST" })));
    expect(lines.at(-1)).toMatchObject({ type: "done", updated: 1, skipped: 0, errors: 0, total: 1, references: { total: 2, resolved: 1, unresolved: 1, ambiguous: 0 } });

    const [row] = await db.select({ dataUrl: projects.dataUrl, pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
    const pi = row.pi as Record<string, any>;
    expect(Object.keys(pi).sort()).toEqual(["classCsiOverrides", "knowledgeGraph", "someFutureKey", "yoloTags"]);
    expect(pi.classCsiOverrides).toEqual(userKeys.classCsiOverrides);
    expect(pi.knowledgeGraph).toMatchObject({ v: 1, stored: "s3", references: { total: 2, resolved: 1, unresolved: 1 }, nodes: { sheet: 2, detail: 1 } });
    expect(JSON.stringify(pi)).not.toContain(row.dataUrl!); // the summary never names the S3 prefix
    expect([...s3.keys()].sort()).toEqual([graphIndexObjectKey(row.dataUrl!), graphObjectKey(row.dataUrl!)].sort());

    asUser(member);
    const { status, body } = await readJson(await get(project.publicId));
    expect(status).toBe(200);
    expect(body.built).toBe(true);
    expect(body.summary.references).toMatchObject({ total: 2, resolved: 1 });
    expect(body.index.pages["1"].refersTo.map((l: any) => [l.sheet, l.page, l.status])).toEqual([["A-101", 2, "resolved"], ["Z-1", null, "unresolved"]]);
    expect(body.index.pages["2"].referencedBy).toEqual([expect.objectContaining({ page: 1, sheet: "G-001" })]);
    expect(body.index.unresolved).toEqual([expect.objectContaining({ fromPage: 1, sheet: "Z-1" })]);

    const pageView = (await readJson(await get(project.publicId, "?view=page&page=2"))).body;
    expect(pageView).toMatchObject({ built: true, page: 2 });
    expect(pageView.referencedBy).toHaveLength(1);
    expect(pageView.neighbourhood).toBeUndefined(); // served from the index: no full-graph read per request

    // the full graph (13.5 MB on the largest measured set) is admin / root only
    expect((await get(project.publicId, "?view=full")).status).toBe(403);
    asUser(admin);
    const full = (await readJson(await get(project.publicId, "?view=full"))).body;
    expect(full.graph.edges.filter((e: any) => e.type === "references")).toHaveLength(2);

    // a re-run rewrites the same two objects (idempotent, no new keys)
    asUser(admin);
    await drain(await reprocessPOST(makeReq("/api/admin/reprocess?scope=graph", { method: "POST" })));
    expect(s3.size).toBe(2);
  });

  it("built:false with no graph; a stranger gets the tenancy 404; signed out gets 401", async () => {
    const { company, project } = await createWorld();
    const member = await createUser(company.id, { role: "user" });
    asUser(member);
    expect(await readJson(await get(project.publicId))).toEqual({ status: 200, body: { built: false } });

    const other = await createCompany();
    const stranger = await createUser(other.id, { role: "admin" });
    asUser(stranger);
    expect((await get(project.publicId)).status).toBe(404);

    signedOut();
    expect((await get(project.publicId)).status).toBe(401);
  });
});
