// @vitest-environment node
// Admin › Data tools › Duplicates — scan / apply / restore / page-flags (PLAN §2.4).
// Synthetic page text only (src/lib/__tests__/page-dedup-fixtures.ts).
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { and, eq } from "drizzle-orm";
import { POST as scanPOST } from "@/app/api/admin/duplicates/scan/route";
import { POST as applyPOST } from "@/app/api/admin/duplicates/apply/route";
import { POST as restorePOST } from "@/app/api/admin/duplicates/restore/route";
import { GET as flagsGET } from "@/app/api/projects/[id]/page-flags/route";
import { PATCH as intelligencePATCH } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { annotations, auditLog, pages, projectMutationLeases, projects } from "@/lib/db/schema";
import { body, page, tweak } from "@/lib/__tests__/page-dedup-fixtures";
import {
  asUser, createCompany, createPage, createProject, createUser, makeReq, params, publishDemoFixture, readJson, signedOut,
} from "@/test/harness";

import { planHides } from "@/server/services/page-duplicates-apply";
import type { DuplicateReport } from "@/lib/page-dedup";

const dbUp = inject("dbUp") as boolean;

async function world() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

/** `count` distinct sheets, then `copies - 1` exact copies of the whole set. */
async function seedRepeated(projectId: number, count: number, seed: number, copies = 2) {
  for (let c = 0; c < copies; c++) {
    for (let i = 0; i < count; i++) {
      const p = page(c * count + i + 1, `A-${101 + i}`, body(seed + i));
      await createPage(projectId, p.pageNumber, { rawText: p.rawText, drawingNumber: p.drawingNumber });
    }
  }
}

/** Permit set then IFC re-issue with one changed note line on every other sheet. */
async function seedRevision(projectId: number, count: number, seed: number) {
  for (let i = 0; i < count; i++) {
    const lines = body(seed + i);
    const permit = page(i + 1, `A-${201 + i}`, lines);
    const ifc = page(count + i + 1, `A-${201 + i}`, i % 2 === 0 ? tweak(lines, 1, "ifc") : lines);
    await createPage(projectId, permit.pageNumber, { rawText: permit.rawText, drawingNumber: permit.drawingNumber });
    await createPage(projectId, ifc.pageNumber, { rawText: ifc.rawText, drawingNumber: ifc.drawingNumber });
  }
}

type Line = { t: string } & Record<string, any>;
async function scan(bodyIn: unknown, qs = ""): Promise<{ status: number; lines: Line[]; json?: any }> {
  const res = await scanPOST(makeReq(`/api/admin/duplicates/scan${qs}`, { body: bodyIn }));
  if (res.headers.get("content-type")?.includes("ndjson")) {
    const text = await res.text();
    return { status: res.status, lines: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  }
  return { status: res.status, lines: [], json: await res.json() };
}
const projectLine = (lines: Line[], publicId: string) => lines.find((l) => l.t === "project" && l.project.publicId === publicId);
const apply = async (b: unknown, qs = "") => readJson(await applyPOST(makeReq(`/api/admin/duplicates/apply${qs}`, { body: b })));
const restore = async (b: unknown, qs = "") => readJson(await restorePOST(makeReq(`/api/admin/duplicates/restore${qs}`, { body: b })));

async function marks(projectId: number) {
  const rows = await db.select({ n: pages.pageNumber, pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, projectId));
  const out: Record<number, any> = {};
  for (const r of rows) {
    const mark = (r.pi as Record<string, unknown> | null)?.duplicateOf;
    if (mark) out[r.n] = mark;
  }
  return out;
}

async function scanDigest(publicId: string): Promise<string> {
  const { lines } = await scan({ projectPublicIds: [publicId] });
  return projectLine(lines, publicId)!.reportDigest;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin duplicates — auth + tenancy", () => {
  it("signed-out 401 and member 403 on scan / apply / restore", async () => {
    const { member } = await world();
    const any = { projectPublicId: "00000000-0000-4000-8000-000000000000" };
    expect((await scan({ all: true })).status).toBe(401);
    expect((await apply(any)).status).toBe(401);
    expect((await restore(any)).status).toBe(401);
    asUser(member);
    expect((await scan({ all: true })).status).toBe(403);
    expect((await apply(any)).status).toBe(403);
    expect((await restore(any)).status).toBe(403);
  });

  it("company admin: foreign project 404, foreign companyId 403; root may pick a company", async () => {
    const a = await world();
    const b = await world();
    const foreign = await createProject(b.company.id, b.admin.id);
    await seedRepeated(foreign.id, 3, 10);
    asUser(a.admin);
    expect((await scan({ projectPublicIds: [foreign.publicId] })).status).toBe(404);
    expect((await scan({ all: true }, `?companyId=${b.company.id}`)).status).toBe(403);
    expect((await apply({ projectPublicId: foreign.publicId, reportDigest: "0".repeat(64), tiers: ["exact"] })).status).toBe(404);
    expect((await restore({ projectPublicId: foreign.publicId })).status).toBe(404);
    const own = await scan({ all: true });
    expect(own.lines.some((l) => l.project?.publicId === foreign.publicId)).toBe(false);
    asUser(a.root);
    const rootScan = await scan({ all: true }, `?companyId=${b.company.id}`);
    expect(rootScan.status).toBe(200);
    expect(projectLine(rootScan.lines, foreign.publicId)?.counts.exact).toBe(3);
  });
});

describe.skipIf(!dbUp)("admin duplicates — scan", () => {
  it("streams start / project / done, changes nothing, reports demo and unfinished projects as skipped", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 4, 100);
    const demo = await createProject(company.id, admin.id);
    await seedRepeated(demo.id, 3, 150);
    await publishDemoFixture(demo.id);
    const busy = await createProject(company.id, admin.id, { status: "processing" });
    asUser(admin);
    const { status, lines } = await scan({ all: true });
    expect(status).toBe(200);
    expect(lines[0]).toMatchObject({ t: "start", projects: 3 });
    expect(lines.at(-1)).toMatchObject({ t: "done", scanned: 1 });
    const line = projectLine(lines, p.publicId)!;
    expect(line.reportDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(line.counts).toMatchObject({ pages: 8, exact: 4, blocks: 1 });
    expect(line.blocks[0]).toMatchObject({ start: 1, offset: 4, length: 4, tier: "exact" });
    expect(line.thumbnailBase).toBe(`/api/project-assets/${p.publicId}/thumbnails`);
    const skipped = lines.filter((l) => l.t === "skipped").map((l) => l.project.publicId);
    expect(skipped.sort()).toEqual([demo.publicId, busy.publicId].sort());
    expect(await marks(p.id)).toEqual({});
  });

  it("[fix 2026-10-22] counts surplus page rows sharing (project, page number) — skipped projects too; read-only", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 3, 300);
    await createPage(p.id, 2, { rawText: "dup row" });
    await createPage(p.id, 2, { rawText: "dup row again" });
    await createPage(p.id, 5, { rawText: "dup row" });
    const busy = await createProject(company.id, admin.id, { status: "processing" });
    await createPage(busy.id, 1, {});
    await createPage(busy.id, 1, {});
    const clean = await createProject(company.id, admin.id);
    await seedRepeated(clean.id, 2, 400);
    asUser(admin);
    const before = (await db.select({ id: pages.id }).from(pages).where(eq(pages.projectId, p.id))).length;
    const all = (await scan({ all: true })).lines.find((l) => l.t === "duplicatePageRows")!;
    expect(all.total).toBe(4);
    expect(all.projects).toEqual([
      { publicId: p.publicId, name: p.name, rows: 3 },
      { publicId: busy.publicId, name: busy.name, rows: 1 },
    ]);
    const one = (await scan({ projectPublicIds: [clean.publicId] })).lines.find((l) => l.t === "duplicatePageRows")!;
    expect(one).toMatchObject({ total: 0, projects: [] });
    expect((await db.select({ id: pages.id }).from(pages).where(eq(pages.projectId, p.id))).length).toBe(before);
  });

  it("company scan reports a page-for-page cross-project copy", async () => {
    const { company, admin } = await world();
    const a = await createProject(company.id, admin.id);
    const b = await createProject(company.id, admin.id);
    await seedRepeated(a.id, 5, 200, 1);
    await seedRepeated(b.id, 5, 200, 1);
    asUser(admin);
    const { lines } = await scan({ all: true });
    const cross = lines.find((l) => l.t === "crossProject");
    expect(cross?.pairs).toEqual([{ a: a.publicId, b: b.publicId, shared: 5, bPages: 5, aPages: 5, copy: true }]);
  });
});

describe.skipIf(!dbUp)("admin duplicates — apply / restore", () => {
  it("apply exact hides the later copies with the mark; restore unmarks; both audited", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 3, 300);
    asUser(admin);
    const digest = await scanDigest(p.publicId);
    const r = await apply({ projectPublicId: p.publicId, reportDigest: digest, tiers: ["exact"] });
    expect(r.status).toBe(200);
    expect(r.body.hidden).toEqual([
      { page: 4, canonical: 1, tier: "exact" },
      { page: 5, canonical: 2, tier: "exact" },
      { page: 6, canonical: 3, tier: "exact" },
    ]);
    const m = await marks(p.id);
    expect(Object.keys(m).map(Number)).toEqual([4, 5, 6]);
    expect(m[4]).toMatchObject({ v: 1, pageNumber: 1, tier: "exact", score: 1, by: admin.id });
    expect(typeof m[4].hiddenAt).toBe("string");
    expect(typeof m[4].scannedAt).toBe("string");
    // [fix 2026-10-24 DOUBLE_BACK] hiding recomputes the project analysis + summaries over the VISIBLE pages
    const analysis = async () => (await db.select({ s: projects.projectSummary, pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, p.id)))[0];
    const hidden3 = await analysis();
    expect(hidden3.s).toContain("PROJECT OVERVIEW: 3 sheets");
    expect((hidden3.pi as Record<string, unknown>).summaries).toBeDefined();
    // digest is unchanged by the marks, so a second apply skips "already hidden"
    const again = await apply({ projectPublicId: p.publicId, reportDigest: digest, tiers: ["exact"] });
    expect(again.body.hidden).toEqual([]);
    expect(again.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(["already hidden", "already hidden", "already hidden"]);
    const res = await restore({ projectPublicId: p.publicId, pages: [5] });
    expect(res.body.restored).toEqual([5]);
    expect(Object.keys(await marks(p.id)).map(Number)).toEqual([4, 6]);
    expect((await analysis()).s).toContain("PROJECT OVERVIEW: 4 sheets");
    expect((await restore({ projectPublicId: p.publicId })).body.restored).toEqual([4, 6]);
    expect(await marks(p.id)).toEqual({});
    expect((await analysis()).s).toContain("PROJECT OVERVIEW: 6 sheets");
    await vi.waitFor(async () => {
      const rows = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.userId, admin.id));
      expect(rows.map((x) => x.action).sort()).toEqual(
        ["admin.duplicates.apply", "admin.duplicates.apply", "admin.duplicates.restore", "admin.duplicates.restore"],
      );
    });
  });

  it("digest mismatch → 409; near / run in bulk → 400; unknown block → 400", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 3, 400);
    asUser(admin);
    const digest = await scanDigest(p.publicId);
    expect((await apply({ projectPublicId: p.publicId, reportDigest: "a".repeat(64), tiers: ["exact"] })).status).toBe(409);
    expect((await apply({ projectPublicId: p.publicId, reportDigest: digest, tiers: ["near"] })).status).toBe(400);
    expect((await apply({ projectPublicId: p.publicId, reportDigest: digest, tiers: ["run"] })).status).toBe(400);
    expect((await apply({ projectPublicId: p.publicId, reportDigest: digest, blocks: ["b9d9l9"] })).status).toBe(400);
    expect((await apply({ projectPublicId: p.publicId, reportDigest: digest })).status).toBe(400);
    expect(await marks(p.id)).toEqual({});
  });

  it("revision set: near block only by explicit block; keep latest hides the permit copy", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRevision(p.id, 4, 500);
    asUser(admin);
    const { lines } = await scan({ projectPublicIds: [p.publicId] });
    const line = projectLine(lines, p.publicId)!;
    expect(line.blocks).toHaveLength(1);
    expect(line.blocks[0]).toMatchObject({ tier: "near", label: "likely revision set" });
    expect(line.counts.exact).toBe(0);
    expect(line.pairs.find((x: any) => !x.identical).diff.length).toBeGreaterThan(0);
    expect(line.bulkHold).toBe("holds a likely revision set");
    const bulk = await apply({ projectPublicId: p.publicId, reportDigest: line.reportDigest, tiers: ["exact"] });
    expect(bulk.status).toBe(409);
    expect(await marks(p.id)).toEqual({});
    const r = await apply({ projectPublicId: p.publicId, reportDigest: line.reportDigest, blocks: [line.blocks[0].id], keep: "latest" });
    expect(r.status).toBe(200);
    expect(r.body.hidden.map((h: any) => [h.page, h.canonical, h.tier])).toEqual([[1, 5, "near"], [2, 6, "near"], [3, 7, "near"], [4, 8, "near"]]);
  });

  it("verify-r3: a re-issue with an inserted sheet holds bulk (single and all:true); its exact block goes one at a time", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    const sheet = (i: number) => page(0, `A-${301 + i}`, body(1300 + i));
    const ifcSheets = [0, 1, 2, 3, 4, 50, 5, 6, 7, 8, 9].map(sheet);
    ifcSheets[0] = page(0, "A-301", tweak(body(1300), 2, "ifc"));
    const all = [...Array.from({ length: 10 }, (_, i) => sheet(i)), ...ifcSheets];
    for (const [i, s] of all.entries()) await createPage(p.id, i + 1, { rawText: s.rawText, drawingNumber: s.drawingNumber });
    asUser(admin);
    const line = projectLine((await scan({ projectPublicIds: [p.publicId] })).lines, p.publicId)!;
    expect(line.blocks.map((b: any) => [b.id, b.tier])).toEqual([["b1d10l5", "near"], ["b6d11l5", "exact"]]);
    expect(line.bulkHold).toBe("holds a likely revision set");
    const one = await apply({ projectPublicId: p.publicId, reportDigest: line.reportDigest, tiers: ["exact"] });
    expect(one.status).toBe(409);
    expect(one.body.error.message).toContain("Bulk removal is off for this project");
    const many = await apply({ all: true, tiers: ["exact"], digests: { [p.publicId]: line.reportDigest } });
    expect(many.body.results).toEqual([{ projectPublicId: p.publicId, skipped: expect.stringContaining("Bulk removal is off") }]);
    expect(await marks(p.id)).toEqual({});
    const block = await apply({ projectPublicId: p.publicId, reportDigest: line.reportDigest, blocks: ["b6d11l5"] });
    expect(block.body.hidden.map((h: any) => [h.page, h.canonical])).toEqual([[17, 6], [18, 7], [19, 8], [20, 9], [21, 10]]);
  });

  it("skips pages carrying human work; machine annotations do not block", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 3, 600);
    const ann = { minX: 0, maxX: 1, minY: 0, maxY: 1, projectId: p.id };
    await db.insert(annotations).values({ ...ann, name: "markup", pageNumber: 4, source: "user" });
    await db.insert(annotations).values({ ...ann, name: "det", pageNumber: 5, source: "yolo" });
    asUser(admin);
    const r = await apply({ projectPublicId: p.publicId, reportDigest: await scanDigest(p.publicId), tiers: ["exact"] });
    expect(r.body.hidden.map((h: any) => h.page)).toEqual([5, 6]);
    expect(r.body.skipped).toEqual([{ page: 4, reason: "has your work" }]);
  });

  it("an active lease (yolo-load) makes apply AND restore return busy", async () => {
    const { company, admin } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 3, 700);
    asUser(admin);
    const digest = await scanDigest(p.publicId);
    await db.insert(projectMutationLeases).values({
      projectId: p.id, lifecycleEpoch: p.lifecycleEpoch, kind: "yolo-load", expiresAt: new Date(Date.now() - 60_000),
    });
    const a = await apply({ projectPublicId: p.publicId, reportDigest: digest, tiers: ["exact"] });
    expect(a.status).toBe(409);
    expect(a.body.error.message).toMatch(/busy/);
    const r = await restore({ projectPublicId: p.publicId });
    expect(r.status).toBe(409);
    expect(await marks(p.id)).toEqual({});
  });

  it("demo and processing projects are refused", async () => {
    const { company, admin } = await world();
    const demo = await createProject(company.id, admin.id);
    await seedRepeated(demo.id, 3, 800);
    await publishDemoFixture(demo.id);
    const processing = await createProject(company.id, admin.id, { status: "processing" });
    await seedRepeated(processing.id, 3, 850);
    asUser(admin);
    const d = "b".repeat(64);
    expect((await apply({ projectPublicId: demo.publicId, reportDigest: d, tiers: ["exact"] })).status).toBe(403);
    expect((await apply({ projectPublicId: processing.publicId, reportDigest: d, tiers: ["exact"] })).status).toBe(409);
    expect((await restore({ projectPublicId: demo.publicId })).status).toBe(403);
    expect(await marks(demo.id)).toEqual({});
  });

  it("all:true touches only listed projects; a changed project is skipped; foreign ids are not found", async () => {
    const { company, admin } = await world();
    const other = await world();
    const listed = await createProject(company.id, admin.id);
    const changed = await createProject(company.id, admin.id);
    const unlisted = await createProject(company.id, admin.id);
    const foreign = await createProject(other.company.id, other.admin.id);
    for (const [proj, seed] of [[listed, 900], [changed, 950], [unlisted, 980], [foreign, 990]] as const) await seedRepeated(proj.id, 3, seed);
    asUser(admin);
    const { lines } = await scan({ all: true });
    const digests = {
      [listed.publicId]: projectLine(lines, listed.publicId)!.reportDigest,
      [changed.publicId]: projectLine(lines, changed.publicId)!.reportDigest,
      [foreign.publicId]: "c".repeat(64),
    };
    await createPage(changed.id, 7, { rawText: page(7, "A-101", body(950)).rawText, drawingNumber: "A-101" });
    expect((await apply({ all: true, tiers: ["exact"] })).status).toBe(400);
    expect((await apply({ all: true, tiers: ["exact"], digests, blocks: ["b1d3l3"] })).status).toBe(400);
    const r = await apply({ all: true, tiers: ["exact"], digests });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.results.map((x: any) => [x.projectPublicId, x]));
    expect(byId[listed.publicId].hidden).toHaveLength(3);
    expect(byId[changed.publicId].skipped).toBe("changed since scan");
    expect(byId[foreign.publicId].skipped).toBe("not found");
    expect(await marks(unlisted.id)).toEqual({});
    expect(await marks(changed.id)).toEqual({});
    expect(await marks(foreign.id)).toEqual({});
  });
});

describe.skipIf(!dbUp)("hidden duplicates — viewer flags + server-owned mark", () => {
  it("page-flags lists hidden pages for members; other companies 404", async () => {
    const { company, admin, member } = await world();
    const stranger = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 3, 1000);
    asUser(admin);
    await apply({ projectPublicId: p.publicId, reportDigest: await scanDigest(p.publicId), tiers: ["exact"] });
    asUser(member);
    const flags = await readJson(await flagsGET(makeReq(`/api/projects/${p.publicId}/page-flags`, { method: "GET" }), params({ id: p.publicId })));
    expect(flags.status).toBe(200);
    expect(flags.body.hidden).toEqual([
      { pageNumber: 4, duplicateOf: 1, tier: "exact" },
      { pageNumber: 5, duplicateOf: 2, tier: "exact" },
      { pageNumber: 6, duplicateOf: 3, tier: "exact" },
    ]);
    asUser(stranger.member);
    const denied = await flagsGET(makeReq(`/api/projects/${p.publicId}/page-flags`, { method: "GET" }), params({ id: p.publicId }));
    expect(denied.status).toBe(404);
  });

  it("PATCH /api/pages/intelligence keeps the mark (stale object, explicit null, forged mark)", async () => {
    const { company, admin, member } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 3, 1100);
    asUser(admin);
    await apply({ projectPublicId: p.publicId, reportDigest: await scanDigest(p.publicId), tiers: ["exact"] });
    const before = (await marks(p.id))[4];
    asUser(member);
    const patch = (intelligence: unknown, pageNumber = 4) =>
      intelligencePATCH(makeReq("/api/pages/intelligence", { method: "PATCH", body: { publicId: p.publicId, pageNumber, intelligence } }));
    expect((await patch({ classification: "plan" })).status).toBe(200);
    expect((await patch({ duplicateOf: null })).status).toBe(200);
    expect((await marks(p.id))[4]).toEqual(before);
    await patch({ duplicateOf: { v: 1, pageNumber: 2, tier: "exact", hiddenAt: "x" } }, 2);
    expect((await marks(p.id))[2]).toBeUndefined();
    const [row] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(and(eq(pages.projectId, p.id), eq(pages.pageNumber, 4)));
    expect((row.pi as Record<string, unknown>).classification).toBe("plan");
  });

  it("[tiles T9 fix round] PATCH /api/pages/intelligence can neither set nor clear the server-owned tiles pointer", async () => {
    const { company, admin, member } = await world();
    const p = await createProject(company.id, admin.id);
    await seedRepeated(p.id, 2, 1200);
    const tiles = { v: 1, width: 10800, height: 7200, overlap: 0.2, levels: [{ size: 3600, rows: 3, cols: 4, tiles: 12 }], tiledAt: "2026-10-24T00:00:00.000Z" };
    await db.update(pages).set({ pageIntelligence: { tiles, classification: "old" } as never }).where(and(eq(pages.projectId, p.id), eq(pages.pageNumber, 1)));
    const pi = async (pageNumber: number) =>
      (await db.select({ pi: pages.pageIntelligence }).from(pages).where(and(eq(pages.projectId, p.id), eq(pages.pageNumber, pageNumber))))[0].pi as Record<string, unknown> | null;
    asUser(member);
    const patch = (intelligence: unknown, pageNumber: number) =>
      intelligencePATCH(makeReq("/api/pages/intelligence", { method: "PATCH", body: { publicId: p.publicId, pageNumber, intelligence } }));
    // forge: a key under another prefix (the pre-fix delete path trusted it)
    expect((await patch({ tiles: { ...tiles, manifestKey: "other-company/x/original.pdf" }, classification: "plan" }, 1)).status).toBe(200);
    expect(await pi(1)).toEqual({ tiles, classification: "plan" });
    // clear
    expect((await patch({ tiles: null }, 1)).status).toBe(200);
    expect((await pi(1))?.tiles).toEqual(tiles);
    // set on a page that has none
    expect((await patch({ tiles }, 2)).status).toBe(200);
    expect((await pi(2))?.tiles).toBeUndefined();
  });
});

describe("planHides (pure)", () => {
  const pair = (page: number, canonical: number, tier: "exact" | "run", blockId: string | null) =>
    ({ page, canonical, tier, content: 1, full: tier === "exact" ? 1 : 0.998, sameNumber: true, identical: tier === "exact", blockId });
  const report: DuplicateReport = {
    counts: { pages: 8, blank: 0, exact: 1, run: 3, near: 0, possible: 0, blocks: 1 },
    blocks: [{ id: "b1d3l3", start: 1, offset: 3, length: 3, tier: "run", label: "repeat set", minContent: 1, minFull: 0.998 }],
    pairs: [pair(4, 1, "run", "b1d3l3"), pair(5, 2, "run", "b1d3l3"), pair(6, 3, "run", "b1d3l3"), pair(8, 7, "exact", null)],
    bulkHold: null,
  };
  it("a bulk tier whose blocks keep the latest copy (run) hides the EARLIER copy; exact lone pairs hide the later page", () => {
    // run is not a bulk tier while RUN_BULK_ENABLED=false (validateTiers 400s it); planHides is
    // what bulk will do once it flips, so it must never hide the copy a revision may live in
    expect(planHides(report, ["run", "exact"], [], undefined).map((h) => [h.page, h.canonical, h.tier])).toEqual([
      [1, 4, "run"], [2, 5, "run"], [3, 6, "run"], [8, 7, "exact"],
    ]);
    expect(planHides(report, [], ["b1d3l3"], "earliest").map((h) => h.page)).toEqual([4, 5, 6]);
  });
  it("a held report refuses every bulk tier (409) but still resolves a named block", () => {
    const held: DuplicateReport = { ...report, bulkHold: "holds a likely revision set" };
    expect(() => planHides(held, ["exact"], [], undefined)).toThrow(/Bulk removal is off for this project: it holds a likely revision set/);
    expect(planHides(held, [], ["b1d3l3"], "earliest").map((h) => h.page)).toEqual([4, 5, 6]);
  });
});
