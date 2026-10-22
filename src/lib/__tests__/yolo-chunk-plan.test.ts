// [2026-10-22] Bulk YOLO planning: jobs of ≤ 9 projects, count = max(ceil(n/9), min(N, n), budget),
// balanced by page count (largest first into the lightest job), bounded by 80% of the timeout, deterministic;
// the wall-clock/cost estimate follows N and the GPUs per machine.
import { describe, expect, it } from "vitest";
import {
  MAX_PROJECTS_PER_YOLO_JOB,
  estimateYoloBatchRun,
  planYoloChunks,
  yoloJobPageBudget,
  yoloJobSeconds,
} from "@/lib/yolo-chunk-plan";

const timing = { startupSeconds: 240, secondsPerPage: 1.5 };
const projects79 = Array.from({ length: 79 }, (_, i) => ({ id: `p${String(i).padStart(2, "0")}`, pages: 5 + ((i * 37) % 120) }));
const plan = (machines: number, gpus = 4, maxRuntimeSeconds = 3600, list = projects79) =>
  planYoloChunks(list, { machines, gpusPerMachine: gpus, timing, maxRuntimeSeconds });

describe("planYoloChunks", () => {
  it("N=5 → ceil(79/9)=9 jobs; N=10 → 10 jobs; every project exactly once, ≤ 9 per job", () => {
    for (const [n, jobs] of [[5, 9], [10, 10]] as const) {
      const chunks = plan(n);
      expect(chunks).toHaveLength(jobs);
      expect(chunks.every((c) => c.projectIds.length <= MAX_PROJECTS_PER_YOLO_JOB)).toBe(true);
      expect(chunks.flatMap((c) => c.projectIds).sort()).toEqual(projects79.map((p) => p.id).sort());
    }
  });

  it("balances by page count: heaviest and lightest jobs stay close", () => {
    for (const n of [5, 10]) {
      const pages = plan(n).map((c) => c.pages);
      const max = Math.max(...pages);
      const min = Math.min(...pages);
      expect(max - min).toBeLessThanOrEqual(Math.max(...projects79.map((p) => p.pages)));
      expect(max / min).toBeLessThan(1.25);
    }
  });

  it("is deterministic: same input → same plan; ties keep input order", () => {
    expect(plan(10)).toEqual(plan(10));
    const equal = planYoloChunks(
      ["a", "b", "c", "d"].map((id) => ({ id, pages: 10 })),
      { machines: 2, gpusPerMachine: 1, timing, maxRuntimeSeconds: 3600 },
    );
    expect(equal.map((c) => c.projectIds)).toEqual([["a", "c"], ["b", "d"]]);
  });

  it("never uses more jobs than projects, and one machine still splits at 9", () => {
    expect(plan(10, 4, 3600, projects79.slice(0, 3))).toHaveLength(3);
    const one = plan(1, 4, 86_400, projects79.slice(0, 20));
    expect(one).toHaveLength(3);
    expect(one.every((c) => c.projectIds.length <= 9)).toBe(true);
  });

  it("keeps each job's estimate within 80% of the timeout, splitting further when needed", () => {
    const heavy = Array.from({ length: 9 }, (_, i) => ({ id: `h${i}`, pages: 1000 }));
    const chunks = planYoloChunks(heavy, { machines: 1, gpusPerMachine: 1, timing, maxRuntimeSeconds: 3600 });
    const budget = yoloJobPageBudget(1, timing, 3600); // (2880 − 240) / 1.5 = 1760 pages
    expect(budget).toBeCloseTo(1760);
    expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(9000 / 1760));
    expect(chunks.every((c) => c.pages <= budget && c.seconds <= 0.8 * 3600)).toBe(true);
    // 4 GPUs carry 4× the pages within the same budget
    expect(planYoloChunks(heavy, { machines: 1, gpusPerMachine: 4, timing, maxRuntimeSeconds: 3600 }).length).toBeLessThan(chunks.length);
  });

  it("a single project over the budget runs alone and is flagged", () => {
    const chunks = planYoloChunks(
      [{ id: "huge", pages: 5000 }, { id: "s1", pages: 10 }, { id: "s2", pages: 10 }],
      { machines: 1, gpusPerMachine: 1, timing, maxRuntimeSeconds: 3600 },
    );
    const huge = chunks.find((c) => c.projectIds.includes("huge"))!;
    expect(huge.projectIds).toEqual(["huge"]);
    expect(huge.overBudget).toBe(true);
    expect(chunks.filter((c) => !c.overBudget).flatMap((c) => c.projectIds).sort()).toEqual(["s1", "s2"]);
  });

  it("unknown page counts weigh nothing and duplicates are dropped", () => {
    const chunks = planYoloChunks(
      [{ id: "a", pages: null }, { id: "a", pages: 3 }, { id: "b", pages: 0 }],
      { machines: 2, gpusPerMachine: 1, timing, maxRuntimeSeconds: 3600 },
    );
    expect(chunks.flatMap((c) => c.projectIds).sort()).toEqual(["a", "b"]);
    expect(chunks.reduce((s, c) => s + c.pages, 0)).toBe(0);
  });
});

describe("estimateYoloBatchRun", () => {
  it("wall clock ≈ startup + heaviest job ÷ GPUs per wave; more machines → fewer waves, same work", () => {
    const at5 = estimateYoloBatchRun(plan(5), 5, 7.09, 3600);
    const at10 = estimateYoloBatchRun(plan(10), 10, 7.09, 3600);
    expect(at5.jobs).toBe(9);
    expect(at5.waves).toBe(2);
    expect(at10.waves).toBe(1);
    expect(at10.wallSeconds).toBeLessThan(at5.wallSeconds);
    const heaviest10 = Math.max(...plan(10).map((c) => c.pages));
    expect(at10.wallSeconds).toBeCloseTo(yoloJobSeconds(heaviest10, 4, timing));
    // cost: one extra job's startup at N=10, otherwise the same pages
    expect(at10.usd - at5.usd).toBeCloseTo((240 * 7.09) / 3600, 5);
    expect(at5.pages).toBe(at10.pages);
  });

  it("GPUs per machine shorten the estimate", () => {
    const one = estimateYoloBatchRun(plan(5, 1, 86_400), 5, 1, 86_400);
    const four = estimateYoloBatchRun(plan(5, 4, 86_400), 5, 1, 86_400);
    expect(four.wallSeconds).toBeLessThan(one.wallSeconds);
    expect(four.usd).toBeLessThan(one.usd);
  });

  it("bills a job at most the timeout and counts it", () => {
    const e = estimateYoloBatchRun([{ pages: 10_000, seconds: 15_240 }], 1, 3.6, 3600);
    expect(e.overTimeout).toBe(1);
    expect(e.usd).toBeCloseTo(3.6);
  });
});
