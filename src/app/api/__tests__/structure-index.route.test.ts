// @vitest-environment node
// [table pipeline WP-3.H, C1-B2 / C1-B3 / C2-M8] DB-backed: `PJ.structureIndex` is DERIVED by the real
// computeProjectSummaries (never mocked here), so a classic promote indexes the region and a classic
// DELETE /api/regions un-indexes it; hidden duplicate pages are absent; a drawing-number change leaves
// nothing stale (the index is keyed by page). The signed-in and demo bootstraps ship only the
// `regions` slice (viewerProjectIntelligence). humanWorkPages protects every user-owned page record.
// Synthetic text only (rule 12).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { eq, sql } from "drizzle-orm";
import { POST as promotePOST } from "@/app/api/regions/promote/route";
import { DELETE as regionsDELETE } from "@/app/api/regions/route";
import { GET as projectGET } from "@/app/api/projects/[id]/route";
import { GET as demoProjectGET } from "@/app/api/demo/projects/[id]/route";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { deriveStructureIndex } from "@/lib/parse-engine/index-derive";
import { viewHash } from "@/lib/parse-engine/legacy-view";
import { assertProjectWritable } from "@/server/api/access";
import { withProjectWrite } from "@/server/api/project-write-capability";
import { humanWorkPages } from "@/server/services/page-duplicates-apply";
import { asUser, createPage, createWorld, makeReq, params, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const GRID = {
  headers: ["MARK", "SIZE"],
  rows: [{ MARK: "D-1", SIZE: "A" }, { MARK: "D-2", SIZE: "B" }],
  tagColumn: "MARK",
  tableName: "Door Schedule",
  rowCount: 2,
  columnCount: 2,
};

async function projectPi(projectId: number): Promise<Record<string, any>> {
  const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
  return (row?.pi ?? {}) as Record<string, any>;
}

async function recompute(projectId: number) {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  return computeProjectSummaries(projectId, assertProjectWritable(row));
}

const schedule = (id: string) => ({ id, type: "schedule", category: "door-schedule", bbox: [0.1, 0.1, 0.4, 0.4], confidence: 0.85, source: "user", data: GRID });

describe.skipIf(!dbUp)("PJ.structureIndex is derived in computeProjectSummaries", () => {
  it("a classic promote of a schedule appears in regions and its keys; a classic DELETE removes them", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { drawingNumber: "A-101" });
    asUser(user);
    const promoted = await readJson(await promotePOST(makeReq("/api/regions/promote", {
      method: "POST",
      body: { publicId: project.publicId, pageNumber: 1, type: "schedule", overrides: { regionId: "pr-classic", bbox: [0.1, 0.1, 0.4, 0.4], data: GRID } },
    })));
    expect(promoted.status).toBe(200);
    let index = (await projectPi(project.id)).structureIndex;
    expect(index.v).toBe(1);
    expect(index.regions["1"]).toEqual([expect.objectContaining({ regionId: "pr-classic", kind: "schedule", title: "Door Schedule", rows: 2, cols: 2, origin: "classic" })]);
    expect(index.keys["1"].D1).toEqual([["pr-classic", "schedule", "r1", null]]);
    expect(index.keys["1"].D2).toEqual([["pr-classic", "schedule", "r2", null]]);

    const deleted = await readJson(await regionsDELETE(makeReq("/api/regions", {
      method: "DELETE", body: { publicId: project.publicId, pageNumber: 1, regionId: "pr-classic" },
    })));
    expect(deleted.status).toBe(200);
    index = (await projectPi(project.id)).structureIndex;
    expect(index.regions).toEqual({});
    expect(index.keys).toEqual({});
  });

  it("a hidden duplicate page is absent; existing PJ keys survive the derived write", async () => {
    const { project } = await createWorld();
    await db.update(projects).set({ projectIntelligence: { keepMe: { x: 1 } } as never }).where(eq(projects.id, project.id));
    await createPage(project.id, 1, { pageIntelligence: { parsedRegions: [schedule("pr-visible")] } as never });
    await createPage(project.id, 2, {
      pageIntelligence: { parsedRegions: [schedule("pr-hidden")], duplicateOf: { page: 1, hiddenAt: "2026-10-27T00:00:00Z" } } as never,
    });
    await recompute(project.id);
    const pi = await projectPi(project.id);
    expect(pi.keepMe).toEqual({ x: 1 });
    expect(Object.keys(pi.structureIndex.regions)).toEqual(["1"]);
    expect(JSON.stringify(pi.structureIndex)).not.toContain("pr-hidden");
  });

  it("a drawing-number change re-derives on the next recompute; keys are by page, so nothing is stale", async () => {
    const { project } = await createWorld();
    const page = await createPage(project.id, 4, { drawingNumber: "A-101", pageIntelligence: { parsedRegions: [schedule("pr-a")] } as never });
    await recompute(project.id);
    const before = (await projectPi(project.id)).structureIndex;
    await db.update(pages).set({ drawingNumber: "A-999" }).where(eq(pages.id, page.id));
    await recompute(project.id);
    const after = (await projectPi(project.id)).structureIndex;
    expect(after.keys).toEqual(before.keys);
    expect(Object.keys(after.keys)).toEqual(["4"]);
    expect(JSON.stringify(after)).not.toContain("A-101");
    expect(JSON.stringify(after)).not.toContain("A-999");
  });
});

/** Wait until some backend is blocked on a lock held by backend `holderPid` (5 s bound). */
async function waitForWaiterOn(holderPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await db.execute(sql`
      SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`);
    if ((result as unknown as { rows: unknown[] }).rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the summaries pass to block on the project lock");
}

// LTWH text region; its MinMax box is [0.6, 0.1, 0.9, 0.5].
const textRegion = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, type: "notes-numbered", bbox: [0.6, 0.1, 0.3, 0.4], confidence: 0.7, wordCount: 40, headerText: "GENERAL NOTES", ...over });
const rejectVerdict = { verdict: "reject", type: "notes-numbered", b: [0.6, 0.1, 0.9, 0.5], at: "2026-10-28T00:00:00.000Z" };

describe.skipIf(!dbUp)("the summaries pass re-derives the inbox under its project lock (WP-3.H verify MED-2)", () => {
  it("a verdict that commits between the summaries' page read and its lock is not overwritten (deterministic)", async () => {
    const { project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [textRegion("region-0")] } as never });
    await recompute(project.id);
    expect((await projectPi(project.id)).structureIndex.inbox["1"][0].state).toBe("todo");

    const capability = assertProjectWritable(project);
    let summaries: Promise<unknown> | undefined;
    await withProjectWrite(capability, project.id, async (tx) => {
      const [{ pid }] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as { rows: { pid: number }[] }).rows;
      summaries = recompute(project.id);
      // The summaries pass has read every page (pre-lock) and now waits for this project lock.
      await waitForWaiterOn(pid);
      // What the WP-3.F verdict route does in its one withProjectWrite: the page verdict, then the inbox slice.
      await tx.update(pages)
        .set({ pageIntelligence: sql`${pages.pageIntelligence} || ${JSON.stringify({ textRegionVerdicts: { "tr:k": rejectVerdict } })}::jsonb` })
        .where(eq(pages.id, page.id));
      await tx.update(projects)
        .set({ projectIntelligence: sql`jsonb_set(${projects.projectIntelligence}, '{structureIndex,inbox,1,0,state}', '"rejected"'::jsonb)` })
        .where(eq(projects.id, project.id));
    });
    await summaries;
    const after = (await projectPi(project.id)).structureIndex;
    expect(after.inbox["1"]).toEqual([expect.objectContaining({ origin: "text-region", kind: "notes", state: "rejected" })]);
  });

  it("the projected in-lock inputs give the same inbox as the full page intelligence (parity)", async () => {
    const { project } = await createWorld();
    const notesRegion = {
      id: "parsed-n", type: "notes", category: "general-notes", bbox: [0.6, 0.1, 0.9, 0.5], confidence: 0.8, source: "user",
      data: { headers: ["Key", "Note"], rows: [{ Key: "1", Note: "ALPHA" }], tagColumn: "Key", tableName: "GENERAL NOTES" },
    };
    // [TP-3 integrate g2b] WP-3.F's derive joins a promoted region by sourceTextRegionId only while it still
    // overlaps (IoU ≥ .5, any family), so case 1 uses a schedule-typed region over the text region (no
    // same-family fallback); cases 6-7 cover the proposal keys the projection was widened to (INBOX_DERIVE_PI_KEYS).
    const proposal = (id: string, over: Record<string, unknown> = {}) =>
      ({ id, target: "schedule", classId: "door-schedule", bbox: [0.1, 0.1, 0.4, 0.4], displayName: "Door Schedule", className: "Door schedule", p: 0.9, tableP: 0.8, extra: { big: [1, 2, 3] }, ...over });
    const rich = [
      { textRegions: [textRegion("region-0")], parsedRegions: [{ ...notesRegion, type: "schedule", sourceTextRegionId: "region-0" }] }, // parsed by id
      { textRegions: [textRegion("region-0")], parsedRegions: [notesRegion] }, // parsed by same-family IoU
      { textRegions: [textRegion("region-3")], textRegionVerdicts: { "tr:k": rejectVerdict } }, // content verdict
      { textRegions: [textRegion("region-2"), textRegion("region-5", { bbox: [0.1, 0.6, 0.2, 0.2] })], rejectedTextRegionIds: ["region-2"] }, // legacy reject + todo
      { textRegions: [textRegion("region-0")], parsedRegions: "not-an-array" }, // malformed parsedRegions
      { classifierProposals: { proposals: [proposal("p-a"), proposal("p-b", { bbox: [0.5, 0.5, 0.9, 0.9], tableP: undefined }), "junk"] },
        proposalVerdicts: { "p-b": { verdict: "reject", at: "t" } } }, // proposals: todo + rejected
      { classifierProposals: { proposals: [proposal("p-c")] }, proposalVerdicts: { "p-c": { verdict: "accept", regionId: "pr-x" } },
        parsedRegions: [{ ...notesRegion, id: "pr-x", type: "schedule", bbox: [0.7, 0.7, 0.8, 0.8] }] }, // parsed through the K58 regionId
      {}, // a visible page with nothing: still keyed
    ];
    for (const [i, pageIntelligence] of rich.entries()) await createPage(project.id, i + 1, { pageIntelligence: pageIntelligence as never });
    await recompute(project.id);
    const stored = (await projectPi(project.id)).structureIndex;
    const full = await db.select({ pageNumber: pages.pageNumber, pageIntelligence: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, project.id));
    expect(stored.inbox).toEqual(deriveStructureIndex(full, "t").inbox);
    expect(stored.inbox["1"][0]).toMatchObject({ state: "parsed", regionId: "parsed-n" });
    expect(stored.inbox["2"][0]).toMatchObject({ state: "parsed", regionId: "parsed-n" });
    expect(stored.inbox["3"][0].state).toBe("rejected");
    expect(stored.inbox["4"].map((x: { state: string }) => x.state)).toEqual(["rejected", "todo"]);
    expect(stored.inbox["5"][0].state).toBe("todo");
    expect(stored.inbox["6"].map((x: { id: string; state: string }) => [x.id, x.state])).toEqual([["p-a", "todo"], ["p-b", "rejected"]]);
    expect(stored.inbox["7"][0]).toMatchObject({ id: "p-c", state: "parsed", regionId: "pr-x" });
    expect(stored.inbox["8"]).toEqual([]);
  });

  it("a derive failure keeps the previously stored index and still writes the summaries (verify LOW-5)", async () => {
    const { project } = await createWorld();
    const previous = { v: 1, at: "previous", regions: {}, keys: {}, specSections: {}, inbox: {} };
    await db.update(projects).set({ projectIntelligence: { structureIndex: previous } as never }).where(eq(projects.id, project.id));
    // Bad stored data that makes the derive throw: a workspace model (its viewHash matches) with a null row.
    // [TP-3 integrate g2b] The old trigger (a non-string headerText) no longer throws: WP-3.F's inbox derive is total.
    const data: Record<string, unknown> = { tableName: "T", structure: { v: 1, kind: "schedule", rows: [null], cols: [], cells: [] } };
    data.links = { viewHash: viewHash(data), revision: 1 };
    await createPage(project.id, 1, { pageIntelligence: { parsedRegions: [{ id: "pr-bad", type: "schedule", bbox: [0.1, 0.1, 0.4, 0.4], data }] } as never });
    const summaries = await recompute(project.id);
    expect(summaries).toBeTruthy();
    const pi = await projectPi(project.id);
    expect(pi.summaries).toBeTruthy();
    expect(pi.structureIndex).toEqual(previous);
  });
});

describe.skipIf(!dbUp)("viewerProjectIntelligence on the bootstraps", () => {
  const PI = {
    summaries: { keep: true },
    tagMaps: { "pr-a": { v: 1, defs: {} } },
    structureIndex: { v: 1, at: "t", regions: { "1": [] }, keys: { "1": { D1: [] } }, specSections: { "087100": [] }, inbox: { "1": [] } },
  };

  it("the signed-in bootstrap lacks tagMaps and the server-only index slices", async () => {
    const { user, project } = await createWorld();
    await db.update(projects).set({ projectIntelligence: PI as never }).where(eq(projects.id, project.id));
    asUser(user);
    const { status, body } = await readJson(await projectGET(makeReq(`/api/projects/${project.publicId}`, { method: "GET" }), params({ id: project.publicId })));
    expect(status).toBe(200);
    expect(body.projectIntelligence).toEqual({ summaries: { keep: true }, structureIndex: { v: 1, at: "t", regions: { "1": [] } } });
    expect(body.summaries).toEqual({ keep: true });
    const stored = await projectPi(project.id);
    expect(stored.tagMaps).toBeDefined(); // stripped on the way out, never in the row
    expect(stored.structureIndex.keys).toBeDefined();
  });

  it("the demo bootstrap strips the same slices (and still the cross-set summary)", async () => {
    const { project } = await createWorld({ status: "completed" });
    await db.update(projects).set({ projectIntelligence: { ...PI, crossSetLinks: { v: 2 } } as never }).where(eq(projects.id, project.id));
    await publishDemoFixture(project.id);
    signedOut();
    const res = await demoProjectGET(makeReq(`/api/demo/projects/${project.publicId}`, { method: "GET" }), params({ id: project.publicId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectIntelligence).toEqual({ summaries: { keep: true }, structureIndex: { v: 1, at: "t", regions: { "1": [] } } });
  });
});

describe.skipIf(!dbUp)("humanWorkPages protects user-owned page records (rule 8)", () => {
  it("a parse label, a text-region verdict, a proposal verdict, or a non-auto tag-map instance pins its page", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1, { pageIntelligence: { parseLabels: { "parsed-x": { verdict: "wrong" } } } as never });
    await createPage(project.id, 2, { pageIntelligence: { textRegionVerdicts: { "tr:k": { verdict: "reject", type: "notes-numbered", b: [0, 0, 1, 1], at: "t" } } } as never });
    await createPage(project.id, 3, { pageIntelligence: { proposalVerdicts: { "p-1": { verdict: "reject" } } } as never });
    await createPage(project.id, 4, { pageIntelligence: { textRegionVerdicts: {}, proposalVerdicts: {}, parseLabels: {} } as never });
    await createPage(project.id, 5);
    await createPage(project.id, 6);
    await db.update(projects).set({
      projectIntelligence: {
        tagMaps: {
          "pr-a": { v: 1, defs: { r1: { instances: [{ id: "i1", page: 5, status: "confirmed" }, { id: "i2", page: 6, status: "auto" }] } } },
          "pr-b": { v: 1, defs: { r2: { instances: [{ id: "i3", page: 6, status: "auto" }] } } },
        },
      } as never,
    }).where(eq(projects.id, project.id));
    const work = await humanWorkPages(db, project.id);
    expect([...work].sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
  });
});
