// [refactor jul10 P2.2②] QTO MIGRATION FREEZE NET — backing-agnostic characterization suite.
//
// This suite drives AutoQtoTab through its OWN handlers + the DOM. It is written GREEN against the
// CURRENT (zustand-backed) code, and MUST stay green byte-for-byte after the qtoWorkflows collection
// migrates to the TanStack Query cache (variant b, independent-fetch — P2_DESIGN/QTO_IMPL/
// DESIGN_BRIEF.md). The single sanctioned point of pre/post divergence is `seedQtoWorkflows()`
// below: pre-migration it writes the zustand field; post-migration it writes the query cache.
// Every test body stays identical.
//
// Scope discipline (BRIEF H7): only qto-DATA-driven behavior is frozen here. The schedule-parse
// machinery, "N parsed" badges and suggested-pages read summaries/pageIntelligence (other domains,
// ③/⑥ later) — they are seeded only as far as the preflight gate needs, never asserted on.
//
// Harness gotchas baked in (RECIPE §gotchas): jest-dom matchers imported per file; persistFetch
// module-mocked via importOriginal spread (canPersist keeps its REAL publicId/isDemo logic);
// GET mocks keyed by projectId so remount/refetch under either backing sees consistent rows.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import AutoQtoTab from "../AutoQtoTab";
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import { persistFetch } from "@/lib/client-persist";
import type { QtoWorkflow } from "@/types";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: vi.fn() };
});
const persistFetchMock = vi.mocked(persistFetch);

// ── seedQtoWorkflows: THE sanctioned divergence point ────────────────────────
// POST-migration (the collection lives in the query cache): seed the per-publicId cache entry the
// facade hook reads. (Pre-migration this wrote useViewerStore.setState({ qtoWorkflows: rows });
// flipping this ONE helper body — nothing else in the file — was the entire test-side delta of
// the migration. Demo/failure cases only; non-demo cases seed via the GET mock, SPEC §6.1.)
let qc: QueryClient;
function seedQtoWorkflows(rows: QtoWorkflow[]) {
  qc.setQueryData(queryKeys.qtoWorkflows.all(useViewerStore.getState().publicId), rows);
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
function renderTab() {
  return render(<AutoQtoTab />, { wrapper });
}

// Minimal valid QtoWorkflow row (matches the server's raw drizzle-row superset — extra timestamp
// keys survive untouched because the client applies NO mapper, a frozen property of this domain).
function wf(over: Partial<QtoWorkflow> & { id: number }): QtoWorkflow {
  return {
    projectId: 1,
    materialType: "doors",
    materialLabel: "Doors",
    step: "select-schedule",
    schedulePageNumber: null,
    yoloClassFilter: null,
    itemType: "yolo-with-inner-text",
    tagShapeClass: null,
    parsedSchedule: null,
    lineItems: null,
    userEdits: null,
    exportedAt: null,
    ...over,
  } as QtoWorkflow;
}

// Preflight-satisfying summaries: the strict exclusion classes must have count>0 or the material
// picker hard-blocks (AutoQtoTab computeQtoPreflight). Seeded via the summaries STORE field —
// that's domain ③, still zustand-backed; when ③ migrates, its own recipe flips this seed.
function seedPreflightOk() {
  useViewerStore.setState({
    summaries: {
      annotationSummary: {
        categoryCounts: {
          tables: { count: 3 },
          title_block: { count: 2 },
          drawings: { count: 5 },
        },
      },
    } as never,
  });
}

const fetchMock = vi.fn();
// GET responder keyed by projectId — consistent across remounts/refetches under either backing.
function mockQtoGet(rowsByPublicId: Record<string, QtoWorkflow[] | { status: number }>) {
  fetchMock.mockImplementation((url: string) => {
    const m = /\/api\/qto-workflows\?projectId=([^&]+)/.exec(String(url));
    if (m) {
      const entry = rowsByPublicId[m[1]];
      if (entry && !Array.isArray(entry)) {
        return Promise.resolve({ ok: false, status: entry.status, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => entry ?? [] });
    }
    throw new Error(`unexpected fetch in AutoQtoTab freeze test: ${url}`);
  });
}

// window.alert IS frozen behavior on the create/save failure paths (AutoQtoTab :216/:239);
// jsdom errors "not implemented" if left unstubbed.
const alertMock = vi.fn();

beforeEach(() => {
  // [DETECTOR closer] PURE-DEFAULTS client, matching production (Providers.tsx has no
  // defaultOptions). A test-level retry:false here masked whether the HOOK pins retry itself —
  // the freeze net must run against production-equivalent client defaults.
  qc = new QueryClient();
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({ publicId: "pid", isDemo: false, pageNames: {} });
  seedPreflightOk();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
  fetchMock.mockReset();
  persistFetchMock.mockReset();
  alertMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function prevWorkflowsRegion(): HTMLElement {
  const label = screen.getByText("Previous workflows");
  return label.parentElement as HTMLElement;
}

describe("AutoQtoTab — mount GET populates the workflow list (Q-1)", () => {
  it("non-demo: GETs /api/qto-workflows?projectId=<publicId> and renders rows with step labels", async () => {
    mockQtoGet({ pid: [wf({ id: 1, materialLabel: "Doors", step: "done" }), wf({ id: 2, materialLabel: "Finishes", step: "map-tags" })] });
    renderTab();

    await waitFor(() => expect(screen.getByText("Previous workflows")).toBeInTheDocument());
    const region = prevWorkflowsRegion();
    expect(within(region).getByText("Doors")).toBeInTheDocument();
    expect(within(region).getByText("(completed)")).toBeInTheDocument();
    expect(within(region).getByText("Finishes")).toBeInTheDocument();
    expect(within(region).getByText("(step 3/5)")).toBeInTheDocument();
    // URL pinned; options NOT pinned (the old effect passes an AbortController signal, the query
    // fn may not — that difference is unobservable to the user and unsanctioned to freeze).
    expect(fetchMock.mock.calls[0][0]).toBe("/api/qto-workflows?projectId=pid");
  });
});

describe("AutoQtoTab — non-ok GET clears the list (Q-2)", () => {
  it("a 500 list response empties a previously-seeded list (non-ok → [], frozen)", async () => {
    // [DETECTOR closer] de-vacuated: the 500 is DEFERRED so we can prove the seeded row actually
    // rendered before the clear — the old absence-only assert also passed with a broken seed
    // helper or a full revert (vacuous truth).
    seedQtoWorkflows([wf({ id: 3, materialLabel: "Plumbing" })]);
    let release500!: () => void;
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          if (!/\/api\/qto-workflows\?projectId=/.test(String(url))) {
            throw new Error(`unexpected fetch in AutoQtoTab freeze test: ${url}`);
          }
          release500 = () => resolve({ ok: false, status: 500, json: async () => ({}) });
        }),
    );
    renderTab();

    // seeded row visible while the GET is in flight…
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Plumbing")).toBeInTheDocument());
    release500();
    // …then the non-ok settle clears it
    await waitFor(() => expect(screen.queryByText("Previous workflows")).not.toBeInTheDocument());
  });
});

describe("AutoQtoTab — demo never GETs (Q-3)", () => {
  it("isDemo: no qto fetch fires; a seeded list still renders", async () => {
    useViewerStore.setState({ isDemo: true });
    seedQtoWorkflows([wf({ id: 4, materialLabel: "Equipment", step: "confirm-tags" })]);
    renderTab();

    // list assertions are waitFor-wrapped suite-wide: the zustand backing notifies synchronously
    // but the query-cache backing notifies via microtask (SPEC §3 mixed sync/async edge)
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Equipment")).toBeInTheDocument());
    expect(within(prevWorkflowsRegion()).getByText("(step 2/5)")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoQtoTab — open a previous workflow (Q-4)", () => {
  it("click → active view (label + step header); header ← Back returns to the picker with the list intact", async () => {
    useViewerStore.setState({ isDemo: true }); // demo = no mount fetch; list is purely seeded
    seedQtoWorkflows([wf({ id: 5, materialLabel: "Doors" })]);
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
    expect(screen.getByText(/Step 1: Find & Parse Doors Schedule/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await waitFor(() => expect(screen.getByText("Previous workflows")).toBeInTheDocument());
    expect(screen.getByText("Pick a material to take off")).toBeInTheDocument();
  });
});

describe("AutoQtoTab — create workflow, non-demo (Q-5)", () => {
  it("POSTs via persistFetch, activates the server row, prepends it to the list", async () => {
    mockQtoGet({ pid: [wf({ id: 8, materialLabel: "Finishes", step: "done" })] });
    const serverRow = wf({ id: 42, materialLabel: "Doors" });
    persistFetchMock.mockResolvedValueOnce(serverRow);
    renderTab();
    await waitFor(() => expect(screen.getByText("Previous workflows")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));

    await waitFor(() => expect(screen.getByText("Step: select-schedule")).toBeInTheDocument());
    expect(persistFetchMock).toHaveBeenCalledWith("/api/qto-workflows", {
      projectId: "pid",
      materialType: "doors",
      materialLabel: "Doors",
    });

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await waitFor(() => {
      const rows = within(prevWorkflowsRegion()).getAllByRole("button");
      // prepended: newest first
      expect(rows[0]).toHaveTextContent("Doors");
      expect(rows[1]).toHaveTextContent("Finishes");
    });
  });
});

describe("AutoQtoTab — create workflow, demo (Q-6)", () => {
  it("builds a local temp workflow (no API at all), activates + prepends it", async () => {
    useViewerStore.setState({ isDemo: true });
    seedQtoWorkflows([]);
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));

    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
    expect(persistFetchMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
  });
});

describe("AutoQtoTab — demo temp workflow survives unmount/remount (Q-7)", () => {
  // THE load-bearing persistence pin (BRIEF H3): AutoQtoTab is conditionally mounted
  // (TakeoffPanel:463) and demo temps are client-only. Old backing: zustand persists across the
  // auto-qto sub-tab toggle. New backing: the cache entry + enabled:!isDemo reproduce it. NOTE
  // this SYNCHRONOUS remount does NOT discriminate gcTime values (no GC timer fires without a
  // timer advance) — the actual gcTime:Infinity pin is the hook suite's T-Q9 fake-timer test.
  it("create temp in demo → unmount → remount → temp still listed", async () => {
    useViewerStore.setState({ isDemo: true });
    seedQtoWorkflows([]);
    const view = renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();

    view.unmount(); // sub-tab switched away
    // NOTE deliberately NO reset here — same project, same session, panel toggled.
    // active pointer survives in zustand either way; clear it so the remount shows the picker.
    useViewerStore.setState({ activeQtoWorkflow: null });

    renderTab(); // sub-tab switched back
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoQtoTab — updateWorkflowStep, non-demo (Q-8)", () => {
  it("Done from review: optimistic active+list update, PUT via persistFetch, server row reconciled", async () => {
    const reviewWf = wf({ id: 7, materialLabel: "Plumbing", step: "review", lineItems: [] });
    mockQtoGet({ pid: [reviewWf] });
    persistFetchMock.mockImplementation(async (_url, updates) => ({ ...reviewWf, ...(updates as object) }));
    renderTab();
    await waitFor(() => expect(screen.getByText("Previous workflows")).toBeInTheDocument());

    fireEvent.click(within(prevWorkflowsRegion()).getByText("Plumbing"));
    expect(screen.getByText("Step: review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // optimistic: header flips before/regardless of the PUT settling
    expect(screen.getByText("Step: done")).toBeInTheDocument();
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith(
        "/api/qto-workflows/7",
        expect.objectContaining({ step: "done", exportedAt: expect.any(String) }),
        "PUT",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("(completed)")).toBeInTheDocument());
  });
});

describe("AutoQtoTab — updateWorkflowStep, demo (Q-9)", () => {
  it("Done from review updates the UI locally; NO PUT (demo never writes)", async () => {
    useViewerStore.setState({ isDemo: true });
    seedQtoWorkflows([wf({ id: -99, materialLabel: "Doors", step: "review", lineItems: [] })]);
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.getByText("Step: done")).toBeInTheDocument();
    expect(persistFetchMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("(completed)")).toBeInTheDocument());
  });
});

describe("AutoQtoTab — preflight hard block (Q-10)", () => {
  it("missing strict YOLO classes: warning shown, material buttons disabled, no workflow creatable", async () => {
    useViewerStore.setState({ summaries: { annotationSummary: { categoryCounts: {} } } as never });
    mockQtoGet({ pid: [] });
    renderTab();

    expect(screen.getByText(/Can't run Auto-QTO yet/)).toBeInTheDocument();
    const doors = screen.getByRole("button", { name: /^D ?Doors$/ });
    expect(doors).toBeDisabled();
    fireEvent.click(doors);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoQtoTab — empty GET renders no list section (Q-12)", () => {
  it("GET → [] shows the picker with NO 'Previous workflows' section", async () => {
    mockQtoGet({ pid: [] });
    renderTab();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Pick a material to take off")).toBeInTheDocument();
    expect(screen.queryByText("Previous workflows")).not.toBeInTheDocument();
  });
});

describe("AutoQtoTab — empty publicId never GETs (Q-13)", () => {
  it("publicId '' (pre-load): no qto fetch fires", async () => {
    useViewerStore.setState({ publicId: "" });
    mockQtoGet({});
    renderTab();

    // give a wrong-world effect/query the beat it would need to fire
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoQtoTab — GET network error keeps the shown list (Q-14)", () => {
  it("a rejected GET (vs Q-2's non-ok) leaves previously-seeded rows rendered", async () => {
    // The seed survives here precisely because the GET never settles ok — in both worlds a
    // NETWORK failure leaves the current list alone (old: console.error, list unchanged;
    // new: queryFn throws, cache keeps the seeded entry).
    seedQtoWorkflows([wf({ id: 11, materialLabel: "Electrical" })]);
    fetchMock.mockRejectedValue(new Error("down"));
    renderTab();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Electrical")).toBeInTheDocument());
  });
});

describe("AutoQtoTab — create failure path (Q-15)", () => {
  it("POST rejection: alert 'Failed to create workflow:', stays on picker, list unchanged, buttons re-enabled", async () => {
    mockQtoGet({ pid: [wf({ id: 12, materialLabel: "Finishes" })] });
    persistFetchMock.mockRejectedValueOnce(new Error("quota"));
    renderTab();
    await waitFor(() => expect(screen.getByText("Previous workflows")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));

    await waitFor(() =>
      expect(alertMock).toHaveBeenCalledWith("Failed to create workflow: quota"),
    );
    // still the picker (active never set), list untouched, creating flag reset
    expect(screen.getByText("Pick a material to take off")).toBeInTheDocument();
    expect(within(prevWorkflowsRegion()).getAllByRole("button")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: /^D ?Doors$/ })).not.toBeDisabled());
  });
});

describe("AutoQtoTab — save failure keeps the optimistic update, NO ROLLBACK (Q-16)", () => {
  // THE quirk pin (SPEC §6.3): updateWorkflowStep applies the optimistic active+list update
  // BEFORE the PUT (AutoQtoTab :224-226); the catch only alerts (:237-240). A future tier-2
  // useMutation with onError rollback would pass every other test while changing this behavior.
  it("PUT rejection: alert 'Failed to save workflow:' and the optimistic step change REMAINS", async () => {
    mockQtoGet({ pid: [wf({ id: 13, materialLabel: "Plumbing", step: "review", lineItems: [] })] });
    persistFetchMock.mockRejectedValueOnce(new Error("db down"));
    renderTab();
    await waitFor(() => expect(screen.getByText("Previous workflows")).toBeInTheDocument());

    fireEvent.click(within(prevWorkflowsRegion()).getByText("Plumbing"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to save workflow: db down"));
    // optimistic update NOT rolled back — active header AND the list row both show done
    expect(screen.getByText("Step: done")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("(completed)")).toBeInTheDocument());
  });
});

describe("AutoQtoTab — demo feature gate (Q-17)", () => {
  it("isDemo + demoFeatureConfig {autoQto:false} renders the not-available notice, nothing else", async () => {
    useViewerStore.setState({ isDemo: true, demoFeatureConfig: { autoQto: false } as never });
    renderTab();

    expect(screen.getByText(/Auto-QTO is not available in demo mode/)).toBeInTheDocument();
    expect(screen.queryByText("Pick a material to take off")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoQtoTab — mapping step render-only (Q-18)", () => {
  // Render-level ONLY. Mapping COMPLETION is deliberately untested: the MappingStep effect
  // self-aborts its POST (deps include `mapping`, body calls setMapping(true) — pre-existing
  // bug, probe-confirmed, OWNER-flagged in SPEC §8). Never-resolving fetch = deterministic.
  it("map-tags workflow shows the 'Mapping N tags' spinner", async () => {
    useViewerStore.setState({ isDemo: true });
    const mapWf = wf({
      id: 14,
      materialLabel: "Doors",
      step: "map-tags",
      yoloClassFilter: "door_single",
      parsedSchedule: {
        headers: ["TAG", "SIZE"],
        rows: [{ TAG: "D-101", SIZE: "3070" }, { TAG: "D-102", SIZE: "3070" }],
        tagColumn: "TAG",
        tableName: "DOOR SCHEDULE",
        scheduleCategory: "door-schedule",
        sourcePageNumber: 4,
      },
    });
    seedQtoWorkflows([mapWf]);
    fetchMock.mockImplementation(() => new Promise(() => {})); // POST never settles
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    await waitFor(() => expect(screen.getByText("Mapping 2 tags")).toBeInTheDocument());
  });
});

describe("AutoQtoTab — project switch swaps the visible list (Q-11)", () => {
  // Models the REAL navigation flow (project/[id]/page.tsx load()): resetProjectData → set
  // publicId. The list re-populates from the GET for the new project under EITHER backing
  // (old: effect deps [publicId]; new: key change → fresh query). Final states asserted only.
  it("open A → A's rows; switch to B → B's rows; back to A → A's rows", async () => {
    mockQtoGet({
      A: [wf({ id: 1, materialLabel: "A-only" })],
      B: [wf({ id: 2, materialLabel: "B-only" })],
    });

    function openProject(publicId: string) {
      useViewerStore.getState().resetProjectData();
      useViewerStore.setState({ publicId, isDemo: false });
      seedPreflightOk();
    }

    openProject("A");
    const view = renderTab();
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("A-only")).toBeInTheDocument());

    openProject("B");
    view.rerender(<QueryClientProvider client={qc}><AutoQtoTab /></QueryClientProvider>);
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("B-only")).toBeInTheDocument());
    expect(screen.queryByText("A-only")).not.toBeInTheDocument();

    openProject("A");
    view.rerender(<QueryClientProvider client={qc}><AutoQtoTab /></QueryClientProvider>);
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("A-only")).toBeInTheDocument());
    expect(screen.queryByText("B-only")).not.toBeInTheDocument();
  });
});
