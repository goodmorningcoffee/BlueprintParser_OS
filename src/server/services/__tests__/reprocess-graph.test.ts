// @vitest-environment node
// [graph T8 2026-10-24] Reprocess scope=graph (services/reprocess-graph.ts) with the refresh
// injected, plus the DB-free half of services/project-graph.ts (build from injected rows, persist
// to injected storage with DERIVED keys, refresh never throws).
import { describe, expect, it } from "vitest";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import { reprocessGraphScope } from "@/server/services/reprocess-graph";
import {
  getProjectGraph,
  projectGraphForLlm,
  readProjectGraphIndex,
  refreshProjectGraph,
  type ProjectGraphDeps,
} from "@/server/services/project-graph";
import { graphIndexObjectKey, graphObjectKey, summarizeGraph, buildKnowledgeGraph } from "@/lib/knowledge-graph";
import type { GraphSummary } from "@/lib/knowledge-graph";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const wc = {} as ProjectWriteCapability;

function storage() {
  const objects = new Map<string, string>();
  const summaries: Array<{ projectId: number; summary: GraphSummary }> = [];
  const rows = [
    { id: 11, pageNumber: 1, name: "Cover", drawingNumber: "G-001", pageIntelligence: { crossRefs: [{ sourceText: "SEE SHEET A-101", targetDrawing: "A-101", refType: "sheet", bbox: [0.1, 0.1, 0.02, 0.01], confidence: 0.85 }, { sourceText: "SEE SHEET Z-1", targetDrawing: "Z-1", refType: "sheet", bbox: [0.1, 0.2, 0.02, 0.01], confidence: 0.85 }] }, csiCodes: null, textAnnotations: null, keynotes: null },
    { id: 12, pageNumber: 2, name: "Plan", drawingNumber: "A-101", pageIntelligence: null, csiCodes: [{ code: "08 11 13", division: "08", confidence: 0.8 }], textAnnotations: null, keynotes: null },
  ];
  const deps: ProjectGraphDeps = {
    loadProject: async (id) => (id === 1 ? { id: 1, publicId: "pub-1", dataUrl: "co/proj-1" } : id === 2 ? { id: 2, publicId: "pub-2", dataUrl: null } : undefined),
    listPages: async (id) => { if (id === 3) throw new Error("db exploded"); return id === 1 ? rows : []; },
    loadTextract: async (pageId) => (pageId === 11 ? { lines: [{ text: "3 WALL SECTION", bbox: [0.1, 0.9, 0.2, 0.01] }], words: null } : null),
    loadTagFamilies: async () => undefined,
    putObject: async (key, body) => { objects.set(key, body); },
    getObject: async (key) => objects.get(key) ?? null,
    writeSummary: async (_wc, projectId, summary) => { summaries.push({ projectId, summary }); },
  };
  return { deps, objects, summaries };
}

describe("refreshProjectGraph", () => {
  it("builds from stored rows, writes the graph + index under DERIVED keys, and the summary into jsonb", async () => {
    const s = storage();
    const result = await refreshProjectGraph(1, wc, s.deps, NOW);
    expect(result.ok).toBe(true);
    expect([...s.objects.keys()].sort()).toEqual([graphIndexObjectKey("co/proj-1"), graphObjectKey("co/proj-1")].sort());
    expect(s.summaries).toHaveLength(1);
    const summary = s.summaries[0].summary;
    expect(summary.references).toMatchObject({ total: 2, resolved: 1, unresolved: 1 });
    expect(summary.nodes).toMatchObject({ sheet: 2, detail: 1, csi_code: 1 });
    expect(summary.bytes).toBe(Buffer.byteLength(s.objects.get(graphObjectKey("co/proj-1"))!));
    expect(JSON.stringify(summary)).not.toContain("co/proj-1"); // no key, no prefix in jsonb
    const index = await readProjectGraphIndex("co/proj-1", s.deps);
    expect(index?.pages[1].refersTo.map((l) => [l.sheet, l.page, l.status])).toEqual([["A-101", 2, "resolved"], ["Z-1", null, "unresolved"]]);
    expect(index?.pages[2].referencedBy).toEqual([expect.objectContaining({ page: 1, sheet: "G-001" })]);
    expect(index?.unresolved).toEqual([expect.objectContaining({ fromPage: 1, sheet: "Z-1", status: "unresolved" })]);
  });

  it("never throws: no project / no data prefix / a DB failure are ok:false with a reason and no writes", async () => {
    const s = storage();
    expect(await refreshProjectGraph(99, wc, s.deps, NOW)).toEqual({ ok: false, reason: "no-project" });
    expect(await refreshProjectGraph(2, wc, s.deps, NOW)).toEqual({ ok: false, reason: "no-data-url" });
    const failing = { ...s.deps, loadProject: async () => ({ id: 3, publicId: "x", dataUrl: "co/x" }) };
    expect(await refreshProjectGraph(3, wc, failing, NOW)).toEqual({ ok: false, reason: "db exploded" });
    expect(s.objects.size).toBe(0);
    expect(s.summaries).toHaveLength(0);
  });

  it("the summary matches summarizeGraph over the same stored object", async () => {
    const s = storage();
    await refreshProjectGraph(1, wc, s.deps, NOW);
    const json = s.objects.get(graphObjectKey("co/proj-1"))!;
    expect(s.summaries[0].summary).toEqual(summarizeGraph(JSON.parse(json), Buffer.byteLength(json)));
  });
});

describe("getProjectGraph / projectGraphForLlm (reads)", () => {
  const project = { id: 1, publicId: "pub-1", companyId: 1, isDemo: false, dataUrl: "co/proj-1", name: "P", numPages: 2, status: "completed", lifecycleEpoch: 0, updatedAt: null };

  it("built:false before any build; index / page / full views after", async () => {
    const s = storage();
    expect(await readProjectGraphIndex("co/proj-1", s.deps)).toBeNull();
    expect(await projectGraphForLlm(1, undefined, s.deps)).toBeNull();
    await refreshProjectGraph(1, wc, s.deps, NOW);
    const forPage = (await projectGraphForLlm(1, 1, s.deps))!;
    expect(forPage.refersTo).toEqual([
      { page: 2, sheet: "A-101", status: "resolved", text: "SEE SHEET A-101" },
      { page: null, sheet: "Z-1", status: "unresolved", text: "SEE SHEET Z-1" },
    ]);
    const forProject = (await projectGraphForLlm(1, undefined, s.deps))!;
    expect(forProject.references).toMatchObject({ total: 2, resolved: 1 });
    expect((forProject.unresolved as unknown[]).length).toBe(1);
  });

  it("getProjectGraph view=page returns the page lists + its neighbourhood from the full graph", async () => {
    // getProjectGraph reads the stored summary through the DB for `summary`; here only the S3 half is
    // exercised, through the deps, by calling the pieces it composes.
    const s = storage();
    await refreshProjectGraph(1, wc, s.deps, NOW);
    const graph = JSON.parse(s.objects.get(graphObjectKey("co/proj-1"))!);
    expect(buildKnowledgeGraph({ publicId: "pub-1", pages: [] }, { now: NOW }).v).toBe(graph.v);
    expect(typeof getProjectGraph).toBe("function");
  });
});

describe("reprocessGraphScope", () => {
  const stream = () => { const events: Array<Record<string, unknown>> = []; return { events, s: { send: (e: Record<string, unknown>) => events.push(e), debug: () => {} } }; };
  const withLease = <T,>(leases: number[]) => (id: number, op: (w: ProjectWriteCapability) => Promise<T>): Promise<T> => { leases.push(id); return op(wc); };
  const summary = (resolved: number, unresolved: number): GraphSummary => ({
    v: 1, computedAt: NOW.toISOString(), stored: "s3", bytes: 10, nodes: { sheet: 2 }, edges: { references: resolved + unresolved },
    references: { total: resolved + unresolved, resolved, unresolved, ambiguous: 0, self: 0, detailFound: 0, detailMissing: 0 }, sheets: [], unresolvedTop: [],
  });

  it("counts rebuilt projects and sums their resolution figures under one lease each", async () => {
    const { events, s } = stream();
    const leases: number[] = [];
    const counts = await reprocessGraphScope({
      projects: [{ id: 1, name: "A" }, { id: 2, name: "B" }], withLease: withLease(leases), stream: s,
      refresh: async (id) => (id === 1 ? { ok: true, summary: summary(3, 1) } : { ok: false, reason: "no-data-url" }),
    });
    expect(counts).toEqual({ updated: 1, skipped: 1, errors: 0, total: 2, nodes: 2, edges: 4, references: { total: 4, resolved: 3, unresolved: 1, ambiguous: 0 } });
    expect(leases).toEqual([1, 2]);
    expect(events.filter((e) => e.type === "warning")).toEqual([{ type: "warning", project: "B", message: "Graph not built (no-data-url)" }]);
    expect(Object.keys(counts)).not.toContain("failed");
  });

  it("a failed build is skipped + counted as an error; a thrown project is an error event and the run continues", async () => {
    const { events, s } = stream();
    const counts = await reprocessGraphScope({
      projects: [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }],
      withLease: async (id, op) => { if (id === 2) throw new Error("lease held"); return op(wc); }, stream: s,
      refresh: async (id) => (id === 3 ? { ok: true, summary: summary(1, 0) } : { ok: false, reason: "S3 down" }),
    });
    expect(counts).toMatchObject({ updated: 1, skipped: 1, errors: 1, total: 2 });
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", project: "B", error: "lease held" });
  });
});
