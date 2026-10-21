// @vitest-environment node
// Hidden duplicate pages leave search (project + global), the LLM tools, the global chat context
// and the project-scope chat context (PLAN §2.2 surface table; verify-r1 #3 added project chat
// and the project-wide tag/annotation/index tools). A request naming the hidden page still
// sees it (direct navigation works). Synthetic text only.
import { describe, expect, inject, it, vi } from "vitest";

const h = vi.hoisted(() => ({ captured: [] as unknown[] }));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/llm/resolve", () => ({
  resolveLLMConfig: async () => ({ provider: "anthropic", model: "test-model", apiKey: "x" }),
}));
vi.mock("@/lib/llm/stream", () => ({
  streamChatResponse: async (_config: unknown, msgs: unknown) => {
    h.captured.push(msgs);
    return new Response("ok");
  },
}));

import { eq, sql } from "drizzle-orm";
import { GET as searchGET } from "@/app/api/search/route";
import { GET as globalGET } from "@/app/api/search/global/route";
import { db } from "@/lib/db";
import { annotations, pages, projects } from "@/lib/db/schema";
import { executeToolCall } from "@/lib/llm/tools";
import { handleGlobalChat } from "@/lib/services/chat/global";
import { handleScopedChat } from "@/lib/services/chat/scoped";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { asUser, createCompany, createPage, createProject, createUser, makeReq, readJson } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const HIDDEN_MARK = { v: 1, pageNumber: 1, tier: "exact", score: 1, content: 1, full: 1, scannedAt: "2026-10-21T00:00:00Z", hiddenAt: "2026-10-21T00:00:00Z" };

async function seed(projectId: number, pageNumber: number, rawText: string, pageIntelligence?: Record<string, unknown>) {
  const pg = await createPage(projectId, pageNumber, { rawText, pageIntelligence: pageIntelligence as never });
  await db.execute(sql`UPDATE pages SET search_vector = to_tsvector('english', raw_text) WHERE id = ${pg.id}`);
}

async function world() {
  const company = await createCompany();
  const user = await createUser(company.id);
  const project = await createProject(company.id, user.id);
  // page 1 canonical, page 2 its hidden duplicate, page 3 a marked-but-not-hidden page
  await seed(project.id, 1, "zephyrine gasket schedule level one");
  await seed(project.id, 2, "zephyrine gasket schedule level one", { duplicateOf: HIDDEN_MARK });
  const { hiddenAt: _drop, ...unhidden } = HIDDEN_MARK;
  void _drop;
  await seed(project.id, 3, "zephyrine gasket schedule level three", { duplicateOf: unhidden });
  return { company, user, project };
}

describe.skipIf(!dbUp)("hidden duplicates are excluded from search, LLM tools and global chat", () => {
  it("project search (plain + exact phrase) skips hidden pages only", async () => {
    const { user, project } = await world();
    asUser(user);
    for (const q of ["zephyrine", `"zephyrine gasket"`]) {
      const r = await readJson(await searchGET(makeReq(`/api/search?projectId=${project.publicId}&q=${encodeURIComponent(q)}`, { method: "GET" })));
      expect(r.status).toBe(200);
      expect(r.body.results.map((x: { pageNumber: number }) => x.pageNumber).sort()).toEqual([1, 3]);
    }
  });

  it("global search counts no hidden page", async () => {
    const { user, project } = await world();
    asUser(user);
    const r = await readJson(await globalGET(makeReq(`/api/search/global?q=zephyrine`, { method: "GET" })));
    const row = r.body.results.find((x: { projectId: string }) => x.projectId === project.publicId);
    expect(row.matchCount).toBe(2);
  });

  it("LLM searchPages tool skips hidden pages", async () => {
    const { company, user, project } = await world();
    const result = await executeToolCall("searchPages", { query: "zephyrine" }, {
      projectId: project.id, publicId: project.publicId, companyId: company.id, userId: user.id,
      writeCapability: assertProjectWritable(project),
    }) as { results: { page_number: number }[] };
    expect(result.results.map((x) => x.page_number).sort()).toEqual([1, 3]);
  });

  it("global chat context carries no hidden page", async () => {
    const { company, user } = await world();
    h.captured.length = 0;
    await handleGlobalChat({ user: { companyId: company.id, dbId: user.id } }, "zephyrine gasket");
    const system = JSON.stringify(h.captured[0]);
    expect(system).toContain("Page 1 ");
    expect(system).toContain("Page 3 ");
    expect(system).not.toContain("Page 2 ");
  });

  async function withYolo() {
    const w = await world();
    const ann = { minX: 0, maxX: 1, minY: 0, maxY: 1, projectId: w.project.id, source: "yolo" };
    await db.insert(annotations).values({ ...ann, name: "alphaclass", pageNumber: 1 });
    await db.insert(annotations).values({ ...ann, name: "zephyrclass", pageNumber: 2 });
    return w;
  }

  it("project-scope chat context carries no hidden page (OCR, YOLO); page-scope on the hidden page still does", async () => {
    const { company, user, project } = await withYolo();
    const session = { user: { companyId: company.id, dbId: user.id } };
    h.captured.length = 0;
    await handleScopedChat({ project, message: "zephyrine", scope: "project", session, isDemo: false });
    const system = JSON.stringify(h.captured[0]);
    expect(system).toContain("--- Page 1 (");
    expect(system).toContain("--- Page 3 (");
    expect(system).not.toContain("--- Page 2 (");
    expect(system).toContain("alphaclass");
    expect(system).not.toContain("zephyrclass");
    h.captured.length = 0;
    await handleScopedChat({ project, message: "zephyrine", scope: "page", pageNumber: 2, session, isDemo: false });
    expect(JSON.stringify(h.captured[0])).toContain("zephyrclass");
  });

  it("project-wide LLM tools skip hidden pages; a tool call naming the hidden page still sees it", async () => {
    const { company, user, project } = await withYolo();
    const word = { text: "ZEPHYRINE", confidence: 99, bbox: [0.1, 0.1, 0.1, 0.05] };
    await db.update(pages).set({ textractData: { lines: [], words: [word] } as never }).where(eq(pages.projectId, project.id));
    await db.update(projects).set({ projectIntelligence: { summaries: { csiPageIndex: { "08 11 16": [1, 2, 3] } } } as never }).where(eq(projects.id, project.id));
    const ctx = { projectId: project.id, publicId: project.publicId, companyId: company.id, userId: user.id, writeCapability: assertProjectWritable(project) };
    const call = (name: string, input: Record<string, unknown>) => executeToolCall(name, input, ctx) as Promise<Record<string, never>>;

    const anns = await call("getAnnotations", {});
    expect((anns.annotations as { pageNumber: number }[]).map((a) => a.pageNumber)).toEqual([1]);
    const onHidden = await call("getAnnotations", { pageNumber: 2 });
    expect((onHidden.annotations as { class: string }[]).map((a) => a.class)).toEqual(["zephyrclass"]);

    const tags = await call("mapTagsToPages", { tags: "zephyrine" });
    expect((tags.results as Record<string, { pages: number[] }>).zephyrine.pages).toEqual([1, 3]);

    const scan = await call("scanYoloClassTexts", { yoloClass: "zephyrclass" });
    expect(scan.totalAnnotations).toBe(0);

    const idx = await call("lookupPagesByIndex", { index: "csi", key: "08 11 16" });
    expect(idx.pages).toEqual([1, 3]);
    const prefix = await call("lookupPagesByIndex", { index: "csi", key: "08" });
    expect(prefix.prefixMatches).toEqual({ "08 11 16": [1, 3] });
  });
});
