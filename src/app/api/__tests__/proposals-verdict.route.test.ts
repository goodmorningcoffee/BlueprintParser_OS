// @vitest-environment node
// [classifier-builder 2026-10-24] POST / DELETE /api/projects/[id]/proposals/verdict — auth, demo refusal for
// every role, missing page / proposal → 404, the features + classId snapshot comes from the STORED proposal
// (a forged client `features` is ignored), the projectIntelligence.proposals mirror, undo, and the generic
// PATCH /api/pages/intelligence cannot write proposalVerdicts / classifierProposals.
import { describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { DELETE, POST } from "@/app/api/projects/[id]/proposals/verdict/route";
import { PATCH as intelligencePATCH } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import type { ClassifierProposal, ProjectProposalSummary } from "@/lib/classifier-engine/types";
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
  features: { "detect.structure": 0.7, "door.header": 1 },
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

const url = (publicId: string) => `/api/projects/${publicId}/proposals/verdict`;
const post = (publicId: string, body: unknown) =>
  POST(makeReq(url(publicId), { method: "POST", body }), params({ id: publicId }));
const del = (publicId: string, body: unknown) =>
  DELETE(makeReq(url(publicId), { method: "DELETE", body }), params({ id: publicId }));

async function seeded() {
  const world = await createWorld();
  const page = await createPage(world.project.id, 1, {
    pageIntelligence: {
      classifierProposals: { engineVersion: "clf/0.1", recipes: { "schedule-kind": 3 }, proposals: [PROPOSAL] },
      keep: "me",
    } as never,
  });
  await db.update(projects)
    .set({ projectIntelligence: { proposals: SUMMARY, other: { kept: true } } as never })
    .where(eq(projects.id, world.project.id));
  return { ...world, page };
}

async function pageIntel(pageId: number) {
  const [row] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId));
  return row.pi as Record<string, any>;
}

async function projectIntel(projectId: number) {
  const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
  return row.pi as Record<string, any>;
}

describe.skipIf(!dbUp)("POST/DELETE /api/projects/[id]/proposals/verdict", () => {
  it("records a rename with the server's snapshot, mirrors the summary, keeps other keys", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    const { status, body } = await readJson(await post(project.publicId, {
      pageNumber: 1, proposalId: PROPOSAL.id, verdict: "rename", classId: "window",
      features: { forged: 99 }, proposedClassId: "panel", userId: 12345,
    }));
    expect(status).toBe(200);
    const v = body.verdict;
    expect(v).toMatchObject({
      proposalId: PROPOSAL.id, recipeId: "schedule-kind", recipeVersion: 3, verdict: "rename", classId: "window",
      features: PROPOSAL.features, proposedClassId: "door", userId: user.id,
    });
    expect(typeof v.at).toBe("string");
    const pi = await pageIntel(page.id);
    expect(pi.proposalVerdicts[PROPOSAL.id]).toEqual(v);
    expect(pi.keep).toBe("me");
    expect(pi.classifierProposals.proposals).toHaveLength(1);
    const proj = await projectIntel(project.id);
    expect(proj.proposals.items[0].verdict).toBe("rename");
    expect(proj.other).toEqual({ kept: true });
  });

  it("other-schedule rename carries a free name; reject takes none", async () => {
    const { user, project } = await seeded();
    asUser(user);
    const named = await readJson(await post(project.publicId, {
      pageNumber: 1, proposalId: PROPOSAL.id, verdict: "rename", classId: "other-schedule", name: "  Louver schedule ",
    }));
    expect(named.status).toBe(200);
    expect(named.body.verdict.name).toBe("Louver schedule");
    const bad = await readJson(await post(project.publicId, {
      pageNumber: 1, proposalId: PROPOSAL.id, verdict: "reject", classId: "door",
    }));
    expect(bad.status).toBe(400);
    const unknownKind = await readJson(await post(project.publicId, {
      pageNumber: 1, proposalId: PROPOSAL.id, verdict: "rename", classId: "spaceship",
    }));
    expect(unknownKind.status).toBe(400);
    const noClass = await readJson(await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "rename" }));
    expect(noClass.status).toBe(400);
  });

  it("missing proposal or page → 404 and nothing is written", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    const missing = await readJson(await post(project.publicId, { pageNumber: 1, proposalId: "nope", verdict: "accept" }));
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe("Proposal not found");
    const noPage = await readJson(await post(project.publicId, { pageNumber: 9, proposalId: PROPOSAL.id, verdict: "accept" }));
    expect(noPage.status).toBe(404);
    expect((await pageIntel(page.id)).proposalVerdicts).toBeUndefined();
  });

  it("undo deletes the verdict and clears the summary mirror; a second undo is a no-op", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    expect((await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "reject" })).status).toBe(200);
    expect((await projectIntel(project.id)).proposals.items[0].verdict).toBe("reject");
    const first = await readJson(await del(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id }));
    expect(first).toMatchObject({ status: 200, body: { removed: true } });
    expect((await pageIntel(page.id)).proposalVerdicts).toEqual({});
    expect((await projectIntel(project.id)).proposals.items[0].verdict).toBeUndefined();
    const second = await readJson(await del(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id }));
    expect(second).toMatchObject({ status: 200, body: { removed: false } });
  });

  it("signed-out → 401; cross-tenant → 404", async () => {
    const { project } = await seeded();
    signedOut();
    expect((await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "accept" })).status).toBe(401);
    asUser(await createUser((await createWorld()).company.id));
    expect((await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "accept" })).status).toBe(404);
  });

  it("demo projects refuse every role, both methods, before any write", async () => {
    const { company, project, page } = await seeded();
    await publishDemoFixture(project.id);
    const member = await createUser(company.id);
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const statuses: number[] = [];
    for (const actor of [null, member, root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push((await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "accept" })).status);
      statuses.push((await del(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id })).status);
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
    expect((await pageIntel(page.id)).proposalVerdicts).toBeUndefined();
  });

  it("the generic intelligence PATCH can neither write nor clear proposalVerdicts / classifierProposals", async () => {
    const { user, project, page } = await seeded();
    asUser(user);
    expect((await post(project.publicId, { pageNumber: 1, proposalId: PROPOSAL.id, verdict: "accept" })).status).toBe(200);
    const before = await pageIntel(page.id);
    const res = await intelligencePATCH(makeReq("/api/pages/intelligence", {
      method: "PATCH",
      body: {
        publicId: project.publicId, pageNumber: 1,
        intelligence: { proposalVerdicts: { forged: { verdict: "accept" } }, classifierProposals: null, note: 1 },
      },
    }));
    expect(res.status).toBe(200);
    const after = await pageIntel(page.id);
    expect(after.proposalVerdicts).toEqual(before.proposalVerdicts);
    expect(after.classifierProposals).toEqual(before.classifierProposals);
    expect(after.note).toBe(1);
  });
});
