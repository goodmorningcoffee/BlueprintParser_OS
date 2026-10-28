// @vitest-environment node
// [table pipeline WP-3.F] GET …/parse-engine/items, GET …/parse-engine/verdicts, POST/DELETE …/parse-engine/verdict.
//   • scope=all reads ONE projects row and no page row (query spy, C1-D6); a hidden duplicate page is absent;
//   • scope=sheet: page detail with low-confidence classifiedTables/ensembleRegions; a hidden page → no groups;
//   • a classic (legacy id) reject hides the inbox item only while the IoU check holds (renumbered region-${i});
//   • a text-region verdict is content-keyed from the SERVER's stored box, refreshes the inbox slice in the same
//     transaction (never creates an index), is pinned against the generic PATCH and never shipped by the window;
//   • a proposal verdict is delegated to the classifier verdict service (+ summary mirror, + slice refresh);
//   • fix round: the inbox item's own body shape (WP-3.L) works; a bare text accept is refused; the classic
//     verdict bar refreshes the slice (MED-1); a folded text region follows its proposal item (MED-2); Undo
//     clears a classic positional reject; one verdict per region (LOW-4);
//   • demo refused for every method and role.
// All strings are synthetic.
import { describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as itemsGET } from "@/app/api/projects/[id]/parse-engine/items/route";
import { GET as verdictsGET } from "@/app/api/projects/[id]/parse-engine/verdicts/route";
import { DELETE as verdictDELETE, POST as verdictPOST } from "@/app/api/projects/[id]/parse-engine/verdict/route";
import { DELETE as classicVerdictDELETE, POST as classicVerdictPOST } from "@/app/api/projects/[id]/proposals/verdict/route";
import { PATCH as intelligencePATCH } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { textRegionKey } from "@/lib/parse-engine/text-region-verdicts";
import { serializePageWindowIntelligence } from "@/server/services/page-window-serialization";
import { getWorkspaceItems } from "@/server/services/parse-engine/items";
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

// Stored TextRegion boxes are LTWH; their content keys are MinMax.
const TR_A = { id: "region-0", type: "notes-numbered", bbox: [0.1, 0.1, 0.3, 0.2], confidence: 0.8, headerText: "LOREM NOTES", wordCount: 9 };
const TR_B = { id: "region-1", type: "notes-numbered", bbox: [0.6, 0.6, 0.3, 0.2], confidence: 0.7, headerText: "IPSUM NOTES", wordCount: 9 };
const KEY_A = textRegionKey("notes-numbered", [0.1, 0.1, 0.4, 0.3]);
const KEY_B = textRegionKey("notes-numbered", [0.6, 0.6, 0.9, 0.8]);
const PROPOSAL = {
  id: "schedules.v1:p1:abc", recipeId: "schedules.v1", recipeVersion: 1, engineVersion: "e1", pageNumber: 1,
  bbox: [0.5, 0.05, 0.95, 0.4], target: "schedule", p: 0.9, tableP: 0.8, classId: "door", className: "Door schedule",
  group: "arch", nameP: 0.7, margin: 0.2, displayName: "Door schedule", detectWhy: [], nameWhy: [], features: { "detect.x": 1 },
};
const SUMMARY_ITEM = (page: number, id = PROPOSAL.id) => ({
  id, recipeId: "schedules.v1", pageNumber: page, bbox: PROPOSAL.bbox, target: "schedule", classId: "door",
  className: "Door schedule", group: "arch", displayName: "Door schedule", p: 0.9, nameP: 0.7, tableP: 0.8,
});

const base = (publicId: string, path: string) => `/api/projects/${publicId}/parse-engine/${path}`;
const items = (publicId: string, q = "") => itemsGET(makeReq(base(publicId, `items${q}`), { method: "GET" }), params({ id: publicId }));
const verdicts = (publicId: string, page: number) => verdictsGET(makeReq(base(publicId, `verdicts?page=${page}`), { method: "GET" }), params({ id: publicId }));
const post = (publicId: string, body: unknown) => verdictPOST(makeReq(base(publicId, "verdict"), { method: "POST", body }), params({ id: publicId }));
const del = (publicId: string, body: unknown) => verdictDELETE(makeReq(base(publicId, "verdict"), { method: "DELETE", body }), params({ id: publicId }));
const classic = (publicId: string, method: "POST" | "DELETE", body: unknown) =>
  (method === "POST" ? classicVerdictPOST : classicVerdictDELETE)(makeReq(`/api/projects/${publicId}/proposals/verdict`, { method, body }), params({ id: publicId }));
const EMPTY_INDEX = { v: 1, at: "t", regions: {}, keys: {}, specSections: {}, inbox: {} };
// A regions.v1 notes proposal over block A: the items service folds TR_A into it (one item per block).
const NOTES_PROPOSAL = { ...PROPOSAL, id: "regions.v1:p1:n", recipeId: "regions.v1", target: "text-region", classId: "general-notes", className: "General notes", displayName: "General notes", bbox: [0.1, 0.1, 0.4, 0.31], tableP: undefined };
const itemState = async (publicId: string, id: string) =>
  (await readJson(await items(publicId, "?scope=sheet&page=1"))).body.groups[0].items.find((i: { id: string }) => i.id === id)?.state;

async function pageIntel(pageId: number) {
  const [row] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId));
  return row.pi as Record<string, any>;
}
async function projectIntel(projectId: number) {
  const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
  return row.pi as Record<string, any>;
}

describe.skipIf(!dbUp)("parse-engine items + verdicts", () => {
  it("scope=all reads one projects row and no page row; a hidden duplicate page is absent", async () => {
    const { user, project } = await createWorld({
      projectIntelligence: {
        proposals: { engineVersion: "e1", generatedAt: "t", total: 2, truncated: false, items: [SUMMARY_ITEM(1), SUMMARY_ITEM(2, "schedules.v1:p2:abc")] },
        structureIndex: {
          v: 1, at: "t", keys: {}, specSections: {},
          regions: { "1": [{ regionId: "parsed-1", kind: "schedule", title: "R", bbox: [0.5, 0.05, 0.95, 0.41], rows: 3, origin: "classic" }] },
          inbox: { "1": [{ id: KEY_B, origin: "text-region", kind: "notes", b: [0.6, 0.6, 0.9, 0.8], title: "IPSUM NOTES", p: 0.7, state: "todo" }] },
        },
      } as never,
    });
    // Page 2 is a hidden duplicate: the summary still lists its proposal, the derived index does not.
    await createPage(project.id, 1, { pageIntelligence: { classifierProposals: { proposals: [PROPOSAL] } } as never });
    await createPage(project.id, 2, { pageIntelligence: { duplicateOf: { pageNumber: 1, tier: "exact", hiddenAt: "t" } } as never });
    asUser(user);

    const tables: unknown[] = [];
    const select = db.select.bind(db);
    const spy = vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof db.select>) => {
      const builder = select(...args);
      const from = builder.from.bind(builder);
      (builder as { from: unknown }).from = (table: unknown) => { tables.push(table); return from(table as never); };
      return builder;
    }) as typeof db.select);
    let out;
    try {
      out = await getWorkspaceItems(project, null, { scope: "all" });
    } finally {
      spy.mockRestore();
    }
    expect(tables).toEqual([projects]);
    expect(out.indexReady).toBe(true);
    expect(out.groups.map((g) => g.page)).toEqual([1]);
    expect(out.groups[0].items.map((i) => [i.id, i.state, i.regionId ?? null])).toEqual([
      [PROPOSAL.id, "parsed", "parsed-1"],
      [KEY_B, "todo", null],
    ]);

    const http = await readJson(await items(project.publicId));
    expect(http.status).toBe(200);
    expect(http.body.groups.map((g: { page: number }) => g.page)).toEqual([1]);
  });

  it("before the index exists, scope=all lists the summary minus hidden pages (indexReady:false)", async () => {
    const { user, project } = await createWorld({
      projectIntelligence: { proposals: { engineVersion: "e1", generatedAt: "t", total: 2, truncated: false, items: [SUMMARY_ITEM(1), SUMMARY_ITEM(2, "x:p2")] } } as never,
    });
    await createPage(project.id, 1);
    await createPage(project.id, 2, { pageIntelligence: { duplicateOf: { pageNumber: 1, tier: "exact", hiddenAt: "t" } } as never });
    asUser(user);
    const res = await readJson(await items(project.publicId, "?scope=all"));
    expect(res.body).toMatchObject({ scope: "all", indexReady: false });
    expect(res.body.groups.map((g: { page: number }) => g.page)).toEqual([1]);
  });

  it("scope=sheet: the page detail, low-confidence detector boxes, and nothing for a hidden page", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {
      pageIntelligence: {
        classifierProposals: { proposals: [{ ...PROPOSAL, tableP: 0.1 }] },
        textRegions: [TR_A],
        classifiedTables: [{ id: "c", type: "schedule-table", bbox: [0.05, 0.6, 0.2, 0.2], confidence: 0.6, wordCount: 3, category: "door-schedule", evidence: [], pageNumber: 1, isPageSpecific: true }],
        ensembleRegions: [{ bbox: [0.05, 0.85, 0.1, 0.1], tableProbability: 0.5, contributingVotes: [], voteSources: [], reasoning: "r", pageNumber: 1 }],
      } as never,
    });
    await createPage(project.id, 2, { pageIntelligence: { textRegions: [TR_A], duplicateOf: { pageNumber: 1, tier: "exact", hiddenAt: "t" } } as never });
    asUser(user);
    const res = await readJson(await items(project.publicId, "?scope=sheet&page=1"));
    expect(res.status).toBe(200);
    const [group] = res.body.groups;
    expect(group.items.map((i: { id: string }) => i.id)).toEqual([KEY_A]);
    expect(group.lowConfidence.map((i: { origin: string }) => i.origin).sort()).toEqual(["classified-table", "ensemble", "proposal"]);
    expect((await readJson(await items(project.publicId, "?scope=sheet&page=2"))).body.groups).toEqual([]);
    expect((await items(project.publicId, "?scope=sheet")).status).toBe(400);
    expect((await items(project.publicId, "?scope=sheet&page=9")).status).toBe(404);
  });

  it("a classic reject hides the inbox item only while the IoU check holds (renumbered region-${i})", async () => {
    // The slice recorded region-0 at block A. A reprocess then renumbered: region-0 is now block B.
    const { user, project } = await createWorld({
      projectIntelligence: {
        structureIndex: {
          v: 1, at: "t", regions: {}, keys: {}, specSections: {},
          inbox: { "1": [
            { id: KEY_A, origin: "text-region", kind: "notes", b: [0.1, 0.1, 0.4, 0.3], title: "LOREM NOTES", p: 0.8, state: "rejected", legacyId: "region-0" },
            { id: KEY_B, origin: "text-region", kind: "notes", b: [0.6, 0.6, 0.9, 0.8], title: "IPSUM NOTES", p: 0.7, state: "todo", legacyId: "region-1" },
          ] },
        },
      } as never,
    });
    const page = await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [{ ...TR_B, id: "region-0" }, { ...TR_A, id: "region-1" }], rejectedTextRegionIds: ["region-0"] } as never,
    });
    asUser(user);
    const sheet = await readJson(await items(project.publicId, "?scope=sheet&page=1"));
    const states = Object.fromEntries(sheet.body.groups[0].items.map((i: { id: string; state: string }) => [i.id, i.state]));
    expect(states).toEqual({ [KEY_A]: "todo", [KEY_B]: "todo" });
    // Same rule on the verdict-time slice refresh: a workspace reject of A, then the slice holds A only.
    expect((await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.1, 0.1, 0.4, 0.3] }, verdict: "reject" })).status).toBe(200);
    const slice = (await projectIntel(project.id)).structureIndex.inbox["1"];
    expect(Object.fromEntries(slice.map((e: { id: string; state: string }) => [e.id, e.state]))).toEqual({ [KEY_A]: "rejected", [KEY_B]: "todo" });
    expect((await pageIntel(page.id)).rejectedTextRegionIds).toEqual(["region-0"]); // classic data untouched
    // The refreshed slice keeps the reject bound to block A, so block B stays in review on the next read.
    expect(slice.find((e: { id: string }) => e.id === KEY_B)).toMatchObject({ legacyId: "region-0", legacyRejectB: [0.1, 0.1, 0.4, 0.3] });
    const again = await readJson(await items(project.publicId, "?scope=sheet&page=1"));
    expect(again.body.groups[0].items.find((i: { id: string }) => i.id === KEY_B).state).toBe("todo");
  });

  it("a text-region verdict stores the SERVER's box under its content key; GET is slim; undo removes it", async () => {
    const { user, project } = await createWorld({
      projectIntelligence: { keep: "pj", structureIndex: { v: 1, at: "t", regions: {}, keys: { "1": { K: [] } }, specSections: {}, inbox: {} } } as never,
    });
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [TR_A, TR_B], keep: "me" } as never });
    asUser(user);
    // A slightly-off box (IoU ≥ .7) and forged fields: the stored box is the region's own.
    const res = await readJson(await post(project.publicId, {
      pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.105, 0.1, 0.4, 0.31] }, verdict: "reject", by: 999, at: "forged",
    }));
    expect(res).toMatchObject({ status: 200, body: { key: KEY_A, verdict: { verdict: "reject", type: "notes-numbered" }, inboxRefreshed: true } });
    const stored = (await pageIntel(page.id)).textRegionVerdicts[KEY_A];
    expect(stored).toMatchObject({ verdict: "reject", type: "notes-numbered", by: user.id });
    expect(stored.b[0]).toBeCloseTo(0.1, 9);
    expect(stored.at).not.toBe("forged");
    expect((await pageIntel(page.id)).keep).toBe("me");
    const pj = await projectIntel(project.id);
    expect(pj.keep).toBe("pj");
    expect(pj.structureIndex.keys).toEqual({ "1": { K: [] } });
    expect(pj.structureIndex.inbox["1"].find((e: { id: string }) => e.id === KEY_A).state).toBe("rejected");

    const read = await readJson(await verdicts(project.publicId, 1));
    expect(read).toMatchObject({ status: 200, body: { page: 1 } });
    expect(Object.keys(read.body.verdicts)).toEqual([KEY_A]);
    expect(read.body.verdicts[KEY_A]).not.toHaveProperty("by");

    expect((await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.1, 0.5, 0.2, 0.55] }, verdict: "reject" })).status).toBe(404);
    expect((await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.1, 0.1, 0.4, 0.3] }, verdict: "maybe" })).status).toBe(400);

    expect(await readJson(await del(project.publicId, { pageNumber: 1, key: KEY_A }))).toMatchObject({ status: 200, body: { removed: true, inboxRefreshed: true } });
    expect(await readJson(await del(project.publicId, { pageNumber: 1, key: KEY_A }))).toMatchObject({ status: 200, body: { removed: false } });
    expect((await pageIntel(page.id)).textRegionVerdicts).toEqual({});
    expect((await projectIntel(project.id)).structureIndex.inbox["1"].find((e: { id: string }) => e.id === KEY_A).state).toBe("todo");
  });

  it("no derived index yet: the verdict is stored and no index is hand-created (C1-B2)", async () => {
    const { user, project } = await createWorld({ projectIntelligence: { keep: "pj" } as never });
    await createPage(project.id, 1, { pageIntelligence: { textRegions: [TR_A] } as never });
    asUser(user);
    const res = await readJson(await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.1, 0.1, 0.4, 0.3] }, verdict: "reject" }));
    expect(res).toMatchObject({ status: 200, body: { inboxRefreshed: false } });
    expect(await projectIntel(project.id)).toEqual({ keep: "pj" });
  });

  it("the generic PATCH can neither write nor clear textRegionVerdicts; the page window never ships them", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [TR_A] } as never });
    asUser(user);
    await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.1, 0.1, 0.4, 0.3] }, verdict: "reject" });
    const before = await pageIntel(page.id);
    for (const value of [{ forged: { verdict: "reject" } }, null]) {
      const res = await intelligencePATCH(makeReq("/api/pages/intelligence", {
        method: "PATCH", body: { publicId: project.publicId, pageNumber: 1, intelligence: { textRegionVerdicts: value, note: 1 } },
      }));
      expect(res.status).toBe(200);
      expect((await pageIntel(page.id)).textRegionVerdicts).toEqual(before.textRegionVerdicts);
    }
    expect(serializePageWindowIntelligence(await pageIntel(page.id))).not.toHaveProperty("textRegionVerdicts");
  });

  it("a proposal verdict is delegated: stored with the server snapshot, mirrored on the summary, slice refreshed", async () => {
    const { user, project } = await createWorld({
      projectIntelligence: {
        proposals: { engineVersion: "e1", generatedAt: "t", total: 1, truncated: false, items: [SUMMARY_ITEM(1)] },
        structureIndex: { v: 1, at: "t", regions: {}, keys: {}, specSections: {}, inbox: {} },
      } as never,
    });
    const page = await createPage(project.id, 1, { pageIntelligence: { classifierProposals: { proposals: [PROPOSAL] } } as never });
    asUser(user);
    const res = await readJson(await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "reject", features: { forged: 1 } }));
    expect(res).toMatchObject({ status: 200, body: { proposalVerdict: { verdict: "reject", features: { "detect.x": 1 } }, inboxRefreshed: true } });
    expect((await pageIntel(page.id)).proposalVerdicts[PROPOSAL.id]).toMatchObject({ verdict: "reject", userId: user.id });
    const pj = await projectIntel(project.id);
    expect(pj.proposals.items[0].verdict).toBe("reject");
    expect(pj.structureIndex.inbox["1"]).toEqual([expect.objectContaining({ id: PROPOSAL.id, state: "rejected" })]);
    // The save-time accept belongs to the parse save, not the workspace.
    expect((await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "accept", via: "parse", regionId: "r" })).status).toBe(400);
    expect(await readJson(await del(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id }))).toMatchObject({ status: 200, body: { removed: true, inboxRefreshed: true } });
    expect((await projectIntel(project.id)).structureIndex.inbox["1"][0].state).toBe("todo");
  });

  it("the inbox item's own body (WP-3.L: itemId + origin + bbox) records a text-region reject; a bare accept is refused", async () => {
    const { user, project } = await createWorld({ projectIntelligence: { structureIndex: EMPTY_INDEX } as never });
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [TR_A, TR_B], classifierProposals: { proposals: [PROPOSAL] } } as never });
    asUser(user);
    const item = { pageNumber: 1, itemId: KEY_A, origin: "text-region", kind: "notes", bbox: [0.1, 0.1, 0.4, 0.3] };
    expect(await readJson(await post(project.publicId, { ...item, verdict: "reject" }))).toMatchObject({ status: 200, body: { key: KEY_A, inboxRefreshed: true } });
    expect((await pageIntel(page.id)).textRegionVerdicts[KEY_A]).toMatchObject({ verdict: "reject", type: "notes-numbered" });
    // Accept is a commit (WP-3.G), in either body shape.
    expect((await post(project.publicId, { ...item, itemId: KEY_B, bbox: [0.6, 0.6, 0.9, 0.8], verdict: "accept" })).status).toBe(400);
    expect((await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.6, 0.6, 0.9, 0.8] }, verdict: "accept" })).status).toBe(400);
    expect((await post(project.publicId, { ...item, itemId: "draw:0.1,0.1", verdict: "reject" })).status).toBe(400);
    expect((await post(project.publicId, { ...item, origin: "region", verdict: "reject" })).status).toBe(400);
    // A proposal item in the same shape is delegated as before.
    const proposalItem = { pageNumber: 1, itemId: PROPOSAL.id, origin: "proposal", kind: "schedule", bbox: PROPOSAL.bbox, proposalId: PROPOSAL.id, verdict: "reject" };
    expect(await readJson(await post(project.publicId, proposalItem))).toMatchObject({ status: 200, body: { proposalVerdict: { verdict: "reject" } } });
    // Undo by the item id.
    expect(await readJson(await del(project.publicId, { pageNumber: 1, itemId: KEY_A }))).toMatchObject({ status: 200, body: { removed: true } });
    expect((await pageIntel(page.id)).textRegionVerdicts).toEqual({});
  });

  it("the classic verdict bar refreshes the derived slice too: scope=all follows a reject and its undo (MED-1)", async () => {
    const { user, project } = await createWorld({
      projectIntelligence: {
        proposals: { engineVersion: "e1", generatedAt: "t", total: 1, truncated: false, items: [SUMMARY_ITEM(1)] },
        structureIndex: { ...EMPTY_INDEX, inbox: { "1": [{ id: PROPOSAL.id, origin: "proposal", kind: "schedule", b: PROPOSAL.bbox, title: "Door schedule", p: 0.9, state: "todo", proposalId: PROPOSAL.id }] } },
      } as never,
    });
    await createPage(project.id, 1, { pageIntelligence: { classifierProposals: { proposals: [PROPOSAL] } } as never });
    asUser(user);
    const stateAll = async () => (await getWorkspaceItems(project, null, { scope: "all" })).groups[0].items.find((i) => i.id === PROPOSAL.id);
    expect((await classic(project.publicId, "POST", { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "reject" })).status).toBe(200);
    expect(await stateAll()).toMatchObject({ verdict: "reject", state: "rejected" });
    expect((await classic(project.publicId, "DELETE", { pageNumber: 1, proposalId: PROPOSAL.id })).status).toBe(200);
    expect((await stateAll())?.state).toBe("todo");
  });

  it("a reject of a proposal item reaches the text region folded into it, and Undo clears both (MED-2)", async () => {
    const { user, project } = await createWorld({ projectIntelligence: { structureIndex: EMPTY_INDEX } as never });
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [TR_A, TR_B], classifierProposals: { proposals: [NOTES_PROPOSAL] } } as never });
    asUser(user);
    const sheet = (await readJson(await items(project.publicId, "?scope=sheet&page=1"))).body.groups[0];
    expect(sheet.items.map((i: { id: string }) => i.id).sort()).toEqual([KEY_B, NOTES_PROPOSAL.id].sort()); // block A is folded
    const res = await readJson(await post(project.publicId, { pageNumber: 1, proposalId: NOTES_PROPOSAL.id, verdict: "reject" }));
    expect(res).toMatchObject({ status: 200, body: { proposalVerdict: { verdict: "reject" }, folded: [KEY_A], inboxRefreshed: true } });
    // The classic Notes card reads textRegionVerdicts: block A now carries the reject; block B does not.
    expect(Object.keys((await pageIntel(page.id)).textRegionVerdicts)).toEqual([KEY_A]);
    expect((await projectIntel(project.id)).structureIndex.inbox["1"].find((e: { id: string }) => e.id === KEY_A).state).toBe("rejected");
    expect(await readJson(await del(project.publicId, { pageNumber: 1, proposalId: NOTES_PROPOSAL.id }))).toMatchObject({ status: 200, body: { removed: true, folded: [KEY_A] } });
    expect((await pageIntel(page.id)).textRegionVerdicts).toEqual({});
    expect((await pageIntel(page.id)).proposalVerdicts).toEqual({});
    expect(await itemState(project.publicId, NOTES_PROPOSAL.id)).toBe("todo");
  });

  it("Undo lifts a classic positional reject the inbox is showing (folded or not), only while the IoU check holds", async () => {
    const { user, project } = await createWorld({ projectIntelligence: { structureIndex: EMPTY_INDEX } as never });
    const page = await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [TR_A, TR_B], rejectedTextRegionIds: ["region-0", "region-1", "region-9"], classifierProposals: { proposals: [NOTES_PROPOSAL] } } as never,
    });
    asUser(user);
    // Folded: the proposal item adopted block A's classic reject; Undo on the item lifts it.
    expect(await itemState(project.publicId, NOTES_PROPOSAL.id)).toBe("rejected");
    expect(await readJson(await del(project.publicId, { pageNumber: 1, proposalId: NOTES_PROPOSAL.id }))).toMatchObject({ status: 200, body: { removed: true } });
    expect((await pageIntel(page.id)).rejectedTextRegionIds).toEqual(["region-1", "region-9"]);
    expect(await itemState(project.publicId, NOTES_PROPOSAL.id)).toBe("todo");
    // Not folded: Undo by the content key lifts block B's classic reject; an unrelated id stays.
    expect(await itemState(project.publicId, KEY_B)).toBe("rejected");
    expect(await readJson(await del(project.publicId, { pageNumber: 1, key: KEY_B }))).toMatchObject({ status: 200, body: { removed: true } });
    expect((await pageIntel(page.id)).rejectedTextRegionIds).toEqual(["region-9"]);
    expect(await readJson(await del(project.publicId, { pageNumber: 1, key: KEY_B }))).toMatchObject({ status: 200, body: { removed: false } });
  });

  it("a new verdict replaces an older one that matches the same region under a re-minted key (LOW-4)", async () => {
    const OLD = "tr:notes-numbered:0.11,0.10,0.40,0.30";
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: { textRegions: [TR_A], textRegionVerdicts: { [OLD]: { verdict: "reject", type: "notes-numbered", b: [0.11, 0.1, 0.4, 0.3], at: "2026-01-01T00:00:00.000Z" } } } as never,
    });
    asUser(user);
    expect((await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.1, 0.1, 0.4, 0.3] }, verdict: "reject" })).status).toBe(200);
    expect(Object.keys((await pageIntel(page.id)).textRegionVerdicts)).toEqual([KEY_A]);
  });

  it("demo projects refuse every method and role", async () => {
    const { company, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { textRegions: [TR_A] } as never });
    await publishDemoFixture(project.id);
    const member = await createUser(company.id);
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const writes: number[] = [];
    const reads: number[] = [];
    for (const actor of [null, member, root]) {
      actor ? asUser(actor) : signedOut();
      writes.push((await post(project.publicId, { pageNumber: 1, textRegion: { type: "notes-numbered", bbox: [0.1, 0.1, 0.4, 0.3] }, verdict: "reject" })).status);
      writes.push((await del(project.publicId, { pageNumber: 1, key: KEY_A })).status);
      reads.push((await items(project.publicId)).status, (await items(project.publicId, "?scope=sheet&page=1")).status, (await verdicts(project.publicId, 1)).status);
    }
    expect(writes).toEqual([403, 403, 403, 403, 403, 403]);
    expect(reads.every((s) => s === 401 || s === 403 || s === 404)).toBe(true);
    expect((await pageIntel(page.id)).textRegionVerdicts).toBeUndefined();
  });

  it("signed-out → 401; cross-tenant → 404", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1);
    signedOut();
    expect((await items(project.publicId)).status).toBe(401);
    expect((await verdicts(project.publicId, 1)).status).toBe(401);
    asUser(await createUser((await createWorld()).company.id));
    expect((await items(project.publicId)).status).toBe(404);
    expect((await post(project.publicId, { pageNumber: 1, key: KEY_A })).status).toBe(404);
  });
});
