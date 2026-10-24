// @vitest-environment node
// [clf step 4 2026-10-24] POST /api/admin/classifiers/fit — DB-backed. Root only; dryRun must be
// true; reads one company's NON-DEMO verdicts (other companies and demo projects never counted);
// returns the report + a proposed overlay and writes nothing (pages and the company overlay unchanged).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { eq } from "drizzle-orm";
import { POST } from "@/app/api/admin/classifiers/fit/route";
import { db } from "@/lib/db";
import { companies, pages } from "@/lib/db/schema";
import type { ProposalVerdict } from "@/lib/classifier-engine/types";
import {
  asUser, createCompany, createPage, createProject, createUser, makeReq, publishDemoFixture, readJson, signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

/** n verdicts on schedules.v1: accepted ones have high structure, rejected ones low. */
function verdicts(n: number, tag: string): Record<string, ProposalVerdict> {
  const out: Record<string, ProposalVerdict> = {};
  for (let i = 0; i < n; i++) {
    const accept = i % 2 === 0;
    const s = ((i * 37) % 100) / 100;
    const id = `schedules.v1:p1:${tag}${i}`;
    out[id] = {
      proposalId: id, recipeId: "schedules.v1", recipeVersion: 2, verdict: accept ? "accept" : "reject",
      features: { "detect.structure": accept ? 0.5 + s / 2 : s / 2, "detect.textract": 0, "detect.scheduleWord": accept ? 1 : 0.2, "detect.rows": s },
      proposedClassId: null, userId: 1, at: "2026-10-24T00:00:00Z",
    };
  }
  return out;
}

async function world() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const root = await createUser(company.id, { isRootAdmin: true });
  const p1 = await createProject(company.id, admin.id);
  return { company, admin, root, p1 };
}

const post = (body: Record<string, unknown>) => POST(makeReq("/api/admin/classifiers/fit", { body })).then(readJson);

describe.skipIf(!dbUp)("admin classifier fit", () => {
  it("auth: signed-out 401, company admin 403, root 200; dryRun must be true", async () => {
    const w = await world();
    signedOut();
    expect((await post({ dryRun: true })).status).toBe(401);
    asUser(w.admin);
    expect((await post({ dryRun: true })).status).toBe(403);
    asUser(w.root);
    expect((await post({ dryRun: true })).status).toBe(200);
    expect((await post({ dryRun: false })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("fits on the company's non-demo verdicts only, returns a proposed overlay, writes nothing", async () => {
    const w = await world();
    const page1 = await createPage(w.p1.id, 1, { pageIntelligence: { proposalVerdicts: verdicts(30, "a") } as never });
    await createPage(w.p1.id, 2, { pageIntelligence: { proposalVerdicts: verdicts(10, "b") } as never });
    await createPage(w.p1.id, 3, { pageIntelligence: {} as never });
    const demo = await createProject(w.company.id, w.admin.id);
    await createPage(demo.id, 1, { pageIntelligence: { proposalVerdicts: verdicts(7, "d") } as never });
    await publishDemoFixture(demo.id);
    const other = await createCompany();
    const otherAdmin = await createUser(other.id, { role: "admin" });
    const otherProject = await createProject(other.id, otherAdmin.id);
    await createPage(otherProject.id, 1, { pageIntelligence: { proposalVerdicts: verdicts(5, "o") } as never });
    const before = (await db.select().from(pages).where(eq(pages.id, page1.id)))[0].pageIntelligence;
    const configBefore = (await db.select().from(companies).where(eq(companies.id, w.company.id)))[0].pipelineConfig;

    asUser(w.root);
    const { status, body } = await post({ companyId: w.company.id, dryRun: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ dryRun: true, applied: false, companyId: w.company.id });
    expect(body.verdicts).toMatchObject({ total: 40, pages: 2, truncated: false, byRecipe: { "schedules.v1": { accept: 20, reject: 20, rename: 0 } } });
    expect(body.fits).toHaveLength(1);
    expect(body.fits[0]).toMatchObject({ recipeId: "schedules.v1", samples: 40, targets: 20 });
    expect(body.fits[0].detect.status).toMatch(/^(fitted|no-gain)$/);
    expect(body.fits[0].classes.every((c: { status: string }) => c.status === "small-n")).toBe(true);
    expect(body.overlay).toMatchObject({ custom: [] });
    if (body.fits[0].detect.status === "fitted") {
      expect(Object.keys(body.overlay.patches["schedules.v1"].signals).every((k: string) => k.startsWith("detect."))).toBe(true);
    }
    // nothing written
    expect((await db.select().from(pages).where(eq(pages.id, page1.id)))[0].pageIntelligence).toEqual(before);
    expect((await db.select().from(companies).where(eq(companies.id, w.company.id)))[0].pipelineConfig).toEqual(configBefore);

    // root may name another company; an unknown company is 404; a bad id is 400
    const o = await post({ companyId: String(other.id), dryRun: true });
    expect(o.status).toBe(200);
    expect(o.body.verdicts.total).toBe(5);
    expect(o.body.fits[0].detect.status).toBe("small-n");
    expect(o.body.overlay.patches).toEqual({});
    expect((await post({ companyId: 2_000_000_000, dryRun: true })).status).toBe(404);
    expect((await post({ companyId: "abc", dryRun: true })).status).toBe(400);
  });
});
