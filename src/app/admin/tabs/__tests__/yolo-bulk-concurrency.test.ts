import { describe, expect, it } from "vitest";
import { bulkConcurrency, bulkMachineBounds, clampMachines, MAX_BULK_CONCURRENCY } from "../yolo-bulk-concurrency";
import { DEFAULT_CONCURRENCY } from "../yolo-batch";
import type { YoloInstanceOptionsResponse } from "@/lib/yolo-cost";

function opts(instanceType: string, quotas: Record<string, number | null>): YoloInstanceOptionsResponse {
  return {
    instanceType,
    catalog: { options: Object.entries(quotas).map(([type, quota]) => ({ type, quota })) },
  } as unknown as YoloInstanceOptionsResponse;
}

describe("bulkConcurrency", () => {
  it("uses the chosen instance's processing-job quota", () => {
    expect(bulkConcurrency(opts("ml.g5.xlarge", { "ml.g5.xlarge": 8, "ml.g4dn.xlarge": 3 }))).toBe(8);
  });
  it("caps at MAX_BULK_CONCURRENCY", () => {
    expect(bulkConcurrency(opts("ml.g5.xlarge", { "ml.g5.xlarge": 500 }))).toBe(MAX_BULK_CONCURRENCY);
  });
  it("falls back to the default when options or quota are unknown or zero", () => {
    expect(bulkConcurrency(null)).toBe(DEFAULT_CONCURRENCY);
    expect(bulkConcurrency(opts("ml.g5.xlarge", { "ml.g5.xlarge": null }))).toBe(DEFAULT_CONCURRENCY);
    expect(bulkConcurrency(opts("ml.g5.xlarge", { "ml.g4dn.xlarge": 4 }))).toBe(DEFAULT_CONCURRENCY);
    expect(bulkConcurrency(opts("ml.g5.xlarge", { "ml.g5.xlarge": 0 }))).toBe(DEFAULT_CONCURRENCY);
  });
});

// [2026-10-22] "Machines at once": default = the chosen instance's quota; bounds 1 … min(quota, 20), or 1 … 20
// when the quota is unknown (default 2).

describe("bulkMachineBounds / clampMachines", () => {
  it("default = quota, max = quota (capped at 20)", () => {
    expect(bulkMachineBounds(opts("ml.g5.12xlarge", { "ml.g5.12xlarge": 10 }))).toEqual({ min: 1, max: 10, quota: 10, defaultValue: 10 });
    expect(bulkMachineBounds(opts("ml.g5.12xlarge", { "ml.g5.12xlarge": 64 }))).toMatchObject({ max: 20, quota: 64, defaultValue: 20 });
  });
  it("unknown quota → default 2, free entry 1–20", () => {
    expect(bulkMachineBounds(null)).toEqual({ min: 1, max: 20, quota: null, defaultValue: DEFAULT_CONCURRENCY });
    expect(bulkMachineBounds(opts("ml.g5.xlarge", { "ml.g5.xlarge": null }))).toMatchObject({ max: 20, quota: null, defaultValue: 2 });
  });
  it("clamps a typed value into the bounds; junk → default", () => {
    const b = bulkMachineBounds(opts("ml.g5.12xlarge", { "ml.g5.12xlarge": 10 }));
    expect(clampMachines(5, b)).toBe(5);
    expect(clampMachines(0, b)).toBe(1);
    expect(clampMachines(11, b)).toBe(10);
    expect(clampMachines(3.7, b)).toBe(3);
    expect(clampMachines(Number.NaN, b)).toBe(10);
    expect(clampMachines("7", b)).toBe(7);
  });
});
