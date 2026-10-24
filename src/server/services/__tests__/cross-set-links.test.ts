// @vitest-environment node
// [cross-set F3 2026-10-24] services/cross-set-links.ts with storage + DB injected: the company pass
// never crosses a company, persists under a key DERIVED from data_url with publicIds only in jsonb,
// the upload-end refresh is fail-soft and bounded, the read API drops links the caller cannot open,
// and the reprocess scope (reprocess-cross-set.ts) writes each selected project under its lease.
import { describe, expect, it } from "vitest";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import type { AuthSession } from "@/lib/api-utils";
import { crossSetObjectKey, type CrossSetPageInput, type CrossSetSummary } from "@/lib/knowledge-graph";
import {
  computeCompanyCrossSet,
  crossSetLinksForLlm,
  getProjectCrossSetLinks,
  HOOK_MAX_PROJECTS,
  persistProjectCrossSet,
  readProjectCrossSetLinks,
  refreshProjectCrossSetLinks,
  type CrossSetDeps,
  type CrossSetProjectRow,
} from "@/server/services/cross-set-links";
import { reprocessCrossSetScope } from "@/server/services/reprocess-cross-set";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const wc = {} as ProjectWriteCapability;

function text(seed: number, n = 40): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`line${seed} ${i} alpha${seed} beta${seed} gamma${seed} delta${seed}`);
  return lines.join("\n");
}
const pg = (pageNumber: number, drawingNumber: string | null, rawText: string | null, hidden = false): CrossSetPageInput =>
  ({ pageNumber, drawingNumber, title: "Plan", rawText, hidden });

const row = (id: number, companyId: number, over: Partial<CrossSetProjectRow> = {}): CrossSetProjectRow => ({
  id, publicId: `pub-${id}`, name: `Project ${id}`, dataUrl: `co${companyId}/proj-${id}`, createdAt: new Date(2026, 0, id), companyId, isDemo: false, ...over,
});

/** Two companies. Company 1: 1 and 2 share A-101 text; 3 is a demo copy of 1. Company 2: 9 shares the same text. */
function world() {
  const rows: CrossSetProjectRow[] = [row(1, 1), row(2, 1), row(3, 1, { isDemo: true }), row(4, 1, { dataUrl: null }), row(9, 2)];
  const pagesById = new Map<number, CrossSetPageInput[]>([
    [1, [pg(1, "A-101", text(1)), pg(2, "A-102", text(2)), pg(3, "A-103", text(3), true)]],
    [2, [pg(5, "A101", text(1)), pg(6, "A-102", text(22)), pg(7, "A-103", text(3))]],
    [3, [pg(1, "A-101", text(1))]],
    [9, [pg(1, "A-101", text(1))]],
  ]);
  const objects = new Map<string, string>();
  const summaries: Array<{ projectId: number; summary: CrossSetSummary }> = [];
  const visibleCalls: string[][] = [];
  const deps: CrossSetDeps = {
    loadProject: async (id) => rows.find((r) => r.id === id),
    listCompanyProjects: async (companyId) => rows.filter((r) => r.companyId === companyId),
    loadPages: async (id) => pagesById.get(id) ?? [],
    putObject: async (key, body) => { objects.set(key, body); },
    getObject: async (key) => objects.get(key) ?? null,
    writeSummary: async (_wc, projectId, summary) => { summaries.push({ projectId, summary }); },
    resolveVisibleProjects: async (ids, session) => {
      visibleCalls.push([...ids]);
      const out = new Map<string, string>();
      for (const r of rows) {
        if (!ids.includes(r.publicId) || r.isDemo) continue;
        if (session?.user.isRootAdmin || r.companyId === session?.user.companyId) out.set(r.publicId, r.name);
      }
      return out;
    },
  };
  return { rows, deps, objects, summaries, visibleCalls };
}

const session = (companyId: number, isRootAdmin = false): AuthSession =>
  ({ user: { id: 1, companyId, role: "admin", isRootAdmin } } as unknown as AuthSession);

describe("computeCompanyCrossSet", () => {
  it("links only inside the company, skips demo rows and rows without a data prefix, and never sees the other company", async () => {
    const w = world();
    const loaded: string[] = [];
    const { projects, result } = await computeCompanyCrossSet(1, w.deps, { now: NOW, onProject: (_n, _t, p) => loaded.push(p.publicId) });
    expect(projects.map((p) => p.id)).toEqual([1, 2]);
    expect(loaded).toEqual(["pub-1", "pub-2"]);
    expect(result.projects).toBe(2);
    expect(result.links.map((l) => [l.kind, l.from.project, l.from.page, l.to.project, l.to.page])).toEqual([["twin_of", "pub-1", 1, "pub-2", 5]]);
    // page 3 of project 1 is a hidden duplicate: its identical text on project 2 page 7 is NOT linked
    expect(result.links.some((l) => l.from.page === 3 || l.to.page === 7)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("pub-9");
    expect(JSON.stringify(result)).not.toContain("pub-3");
  });

  it("a listing that leaks another company's rows is still filtered to the requested company", async () => {
    const w = world();
    const leaky = { ...w.deps, listCompanyProjects: async () => w.rows };
    const { projects } = await computeCompanyCrossSet(1, leaky, { now: NOW });
    expect(projects.every((p) => p.companyId === 1)).toBe(true);
  });
});

describe("refreshProjectCrossSetLinks (upload-end hook)", () => {
  it("persists THIS project's slice under the derived key and publicIds only in the summary", async () => {
    const w = world();
    const r = await refreshProjectCrossSetLinks(2, wc, w.deps, NOW);
    expect(r.ok).toBe(true);
    expect([...w.objects.keys()]).toEqual([crossSetObjectKey("co1/proj-2")]);
    const file = (await readProjectCrossSetLinks("co1/proj-2", w.deps))!;
    expect(file.project).toBe("pub-2");
    expect(file.pages[5]).toEqual([{ kind: "twin_of", project: "pub-1", page: 1, sheet: "A-101", confidence: 1, direction: "older" }]);
    expect(w.summaries).toEqual([{ projectId: 2, summary: { v: 1, computedAt: NOW.toISOString(), linkedProjects: [{ publicId: "pub-1", twins: 1, revisions: 0, copy: null }] } }]);
    expect(JSON.stringify(w.summaries)).not.toMatch(/Project 1|co1\//);
    // the other side's file is NOT written by the hook (the stage catches it up)
    expect(w.objects.has(crossSetObjectKey("co1/proj-1"))).toBe(false);
  });

  it("never throws: missing project, demo, no data prefix, too many company projects, a storage failure", async () => {
    const w = world();
    expect(await refreshProjectCrossSetLinks(42, wc, w.deps, NOW)).toEqual({ ok: false, reason: "no-project" });
    expect(await refreshProjectCrossSetLinks(3, wc, w.deps, NOW)).toEqual({ ok: false, reason: "demo" });
    expect(await refreshProjectCrossSetLinks(4, wc, w.deps, NOW)).toEqual({ ok: false, reason: "no-data-url" });
    const big = { ...w.deps, listCompanyProjects: async () => Array.from({ length: HOOK_MAX_PROJECTS + 1 }, (_, i) => row(100 + i, 1)) };
    expect(await refreshProjectCrossSetLinks(1, wc, big, NOW)).toEqual({ ok: false, reason: "company-too-large" });
    const failing = { ...w.deps, putObject: async () => { throw new Error("S3 down"); } };
    expect(await refreshProjectCrossSetLinks(1, wc, failing, NOW)).toEqual({ ok: false, reason: "S3 down" });
    expect(w.summaries).toHaveLength(0);
  });
});

describe("getProjectCrossSetLinks (read API)", () => {
  const access = (id: number, companyId = 1, isDemo = false) =>
    ({ id, publicId: `pub-${id}`, companyId, isDemo, dataUrl: `co${companyId}/proj-${id}`, name: `Project ${id}`, numPages: 3, status: "completed", lifecycleEpoch: 0, updatedAt: null });

  it("built:false before a pass and for a demo project; names resolved at read time for visible targets", async () => {
    const w = world();
    expect(await getProjectCrossSetLinks(access(2), {}, session(1), w.deps)).toEqual({ built: false });
    await refreshProjectCrossSetLinks(2, wc, w.deps, NOW);
    expect(await getProjectCrossSetLinks(access(2, 1, true), {}, session(1), w.deps)).toEqual({ built: false });
    const all = (await getProjectCrossSetLinks(access(2), {}, session(1), w.deps)) as any;
    expect(all.built).toBe(true);
    expect(all.pages).toEqual({ 5: [expect.objectContaining({ kind: "twin_of", project: { publicId: "pub-1", name: "Project 1" }, page: 1 })] });
    const one = (await getProjectCrossSetLinks(access(2), { page: 5 }, session(1), w.deps)) as any;
    expect(one).toMatchObject({ built: true, page: 5 });
    expect(one.links).toHaveLength(1);
    expect((await getProjectCrossSetLinks(access(2), { page: 6 }, session(1), w.deps)) as any).toMatchObject({ built: true, page: 6, links: [] });
  });

  it("a link to a project the caller cannot open is dropped — no name, no publicId, no count", async () => {
    const w = world();
    await refreshProjectCrossSetLinks(2, wc, w.deps, NOW);
    // a session from another company (defence in depth: the route's tenancy check already 404s the project)
    const foreign = (await getProjectCrossSetLinks(access(2), {}, session(2), w.deps)) as any;
    expect(foreign).toEqual({ built: true, computedAt: NOW.toISOString(), pages: {}, projects: [] });
    expect(JSON.stringify(foreign)).not.toContain("pub-1");
    // the resolver is asked exactly for the ids in the file, and a stale id (project deleted since) vanishes
    const stale = { ...w.deps, resolveVisibleProjects: async () => new Map<string, string>() };
    const gone = (await getProjectCrossSetLinks(access(2), { page: 5 }, session(1), stale)) as any;
    expect(gone.links).toEqual([]);
    expect(w.visibleCalls.at(-1)).toEqual(["pub-1"]);
    // root sees it
    expect(((await getProjectCrossSetLinks(access(2), {}, session(2, true), w.deps)) as any).pages[5]).toHaveLength(1);
  });

  it("the LLM view carries publicIds only", async () => {
    const w = world();
    expect(await crossSetLinksForLlm(2, 5, w.deps)).toBeNull();
    await refreshProjectCrossSetLinks(2, wc, w.deps, NOW);
    expect(await crossSetLinksForLlm(2, 5, w.deps)).toEqual({ computedAt: NOW.toISOString(), links: [{ kind: "twin_of", project: "pub-1", page: 1, sheet: "A-101", confidence: 1, direction: "older" }] });
    expect(await crossSetLinksForLlm(3, 1, w.deps)).toBeNull(); // demo
  });
});

describe("reprocessCrossSetScope", () => {
  const stream = () => { const events: Array<Record<string, unknown>> = []; return { events, s: { send: (e: Record<string, unknown>) => events.push(e), debug: () => {} } }; };

  it("computes once for the company, then writes each SELECTED eligible project under its own lease", async () => {
    const w = world();
    const { events, s } = stream();
    const leases: number[] = [];
    let computes = 0;
    const counts = await reprocessCrossSetScope({
      companyId: 1,
      projects: [{ id: 1, name: "Project 1" }, { id: 4, name: "Project 4" }],
      withLease: (id, op) => { leases.push(id); return op(wc); },
      stream: s,
      compute: async (companyId, onProject) => { computes++; return computeCompanyCrossSet(companyId, w.deps, { now: NOW, onProject: (n, t, p) => onProject(n, t, p.name) }); },
      persist: (cap, project, result) => persistProjectCrossSet(cap, project, result, w.deps),
    });
    expect(computes).toBe(1);
    expect(leases).toEqual([1, 4]);
    expect(counts).toMatchObject({ updated: 1, skipped: 1, errors: 0, total: 2, companyProjects: 2, links: { twin: 1, revision: 0, copy: 0 } });
    expect([...w.objects.keys()]).toEqual([crossSetObjectKey("co1/proj-1")]); // project 2 was not selected → not written
    expect(events.filter((e) => e.type === "warning")).toEqual([expect.objectContaining({ project: "Project 4" })]);
    expect(events.filter((e) => e.type === "progress" && "loaded" in e)).toHaveLength(2);
  });

  it("a thrown project is an error event and the run continues", async () => {
    const w = world();
    const { events, s } = stream();
    const counts = await reprocessCrossSetScope({
      companyId: 1,
      projects: [{ id: 1, name: "Project 1" }, { id: 2, name: "Project 2" }],
      withLease: async (id, op) => { if (id === 1) throw new Error("lease held"); return op(wc); },
      stream: s,
      compute: (companyId) => computeCompanyCrossSet(companyId, w.deps, { now: NOW }),
      persist: (cap, project, result) => persistProjectCrossSet(cap, project, result, w.deps),
    });
    expect(counts).toMatchObject({ updated: 1, errors: 1, total: 1 });
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", project: "Project 1", error: "lease held" });
  });
});
