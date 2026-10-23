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
    yoloStatus?: Record<string, Record<string, number>>;
    yoloStatusLoad?: { loaded: boolean; error: string | null };
  },
}));
const NON_ROOT = h.session;
const ROOT = { data: { user: { role: "admin", isRootAdmin: true } }, status: "authenticated" };

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
  h.session = NON_ROOT;
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

// [2026-10-23] GET /api/admin/yolo-status is root-only (as are the YOLO controls), and its load state
// reaches the tab so "only projects without results" can say "loading results…" / show the error.
describe("AdminPage YOLO results status", () => {
  it("a non-root admin never asks for it", async () => {
    await mountPage();
    expect(calls("/api/admin/yolo-status")).toEqual([]);
    expect(h.tabProps!.yoloStatusLoad).toEqual({ loaded: false, error: null });
  });

  it("root: loaded once it lands", async () => {
    h.session = ROOT;
    const base = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation(async (url: string) =>
      String(url) === "/api/admin/yolo-status"
        ? { ok: true, status: 200, json: async () => ({ p1: { "7": 3 } }) }
        : base(url),
    );
    await mountPage();
    expect(calls("/api/admin/yolo-status").length).toBe(1);
    expect(h.tabProps!.yoloStatus).toEqual({ p1: { "7": 3 } });
    expect(h.tabProps!.yoloStatusLoad).toEqual({ loaded: true, error: null });
  });

  it("root: a failed load is surfaced, not swallowed", async () => {
    h.session = ROOT;
    const base = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation(async (url: string) =>
      String(url) === "/api/admin/yolo-status"
        ? { ok: false, status: 500, json: async () => ({ error: { code: "INTERNAL", message: "Internal error" } }) }
        : base(url),
    );
    await mountPage();
    expect(h.tabProps!.yoloStatus).toEqual({});
    expect(h.tabProps!.yoloStatusLoad).toEqual({ loaded: false, error: "Internal error" });
  });
});
