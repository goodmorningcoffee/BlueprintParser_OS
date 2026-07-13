// @vitest-environment node
// [refactor jul13 P2.4 W1] DELETE /api/regions — durable ParsedRegion deletion.
//
// Mutation-bearing acceptance coverage: strict wire/auth/demo policy; row-locked deletion that
// removes every duplicate id while preserving sibling order, unknown PageIntelligence keys, and
// page-level CSI codes; an idempotent absent target that performs no UPDATE; post-commit summary
// success/failure; and concurrent distinct-id / same-id deletes.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/project-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/project-analysis")>();
  return { ...orig, computeProjectSummaries: vi.fn() };
});

import { DELETE } from "@/app/api/regions/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { computeProjectSummaries } from "@/lib/project-analysis";
import {
  asUser,
  createPage,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const loggerWarn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

const req = (body: unknown) =>
  DELETE(makeReq("/api/regions", { method: "DELETE", body }));

const region = (id: string, marker: string) => ({
  id,
  type: "schedule",
  bbox: [0.1, 0.2, 0.3, 0.4],
  data: { marker },
  category: marker,
  source: "user",
  confidence: 0.85,
});

const pageState = async (pageId: number) => {
  const [row] = await db
    .select({ pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  return {
    pageIntelligence: row?.pageIntelligence as Record<string, unknown>,
    csiCodes: row?.csiCodes,
  };
};

const pageVersion = async (pageId: number): Promise<string> => {
  const result = await db.execute(sql`SELECT xmin::text AS version FROM pages WHERE id = ${pageId}`);
  return String((result.rows[0] as { version: string }).version);
};

beforeEach(() => {
  loggerWarn.mockClear();
  vi.mocked(computeProjectSummaries).mockReset();
  vi.mocked(computeProjectSummaries).mockResolvedValue({ marker: "summary" } as never);
});

describe.skipIf(!dbUp)("DELETE /api/regions", () => {
  it("deletes every matching id durably and preserves ordered siblings, unknown PI, and csiCodes", async () => {
    const { user, project } = await createWorld();
    const csiCodes = [
      { code: "08 11 16", description: "Aluminum Doors", trade: "Openings", division: "08" },
    ];
    const page = await createPage(project.id, 1, {
      pageIntelligence: {
        parsedRegions: [
          region("keep-a", "A"),
          region("target", "first duplicate"),
          region("keep-b", "B"),
          region("target", "second duplicate"),
        ],
        futureOwner: { nested: [1, 2, 3] },
        rejectedTextRegionIds: ["tr-7"],
      } as never,
      csiCodes,
    });
    vi.mocked(computeProjectSummaries).mockImplementationOnce(async () => {
      // A separate connection can observe the target as absent only after the delete tx commits.
      // This kills moving summary recomputation under the row lock or before the UPDATE.
      const committed = await pageState(page.id);
      const ids = (committed.pageIntelligence.parsedRegions as Array<{ id: string }>).map(
        (candidate) => candidate.id,
      );
      expect(ids).toEqual(["keep-a", "keep-b"]);
      return { marker: "summary" } as never;
    });
    asUser(user);

    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, regionId: "target" }),
    );

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "deleted",
      "ok",
      "summaries",
      "updatedIntelligence",
    ]);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(true);
    expect(body.updatedIntelligence).toEqual({
      parsedRegions: [region("keep-a", "A"), region("keep-b", "B")],
      futureOwner: { nested: [1, 2, 3] },
      rejectedTextRegionIds: ["tr-7"],
    });
    expect(body.summaries).toEqual({ marker: "summary" });
    expect(computeProjectSummaries).toHaveBeenCalledOnce();
    expect(computeProjectSummaries).toHaveBeenCalledWith(project.id);

    const fresh = await pageState(page.id);
    expect(fresh.pageIntelligence).toEqual(body.updatedIntelligence);
    expect(fresh.csiCodes).toEqual(csiCodes);
  });

  it("already-absent is idempotent deleted:false, returns authoritative PI, and performs no UPDATE", async () => {
    const { user, project } = await createWorld();
    const intelligence = {
      parsedRegions: [region("keep", "K")],
      unknownOwner: { value: true },
    };
    const page = await createPage(project.id, 1, { pageIntelligence: intelligence as never });
    const beforeVersion = await pageVersion(page.id);
    asUser(user);

    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, regionId: "absent" }),
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      deleted: false,
      updatedIntelligence: intelligence,
      summaries: { marker: "summary" },
    });
    expect(await pageVersion(page.id)).toBe(beforeVersion);
    expect(computeProjectSummaries).toHaveBeenCalledWith(project.id);
  });

  it("binds the write to the authorized project and requested non-1 page", async () => {
    const { user, project } = await createWorld();
    const foreign = await createWorld();
    const ownPageOneIntel = {
      parsedRegions: [region("target", "own page-1 decoy")],
      owner: "own-page-1",
    };
    const foreignPageTwoIntel = {
      parsedRegions: [region("target", "foreign page-2 decoy")],
      owner: "foreign-page-2",
    };
    const targetPageIntel = {
      parsedRegions: [region("target", "delete me"), region("keep", "K")],
      owner: "own-page-2",
    };
    const ownPageOne = await createPage(project.id, 1, {
      pageIntelligence: ownPageOneIntel as never,
    });
    const foreignPageTwo = await createPage(foreign.project.id, 2, {
      pageIntelligence: foreignPageTwoIntel as never,
    });
    const targetPage = await createPage(project.id, 2, {
      pageIntelligence: targetPageIntel as never,
    });
    asUser(user);

    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 2, regionId: "target" }),
    );

    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.updatedIntelligence).toEqual({
      parsedRegions: [region("keep", "K")],
      owner: "own-page-2",
    });
    expect((await pageState(targetPage.id)).pageIntelligence).toEqual(body.updatedIntelligence);
    expect((await pageState(ownPageOne.id)).pageIntelligence).toEqual(ownPageOneIntel);
    expect((await pageState(foreignPageTwo.id)).pageIntelligence).toEqual(foreignPageTwoIntel);
  });

  it("summary rejection is non-fatal after commit and returns summaries:null", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: { parsedRegions: [region("target", "T"), region("keep", "K")] } as never,
    });
    vi.mocked(computeProjectSummaries).mockRejectedValue(new Error("summary boom"));
    asUser(user);

    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, regionId: "target" }),
    );

    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.summaries).toBeNull();
    expect(loggerWarn).toHaveBeenCalledOnce();
    expect(loggerWarn).toHaveBeenCalledWith(
      "[regions/delete] Summary recompute failed (non-fatal):",
      expect.objectContaining({ message: "summary boom" }),
    );
    expect((await pageState(page.id)).pageIntelligence).toEqual({
      parsedRegions: [region("keep", "K")],
    });
  });

  it("missing page is 404 and does not recompute summaries", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await req({ publicId: project.publicId, pageNumber: 99, regionId: "target" }),
    );
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Page not found" });
    expect(computeProjectSummaries).not.toHaveBeenCalled();
  });

  it("strict body rejects missing, malformed, and extra fields", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    for (const body of [
      { publicId: project.publicId, pageNumber: 1 },
      { publicId: project.publicId, pageNumber: 0, regionId: "r" },
      { publicId: project.publicId, pageNumber: 1, regionId: "" },
      { publicId: project.publicId, pageNumber: 1, regionId: "r", projectId: project.id },
    ]) {
      const result = await readJson(await req(body));
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION");
    }

    const raw = new Request("http://test.local/api/regions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    const malformed = await readJson(await DELETE(raw));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("BAD_REQUEST");
  });

  it("signed-out real project is 401; cross-tenant and missing project are indistinguishable 404", async () => {
    const { project } = await createWorld();
    signedOut();
    let result = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, regionId: "r" }),
    );
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("UNAUTHORIZED");

    const outsider = await createWorld();
    asUser(outsider.user);
    result = await readJson(
      await req({ publicId: project.publicId, pageNumber: 1, regionId: "r" }),
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");

    result = await readJson(
      await req({ publicId: "00000000-0000-4000-8000-000000000000", pageNumber: 1, regionId: "r" }),
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects every demo write, including owner admin and root, and leaves DB unchanged", async () => {
    const { company, user, project } = await createWorld({ isDemo: true });
    const original = { parsedRegions: [region("target", "T")] };
    const page = await createPage(project.id, 1, { pageIntelligence: original as never });
    const body = { publicId: project.publicId, pageNumber: 1, regionId: "target" };
    const callers = [
      null,
      user,
      await createUser(company.id, { role: "admin" }),
      await createUser((await createWorld()).company.id, { isRootAdmin: true }),
    ];

    for (const caller of callers) {
      if (caller) asUser(caller);
      else signedOut();
      const result = await readJson(await req(body));
      expect(result.status).toBe(403);
      expect(result.body.error).toEqual({
        code: "FORBIDDEN",
        message: "Demo projects are read-only",
      });
      expect((await pageState(page.id)).pageIntelligence).toEqual(original);
    }
    expect(computeProjectSummaries).not.toHaveBeenCalled();
  });

  it("concurrent different-id deletes both survive with the third sibling retained", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: {
        parsedRegions: [region("delete-a", "A"), region("keep", "K"), region("delete-b", "B")],
      } as never,
    });
    asUser(user);

    const [a, b] = await Promise.all([
      req({ publicId: project.publicId, pageNumber: 1, regionId: "delete-a" }).then(readJson),
      req({ publicId: project.publicId, pageNumber: 1, regionId: "delete-b" }).then(readJson),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.deleted, b.body.deleted]).toEqual([true, true]);
    expect((await pageState(page.id)).pageIntelligence).toEqual({
      parsedRegions: [region("keep", "K")],
    });
  });

  it("concurrent same-id deletes serialize to exactly one true and one false", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: { parsedRegions: [region("target", "T"), region("keep", "K")] } as never,
    });
    asUser(user);
    const body = { publicId: project.publicId, pageNumber: 1, regionId: "target" };

    const results = await Promise.all([req(body).then(readJson), req(body).then(readJson)]);

    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.map((result) => result.body.deleted).sort()).toEqual([false, true]);
    expect((await pageState(page.id)).pageIntelligence).toEqual({
      parsedRegions: [region("keep", "K")],
    });
  });
});
