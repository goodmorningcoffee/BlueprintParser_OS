// @vitest-environment node
// [TP-1 WP-1.B 2026-10-26] K03 (classic), server side.
//  1. Accept card A, then Reject card B with the body the classifiers now send
//     (`{rejectedTextRegionIds}` only): A's committed region survives. The second case pins WHY the
//     client had to change — the PATCH merge is a frozen shallow merge (PLAN §1.6 rule 2), so a
//     whole stale blob still rolls parsedRegions back; that server behaviour is deliberately unchanged.
//  2. promote/delete responses carry the page-window projection (serializePageWindowIntelligence):
//     denylisted server-only keys never reach the client cache, and stay in the DB.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/project-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/project-analysis")>();
  return { ...orig, computeProjectSummaries: vi.fn() };
});

import { POST as promotePOST } from "@/app/api/regions/promote/route";
import { DELETE as regionDELETE } from "@/app/api/regions/route";
import { PATCH as intelligencePATCH } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { asUser, createPage, createWorld, makeReq, readJson } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const promote = (body: unknown) => promotePOST(makeReq("/api/regions/promote", { method: "POST", body }));
const patch = (body: unknown) => intelligencePATCH(makeReq("/api/pages/intelligence", { method: "PATCH", body }));
const remove = (body: unknown) => regionDELETE(makeReq("/api/regions", { method: "DELETE", body }));

const textRegion = (id: string) => ({ id, type: "notes-numbered", bbox: [0.1, 0.1, 0.5, 0.1], headerText: `Notes ${id}` });
const ACCEPT_A = { type: "notes", overrides: { regionId: "parsed-A", bbox: [0.1, 0.1, 0.6, 0.2], data: { tableName: "Notes A" } } };

const pageIntel = async (pageId: number) => {
  const [row] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId));
  return row.pi as Record<string, any>;
};

beforeEach(() => {
  vi.mocked(computeProjectSummaries).mockReset().mockResolvedValue(null as never);
});

describe.skipIf(!dbUp)("K03: Accept A, then Reject B", () => {
  it("the one-key Reject body keeps A's committed region", async () => {
    const { user, project } = await createWorld();
    const stale = { textRegions: [textRegion("A"), textRegion("B")], parsedRegions: [] };
    const page = await createPage(project.id, 1, { pageIntelligence: stale as never });
    asUser(user);

    expect((await promote({ publicId: project.publicId, pageNumber: 1, ...ACCEPT_A })).status).toBe(200);
    const { status } = await readJson(await patch({
      publicId: project.publicId, pageNumber: 1, intelligence: { rejectedTextRegionIds: ["B"] },
    }));
    expect(status).toBe(200);

    const pi = await pageIntel(page.id);
    expect(pi.parsedRegions.map((r: { id: string }) => r.id)).toEqual(["parsed-A"]); // A survived
    expect(pi.rejectedTextRegionIds).toEqual(["B"]);
    expect(pi.textRegions).toEqual(stale.textRegions);
  });

  it("pins the mechanism: the old whole-blob body (stale cache) still rolls A back — the frozen shallow merge", async () => {
    const { user, project } = await createWorld();
    const stale = { textRegions: [textRegion("A"), textRegion("B")], parsedRegions: [] };
    const page = await createPage(project.id, 1, { pageIntelligence: stale as never });
    asUser(user);
    await promote({ publicId: project.publicId, pageNumber: 1, ...ACCEPT_A });
    await patch({ publicId: project.publicId, pageNumber: 1, intelligence: { ...stale, rejectedTextRegionIds: ["B"] } });
    expect((await pageIntel(page.id)).parsedRegions).toEqual([]);
  });
});

describe.skipIf(!dbUp)("K03: promote/delete responses use the page-window projection", () => {
  const SERVER_ONLY = {
    evidence: { holes: [] },
    shapes: { s: 1 },
    regionsV2: { regions: [] },
    classifiedRegions: { tables: [] },
    yoloHeatmap: { confidentRegions: [] },
    csiSpatialMap: { zones: [] },
    classifierProposals: { proposals: [] },
    proposalVerdicts: { p: { verdict: "accept" } },
  };

  it("promote omits denylisted keys from updatedIntelligence; the DB keeps them", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { ...SERVER_ONLY, keep: "me" } as never });
    asUser(user);
    const { status, body } = await readJson(await promote({ publicId: project.publicId, pageNumber: 1, ...ACCEPT_A }));
    expect(status).toBe(200);
    expect(Object.keys(body.updatedIntelligence).sort()).toEqual(["keep", "parsedRegions"]);
    const pi = await pageIntel(page.id);
    for (const [key, value] of Object.entries(SERVER_ONLY)) expect(pi[key]).toEqual(value);
  });

  it("delete omits denylisted keys from updatedIntelligence; the DB keeps them", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: { ...SERVER_ONLY, parsedRegions: [{ id: "gone", type: "notes", bbox: [0, 0, 1, 1], data: {} }] } as never,
    });
    asUser(user);
    const { status, body } = await readJson(await remove({ publicId: project.publicId, pageNumber: 1, regionId: "gone" }));
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.updatedIntelligence).toEqual({ parsedRegions: [] });
    const pi = await pageIntel(page.id);
    for (const [key, value] of Object.entries(SERVER_ONLY)) expect(pi[key]).toEqual(value);
  });
});
