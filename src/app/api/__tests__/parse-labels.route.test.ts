// @vitest-environment node
// [table pipeline WP-2.F] GET / POST / DELETE /api/projects/[id]/parse-labels — the verdict bar's ✓/✗.
//   • the label's machine snapshot + snapshotHash are computed by the SERVER from the stored region (forged
//     fields ignored), and the proposal link comes from the region's save-time accept (K58);
//   • two tabs: concurrent verdicts on two regions both survive; the same region twice → one key;
//   • a verdict survives reload (GET), the page window never ships it, the generic PATCH cannot touch it;
//   • an edit-save after ✗ reads back as `corrected` (C3-m4), with the stored snapshot as machine;
//   • demo refused for every method and role; a labelled page is human work for the duplicate hide.
// All strings are synthetic.
import { describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { DELETE, GET, POST } from "@/app/api/projects/[id]/parse-labels/route";
import { POST as promotePOST } from "@/app/api/regions/promote/route";
import { PATCH as intelligencePATCH } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { serializePageWindowIntelligence } from "@/server/services/page-window-serialization";
import { humanWorkPages } from "@/server/services/page-duplicates-apply";
import { regionSnapshot, snapshotHashOf } from "@/server/services/parse-labels";
import {
  asUser,
  createCompany,
  createPage,
  createUser,
  createWorld,
  makeReq,
  params,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const REGION_A = {
  id: "parsed-a",
  type: "schedule",
  category: "synthetic-schedule",
  bbox: [0.1, 0.1, 0.5, 0.4],
  confidence: 0.9,
  data: {
    headers: ["Mark", "Width"],
    rows: [{ Mark: "QX-1", Width: "10" }, { Mark: "QX-2", Width: "20" }],
    tagColumn: "Mark",
    rowCount: 2,
    columnCount: 2,
    colBoundaries: [0.1, 0.3, 0.5],
    rowBoundaries: [0.1, 0.2, 0.3, 0.4],
  },
};
const REGION_B = {
  id: "parsed-b",
  type: "keynote",
  category: "synthetic-keynotes",
  bbox: [0.6, 0.1, 0.9, 0.4],
  confidence: 0.9,
  data: { keynotes: [{ key: "1", description: "Lorem" }, { key: "2", description: "Ipsum" }], isPageSpecific: true },
};

const url = (publicId: string, q = "") => `/api/projects/${publicId}/parse-labels${q}`;
const post = (publicId: string, body: unknown) => POST(makeReq(url(publicId), { method: "POST", body }), params({ id: publicId }));
const del = (publicId: string, body: unknown) => DELETE(makeReq(url(publicId), { method: "DELETE", body }), params({ id: publicId }));
const get = (publicId: string, page: number) => GET(makeReq(url(publicId, `?page=${page}`)), params({ id: publicId }));

async function seeded(extra: Record<string, unknown> = {}) {
  const world = await createWorld();
  const page = await createPage(world.project.id, 1, {
    pageIntelligence: { parsedRegions: [REGION_A, REGION_B], keep: "me", ...extra } as never,
  });
  return { ...world, page };
}

async function pageIntel(pageId: number) {
  const [row] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId));
  return row.pi as Record<string, any>;
}

describe("parse-labels snapshot (pure)", () => {
  it("hashes cells, never stores text; a cell edit changes the hash, a key reorder does not", () => {
    const snap = regionSnapshot(REGION_A);
    expect(snap).toMatchObject({ kind: "schedule", headerRows: 1, tagCol: 0, colX: [0.1, 0.3, 0.5], rowY: [0.1, 0.2, 0.3, 0.4] });
    expect(snap.cellHash).toHaveLength(2 + 2 * 2);
    expect(JSON.stringify(snap)).not.toContain("QX-1");
    const edited = { ...REGION_A, data: { ...REGION_A.data, rows: [{ Mark: "QX-1", Width: "11" }, REGION_A.data.rows[1]] } };
    expect(snapshotHashOf(regionSnapshot(edited))).not.toBe(snapshotHashOf(snap));
    const reordered = { ...REGION_A, data: Object.fromEntries(Object.entries(REGION_A.data).reverse()) };
    expect(snapshotHashOf(regionSnapshot(reordered))).toBe(snapshotHashOf(snap));
    expect(regionSnapshot(REGION_B)).toMatchObject({ kind: "keynote", headerRows: 0, tagCol: 0 });
    expect(regionSnapshot(REGION_B).cellHash).toHaveLength(4);
  });
});

describe.skipIf(!dbUp)("GET/POST/DELETE /api/projects/[id]/parse-labels", () => {
  it("POST ✓ stores the SERVER's snapshot (forged fields ignored) and the GET reads it back after reload", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    const res = await readJson(await post(project.publicId, {
      pageNumber: 1, regionId: "parsed-a", verdict: "correct",
      snapshotHash: "forged", machine: { kind: "spec" }, proposalId: "forged-proposal", by: 12345, source: "workspace",
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ regionId: "parsed-a", label: { verdict: "correct" } });
    const stored = (await pageIntel(page.id)).parseLabels["parsed-a"];
    expect(stored).toMatchObject({
      v: 1, regionId: "parsed-a", kind: "schedule", source: "verdict-bar", verdict: "correct", by: user.id,
      snapshotHash: snapshotHashOf(regionSnapshot(REGION_A)), machine: regionSnapshot(REGION_A),
    });
    expect(stored.proposalId).toBeUndefined();
    expect((await pageIntel(page.id)).keep).toBe("me");
    const read = await readJson(await get(project.publicId, 1));
    expect(read).toMatchObject({ status: 200, body: { page: 1, labels: { "parsed-a": { verdict: "correct", at: stored.at } } } });
    expect(Object.keys(read.body.labels)).toEqual(["parsed-a"]);
  });

  it("two tabs: concurrent verdicts on two regions both survive; the same region twice keeps one key (last wins)", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    const [a, b] = await Promise.all([
      post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "correct" }),
      post(project.publicId, { pageNumber: 1, regionId: "parsed-b", verdict: "wrong" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "wrong" })).status).toBe(200);
    const labels = (await pageIntel(page.id)).parseLabels;
    expect(Object.keys(labels).sort()).toEqual(["parsed-a", "parsed-b"]);
    expect(labels["parsed-a"].verdict).toBe("wrong");
    expect(labels["parsed-b"]).toMatchObject({ verdict: "wrong", kind: "keynote" });
  });

  it("an edit-save after ✗ reads back as corrected; the stored label keeps its machine snapshot", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "wrong" })).status).toBe(200);
    const promoted = await promotePOST(makeReq("/api/regions/promote", {
      method: "POST",
      body: {
        publicId: project.publicId, pageNumber: 1, type: "schedule",
        overrides: {
          regionId: "parsed-a", bbox: REGION_A.bbox,
          data: { ...REGION_A.data, rows: [{ Mark: "QX-1", Width: "15" }, { Mark: "QX-2", Width: "20" }] },
        },
      },
    }));
    expect(promoted.status).toBe(200);
    const read = await readJson(await get(project.publicId, 1));
    expect(read.body.labels["parsed-a"]).toMatchObject({ verdict: "corrected", was: "wrong" });
    const stored = (await pageIntel(page.id)).parseLabels["parsed-a"];
    expect(stored).toMatchObject({ verdict: "wrong", snapshotHash: snapshotHashOf(regionSnapshot(REGION_A)) });
    // A fresh verdict on the edited region is a plain ✓ again.
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "correct" })).status).toBe(200);
    expect((await readJson(await get(project.publicId, 1))).body.labels["parsed-a"]).toEqual(
      expect.objectContaining({ verdict: "correct" }),
    );
  });

  it("links the proposal whose save-time accept named this region (K58), never a client-sent id", async () => {
    const { user, project, page } = await seeded({
      proposalVerdicts: {
        "schedule-kind:p1:x": { proposalId: "schedule-kind:p1:x", verdict: "accept", via: "parse", regionId: "parsed-a" },
      },
    });
    asUser(user);
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "correct", proposalId: "other" })).status).toBe(200);
    expect((await pageIntel(page.id)).parseLabels["parsed-a"].proposalId).toBe("schedule-kind:p1:x");
  });

  it("validation and missing targets: bad verdict 400, unknown region / page 404, nothing written", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "corrected" })).status).toBe(400);
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a" })).status).toBe(400);
    expect((await post(project.publicId, { pageNumber: 0, regionId: "parsed-a", verdict: "correct" })).status).toBe(400);
    const missing = await readJson(await post(project.publicId, { pageNumber: 1, regionId: "nope", verdict: "correct" }));
    expect(missing.status).toBe(404);
    expect((await post(project.publicId, { pageNumber: 9, regionId: "parsed-a", verdict: "correct" })).status).toBe(404);
    expect((await get(project.publicId, 9)).status).toBe(404);
    expect((await pageIntel(page.id)).parseLabels).toBeUndefined();
  });

  it("undo removes the key; a second undo is a no-op; other labels survive", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "correct" });
    await post(project.publicId, { pageNumber: 1, regionId: "parsed-b", verdict: "correct" });
    expect(await readJson(await del(project.publicId, { pageNumber: 1, regionId: "parsed-a" }))).toMatchObject({ status: 200, body: { removed: true } });
    expect(Object.keys((await pageIntel(page.id)).parseLabels)).toEqual(["parsed-b"]);
    expect(await readJson(await del(project.publicId, { pageNumber: 1, regionId: "parsed-a" }))).toMatchObject({ status: 200, body: { removed: false } });
    expect(Object.keys((await readJson(await get(project.publicId, 1))).body.labels)).toEqual(["parsed-b"]);
  });

  it("the generic PATCH can neither write nor clear parseLabels; the page window never ships them", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "correct" });
    const before = await pageIntel(page.id);
    const res = await intelligencePATCH(makeReq("/api/pages/intelligence", {
      method: "PATCH",
      body: { publicId: project.publicId, pageNumber: 1, intelligence: { parseLabels: { forged: { verdict: "correct" } }, note: 1 } },
    }));
    expect(res.status).toBe(200);
    const after = await pageIntel(page.id);
    expect(after.parseLabels).toEqual(before.parseLabels);
    expect(after.note).toBe(1);
    const cleared = await intelligencePATCH(makeReq("/api/pages/intelligence", {
      method: "PATCH",
      body: { publicId: project.publicId, pageNumber: 1, intelligence: { parseLabels: null } },
    }));
    expect(cleared.status).toBe(200);
    expect((await pageIntel(page.id)).parseLabels).toEqual(before.parseLabels);
    expect(serializePageWindowIntelligence(after)).not.toHaveProperty("parseLabels");
  });

  it("a page whose regions carry labels is human work (the duplicate hide cannot discard it)", async () => {
    const world = await createWorld();
    const labelled = await createPage(world.project.id, 1, { pageIntelligence: { parseLabels: { "parsed-x": { verdict: "wrong" } } } as never });
    await createPage(world.project.id, 2, { pageIntelligence: { parseLabels: {} } as never });
    await createPage(world.project.id, 3, { pageIntelligence: { keep: "me" } as never });
    const work = await humanWorkPages(db, world.project.id);
    expect(work.has(labelled.pageNumber)).toBe(true);
    expect(work.has(2)).toBe(false);
    expect(work.has(3)).toBe(false);
  });

  it("signed-out → 401; cross-tenant → 404", async () => {
    const { project } = await seeded();
    signedOut();
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "correct" })).status).toBe(401);
    expect((await get(project.publicId, 1)).status).toBe(401);
    asUser(await createUser((await createWorld()).company.id));
    expect((await post(project.publicId, { pageNumber: 1, regionId: "parsed-a", verdict: "correct" })).status).toBe(404);
    expect((await get(project.publicId, 1)).status).toBe(404);
  });

  it("demo projects refuse every method and role before any write or read", async () => {
    const { company, project, page } = await seeded({ parseLabels: { "parsed-a": { verdict: "correct", at: "x", snapshotHash: "h" } } });
    await publishDemoFixture(project.id);
    const member = await createUser(company.id);
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const writes: number[] = [];
    const reads: number[] = [];
    for (const actor of [null, member, root]) {
      actor ? asUser(actor) : signedOut();
      writes.push((await post(project.publicId, { pageNumber: 1, regionId: "parsed-b", verdict: "correct" })).status);
      writes.push((await del(project.publicId, { pageNumber: 1, regionId: "parsed-a" })).status);
      reads.push((await get(project.publicId, 1)).status);
    }
    expect(writes).toEqual([403, 403, 403, 403, 403, 403]);
    expect(reads.every((s) => s === 401 || s === 403 || s === 404)).toBe(true);
    expect(reads).not.toContain(200);
    expect(Object.keys((await pageIntel(page.id)).parseLabels)).toEqual(["parsed-a"]);
  });
});
