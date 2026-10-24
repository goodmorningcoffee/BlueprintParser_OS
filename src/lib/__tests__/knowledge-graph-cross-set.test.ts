// @vitest-environment node
// [cross-set F3 2026-10-24] Knowledge graph v2 cross-set links (src/lib/knowledge-graph/cross-set.ts):
// twin_of on identical text, revision_of ONLY with content support (the same sheet number alone gives
// no link — the refuted "number twins" generator), the stock-sheet cap, hidden pages excluded,
// direction older → newer, copy_of, and the per-project storage shapes (derived key, publicIds only).
import { describe, expect, it } from "vitest";
import {
  buildCrossSetLinks,
  computeCrossSetLinks,
  CROSS_SET_INTELLIGENCE_KEY,
  crossSetObjectKey,
  crossSetSummary,
  isProjectCrossSetLinks,
  projectCrossSetLinks,
  reduceCrossSetProject,
  REVISION_MIN_CONTENT,
  storedCrossSetSummary,
  type CrossSetPageInput,
  type CrossSetProjectInput,
} from "@/lib/knowledge-graph";
import { CROSS_PROJECT_MAX_OWNERS } from "@/lib/page-dedup/cross-project";

const NOW = new Date("2026-10-24T12:00:00.000Z");

/** Deterministic page text: `n` distinct lines seeded by `seed`, each 6 tokens. */
function text(seed: number, n = 40): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`line${seed} ${i} alpha${seed} beta${seed} gamma${seed} delta${seed}`);
  return lines.join("\n");
}
/** The same page with `changed` of its lines rewritten. */
function revised(seed: number, changed: number, n = 40): string {
  const lines = text(seed, n).split("\n");
  for (let i = 0; i < changed; i++) lines[i] = `revised ${seed} ${i} omega psi chi phi`;
  return lines.join("\n");
}
const page = (pageNumber: number, drawingNumber: string | null, rawText: string | null, extra: Partial<CrossSetPageInput> = {}): CrossSetPageInput =>
  ({ pageNumber, drawingNumber, rawText, title: "Floor Plan", ...extra });
const project = (publicId: string, createdAt: string, pages: CrossSetPageInput[]): CrossSetProjectInput => ({ publicId, createdAt, pages });

describe("cross-set links — pure module", () => {
  it("twin_of: identical comparable text in two projects, confidence 1, older → newer", () => {
    const r = buildCrossSetLinks([
      project("new", "2026-02-01T00:00:00Z", [page(5, "A-101", text(1))]),
      project("old", "2026-01-01T00:00:00Z", [page(2, "A101", text(1)), page(3, "A-201", text(2))]),
    ], { now: NOW });
    expect(r.links).toEqual([{ kind: "twin_of", from: { project: "old", page: 2, sheet: "A101" }, to: { project: "new", page: 5, sheet: "A-101" }, confidence: 1 }]);
    expect(r.projectLinks).toEqual([{ kind: "copy_of", from: "new", to: "old", shared: 1, pages: 1 }]); // 1 of 1 comparable pages of "new" is in "old"
    expect(r.computedAt).toBe(NOW.toISOString());
  });

  it("copy_of: ≥ 95 % of the newer project's page texts found in the older one", () => {
    const pagesA = Array.from({ length: 10 }, (_, i) => page(i + 1, `A-${100 + i}`, text(100 + i)));
    const r = buildCrossSetLinks([
      project("copy", "2026-03-01T00:00:00Z", pagesA.map((p) => ({ ...p }))),
      project("orig", "2026-01-01T00:00:00Z", pagesA),
      project("other", "2026-02-01T00:00:00Z", [page(1, "A-100", text(999))]),
    ]);
    expect(r.projectLinks).toEqual([{ kind: "copy_of", from: "copy", to: "orig", shared: 10, pages: 10 }]);
    expect(r.links.filter((l) => l.kind === "twin_of")).toHaveLength(10);
    // "other" shares A-100 by NUMBER only → no link of any kind
    expect(r.links.some((l) => l.from.project === "other" || l.to.project === "other")).toBe(false);
  });

  it("revision_of needs content support: the same sheet number alone gives NO link", () => {
    const unrelated = buildCrossSetLinks([
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1))]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", text(2))]),
    ]);
    expect(unrelated.links).toEqual([]);
    expect(unrelated.dropped.comparisons).toBe(1); // equal sizes pass the prefilter; the score (0) rejects
  });

  it("revision_of: same number + shared content, confidence = the content Jaccard, older → newer, title flag", () => {
    const r = buildCrossSetLinks([
      project("ifc", "2026-02-01T00:00:00Z", [page(7, "A-101", revised(1, 4))]),
      project("permit", "2026-01-01T00:00:00Z", [page(3, "A101", text(1))]),
    ]);
    expect(r.links).toHaveLength(1);
    const l = r.links[0];
    expect(l.kind).toBe("revision_of");
    expect(l.from).toEqual({ project: "permit", page: 3, sheet: "A101" });
    expect(l.to).toEqual({ project: "ifc", page: 7, sheet: "A-101" });
    expect(l.confidence).toBeGreaterThanOrEqual(REVISION_MIN_CONTENT);
    expect(l.confidence).toBeLessThan(1);
    expect(l.titleMatch).toBe(true); // both pages are titled "Floor Plan"
  });

  it("revision_of: shared content below the floor is not a link; a different sheet number is never compared", () => {
    const low = buildCrossSetLinks([
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1))]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", revised(1, 30))]), // 30 of 40 lines changed
    ]);
    expect(low.links).toEqual([]);
    const otherNumber = buildCrossSetLinks([
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1))]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-102", revised(1, 1))]),
    ]);
    expect(otherNumber.links).toEqual([]);
    expect(otherNumber.dropped.comparisons).toBe(0);
  });

  it("a twin pair is not repeated as a revision; in-project duplicates are not cross-set links", () => {
    const r = buildCrossSetLinks([
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1)), page(2, "A-101", text(1))]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", text(1))]),
    ]);
    expect(r.links.map((l) => [l.kind, l.from.page, l.to.project, l.to.page])).toEqual([["twin_of", 1, "p2", 1], ["twin_of", 2, "p2", 1]]);
  });

  it("stock sheets: a text owned by more than CROSS_PROJECT_MAX_OWNERS projects links nothing and is counted", () => {
    const stock = text(77);
    const projects = Array.from({ length: CROSS_PROJECT_MAX_OWNERS + 1 }, (_, i) =>
      project(`p${String(i).padStart(3, "0")}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, [page(1, "G-002", stock)]));
    const r = buildCrossSetLinks(projects);
    expect(r.links).toEqual([]);
    expect(r.projectLinks).toEqual([]);
    expect(r.dropped.stockTexts).toBe(1);
    // one project fewer → a real (if dense) twin bucket
    const ok = buildCrossSetLinks(projects.slice(0, CROSS_PROJECT_MAX_OWNERS));
    expect(ok.dropped.stockTexts).toBe(0);
    expect(ok.links.length).toBe((CROSS_PROJECT_MAX_OWNERS * (CROSS_PROJECT_MAX_OWNERS - 1)) / 2);
  });

  it("hidden duplicate pages and blank pages are excluded before any comparison", () => {
    const r = buildCrossSetLinks([
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1), { hidden: true }), page(2, "A-102", "one two", {})]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", text(1)), page(2, "A-102", "one two")]),
    ]);
    expect(r.links).toEqual([]);
    const keys = reduceCrossSetProject(project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1), { hidden: true }), page(2, "A-102", "one two")]));
    expect(keys.pages).toEqual([]);
    expect(keys.omitted).toEqual({ hidden: 1, blank: 1 });
  });

  it("direction: createdAt decides older → newer; a missing createdAt sorts last; ties by publicId", () => {
    const r = computeCrossSetLinks([
      reduceCrossSetProject(project("b", "", [page(1, "A-101", text(1))])),
      reduceCrossSetProject(project("a", "2026-05-01T00:00:00Z", [page(1, "A-101", text(1))])),
    ]);
    expect(r.links[0].from.project).toBe("a");
    expect(r.links[0].to.project).toBe("b");
    const tie = computeCrossSetLinks([
      reduceCrossSetProject(project("zed", "2026-05-01T00:00:00Z", [page(1, "A-101", text(1))])),
      reduceCrossSetProject(project("alpha", "2026-05-01T00:00:00Z", [page(1, "A-101", text(1))])),
    ]);
    expect(tie.links[0].from.project).toBe("alpha");
  });

  it("per-project file: both directions, keyed by own page, other projects by publicId; summary counts per project", () => {
    const r = buildCrossSetLinks([
      project("old", "2026-01-01T00:00:00Z", [page(3, "A-101", text(1)), page(4, "A-201", text(2))]),
      project("new", "2026-02-01T00:00:00Z", [page(8, "A-101", text(1)), page(9, "A-201", revised(2, 3))]),
    ]);
    const forNew = projectCrossSetLinks(r, "new");
    expect(forNew.project).toBe("new");
    expect(forNew.pages[8]).toEqual([{ kind: "twin_of", project: "old", page: 3, sheet: "A-101", confidence: 1, direction: "older" }]);
    expect(forNew.pages[9]).toEqual([expect.objectContaining({ kind: "revision_of", project: "old", page: 4, direction: "older", titleMatch: true })]);
    const forOld = projectCrossSetLinks(r, "old");
    expect(forOld.pages[3][0]).toMatchObject({ project: "new", page: 8, direction: "newer" });
    expect(isProjectCrossSetLinks(forOld)).toBe(true);
    expect(isProjectCrossSetLinks({ v: 1 })).toBe(false);

    const summary = crossSetSummary(forNew);
    expect(summary).toEqual({ v: 1, computedAt: r.computedAt, linkedProjects: [{ publicId: "old", twins: 1, revisions: 1, copy: null }] }); // 1 of 2 texts shared → no copy_of
    expect(storedCrossSetSummary({ [CROSS_SET_INTELLIGENCE_KEY]: summary })).toEqual(summary);
    expect(storedCrossSetSummary({ [CROSS_SET_INTELLIGENCE_KEY]: { v: 2 } })).toBeNull();
    expect(JSON.stringify(summary)).not.toMatch(/name|dataUrl/);
  });

  it("the S3 key is derived from the data prefix, beside the v1 graph", () => {
    expect(crossSetObjectKey("co/proj-1")).toBe("co/proj-1/graph/cross-set.v1.json");
  });
});
