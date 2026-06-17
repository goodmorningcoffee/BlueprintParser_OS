// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION — PATCH /api/pages/intelligence (persist pageIntelligence
// + CSI merge). The canonical dual-accept route. Freezes: publicId-wins-over-dbId; the demo-WRITE
// 403 gate (admin/root only — the HIGHEST-risk quirk, the shell can't express it); SHALLOW (not
// deep) merge; CSI merge wiring; the CONDITIONAL summaries recompute with an INNER swallow that
// must NOT abort the 200; and the sanctioned leak-drop (a thrown internal → generic 500, no leak).
// mergeCsiCodes + computeProjectSummaries are mocked so the route's WIRING (not their internals)
// is what is frozen.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/csi-utils", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-utils")>();
  return { ...orig, mergeCsiCodes: vi.fn() };
});
vi.mock("@/lib/project-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/project-analysis")>();
  return { ...orig, computeProjectSummaries: vi.fn() };
});

import { PATCH } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { asUser, createPage, createUser, createWorld, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const req = (body: unknown) => PATCH(makeReq("/api/pages/intelligence", { method: "PATCH", body }));
const piOf = async (pageId: number) => {
  const [r] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId)).limit(1);
  return r?.pi as Record<string, unknown>;
};

beforeEach(() => {
  vi.mocked(mergeCsiCodes).mockImplementation((e: any, i: any) => [...(e ?? []), ...(i ?? [])]);
  vi.mocked(computeProjectSummaries).mockReset();
  vi.mocked(computeProjectSummaries).mockResolvedValue(null as any);
});

describe.skipIf(!dbUp)("PATCH /api/pages/intelligence", () => {
  it("happy (publicId): shallow-merges, returns {ok, csiCodeCount, summaries:null}", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { existing: 1 } as any, csiCodes: [{ code: "01" }] as any });
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { foo: "bar" } }));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, csiCodeCount: 1, summaries: null });
    expect(await piOf(page.id)).toEqual({ existing: 1, foo: "bar" });
  });

  it("dual-accept: numeric projectId (dbId) fallback works", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const { status } = await readJson(await req({ projectId: project.id, pageNumber: 1, intelligence: { a: 1 } }));
    expect(status).toBe(200);
  });

  it("publicId WINS over a bogus numeric projectId", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const { status } = await readJson(await req({ publicId: project.publicId, projectId: 999999, pageNumber: 1, intelligence: { a: 1 } }));
    expect(status).toBe(200); // resolved via publicId, not the 404-bound dbId
  });

  it("SANCTIONED diff C: a non-uuid publicId → 400 'Invalid project id'", async () => {
    // [detector-review jun17] locks diff C on this route's publicId branch (resolveByPublicId).
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: "not-a-uuid", pageNumber: 1, intelligence: { a: 1 } }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  it("SANCTIONED diff D: a non-integer dbId projectId → 400 'Invalid project id'", async () => {
    // [detector-review jun17] locks diff D on the dual route's dbId fallback (resolveByDbId guard).
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: "abc", pageNumber: 1, intelligence: { a: 1 } }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  it("FROZEN shallow merge: nested object under a shared key is REPLACED wholesale", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: { a: 1, nested: { x: 1 } } as any });
    asUser(user);
    await req({ publicId: project.publicId, pageNumber: 1, intelligence: { nested: { y: 2 } } });
    expect(await piOf(page.id)).toEqual({ a: 1, nested: { y: 2 } });
  });

  it("CSI merge: csiCodeCount reflects mergeCsiCodes(existing, parsedRegions.csiTags)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { csiCodes: [{ code: "01" }] as any });
    asUser(user);
    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, intelligence: { parsedRegions: [{ csiTags: [{ code: "02", description: "d2" }, { code: "03", description: "d3" }] }] } }),
    );
    expect(status).toBe(200);
    expect(body.csiCodeCount).toBe(3); // 1 existing + 2 incoming (mock concat)
  });

  it("conditional summaries: parsedRegions present → computeProjectSummaries result returned", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    vi.mocked(computeProjectSummaries).mockResolvedValue({ totals: 7 } as any);
    asUser(user);
    const { body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { parsedRegions: [] } }));
    expect(body.summaries).toEqual({ totals: 7 });
  });

  it("FROZEN summaries swallow: a recompute failure → 200 with summaries:null (write still commits)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { pageIntelligence: {} as any });
    vi.mocked(computeProjectSummaries).mockRejectedValue(new Error("recompute boom"));
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { parsedRegions: [], k: 9 } }));
    expect(status).toBe(200);
    expect(body.summaries).toBeNull();
    expect(await piOf(page.id)).toMatchObject({ k: 9 }); // write committed despite the swallow
  });

  describe("demo-write 403 gate", () => {
    it("(a) same-company MEMBER → 403", async () => {
      const { user, project } = await createWorld({ isDemo: true });
      await createPage(project.id, 1);
      asUser(user);
      const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { a: 1 } }));
      expect(status).toBe(403);
      expect(body.error).toEqual({ code: "FORBIDDEN", message: "Demo projects are read-only" });
    });
    it("(b) signed out (scope demo) → 403", async () => {
      const { project } = await createWorld({ isDemo: true });
      await createPage(project.id, 1);
      signedOut();
      const { status } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { a: 1 } }));
      expect(status).toBe(403);
    });
    it("(c) same-company ADMIN → 200", async () => {
      const { company, project } = await createWorld({ isDemo: true });
      await createPage(project.id, 1);
      asUser(await createUser(company.id, { role: "admin" }));
      const { status } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { a: 1 } }));
      expect(status).toBe(200);
    });
    it("(d) root admin → 200", async () => {
      const { project } = await createWorld({ isDemo: true });
      await createPage(project.id, 1);
      asUser(await createUser((await createWorld()).company.id, { isRootAdmin: true }));
      const { status } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { a: 1 } }));
      expect(status).toBe(200);
    });
  });

  it("missing fields → 400 VALIDATION (exact message)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    for (const bad of [
      { publicId: project.publicId, pageNumber: 1 }, // no intelligence
      { publicId: project.publicId, intelligence: { a: 1 } }, // no pageNumber
      { pageNumber: 1, intelligence: { a: 1 } }, // no id
    ]) {
      const { status, body } = await readJson(await req(bad));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "Missing projectId/publicId, pageNumber, or intelligence" });
    }
  });

  it("page not found → 404 'Page not found'", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 7, intelligence: { a: 1 } }));
    expect(status).toBe(404);
    expect(body.error.message).toBe("Page not found");
  });

  it("SANCTIONED leak-drop: an internal throw → generic 500, no leaked detail", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    vi.mocked(mergeCsiCodes).mockImplementationOnce(() => {
      throw new Error("PG_SECRET constraint detail");
    });
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { a: 1 } }));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("PG_SECRET");
  });

  it("cross-tenant → 404", async () => {
    const { project } = await createWorld();
    asUser(await createUser((await createWorld()).company.id));
    const { status, body } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, intelligence: { a: 1 } }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("malformed JSON → 400 BAD_REQUEST", async () => {
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/intelligence", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    const { status, body } = await readJson(await PATCH(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("empty body → 400 VALIDATION (zLooseBody rejects undefined; legacy caught + leaked a 500)", async () => {
    // [detector-review jun17] sanctioned diff E sub-case: empty text → undefined → VALIDATION 400.
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/intelligence", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const { status, body } = await readJson(await PATCH(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });
});
