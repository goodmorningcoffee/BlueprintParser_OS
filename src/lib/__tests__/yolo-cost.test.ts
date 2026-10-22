// @vitest-environment node
// [2026-10-21/22 owner] Cost estimate next to Run all / Run on selected / per-project Run:
// "≈ $X · N pages · J jobs" = Σ (startup_s + pages × s_per_page) × $/h ÷ 3600, timed from past runs
// (labelled "based on K past runs") or a stated default, capped and flagged at the root-set timeout;
// and the picker offers only quota > 0 types when quotas are live.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_YOLO_RUN_TIMING,
  estimateYoloCost,
  fitYoloRunTiming,
  pickYoloRunTiming,
  selectableYoloOptions,
  yoloEstimateFor,
  yoloEstimateText,
  yoloTimingBasis,
  type YoloInstanceCatalog,
  type YoloInstanceOptionsResponse,
} from "@/lib/yolo-cost";
import { YOLO_INSTANCE_OPTIONS } from "@/lib/yolo-instances";

describe("fitYoloRunTiming", () => {
  it("recovers startup + per-page seconds from runs over different page counts", () => {
    const fit = fitYoloRunTiming([
      { pages: 10, seconds: 200 },
      { pages: 50, seconds: 280 },
      { pages: 100, seconds: 380 },
    ]);
    expect(fit).toEqual({ startupSeconds: 180, secondsPerPage: 2, runs: 3 });
  });

  it("with too few runs keeps the default startup (never above the shortest run) and averages the rest per page", () => {
    expect(fitYoloRunTiming([{ pages: 100, seconds: 390 }])).toEqual({ startupSeconds: 240, secondsPerPage: 1.5, runs: 1 });
    expect(fitYoloRunTiming([{ pages: 10, seconds: 100 }])).toEqual({ startupSeconds: 100, secondsPerPage: 0, runs: 1 });
  });

  it("ignores invalid samples; none valid → null", () => {
    expect(fitYoloRunTiming([{ pages: 0, seconds: 100 }, { pages: 5, seconds: Number.NaN }])).toBeNull();
  });
});

describe("estimateYoloCost", () => {
  const timing = { startupSeconds: 240, secondsPerPage: 1.5 };
  it("sums per-job seconds × $/h; unknown page counts are refused and cost nothing", () => {
    const e = estimateYoloCost([100, 200, null], 3.6, timing, 3600);
    // (240+150) + (240+300) = 930 s × $3.60/h = $0.93
    expect(e).toMatchObject({ pages: 300, jobs: 2, unknownPages: 1, overTimeout: 0 });
    expect(e.usd).toBeCloseTo(0.93, 6);
  });

  it("a job longer than the timeout is billed only up to it and flagged", () => {
    const e = estimateYoloCost([4000], 3.6, timing, 3600);
    expect(e.overTimeout).toBe(1);
    expect(e.usd).toBeCloseTo(3.6, 6);
    expect(e.longestJobSeconds).toBe(240 + 6000);
  });
});

describe("pickYoloRunTiming", () => {
  const stats = [
    { modelId: 7, instanceType: "ml.g5.xlarge", startupSeconds: 100, secondsPerPage: 1, runs: 4 },
    { modelId: null, instanceType: "ml.g5.xlarge", startupSeconds: 120, secondsPerPage: 1.2, runs: 9 },
  ];
  it("prefers this model's history, then the instance's, then the labelled default", () => {
    expect(pickYoloRunTiming(stats, 7, "ml.g5.xlarge")).toMatchObject({ basis: "model", runs: 4 });
    expect(pickYoloRunTiming(stats, 8, "ml.g5.xlarge")).toMatchObject({ basis: "instance", runs: 9 });
    expect(pickYoloRunTiming(stats, 7, "ml.g6.xlarge")).toEqual(DEFAULT_YOLO_RUN_TIMING);
    expect(yoloTimingBasis(DEFAULT_YOLO_RUN_TIMING)).toMatch(/^assumed 240 s startup \+ 1\.5 s\/page/u);
    expect(yoloTimingBasis(pickYoloRunTiming(stats, 7, "ml.g5.xlarge"))).toMatch(/^based on 4 past runs/u);
  });
});

function catalog(quotas: Record<string, number> | null): YoloInstanceCatalog {
  return {
    region: "us-east-1",
    checkedAt: "2026-10-22T00:00:00.000Z",
    quotaStatus: quotas ? "live" : "unavailable",
    priceStatus: "approximate",
    priceTableAsOf: "2026-10-21",
    options: YOLO_INSTANCE_OPTIONS.map((o) => ({ ...o, priceSource: "table" as const, quota: quotas ? (quotas[o.type] ?? 0) : null })),
  };
}

describe("selectableYoloOptions (owner: only instances with quota > 0)", () => {
  it("live quotas → only quota > 0, plus the saved type; zero-quota GPU types listed for an increase request", () => {
    const { options, zeroQuota } = selectableYoloOptions(catalog({ "ml.g5.xlarge": 2, "ml.g6.xlarge": 1 }), "ml.g4dn.xlarge");
    expect(options.map((o) => o.type)).toEqual(["ml.g4dn.xlarge", "ml.g5.xlarge", "ml.g6.xlarge"]);
    expect(zeroQuota.some((o) => o.type === "ml.g6e.48xlarge")).toBe(true);
    expect(zeroQuota.some((o) => o.gpu === null)).toBe(false);
  });

  it("quotas unreachable → the whole compatible allowlist", () => {
    const { options, zeroQuota } = selectableYoloOptions(catalog(null), "ml.g4dn.xlarge");
    expect(options).toHaveLength(YOLO_INSTANCE_OPTIONS.length);
    expect(zeroQuota).toEqual([]);
  });
});

describe("yoloEstimateFor / yoloEstimateText", () => {
  const data: YoloInstanceOptionsResponse = {
    instanceType: "ml.g4dn.xlarge",
    valid: true,
    defaultInstanceType: "ml.g4dn.xlarge",
    maxRuntimeSeconds: 3600,
    runtimeBounds: { min: 900, max: 86400, default: 3600 },
    catalog: catalog({ "ml.g4dn.xlarge": 2 }),
    runStats: [],
  };
  it("uses the CURRENT instance's price and says when the timing is an assumption", () => {
    const e = yoloEstimateFor(data, 7, [100, 100]);
    expect(e?.option.type).toBe("ml.g4dn.xlarge");
    // 2 × (240 + 150) s × $0.74/h
    expect(e?.estimate.usd).toBeCloseTo((780 * 0.74) / 3600, 6);
    const text = yoloEstimateText(e!);
    expect(text).toMatch(/^≈ \$0\.16 · 200 pages · 2 jobs · ml\.g4dn\.xlarge @ \$0\.74\/h \(approx\.\) · assumed/u);
    expect(text).toMatch(/timeout 60 min/u);
  });

  it("flags jobs that may hit the timeout", () => {
    const text = yoloEstimateText(yoloEstimateFor({ ...data, maxRuntimeSeconds: 900 }, 7, [1000])!);
    expect(text).toMatch(/⚠ 1 job may hit the timeout/u);
  });

  it("no data → null (non-root admins see no estimate)", () => {
    expect(yoloEstimateFor(null, 7, [10])).toBeNull();
  });
});
