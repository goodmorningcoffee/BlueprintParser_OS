// @vitest-environment node
// [2026-10-21 owner: "have it just auto load"] Server-side catch-up on GET /api/admin/running-jobs:
// a provider-Completed job nobody polled is marked completed (via updateRunningJob) and loaded ONCE;
// a provider-absent row ≥ 30 min old is closed as never accepted; everything else is left alone.
// Bounded, and never throws.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getYoloJobStatus: vi.fn() }));
vi.mock("@/lib/yolo", () => ({ getYoloJobStatus: h.getYoloJobStatus }));

import { CATCH_UP_MAX_LOADS, catchUpYoloJobs } from "@/server/services/yolo-catch-up";

const session = { user: { dbId: 1, companyId: 2, role: "admin", isRootAdmin: false } } as never;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const row = (executionId: string, minutesAgo = 5) => ({
  projectPublicId: `p-${executionId}`,
  executionId,
  modelId: 7,
  modelName: "doors",
  startedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
});
const notFound = () => Object.assign(new Error("Could not find requested job with name x"), { name: "ValidationException" });

beforeEach(() => {
  h.getYoloJobStatus.mockReset();
});

describe("catchUpYoloJobs", () => {
  it("Completed → load once with the admin's session, THEN mark completed; the row leaves the running list", async () => {
    h.getYoloJobStatus.mockImplementation(async (name: string) => ({ status: name === "done" ? "Completed" : "InProgress" }));
    const markTerminal = vi.fn(async () => ({ success: true }));
    const load = vi.fn(async () => ({ success: true }));
    const retired = await catchUpYoloJobs(session, [row("done"), row("busy")], { markTerminal, load, now: () => NOW });
    expect([...retired]).toEqual(["done"]);
    expect(markTerminal).toHaveBeenCalledWith({ executionId: "done", status: "Completed" }, session);
    expect(load).toHaveBeenCalledWith({ projectId: "p-done", modelId: 7, modelName: "doors" }, session);
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(markTerminal.mock.invocationCallOrder[0]);
  });

  it("loads at most CATCH_UP_MAX_LOADS per request; the rest stay for the browser to poll", async () => {
    h.getYoloJobStatus.mockResolvedValue({ status: "Completed" });
    const load = vi.fn(async () => ({}));
    const retired = await catchUpYoloJobs(session, [row("a"), row("b"), row("c")], { markTerminal: async () => ({}), load, now: () => NOW });
    expect(load).toHaveBeenCalledTimes(CATCH_UP_MAX_LOADS);
    expect(retired.size).toBe(CATCH_UP_MAX_LOADS);
  });

  it("provider-absent: closes a row ≥ 30 min old as never accepted, keeps a younger one", async () => {
    h.getYoloJobStatus.mockRejectedValue(notFound());
    const markTerminal = vi.fn(async () => ({}));
    const load = vi.fn();
    const retired = await catchUpYoloJobs(session, [row("old", 45), row("young", 5)], { markTerminal, load, now: () => NOW });
    expect([...retired]).toEqual(["old"]);
    expect(markTerminal).toHaveBeenCalledWith({ executionId: "old", status: "Failed" }, session);
    expect(load).not.toHaveBeenCalled();
  });

  it("Failed/Stopped/throttled/unknown are left untouched, and nothing throws", async () => {
    h.getYoloJobStatus
      .mockResolvedValueOnce({ status: "Failed" })
      .mockRejectedValueOnce(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }))
      .mockResolvedValueOnce(undefined);
    const markTerminal = vi.fn();
    const retired = await catchUpYoloJobs(session, [row("f", 60), row("t", 60), row("u", 60)], { markTerminal, now: () => NOW });
    expect(retired.size).toBe(0);
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("a failing load leaves the row running (not marked, not retired) so the browser still auto-loads it", async () => {
    h.getYoloJobStatus.mockResolvedValue({ status: "Completed" });
    const markTerminal = vi.fn(async () => ({}));
    const load = vi.fn(async () => {
      throw new Error("CONFLICT: lease held");
    });
    const retired = await catchUpYoloJobs(session, [row("x")], { markTerminal, load, now: () => NOW });
    expect(retired.size).toBe(0);
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("a failing load or mark is logged, not thrown", async () => {
    h.getYoloJobStatus.mockResolvedValue({ status: "Completed" });
    const markTerminal = vi.fn(async () => {
      throw new Error("CONFLICT");
    });
    await expect(catchUpYoloJobs(session, [row("x")], { markTerminal, load: async () => ({}), now: () => NOW })).resolves.toEqual(new Set());
  });
});
