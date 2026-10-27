// @vitest-environment node
// [table pipeline WP-2.F, K58] POST /api/projects/[id]/proposals/verdict with `via:"parse"` — the accept the
// SAVE of a "Parse this table" parse posts. The server takes the STORED classId, records the saved region,
// writes only when the proposal has no verdict yet, and ignores (200, verdict null, nothing written) a forged
// or stale proposal id and a region that is missing or does not overlap the proposal. All strings synthetic.
import { describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/projects/[id]/proposals/verdict/route";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import type { ClassifierProposal, ProjectProposalSummary } from "@/lib/classifier-engine/types";
import { asUser, createPage, createWorld, makeReq, params, publishDemoFixture, readJson } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const PROPOSAL: ClassifierProposal = {
  id: "schedule-kind:p1:0.1,0.1,0.5,0.4",
  recipeId: "schedule-kind",
  recipeVersion: 3,
  engineVersion: "clf/0.1",
  pageNumber: 1,
  bbox: [0.1, 0.1, 0.5, 0.4],
  target: "schedule",
  p: 0.91,
  classId: "door",
  className: "Door schedule",
  group: "arch",
  nameP: 0.8,
  margin: 0.4,
  displayName: "Door schedule",
  detectWhy: [],
  nameWhy: [],
  features: { "detect.structure": 0.7 },
};

const SUMMARY: ProjectProposalSummary = {
  engineVersion: "clf/0.1",
  generatedAt: "2026-10-24T00:00:00.000Z",
  total: 1,
  truncated: false,
  items: [{
    id: PROPOSAL.id, recipeId: PROPOSAL.recipeId, pageNumber: 1, bbox: PROPOSAL.bbox, target: "schedule",
    classId: "door", className: "Door schedule", group: "arch", displayName: "Door schedule", p: 0.91, nameP: 0.8,
  }],
};

const region = (id: string, bbox: number[]) => ({
  id, type: "schedule", category: "t", bbox, confidence: 0.9, data: { headers: ["A"], rows: [], rowCount: 0, columnCount: 1 },
});

const post = (publicId: string, body: unknown) =>
  POST(makeReq(`/api/projects/${publicId}/proposals/verdict`, { method: "POST", body }), params({ id: publicId }));

async function seeded(extra: Record<string, unknown> = {}) {
  const world = await createWorld();
  const page = await createPage(world.project.id, 1, {
    pageIntelligence: {
      classifierProposals: { engineVersion: "clf/0.1", recipes: { "schedule-kind": 3 }, proposals: [PROPOSAL] },
      parsedRegions: [region("parsed-near", [0.11, 0.1, 0.5, 0.42]), region("parsed-far", [0.6, 0.6, 0.9, 0.9])],
      ...extra,
    } as never,
  });
  await db.update(projects).set({ projectIntelligence: { proposals: SUMMARY } as never }).where(eq(projects.id, world.project.id));
  return { ...world, page };
}

async function pageIntel(pageId: number) {
  const [row] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId));
  return row.pi as Record<string, any>;
}

const accept = (over: Record<string, unknown> = {}) => ({
  pageNumber: 1, proposalId: PROPOSAL.id, verdict: "accept", via: "parse", regionId: "parsed-near", ...over,
});

describe.skipIf(!dbUp)("POST …/proposals/verdict via parse (K58)", () => {
  it("a hinted save records accept with the STORED classId and the region, and mirrors the summary", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    const res = await readJson(await post(project.publicId, accept()));
    expect(res.status).toBe(200);
    expect(res.body.verdict).toMatchObject({
      proposalId: PROPOSAL.id, verdict: "accept", classId: "door", proposedClassId: "door", via: "parse",
      regionId: "parsed-near", userId: user.id,
    });
    expect((await pageIntel(page.id)).proposalVerdicts[PROPOSAL.id]).toEqual(res.body.verdict);
    const [proj] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
    expect((proj.pi as any).proposals.items[0].verdict).toBe("accept");
  });

  it("an existing verdict is never overwritten (only when no verdict exists)", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    expect((await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "reject" })).status).toBe(200);
    const res = await readJson(await post(project.publicId, accept()));
    expect(res).toMatchObject({ status: 200, body: { verdict: null } });
    expect((await pageIntel(page.id)).proposalVerdicts[PROPOSAL.id].verdict).toBe("reject");
  });

  it("a forged proposalId, a missing region or a region that does not overlap the proposal is ignored", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    for (const over of [{ proposalId: "forged:p1:0,0,1,1" }, { regionId: "nope" }, { regionId: "parsed-far" }]) {
      const res = await readJson(await post(project.publicId, accept(over)));
      expect(res).toMatchObject({ status: 200, body: { verdict: null } });
    }
    expect((await pageIntel(page.id)).proposalVerdicts).toBeUndefined();
  });

  it("via parse takes no client classId or name and needs a regionId; demo is refused", async () => {
    const { user, project } = await seeded();
    asUser(user);
    expect((await post(project.publicId, accept({ classId: "window" }))).status).toBe(400);
    expect((await post(project.publicId, accept({ verdict: "reject" }))).status).toBe(400);
    expect((await post(project.publicId, accept({ regionId: undefined }))).status).toBe(400);
    expect((await post(project.publicId, accept({ via: "other" }))).status).toBe(400);
    await publishDemoFixture(project.id);
    expect((await post(project.publicId, accept())).status).toBe(403);
  });
});
