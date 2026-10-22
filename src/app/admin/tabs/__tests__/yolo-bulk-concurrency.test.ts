import { describe, expect, it } from "vitest";
import { bulkConcurrency, MAX_BULK_CONCURRENCY } from "../yolo-bulk-concurrency";
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
