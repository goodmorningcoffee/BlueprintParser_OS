// @vitest-environment node
// [2026-10-24 master Reprocess tab] The stage DAG, auto-inclusion, presets and run-step planner are
// pure; this pins them. The edges come from the inventory in
// gitignore/projects/master_plan_2026-10-24/notes/reprocess_master_tab.md §2 — if a stage stops
// pulling its downstream, the tab silently leaves data stale again (the 2026-10-21 "full without
// intelligence" trap), so the order and the reasons are asserted literally.
import { describe, expect, it } from "vitest";
import {
  PRESETS,
  STAGES,
  buildRunSteps,
  isRunnable,
  presetTicks,
  resolvePlan,
  resolveProjectIds,
  stageDef,
  type StageId,
} from "@/app/admin/tabs/reprocess-plan";

const ids = (steps: { id: StageId }[]) => steps.map((s) => s.id);
const set = <T,>(...v: T[]) => new Set(v);

describe("stage DAG", () => {
  it("is in pipeline order, ids are unique, and every pull edge points at a runnable stage", () => {
    expect(ids([...STAGES])).toEqual([
      "thumbnails", "page-names", "yolo-run", "yolo-load", "yolo-restamp", "purge-yolo", "dedupe",
      "full", "shape-parse", "intelligence", "graph", "cross-set", "evidence", "tiles", "re-ocr",
    ]);
    // [cross-set F3] company-wide links: a plain reprocess scope after the graph, pulls nothing, pulled by nothing.
    expect(stageDef("cross-set")).toMatchObject({ kind: "reprocess", scope: "cross-set", pulls: [] });
    expect(STAGES.some((s) => s.pulls.some((p) => p.stage === "cross-set"))).toBe(false);
    // [graph T8] knowledge graph: a plain reprocess scope after intelligence, pulls nothing, pulled by nothing.
    expect(stageDef("graph")).toMatchObject({ kind: "reprocess", scope: "graph", pulls: [] });
    expect(STAGES.some((s) => s.pulls.some((p) => p.stage === "graph"))).toBe(false);
    expect(new Set(STAGES.map((s) => s.id)).size).toBe(STAGES.length);
    for (const s of STAGES) {
      for (const p of s.pulls) expect(isRunnable(stageDef(p.stage))).toBe(true);
    }
    expect(stageDef("evidence")).toMatchObject({ kind: "reprocess", scope: "evidence" });
    expect(stageDef("tiles").kind).toBe("reprocess"); // [tiles T9] was a placeholder until 2026-10-24
    expect(stageDef("tiles").scope).toBe("tiles");
    expect(stageDef("re-ocr").kind).toBe("unavailable");
    expect(stageDef("yolo-run").handoffTab).toBe("ai-models");
    expect(stageDef("yolo-restamp").handoffTab).toBe("csi");
  });

  it("every preset ticks only runnable stages; root-only presets are marked", () => {
    for (const p of PRESETS) for (const s of p.stages) expect(isRunnable(stageDef(s))).toBe(true);
    expect(PRESETS.find((p) => p.id === "clean-yolo")?.rootOnly).toBe(true);
    expect(presetTicks("clean-yolo", false).size).toBe(0);
    expect([...presetTicks("full-refresh", false)]).toEqual(["page-names", "full", "shape-parse", "intelligence"]);
  });
});

describe("resolvePlan", () => {
  it("page names pulls in CSI + text annotations and Intelligence, in DAG order, with the reason", () => {
    const plan = resolvePlan(set<StageId>("page-names"), new Set(), false);
    expect(ids(plan.run)).toEqual(["page-names", "full", "intelligence"]);
    expect(plan.run[0].explicit).toBe(true);
    expect(plan.run[1].explicit).toBe(false);
    expect(plan.run[1].reasons[0]).toMatch(/^CSI \+ text annotations added because the drawing number feeds/u);
    expect(plan.run[2].reasons).toEqual([
      "Intelligence added because the drawing number feeds CSI discipline context and page classification",
      "Intelligence added because page intelligence derives from the CSI codes this rewrites",
    ]);
    expect(plan.confirmPhrase).toBeNull();
    expect(plan.warnings).toEqual([]);
  });

  it("full pulls intelligence; intelligence alone pulls nothing; order never follows click order", () => {
    expect(ids(resolvePlan(set<StageId>("full"), new Set(), false).run)).toEqual(["full", "intelligence"]);
    expect(ids(resolvePlan(set<StageId>("intelligence"), new Set(), false).run)).toEqual(["intelligence"]);
    expect(ids(resolvePlan(set<StageId>("intelligence", "shape-parse", "thumbnails"), new Set(), false).run))
      .toEqual(["thumbnails", "shape-parse", "intelligence"]);
  });

  it("an unticked auto-include is kept out of the run with a stale warning; an explicit tick overrides the exclusion", () => {
    const plan = resolvePlan(set<StageId>("page-names"), set<StageId>("intelligence"), false);
    expect(ids(plan.run)).toEqual(["page-names", "full"]);
    expect(ids(plan.steps)).toEqual(["page-names", "full", "intelligence"]);
    expect(plan.steps[2].excluded).toBe(true);
    expect(plan.warnings).toEqual([
      "Intelligence + project analysis unticked — leaves stale: Page names (drawing numbers) → pages.page_intelligence, project analysis; CSI + text annotations → pages.page_intelligence, project analysis",
    ]);
    const overridden = resolvePlan(set<StageId>("page-names", "intelligence"), set<StageId>("intelligence"), false);
    expect(ids(overridden.run)).toEqual(["page-names", "full", "intelligence"]);
    expect(overridden.warnings).toEqual([]);
  });

  it("root-only cleanup stages are ignored for non-root and set the typed phrase for root", () => {
    expect(ids(resolvePlan(set<StageId>("purge-yolo"), new Set(), false).run)).toEqual([]);
    const purge = resolvePlan(set<StageId>("purge-yolo"), new Set(), true);
    expect(ids(purge.run)).toEqual(["purge-yolo", "full", "intelligence", "evidence"]);
    expect(purge.confirmPhrase).toBe("DELETE");
    const dedupe = resolvePlan(set<StageId>("dedupe"), new Set(), true);
    expect(ids(dedupe.run)).toEqual(["dedupe", "intelligence", "evidence"]);
    expect(dedupe.confirmPhrase).toBe("DEDUPE");
    expect(resolvePlan(set<StageId>("dedupe", "purge-yolo"), new Set(), true).confirmPhrase).toBe("DELETE");
  });

  it("[tiles T9] tile images is ROOT-ONLY (python on the web task), runs alone, pulls nothing, is pulled by nothing, and becomes one scope=tiles request", () => {
    expect(stageDef("tiles").rootOnly).toBe(true); // [T9 fix round] was open to every admin in 1882a1b
    const alone = resolvePlan(set<StageId>("tiles"), new Set(), true);
    expect(ids(alone.run)).toEqual(["tiles"]);
    expect(alone.confirmPhrase).toBeNull();
    expect(ids(resolvePlan(set<StageId>("thumbnails", "intelligence", "tiles"), new Set(), true).run)).toEqual(["thumbnails", "intelligence", "tiles"]);
    expect(ids(resolvePlan(set<StageId>("thumbnails", "full"), new Set(), true).run)).not.toContain("tiles");
    expect(buildRunSteps(alone, { projectIds: ["p1"], companyId: 3 }, { clearPageCsi: false })).toEqual([
      { kind: "reprocess", id: "tiles", label: "Tile images", scope: "tiles", projectIds: ["p1"] },
    ]);
    expect([...presetTicks("tiles", true)]).toEqual(["tiles"]);
    // non-root: the tick is dropped, the preset is empty
    expect(ids(resolvePlan(set<StageId>("tiles"), new Set(), false).run)).toEqual([]);
    expect(PRESETS.find((p) => p.id === "tiles")?.rootOnly).toBe(true);
    expect(presetTicks("tiles", false).size).toBe(0);
  });

  it("non-runnable ticks (handoff / unavailable; no placeholders left after evidence + tiles) are dropped", () => {
    expect(ids(resolvePlan(set<StageId>("yolo-run", "re-ocr", "intelligence"), new Set(), true).run)).toEqual(["intelligence"]);
  });
});

describe("evidence stage [evidence T4]", () => {
  it("runs alone as one ?scope=evidence request and pulls nothing", () => {
    const plan = resolvePlan(set<StageId>("evidence"), new Set(), false);
    expect(ids(plan.run)).toEqual(["evidence"]);
    expect(buildRunSteps(plan, { projectIds: ["p1"], companyId: 3 }, { clearPageCsi: false })).toEqual([
      { kind: "reprocess", id: "evidence", label: "Evidence", scope: "evidence", projectIds: ["p1"] },
    ]);
  });

  it("YOLO-row cleanups pull it after Intelligence; unticking it warns what goes stale", () => {
    const plan = resolvePlan(set<StageId>("dedupe"), set<StageId>("intelligence"), true);
    expect(ids(plan.run)).toEqual(["dedupe", "evidence"]);
    expect(plan.run[1].reasons).toEqual(["Evidence added because it fuses OCR with the YOLO rows this changes"]);
    const off = resolvePlan(set<StageId>("purge-yolo"), set<StageId>("evidence"), true);
    expect(off.warnings).toContain("Evidence unticked — leaves stale: Delete YOLO annotations → pages.page_intelligence.evidence");
  });
});

describe("buildRunSteps", () => {
  it("reprocess stages become one request each with the scope's project ids; cleanup stages pin the company and mode", () => {
    const plan = resolvePlan(set<StageId>("purge-yolo", "dedupe"), new Set(), true);
    const steps = buildRunSteps(plan, { projectIds: undefined, companyId: 3 }, { clearPageCsi: true });
    expect(steps.map((s) => s.kind)).toEqual(["cleanup", "cleanup", "reprocess", "reprocess", "reprocess"]);
    expect(steps[0]).toEqual({
      kind: "cleanup", id: "purge-yolo", label: "Delete YOLO annotations", url: "/api/admin/annotation-cleanup?companyId=3",
      body: { mode: "delete", all: true, sources: ["yolo"], clearPageCsi: true },
    });
    expect(steps[1]).toEqual({
      kind: "cleanup", id: "dedupe", label: "Remove exact-duplicate annotations", url: "/api/admin/annotation-cleanup?companyId=3",
      body: { mode: "dedupe", all: true, sources: ["yolo", "shape-parse"], clearPageCsi: false },
    });
    expect(steps[2]).toEqual({ kind: "reprocess", id: "full", label: "CSI + text annotations", scope: "full", projectIds: undefined });
    expect(steps[3]).toMatchObject({ kind: "reprocess", scope: "intelligence" });
  });

  it("explicit project ids go to both route shapes; no company → no query", () => {
    const plan = resolvePlan(set<StageId>("purge-yolo"), new Set(), true);
    const steps = buildRunSteps(plan, { projectIds: ["p1", "p2"], companyId: null }, { clearPageCsi: false, sources: { "purge-yolo": ["yolo", "shape-parse"] } });
    expect(steps[0]).toMatchObject({ url: "/api/admin/annotation-cleanup", body: { projectPublicIds: ["p1", "p2"], sources: ["yolo", "shape-parse"], clearPageCsi: false } });
    expect(steps[0].kind === "cleanup" && "all" in steps[0].body).toBe(false);
    expect(steps[1]).toMatchObject({ kind: "reprocess", projectIds: ["p1", "p2"] });
  });
});

describe("resolveProjectIds", () => {
  const projects = [
    { id: "own-done", name: "A", status: "completed", isDemo: false, companyId: 3 },
    { id: "own-err", name: "B", status: "error", isDemo: false, companyId: 3 },
    { id: "demo", name: "D", status: "completed", isDemo: true, companyId: 3 },
    { id: "foreign", name: "F", status: "completed", isDemo: false, companyId: 4 },
    { id: "no-company", name: "N", status: "completed", isDemo: false },
  ];
  it("All sends nothing (the server's own predicate)", () => {
    expect(resolveProjectIds("all", projects, set("completed"), set("own-done"), 3)).toBeUndefined();
  });
  it("By status keeps own-company non-demo projects in the ticked statuses", () => {
    expect(resolveProjectIds("status", projects, set("completed"), new Set(), 3)).toEqual(["own-done", "no-company"]);
    expect(resolveProjectIds("status", projects, set("completed", "error"), new Set(), 3)).toEqual(["own-done", "own-err", "no-company"]);
    // Company unknown (scope endpoint failed): nothing is dropped as foreign.
    expect(resolveProjectIds("status", projects, set("completed"), new Set(), null)).toEqual(["own-done", "foreign", "no-company"]);
  });
  it("Select… drops demo and other-company picks (the server would silently skip them)", () => {
    expect(resolveProjectIds("select", projects, new Set(), set("own-done", "demo", "foreign", "own-err"), 3)).toEqual(["own-done", "own-err"]);
  });
});
