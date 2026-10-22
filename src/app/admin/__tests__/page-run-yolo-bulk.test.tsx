// [2026-10-21 bulk YOLO] The admin page's runYolo(projectId, modelId, bulk=true) starts the job and
// returns { jobName } WITHOUT starting its own status poller — the YoloBulkBar queue polls and loads
// that job itself. A page-side poller as well would poll every job twice and load each result twice.
// The single-run path (bulk omitted) still polls and auto-loads. Real AdminPage, stubbed AiModelsTab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  // stable identities: AdminPage's load effect depends on [session, status, router]
  session: { data: { user: { role: "admin", isRootAdmin: false } }, status: "authenticated" },
  router: { push: () => {}, replace: () => {} },
  tabProps: null as null | {
    onRunYolo: (projectId: string, modelId: number, bulk?: boolean) => Promise<unknown>;
    yoloJobs: Record<string, Record<string, string>>;
  },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => h.session,
}));
vi.mock("next/navigation", () => ({ useRouter: () => h.router }));
vi.mock("@/components/dashboard/Header", () => ({ default: () => null }));
vi.mock("@/app/admin/tabs/AiModelsTab", () => ({
  default: (props: NonNullable<typeof h.tabProps>) => {
    h.tabProps = props;
    return null;
  },
}));

import AdminPage from "@/app/admin/page";

let fetchMock: ReturnType<typeof vi.fn>;
const calls = (prefix: string) => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(prefix));

beforeEach(() => {
  h.tabProps = null;
  window.history.replaceState(null, "", "/admin?tab=ai-models");
  fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (u === "/api/admin/models") return json([{ id: 7, name: "doors", type: "yolo", config: {}, isDefault: false }]);
    if (u === "/api/yolo/run") return json({ jobName: `job-${calls("/api/yolo/run").length}` });
    if (u.startsWith("/api/yolo/status")) return json({ status: "Completed" });
    if (u === "/api/yolo/load") return json({ detectionsLoaded: 4 });
    if (u === "/api/admin/running-jobs" || u === "/api/projects" || u === "/api/admin/users") return json([]);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountPage() {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  render(<AdminPage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(h.tabProps).not.toBeNull();
}

describe("AdminPage runYolo", () => {
  it("bulk=true returns the job name and starts NO page-side poller or load", async () => {
    await mountPage();
    let result: unknown;
    await act(async () => { result = await h.tabProps!.onRunYolo("p1", 7, true); });
    expect(result).toEqual({ jobName: "job-1" });
    expect(h.tabProps!.yoloJobs).toEqual({ p1: { "7": "Running: job-1" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls("/api/yolo/status")).toEqual([]);
    expect(calls("/api/yolo/load")).toEqual([]);
  });

  it("a single run (bulk omitted) still polls and auto-loads", async () => {
    await mountPage();
    await act(async () => { await h.tabProps!.onRunYolo("p1", 7); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(calls("/api/yolo/status").length).toBeGreaterThanOrEqual(1);
    expect(calls("/api/yolo/load").length).toBe(1);
  });

  it("a refused start returns the error text and HTTP status for the queue to classify", async () => {
    await mountPage();
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: "RATE_LIMITED", message: "No SageMaker quota for ml.g4dn.xlarge …" } }),
    }));
    let result: unknown;
    await act(async () => { result = await h.tabProps!.onRunYolo("p1", 7, true); });
    expect(result).toEqual({ error: "No SageMaker quota for ml.g4dn.xlarge …", httpStatus: 429 });
  });
});
