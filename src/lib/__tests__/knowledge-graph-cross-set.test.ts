// @vitest-environment node
// [cross-set F3 2026-10-24] Knowledge graph v2 cross-set links (src/lib/knowledge-graph/cross-set.ts):
// twin_of on identical text, revision_of ONLY with content support (the same sheet number alone gives
// no link — the refuted "number twins" generator), the stock-sheet cap, hidden pages excluded,
// direction older → newer, copy_of, and the per-project storage shapes (derived key, publicIds only).
import { describe, expect, it } from "vitest";
import {
  BUCKET_PAGE_CAP,
  buildCrossSetLinks,
  computeCrossSetLinks,
  computeCrossSetLinksAsync,
  CROSS_SET_INTELLIGENCE_KEY,
  crossSetObjectKey,
  crossSetSummary,
  isProjectCrossSetLinks,
  PAGE_LINK_CAP,
  projectCrossSetLinks,
  publicProjectIntelligence,
  reduceCrossSetProject,
  REVISION_MIN_CONTENT,
  REVISION_MIN_SHINGLES,
  storedCrossSetSummary,
  YIELD_EVERY,
  type CrossSetLinks,
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

  it("revision_of never rests on thin content: a sheet number plus a generic title is NOT a link", () => {
    // Two sets of one firm, each with an A-101 whose own text (after the title-block strip) is
    // "FIRST FLOOR PLAN": one shingle each, Jaccard 1.0 — the refuted "number twins" generator.
    const titleBlock = (name: string) => `ACME ARCHITECTS\n123 MAIN STREET SUITE 400\nPROJECT ${name}\nISSUED FOR CONSTRUCTION\nDRAWN BY JD CHECKED BY KL`;
    const set = (publicId: string, createdAt: string, name: string) =>
      project(publicId, createdAt, Array.from({ length: 6 }, (_, k) => {
        const i = k + 1;
        const dn = i === 1 ? "A-101" : `A-${100 + i * 10}`;
        const body = i === 1 ? "FIRST FLOOR PLAN" : `UNIQUE ${name} SHEET ${i} CONTENT LINE ALPHA BETA GAMMA DELTA ${i} ${name}`;
        return page(i, dn, `${titleBlock(name)}\n${body}\n${dn}`, { title: null });
      }));
    const r = buildCrossSetLinks([set("school", "2026-01-01T00:00:00Z", "RIVERSIDE SCHOOL"), set("clinic", "2026-02-01T00:00:00Z", "HILLTOP CLINIC")]);
    expect(r.links).toEqual([]);
    expect(r.dropped.comparisons).toBe(0); // thin pages never enter a sheet bucket
    const thin = reduceCrossSetProject(set("school", "2026-01-01T00:00:00Z", "RIVERSIDE SCHOOL")).pages.find((p) => p.drawingNumber === "A-101")!;
    expect(thin.contentTokens).toBeLessThan(REVISION_MIN_SHINGLES);
    expect(thin.content.length).toBe(1);
    // the same thin pages still twin on IDENTICAL full text (the exact-text key keeps its own floor)
    const same = buildCrossSetLinks([
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", "cover sheet index of drawings first floor plan")]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", "cover sheet index of drawings first floor plan")]),
    ]);
    expect(same.links.map((l) => l.kind)).toEqual(["twin_of"]);
    // just over the shingle floor with real shared content: a link
    const wide = (seed: number) => Array.from({ length: REVISION_MIN_SHINGLES + 2 }, (_, i) => `w${seed % 7 === i % 7 ? 9 : seed} ${i}`).join(" ");
    const ok = buildCrossSetLinks([
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", wide(1))]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", wide(1) + " extra")]),
    ]);
    expect(ok.links.map((l) => l.kind)).toEqual(["revision_of"]);
  });

  it("firm-standard sheets: a page whose content matches more than CROSS_PROJECT_MAX_OWNERS sets links nothing (counted)", () => {
    // G-001 general notes, re-issued on every job with only the project name line changed.
    const notes = (i: number) => `general notes for job ${i} site ${i}\n${text(5)}`;
    const sets = (n: number) => Array.from({ length: n }, (_, i) =>
      project(`p${String(i).padStart(3, "0")}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, [page(1, "G-001", notes(i))]));
    const stock = buildCrossSetLinks(sets(CROSS_PROJECT_MAX_OWNERS + 2));
    expect(stock.links).toEqual([]);
    expect(stock.dropped.stockSheets).toBe(CROSS_PROJECT_MAX_OWNERS + 2);
    expect(stock.dropped.stockTexts).toBe(0); // the texts differ, so the twin rule never saw it
    // at the cap it is a (dense) revision cluster, each page linked to every other
    const dense = buildCrossSetLinks(sets(CROSS_PROJECT_MAX_OWNERS));
    expect(dense.dropped.stockSheets).toBe(0);
    expect(dense.links.length).toBe((CROSS_PROJECT_MAX_OWNERS * (CROSS_PROJECT_MAX_OWNERS - 1)) / 2);
    expect(dense.links.every((l) => l.kind === "revision_of")).toBe(true);
  });

  it("the company-wide comparison budget: sheet buckets past it are skipped and counted", () => {
    const sets = [
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1)), page(2, "A-102", text(2)), page(3, "A-103", text(3))]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", revised(1, 2)), page(2, "A-102", revised(2, 2)), page(3, "A-103", revised(3, 2))]),
    ];
    const full = buildCrossSetLinks(sets);
    expect(full.links).toHaveLength(3);
    expect(full.dropped).toMatchObject({ comparisons: 3, truncatedBuckets: 0 });
    const capped = buildCrossSetLinks(sets, { comparisonBudget: 1 });
    expect(capped.links).toHaveLength(1);
    expect(capped.dropped).toMatchObject({ comparisons: 1, truncatedBuckets: 2 });
    expect(buildCrossSetLinks(sets, { comparisonBudget: 0 }).links).toEqual([]);
  });

  it("the async runner yields per bucket and per YIELD_EVERY comparisons and returns the same links", async () => {
    const keys = [
      project("p1", "2026-01-01T00:00:00Z", [page(1, "A-101", text(1)), page(2, "A-102", text(2)), page(3, "A-103", text(3))]),
      project("p2", "2026-02-01T00:00:00Z", [page(1, "A-101", revised(1, 2)), page(2, "A-102", text(2)), page(3, "A-103", text(33))]),
    ].map(reduceCrossSetProject);
    const sync = computeCrossSetLinks(keys, { now: NOW });
    let yields = 0;
    const viaFake = await computeCrossSetLinksAsync(keys, { now: NOW, yieldFn: async () => { yields++; } });
    expect(viaFake).toEqual(sync);
    expect(yields).toBe(4); // 1 twin bucket (A-102) + 3 sheet buckets (A-101, A-102 — its one pair is the twin, A-103)
    expect(await computeCrossSetLinksAsync(keys, { now: NOW })).toEqual(sync); // the real event-loop turn
    // many comparisons inside ONE bucket still yield: a sheet bucket at BUCKET_PAGE_CAP, half per set
    const n = BUCKET_PAGE_CAP / 2;
    expect(n * n).toBeGreaterThan(YIELD_EVERY);
    const big = [
      project("p1", "2026-01-01T00:00:00Z", Array.from({ length: n }, (_, i) => page(i + 1, "A-101", text(1000 + i)))),
      project("p2", "2026-02-01T00:00:00Z", Array.from({ length: n }, (_, i) => page(i + 1, "A-101", text(2000 + i)))),
    ].map(reduceCrossSetProject);
    let bigYields = 0;
    const r = await computeCrossSetLinksAsync(big, { now: NOW, yieldFn: async () => { bigYields++; } });
    expect(r.dropped.comparisons).toBe(n * n);
    expect(bigYields).toBeGreaterThanOrEqual(Math.floor((n * n) / YIELD_EVERY) + 1);
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

  it("per-project file: at most PAGE_LINK_CAP links per page, the strongest kept", () => {
    const result: CrossSetLinks = {
      v: 1, computedAt: NOW.toISOString(), projects: PAGE_LINK_CAP + 11, pages: PAGE_LINK_CAP + 11, projectLinks: [],
      dropped: { stockTexts: 0, stockSheets: 0, oversizedBuckets: 0, truncatedBuckets: 0, comparisons: 0 },
      links: Array.from({ length: PAGE_LINK_CAP + 10 }, (_, i) => ({
        kind: i === 0 ? "twin_of" as const : "revision_of" as const,
        from: { project: "me", page: 1, sheet: "A-101" },
        to: { project: `other-${String(i).padStart(2, "0")}`, page: 1, sheet: "A-101" },
        confidence: i === 0 ? 1 : 0.5 + (i % 10) / 100,
      })),
    };
    const file = projectCrossSetLinks(result, "me");
    expect(file.pages[1]).toHaveLength(PAGE_LINK_CAP);
    expect(file.pages[1][0]).toMatchObject({ kind: "twin_of", confidence: 1 });
    expect(file.pages[1].map((l) => l.confidence)).toEqual([...file.pages[1].map((l) => l.confidence)].sort((a, b) => b - a));
    expect(file.pages[1].at(-1)!.confidence).toBe(0.52); // the 10 weakest (0.50 ×3, 0.51 ×4, three of the 0.52s) fell off
    expect(file.pages[1].some((l) => l.confidence < 0.52)).toBe(false);
    expect(crossSetSummary(file).linkedProjects).toHaveLength(PAGE_LINK_CAP);
  });

  it("publicProjectIntelligence strips the cross-set summary and nothing else", () => {
    const pi = { summaries: { a: 1 }, [CROSS_SET_INTELLIGENCE_KEY]: { v: 1, computedAt: "x", linkedProjects: [{ publicId: "private-set" }] }, tagFamilies: [] };
    expect(publicProjectIntelligence(pi)).toEqual({ summaries: { a: 1 }, tagFamilies: [] });
    expect(JSON.stringify(publicProjectIntelligence(pi))).not.toContain("private-set");
    const untouched = { summaries: { a: 1 } };
    expect(publicProjectIntelligence(untouched)).toBe(untouched);
  });

  it("the S3 key is derived from the data prefix, beside the v1 graph", () => {
    expect(crossSetObjectKey("co/proj-1")).toBe("co/proj-1/graph/cross-set.v1.json");
  });
});
