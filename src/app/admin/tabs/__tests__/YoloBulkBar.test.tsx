// Bulk YOLO bar (owner 2026-10-21): Select all / Deselect all / "only projects without results"
// filter / button counts, Run all with the page-count confirmation, Load all, Stop — wired through
// AiModelsTab's real row checkboxes and the admin page's runYolo(…, bulk=true) / loadYoloResults.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/app/admin/sections/LLMConfigSection", () => ({ default: () => null }));
vi.mock("@/app/admin/sections/S3Browser", () => ({ default: () => null }));

import AiModelsTab from "@/app/admin/tabs/AiModelsTab";
import { resetYoloBulkStoreForTests } from "@/app/admin/tabs/YoloBulkBar";
import { resetYoloOptionsForTests } from "@/app/admin/tabs/yolo-options-store";
import { YOLO_INSTANCE_OPTIONS } from "@/lib/yolo-instances";

const MODELS = [
  { id: 7, name: "doors", type: "yolo", config: {}, isDefault: false },
  { id: 9, name: "windows", type: "yolo", config: {}, isDefault: false },
];
const PROJECTS = [
  { id: "p1", name: "Alpha", numPages: 10, status: "completed", isDemo: false },
  { id: "p2", name: "Bravo", numPages: 5, status: "completed", isDemo: false },
  { id: "p3", name: "Charlie", numPages: 20, status: "completed", isDemo: false },
  { id: "p4", name: "Delta", numPages: 3, status: "processing", isDemo: false }, // not listed
];

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetYoloBulkStoreForTests();
  fetchMock = vi.fn(async (url: string) => {
    if (typeof url === "string" && url.startsWith("/api/yolo/status")) {
      return { ok: true, json: async () => ({ status: "Completed" }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  resetYoloBulkStoreForTests();
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderTab(overrides: Partial<{ yoloStatus: Record<string, Record<string, number>>; isRootAdmin: boolean }> = {}) {
  const onRunYolo = vi.fn(async (projectId: string) => ({ jobName: `job-${projectId}` }));
  const onLoadResults = vi.fn(async () => "Completed — 4 detections loaded");
  const noop = () => {};
  render(
    <AiModelsTab
      yoloModels={MODELS}
      projects={PROJECTS}
      yoloJobs={{}}
      yoloStatus={overrides.yoloStatus ?? { p2: { "7": 12 } }}
      uploading={false}
      uploadProgress={0}
      onUploadModel={noop}
      onDeleteModel={noop}
      onRunYolo={onRunYolo}
      onLoadResults={onLoadResults}
      toggles={{ sagemakerEnabled: true, quotaEnabled: true, hasPassword: false }}
      togglePassword=""
      setTogglePassword={noop}
      toggleError=""
      setToggleError={noop}
      newTogglePass=""
      setNewTogglePass={noop}
      currentTogglePass=""
      setCurrentTogglePass={noop}
      onToggle={noop}
      onSetTogglePassword={noop}
      isRootAdmin={overrides.isRootAdmin ?? false}
    />,
  );
  const bar = screen.getByTestId("yolo-bulk-bar");
  return { onRunYolo, onLoadResults, bar: within(bar) };
}

const rowBox = (name: string) => screen.getByRole("checkbox", { name: `Select ${name} for bulk` }) as HTMLInputElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("YoloBulkBar in AiModelsTab", () => {
  it("Select all honours the default-on 'without results' filter; Deselect all clears; counts follow", () => {
    const { bar } = renderTab();
    expect(bar.getByText("Run doors on 0 selected")).toHaveProperty("disabled", true);
    expect(bar.getByText("Run all (2)")).toBeTruthy(); // p2 already has doors results; p4 is not completed

    fireEvent.click(bar.getByText("Select all"));
    expect(rowBox("Alpha").checked).toBe(true);
    expect(rowBox("Bravo").checked).toBe(false);
    expect(rowBox("Charlie").checked).toBe(true);
    expect(bar.getByText("Run doors on 2 selected")).toHaveProperty("disabled", false);
    expect(bar.getByText("Load doors on 2 selected")).toBeTruthy();

    fireEvent.click(bar.getByRole("checkbox"));  // filter off
    expect(bar.getByText("Run all (3)")).toBeTruthy();
    fireEvent.click(bar.getByText("Select all"));
    expect([rowBox("Alpha"), rowBox("Bravo"), rowBox("Charlie")].every((b) => b.checked)).toBe(true);

    fireEvent.click(bar.getByText("Deselect all"));
    expect([rowBox("Alpha"), rowBox("Bravo"), rowBox("Charlie")].some((b) => b.checked)).toBe(false);
    expect(bar.getByText("Run doors on 0 selected")).toHaveProperty("disabled", true);
  });

  it("row checkboxes toggle the selection, and selection is kept per model", () => {
    const { bar } = renderTab();
    fireEvent.click(rowBox("Charlie"));
    expect(bar.getByText("Run doors on 1 selected")).toBeTruthy();

    fireEvent.change(bar.getByLabelText("Bulk model"), { target: { value: "9" } });
    expect(rowBox("Charlie").checked).toBe(false);
    expect(bar.getByText("Run windows on 0 selected")).toBeTruthy();
    expect(bar.getByText("Run all (3)")).toBeTruthy(); // no windows results anywhere

    fireEvent.change(bar.getByLabelText("Bulk model"), { target: { value: "7" } });
    expect(rowBox("Charlie").checked).toBe(true);
  });

  it("Run all confirms with the page count, starts at most 2 jobs with bulk=true, then auto-loads each", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { bar, onRunYolo, onLoadResults } = renderTab({ yoloStatus: {} });
    fireEvent.click(bar.getByText("Run all (3)"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0][0])).toMatch(/Run doors on 3 projects — 35 pages total/u);
    expect(String(confirmMock.mock.calls[0][0])).toMatch(/Keep this browser tab open/u);
    await flush();
    expect(onRunYolo.mock.calls).toEqual([["p1", 7, true], ["p2", 7, true]]);
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/2 started · 1 waiting · 2 running/u);
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/Keep this tab open/u);
    expect(bar.getByText("Run all (3)")).toHaveProperty("disabled", true);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(onRunYolo.mock.calls.map((c) => c[0])).toEqual(["p1", "p2", "p3"]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/yolo/status?jobName=job-p1"))).toBe(true);
    const terminalWrites = fetchMock.mock.calls.filter(([u, init]) => u === "/api/admin/running-jobs" && init?.method === "PUT");
    expect(terminalWrites.map(([, init]) => JSON.parse(init.body))).toEqual([
      { executionId: "job-p1", status: "Completed" },
      { executionId: "job-p2", status: "Completed" },
      { executionId: "job-p3", status: "Completed" },
    ]);
    expect(onLoadResults.mock.calls).toEqual([["p1", 7, "doors"], ["p2", 7, "doors"], ["p3", 7, "doors"]]);
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/Finished — 3 started · 0 waiting · 3 loaded/u);
  });

  it("cancelling the confirmation starts nothing", async () => {
    confirmMock.mockReturnValue(false);
    const { bar, onRunYolo } = renderTab();
    fireEvent.click(bar.getByText("Run all (2)"));
    await flush();
    expect(onRunYolo).not.toHaveBeenCalled();
    expect(screen.queryByTestId("yolo-bulk-summary")).toBeNull();
  });

  it("Load all loads every candidate one at a time without a confirmation or any run", async () => {
    const { bar, onRunYolo, onLoadResults } = renderTab();
    fireEvent.click(bar.getByText("Load all (2)"));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onRunYolo).not.toHaveBeenCalled();
    expect(onLoadResults.mock.calls).toEqual([["p1", 7, "doors"], ["p3", 7, "doors"]]);
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/Finished — 0 waiting · 2 loaded/u);
  });

  it("Stop queue ends new starts; the summary says running jobs will still finish", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { bar, onRunYolo } = renderTab({ yoloStatus: {} });
    fireEvent.click(bar.getByText("Run all (3)"));
    await flush();
    fireEvent.click(bar.getByText("Stop queue"));
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/stopping: running jobs will finish and load/u);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(onRunYolo.mock.calls.map((c) => c[0])).toEqual(["p1", "p2"]);
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/1 not started \(queue stopped\)/u);
  });

  it("the inference-instance picker is rendered for root only", () => {
    renderTab({ isRootAdmin: false });
    expect(screen.queryByTestId("yolo-instance-picker")).toBeNull();
    cleanup();
    renderTab({ isRootAdmin: true });
    expect(screen.getByTestId("yolo-instance-picker")).toBeTruthy();
  });
});

// A stand-in for the admin page: it OWNS yoloJobs (as page.tsx does) and keeps it across an admin-tab
// switch, which unmounts AiModelsTab only. onRunYolo/onLoadResults write the page's row strings the
// way page.tsx's runYolo(…, bulk=true) / loadYoloResults do.
const pageCtl: {
  setJobs?: (fn: (prev: Record<string, Record<string, string>>) => Record<string, Record<string, string>>) => void;
  setTabShown?: (v: boolean) => void;
} = {};
const onRunYoloPage = vi.fn();
const onLoadPage = vi.fn();

function FakeAdminPage() {
  const [yoloJobs, setJobs] = useState<Record<string, Record<string, string>>>({});
  const [tabShown, setTabShown] = useState(true);
  useEffect(() => {
    pageCtl.setJobs = setJobs;
    pageCtl.setTabShown = setTabShown;
  }, []);
  const row = (projectId: string, modelId: number, text: string) =>
    setJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [String(modelId)]: text } }));
  const onRunYolo = async (projectId: string, modelId: number, bulk?: boolean) => {
    onRunYoloPage(projectId, modelId, bulk);
    const jobName = `job-${projectId}-${onRunYoloPage.mock.calls.length}`;
    row(projectId, modelId, `Running: ${jobName}`);
    return { jobName };
  };
  const onLoadResults = async (projectId: string, modelId: number, modelName: string) => {
    onLoadPage(projectId, modelId, modelName);
    row(projectId, modelId, "Completed — 4 detections loaded");
    return "Completed — 4 detections loaded";
  };
  const noop = () => {};
  if (!tabShown) return null;
  return (
    <AiModelsTab
      yoloModels={[MODELS[0]]}
      projects={PROJECTS}
      yoloJobs={yoloJobs}
      yoloStatus={{}}
      uploading={false}
      uploadProgress={0}
      onUploadModel={noop}
      onDeleteModel={noop}
      onRunYolo={onRunYolo}
      onLoadResults={onLoadResults}
      toggles={{ sagemakerEnabled: true, quotaEnabled: true, hasPassword: false }}
      togglePassword=""
      setTogglePassword={noop}
      toggleError=""
      setToggleError={noop}
      newTogglePass=""
      setNewTogglePass={noop}
      currentTogglePass=""
      setCurrentTogglePass={noop}
      onToggle={noop}
      onSetTogglePassword={noop}
      isRootAdmin={false}
    />
  );
}

const statusByJob = new Map<string, { status: string; failureReason?: string }>();
const bulkBar = () => within(screen.getByTestId("yolo-bulk-bar"));
const runButtonOf = (projectName: string) => {
  const row = rowBox(projectName).closest("div.flex.items-center.justify-between") as HTMLElement;
  return within(row).getByText("Run doors") as HTMLButtonElement;
};
const startedProjects = () => onRunYoloPage.mock.calls.map((c) => c[0]);

describe("YoloBulkBar against a page that owns the row state", () => {
  beforeEach(() => {
    onRunYoloPage.mockReset();
    onLoadPage.mockReset();
    statusByJob.clear();
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/yolo/status")) {
        const jobName = decodeURIComponent(url.split("jobName=")[1] ?? "");
        return { ok: true, json: async () => statusByJob.get(jobName) ?? { status: "InProgress" } };
      }
      return { ok: true, json: async () => ({}) };
    });
  });

  it("skips a row the admin started by hand while it was queued (same mount)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    render(<FakeAdminPage />);
    fireEvent.click(bulkBar().getByText("Run all (3)"));
    await flush();
    expect(startedProjects()).toEqual(["p1", "p2"]);
    act(() => pageCtl.setJobs?.((prev) => ({ ...prev, p3: { "7": "Running: manual-p3" } })));
    statusByJob.set("job-p1-1", { status: "Completed" });
    statusByJob.set("job-p2-2", { status: "Completed" });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(startedProjects()).toEqual(["p1", "p2"]);
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/1 skipped \(already running\)/u);
  });

  it("after an admin-tab switch the queue still sees rows the admin starts by hand (no double start)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    render(<FakeAdminPage />);
    fireEvent.click(bulkBar().getByText("Run all (3)"));
    await flush();
    expect(startedProjects()).toEqual(["p1", "p2"]);
    act(() => pageCtl.setTabShown?.(false)); // switch away: AiModelsTab unmounts, the page and queue live on
    act(() => pageCtl.setTabShown?.(true)); // and back
    act(() => pageCtl.setJobs?.((prev) => ({ ...prev, p3: { "7": "Running: manual-p3" } })));
    statusByJob.set("job-p1-1", { status: "Completed" });
    statusByJob.set("job-p2-2", { status: "Completed" });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(startedProjects()).toEqual(["p1", "p2"]);
  });

  it("a bulk job that ends Failed frees its row: Run is enabled and the next Run all restarts it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    render(<FakeAdminPage />);
    fireEvent.click(rowBox("Alpha"));
    fireEvent.click(bulkBar().getByText("Run doors on 1 selected"));
    await flush();
    expect(startedProjects()).toEqual(["p1"]);
    expect(runButtonOf("Alpha").disabled).toBe(true); // Running
    statusByJob.set("job-p1-1", { status: "Failed", failureReason: "OOM" });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/Finished — 1 started · 0 waiting · 1 failed \(Failed: OOM\)/u);
    expect(runButtonOf("Alpha").disabled).toBe(false);
    expect(screen.getByText("Failed: OOM")).toBeTruthy();

    fireEvent.click(bulkBar().getByText("Run doors on 1 selected"));
    await flush();
    expect(startedProjects()).toEqual(["p1", "p1"]);
    expect(screen.getByTestId("yolo-bulk-summary").textContent).not.toMatch(/skipped/u);
  });

  it("a job the queue gave up on (status unreadable) keeps its row busy until a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fetchMock.mockImplementation(async (url: string) =>
      typeof url === "string" && url.startsWith("/api/yolo/status") ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({}) });
    render(<FakeAdminPage />);
    fireEvent.click(rowBox("Alpha"));
    fireEvent.click(bulkBar().getByText("Run doors on 1 selected"));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(400_000); }); // 30 polls × 10 s
    expect(screen.getByTestId("yolo-bulk-summary").textContent).toMatch(/1 failed \(Status unavailable for job-p1-1/u);
    expect(runButtonOf("Alpha").disabled).toBe(true);
    fireEvent.click(bulkBar().getByText("Run doors on 1 selected"));
    await flush();
    expect(startedProjects()).toEqual(["p1"]); // skipped: the job may still be live on AWS
  });
});

// [2026-10-22] Stage 2 picker (quota > 0 only, live $/h), the timeout setting and the cost estimates
// next to Run all / Run on selected / each per-project Run. Root only.
describe("root: inference picker, timeout and cost estimates", () => {
  const options = (quotas: Record<string, number> | null, maxRuntimeSeconds = 3600, runStats: unknown[] = []) => ({
    instanceType: "ml.g4dn.xlarge",
    valid: true,
    defaultInstanceType: "ml.g4dn.xlarge",
    maxRuntimeSeconds,
    runtimeBounds: { min: 900, max: 86400, default: 3600 },
    catalog: {
      region: "us-east-1",
      checkedAt: "2026-10-22T00:00:00.000Z",
      quotaStatus: quotas ? "live" : "unavailable",
      priceStatus: quotas ? "live" : "approximate",
      priceTableAsOf: "2026-10-21",
      options: YOLO_INSTANCE_OPTIONS.map((o) => ({
        ...o,
        usdPerHour: o.type === "ml.g4dn.xlarge" ? 3.6 : o.usdPerHour,
        priceSource: quotas ? "live" : "table",
        quota: quotas ? (quotas[o.type] ?? 0) : null,
      })),
    },
    runStats,
  });
  const puts: Array<{ url: string; body: unknown }> = [];
  const serve = (payload: unknown) => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.startsWith("/api/admin/yolo-instance/options")) return { ok: true, json: async () => payload };
      if (init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(init.body ?? "null") });
        return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => "{}" };
      }
      return { ok: true, json: async () => ({}) };
    });
  };
  beforeEach(() => {
    puts.length = 0;
    resetYoloOptionsForTests();
  });
  afterEach(() => resetYoloOptionsForTests());

  it("offers only instance types with processing quota > 0 (plus the saved one), each with its $/h", async () => {
    serve(options({ "ml.g5.xlarge": 2, "ml.g6.xlarge": 1 }));
    renderTab({ isRootAdmin: true });
    await flush();
    const select = screen.getByRole("combobox", { name: "Inference instance" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["ml.g4dn.xlarge", "ml.g5.xlarge", "ml.g6.xlarge"]);
    expect(select.options[1].textContent).toMatch(/\$1\.41\/h · quota 2/u);
    expect(screen.getByText(/more compatible GPU types have no processing-job quota/u)).toBeTruthy();
    expect(screen.queryByTestId("yolo-quota-warning")).toBeNull();
  });

  it("quotas unreachable → every compatible type and a 'could not be checked' warning", async () => {
    serve(options(null));
    renderTab({ isRootAdmin: true });
    await flush();
    const select = screen.getByRole("combobox", { name: "Inference instance" }) as HTMLSelectElement;
    expect(select.options).toHaveLength(YOLO_INSTANCE_OPTIONS.length);
    expect(screen.getByTestId("yolo-quota-warning").textContent).toMatch(/could not be checked/u);
    expect(screen.getByText(/Prices are approximate, as of 2026-10-21/u)).toBeTruthy();
  });

  it("the timeout saves through /api/admin/yolo-runtime in seconds", async () => {
    serve(options({ "ml.g4dn.xlarge": 1 }));
    renderTab({ isRootAdmin: true });
    await flush();
    fireEvent.change(screen.getByLabelText("Job timeout (minutes)"), { target: { value: "120" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save timeout"));
    });
    await flush();
    expect(puts).toEqual([{ url: "/api/admin/yolo-runtime", body: { maxRuntimeSeconds: 7200 } }]);
  });

  it("shows ≈$ next to each per-project Run and the bulk estimates, from past runs when there are any", async () => {
    serve(options({ "ml.g4dn.xlarge": 1 }, 3600, [{ modelId: 7, instanceType: "ml.g4dn.xlarge", startupSeconds: 100, secondsPerPage: 10, runs: 5 }]));
    const { bar } = renderTab({ isRootAdmin: true, yoloStatus: {} });
    await flush();
    // Alpha: 100 + 10×10 = 200 s × $3.60/h = $0.20
    const alphaRow = rowBox("Alpha").closest("div.flex.items-center.justify-between") as HTMLElement;
    expect(within(alphaRow).getAllByTestId("yolo-run-cost")[0].textContent).toBe("≈$0.20");
    // all 3: (200) + (100+50) + (100+200) = 650 s → $0.65
    const all = bar.getAllByTestId("yolo-bulk-cost").map((n) => n.textContent ?? "");
    expect(all.find((t) => t.startsWith("Estimate, all 3"))).toMatch(/≈ \$0\.65 · 35 pages · 3 jobs · ml\.g4dn\.xlarge @ \$3\.60\/h · based on 5 past runs/u);
    fireEvent.click(rowBox("Charlie"));
    expect(bar.getAllByTestId("yolo-bulk-cost").map((n) => n.textContent).find((t) => t?.startsWith("Estimate, 1 selected"))).toMatch(/≈ \$0\.30 · 20 pages · 1 job/u);
  });

  it("the Run confirmation carries the estimate", async () => {
    serve(options({ "ml.g4dn.xlarge": 1 }));
    const { bar } = renderTab({ isRootAdmin: true, yoloStatus: {} });
    await flush();
    fireEvent.click(bar.getByText("Run all (3)"));
    expect(String(confirmMock.mock.calls[0][0])).toMatch(/Estimated cost: ≈ \$[0-9.]+ · 35 pages · 3 jobs/u);
  });

  it("non-root admins never load the options and see no estimate", async () => {
    serve(options({ "ml.g4dn.xlarge": 1 }));
    renderTab({ isRootAdmin: false });
    await flush();
    expect(screen.queryAllByTestId("yolo-run-cost")).toEqual([]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/admin/yolo-instance/options"))).toBe(false);
  });
});
