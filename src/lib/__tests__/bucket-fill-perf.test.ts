/**
 * bucket-fill-perf.test.ts — the two gates, and that they close.
 *
 * This module exists to print a table during phase-2/3 dogfooding (PLAN §9 U1). The failure that
 * matters is not a wrong number, it is the table (or its clock reads) reaching a customer, or
 * firing in a `raster` session that has no vector stage to measure. Both gates are therefore
 * asserted directly, in both directions — a gate nobody has watched close is a guess.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBucketFillPerf,
  perfEnabled,
  recordGeometryTiming,
  recordMaskTiming,
  reportBucketFill,
  setBucketFillPerfMode,
} from "@/lib/bucket-fill-perf";

const ROW = {
  publicId: "p1",
  pageNumber: 3,
  key: "p1::3::3000::vector",
  msFlood: 4,
  msTrace: 2,
  segCount: 1000,
  status: "ok",
};

describe("bucket-fill-perf gates", () => {
  let table: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetBucketFillPerf();
    table = vi.spyOn(console, "table").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __resetBucketFillPerf();
  });

  it("stays OFF under vitest (NODE_ENV=test) — the suite can never acquire table noise", () => {
    setBucketFillPerfMode("auto");
    expect(process.env.NODE_ENV).toBe("test");
    expect(perfEnabled()).toBe(false);
    reportBucketFill(ROW);
    expect(table).not.toHaveBeenCalled();
  });

  it("is OFF by default — the mode default is raster, so a fresh session prints nothing", () => {
    expect(perfEnabled()).toBe(false);
    reportBucketFill(ROW);
    expect(table).not.toHaveBeenCalled();
  });

  it("stays OFF in a raster session even in dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    setBucketFillPerfMode("raster");
    expect(perfEnabled()).toBe(false);
    recordGeometryTiming("p1", 3, { msParse: 10, msWalk: 5 });
    recordMaskTiming(ROW.key, 20);
    reportBucketFill(ROW);
    expect(table).not.toHaveBeenCalled();
  });

  it("stays OFF in production even when the mode would allow vector", () => {
    vi.stubEnv("NODE_ENV", "production");
    setBucketFillPerfMode("vector");
    expect(perfEnabled()).toBe(false);
    recordGeometryTiming("p1", 3, { msParse: 10, msWalk: 5 });
    recordMaskTiming(ROW.key, 20);
    reportBucketFill(ROW);
    expect(table).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("prints all four stages when dev AND a vector-capable mode are both true", () => {
    vi.stubEnv("NODE_ENV", "development");
    setBucketFillPerfMode("auto");
    expect(perfEnabled()).toBe(true);

    recordGeometryTiming("p1", 3, { msParse: 12.5, msWalk: 3.25 });
    recordMaskTiming(ROW.key, 40.125);
    reportBucketFill(ROW);

    expect(table).toHaveBeenCalledTimes(1);
    const [[rows]] = table.mock.calls as unknown as [[Record<string, unknown>[]]];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      page: 3,
      msParse: "12.50",
      msWalk: "3.25",
      msMask: "40.13",
      msFlood: "4.00",
      msTrace: "2.00",
    });
    // The click-path total is what the owner compares against the 1.5 s fill timeout.
    expect(rows[0]["click-path ms"]).toBe("46.13");
  });

  it("attributes the mask build to the FIRST click only — later clicks on the page are warm", () => {
    vi.stubEnv("NODE_ENV", "development");
    setBucketFillPerfMode("auto");
    recordGeometryTiming("p1", 3, { msParse: 1, msWalk: 1 });
    recordMaskTiming(ROW.key, 40);

    reportBucketFill(ROW);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("paid the 40.00 ms mask build");

    // Second click, same page: the mask is already built, so it must NOT be charged again.
    reportBucketFill(ROW);
    expect(info).toHaveBeenCalledTimes(1);
    const [[rows]] = table.mock.calls.slice(-1) as unknown as [[Record<string, unknown>[]]];
    expect(rows[0].msMask).toBe("—");
    expect(rows[0]["click-path ms"]).toBe("6.00");
  });

  it("shows an em dash, not a zero, for a stage that never ran", () => {
    vi.stubEnv("NODE_ENV", "development");
    setBucketFillPerfMode("auto");
    // No geometry timing recorded: this page's parse/walk happened before the table was armed.
    reportBucketFill(ROW);
    const [[rows]] = table.mock.calls as unknown as [[Record<string, unknown>[]]];
    expect(rows[0].msParse).toBe("—");
    expect(rows[0].msWalk).toBe("—");
  });
});
