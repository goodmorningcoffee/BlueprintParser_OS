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
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import AutoQtoTab from "../AutoQtoTab";
import { useUiStore } from "@/stores/uiStore";
import { queryKeys } from "@/queries/queryKeys";
import { persistFetch } from "@/lib/client-persist";
import {
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
// [refactor jul10 P2.2③] summaries seeds now route through the SHARED seedSummaries helper —
// the ③ migration's single test-side flip point (its body moves store→cache; call sites frozen).
import { seedSummaries } from "@/test/seed-summaries";
import type { QtoWorkflow } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { useSessionStore } from "@/stores/sessionStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

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
let lifecycleHandle: OpenProjectHandle;
function seedQtoWorkflows(rows: QtoWorkflow[]) {
  qc.setQueryData(queryKeys.qtoWorkflows.all(useSessionStore.getState().publicId), rows);
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
function renderTab() {
  return render(<AutoQtoTab />, { wrapper });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
// picker hard-blocks (AutoQtoTab computeQtoPreflight). [refactor jul10 P2.2③] Routed through the
// shared seedSummaries helper (domain ③'s sanctioned flip point) — when ③ migrates, ONLY the
// helper body changes (store field → query cache); this file stays byte-identical.
const PREFLIGHT_OK_SUMMARIES = {
  annotationSummary: {
    categoryCounts: {
      tables: { count: 3 },
      title_block: { count: 2 },
      drawings: { count: 5 },
    },
  },
} as never;
function seedPreflightOk() {
  seedSummaries(qc, PREFLIGHT_OK_SUMMARIES);
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

function projectResponse(id: string): ProjectResponse {
  return {
    id,
    dbId: 1,
    name: id,
    assetBaseUrl: `projects/${id}`,
    pdfUrl: `https://example.test/${id}.pdf`,
    numPages: 1,
    status: "completed",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 1, name: "A-101", drawingNumber: null }],
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function activateLifecycle(demo: boolean): Promise<OpenProjectHandle> {
  const id = "pid";
  const bootstrapFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/${demo ? "demo/" : ""}projects/${id}`) {
      return jsonResponse(projectResponse(id));
    }
    if (url === `/api/${demo ? "demo/" : ""}projects/${id}/pages?from=1&to=15`) {
      return jsonResponse({ from: 1, to: 1, pages: [], annotations: [] });
    }
    if (!demo && url === `/api/annotation-groups?projectId=${id}`) {
      return jsonResponse({ groups: [], memberships: [] });
    }
    if (url === `/api/qto-workflows?projectId=${id}`) {
      return jsonResponse([]);
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", bootstrapFetch);
  const handle = openProject(qc, id, { demo });
  expect((await handle.result).status).toBe("opened");
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

async function activateDemoForTest(
  patch: Parameters<typeof setViewerStoreStateForTest>[0] = {},
): Promise<void> {
  lifecycleHandle = await activateLifecycle(true);
  seedPreflightOk();
  setViewerStoreStateForTest(patch);
}

beforeEach(async () => {
  // [DETECTOR closer] PURE-DEFAULTS client, matching production (Providers.tsx has no
  // defaultOptions). A test-level retry:false here masked whether the HOOK pins retry itself —
  // the freeze net must run against production-equivalent client defaults.
  qc = new QueryClient();
  resetProjectData();
  fetchMock.mockReset();
  persistFetchMock.mockReset();
  alertMock.mockReset();
  lifecycleHandle = await activateLifecycle(false);
  seedPreflightOk();
  vi.stubGlobal("alert", alertMock);
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
    await activateDemoForTest();
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
    await activateDemoForTest(); // demo = no mount fetch; list is purely seeded
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
    await activateDemoForTest();
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
    await activateDemoForTest();
    seedQtoWorkflows([]);
    const view = renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();

    view.unmount(); // sub-tab switched away
    // NOTE deliberately NO reset here — same project, same session, panel toggled.
    // active pointer survives in zustand either way; clear it so the remount shows the picker.
    useUiStore.setState({ activeQtoWorkflow: null });

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
    await activateDemoForTest();
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

// Hard-block summaries: empty categoryCounts fails every strict preflight class.
// [refactor jul10 P2.2③] shared between Q-10 and AQT-R; seeded via the shared helper.
const HARD_BLOCK_SUMMARIES = { annotationSummary: { categoryCounts: {} } } as never;

describe("AutoQtoTab — preflight hard block (Q-10)", () => {
  it("missing strict YOLO classes: warning shown, material buttons disabled, no workflow creatable", async () => {
    seedSummaries(qc, HARD_BLOCK_SUMMARIES);
    mockQtoGet({ pid: [] });
    renderTab();

    expect(screen.getByText(/Can't run Auto-QTO yet/)).toBeInTheDocument();
    const doors = screen.getByRole("button", { name: /^D ?Doors$/ });
    expect(doors).toBeDisabled();
    fireEvent.click(doors);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoQtoTab — live summaries write clears the hard block (AQT-R, §2.2③)", () => {
  // [refactor jul10 P2.2③] THE imperative-write→subscribed-read pin for the summaries domain
  // (SPEC §6 AQT-R / §5-S1). The 6 production refresher sites (promote responses) all reduce to
  // one imperative summaries write while a subscriber is mounted — that write form is exactly
  // seedSummaries() here, so this case is backing-agnostic without promote-fetch plumbing.
  // Old backing: zustand notifies synchronously; new backing: RQ notifies via microtask — hence
  // the waitFor reads (sync asserts would false-pass now and flake post-migration).
  it("hard-blocked mount → summaries write → warning clears + material buttons enable", async () => {
    seedSummaries(qc, HARD_BLOCK_SUMMARIES);
    mockQtoGet({ pid: [] });
    renderTab();

    // prove the block actually rendered (de-vacuates the clear assertion below)
    expect(screen.getByText(/Can't run Auto-QTO yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^D ?Doors$/ })).toBeDisabled();

    // the production write form, mid-mount (act: a bare store/cache write outside React events)
    act(() => seedSummaries(qc, PREFLIGHT_OK_SUMMARIES));

    await waitFor(() => expect(screen.queryByText(/Can't run Auto-QTO yet/)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /^D ?Doors$/ })).not.toBeDisabled());
    // still no writes fired — this is a read-side unblock, not a workflow action
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
    // [refactor jul10 P2.2③ closers] across the ③ flip the beforeEach seed lives under "pid", so the empty-publicId key reads null → render is hard-blocked; only the no-fetch assertion is frozen here.
    setViewerStoreStateForTest({ publicId: "" });
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
    await activateDemoForTest({ demoFeatureConfig: { autoQto: false } as never });
    renderTab();

    expect(screen.getByText(/Auto-QTO is not available in demo mode/)).toBeInTheDocument();
    expect(screen.queryByText("Pick a material to take off")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoQtoTab — mapping step render-only (Q-18)", () => {
  // Render-level ONLY: a never-resolving POST keeps the spinner up deterministically. Mapping
  // COMPLETION is now covered by Q-19/Q-20 below (added with the MappingStep self-abort fix,
  // jul10) — this case just pins that the spinner renders while the POST is in flight.
  it("map-tags workflow shows the 'Mapping N tags' spinner", async () => {
    await activateDemoForTest();
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

// [MappingStep self-abort fix jul10] These two cases were IMPOSSIBLE before the fix: the effect
// listed `mapping` in its dep array while the body called setMapping(true), so the effect re-ran on
// its own state write and the returned cleanup aborted the just-dispatched map-tags POST; the
// AbortError was swallowed, so the spinner spun forever and mapping never completed. The freeze
// suite's plain fetch mock IGNORES the abort signal, so a naive resolving mock would false-PASS on
// the buggy code (the aborted promise still resolves). These tests use an ABORT-AWARE mock that
// rejects with an AbortError when the controller aborts — exactly like real fetch — so they are RED
// on the pre-fix code and GREEN after. See AutoQtoTab.tsx MappingStep.
function abortAwareFetch(
  settle: (attempt: number) => { ok: boolean; status?: number; body?: unknown },
) {
  let attempt = 0;
  return vi.fn((_url: string, opts?: RequestInit) =>
    new Promise((resolve, reject) => {
      const signal = opts?.signal;
      const fail = () => {
        const e = new Error("The operation was aborted.");
        e.name = "AbortError";
        reject(e);
      };
      if (signal?.aborted) return fail();
      signal?.addEventListener?.("abort", fail);
      attempt += 1;
      const thisAttempt = attempt;
      // Settle on a macrotask so a same-render-tick abort (the bug) always wins the race and the
      // resolve is suppressed — mirroring real fetch, which rejects an aborted request.
      setTimeout(() => {
        if (signal?.aborted) return;
        const r = settle(thisAttempt);
        resolve({ ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body ?? {} });
      }, 0);
    }),
  );
}

// Q-21 needs a request that remains pending across a deliberately unrelated parent rerender. Q-19
// settles on the next macrotask, so it cannot detect an unstable effect dependency aborting the
// request later. This controller-aware transport exposes that exact cleanup and suppresses a
// success resolution after abort, matching native fetch rather than a promise-only mock.
function controlledAbortAwareFetch(body: unknown) {
  let capturedSignal: AbortSignal | undefined;
  let resolveRequest: (() => void) | null = null;
  const fetch = vi.fn((_url: string, opts?: RequestInit) =>
    new Promise((resolve, reject) => {
      capturedSignal = opts?.signal ?? undefined;
      const fail = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (capturedSignal?.aborted) {
        fail();
        return;
      }
      capturedSignal?.addEventListener("abort", fail, { once: true });
      resolveRequest = () => {
        if (capturedSignal?.aborted) return;
        resolve({ ok: true, status: 200, json: async () => body });
      };
    }),
  );
  return {
    fetch,
    signal: () => capturedSignal,
    resolve: () => {
      if (!resolveRequest) throw new Error("Mapping request has not started");
      resolveRequest();
    },
  };
}

// Q-23 needs individually controlled mapping attempts. Keeping the abort signal and resolver
// per call lets the tests distinguish "the old request was correctly retired" from both dangerous
// alternatives: retaining stale work, or aborting it without dispatching the required replacement.
function controlledAbortAwareFetchSequence() {
  type PendingRequest = {
    url: string;
    opts?: RequestInit;
    signal?: AbortSignal;
    resolve: (body: unknown) => void;
  };
  const requests: PendingRequest[] = [];
  const fetch = vi.fn((url: string, opts?: RequestInit) =>
    new Promise((resolve, reject) => {
      const signal = opts?.signal ?? undefined;
      const fail = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      const request: PendingRequest = {
        url,
        opts,
        signal,
        resolve: (body) => {
          if (signal?.aborted) return;
          resolve({ ok: true, status: 200, json: async () => body });
        },
      };
      requests.push(request);
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
    }),
  );
  const request = (index: number) => {
    const found = requests[index];
    if (!found) throw new Error(`Mapping request ${index + 1} has not started`);
    return found;
  };
  return {
    fetch,
    request,
    resolve: (index: number, body: unknown) => request(index).resolve(body),
  };
}

// One matched YOLO instance per page → isYoloOnly builds a single line item; the review summary
// line "<n> instances of 1 tags across <p> pages" is the completion signal.
function mapWorkflow(id: number) {
  return wf({
    id,
    materialLabel: "Doors",
    step: "map-tags",
    itemType: "yolo-only",
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
}
const MAP_RESULTS = {
  door_single: [
    { pageNumber: 4, bbox: [0, 0, 1, 1], confidence: 1, confidenceTier: "high" },
    { pageNumber: 5, bbox: [0, 0, 1, 1], confidence: 1, confidenceTier: "high" },
  ],
};

describe("AutoQtoTab — mapping completes and advances to review (Q-19)", () => {
  it("POST resolves → line items built → step advances to review (no self-abort)", async () => {
    await activateDemoForTest(); // demo: updateWorkflowStep is local, no PUT
    seedQtoWorkflows([mapWorkflow(15)]);
    vi.stubGlobal("fetch", abortAwareFetch(() => ({ ok: true, body: { results: MAP_RESULTS } })));
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    // Spinner while the POST is in flight...
    await waitFor(() => expect(screen.getByText("Mapping 2 tags")).toBeInTheDocument());
    // ...then completion: the review summary renders and the spinner is gone.
    await waitFor(() => expect(screen.getByText(/instances of 1 tags/)).toBeInTheDocument());
    expect(screen.queryByText("Mapping 2 tags")).not.toBeInTheDocument();
  });
});

describe("AutoQtoTab — unrelated rerender cannot abort active mapping (Q-21)", () => {
  it("page-label publication while POST is pending keeps one request alive through review", async () => {
    await activateDemoForTest();
    seedQtoWorkflows([mapWorkflow(17)]);
    const controlled = controlledAbortAwareFetch({ results: MAP_RESULTS });
    vi.stubGlobal("fetch", controlled.fetch);
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    await waitFor(() => expect(screen.getByText("Mapping 2 tags")).toBeInTheDocument());
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
    expect(controlled.fetch.mock.calls[0][0]).toBe("/api/projects/pid/map-tags-batch");
    expect(JSON.parse(String(controlled.fetch.mock.calls[0][1]?.body))).toEqual({
      tags: ["door_single"],
      yoloClass: "door_single",
      itemType: "yolo-only",
      strictnessMode: "strict",
    });

    // AutoQtoTab reads pageNames, but MappingStep's request inputs are unchanged. For yolo-only
    // workflows `effectiveTags` was rebuilt as a fresh one-element array on this rerender; effect
    // cleanup then aborted the sole request while hasRun blocked a replacement, leaving the spinner
    // forever. The signal assertion gives an immediate, source-discriminating RED failure.
    act(() => useSessionStore.getState().setPageNames({ 1: "Unrelated label update" }));
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
    expect(controlled.signal()).toBeDefined();
    expect(controlled.signal()?.aborted).toBe(false);

    await act(async () => controlled.resolve());
    await waitFor(
      () => expect(screen.getByText(/instances of 1 tags/)).toBeInTheDocument(),
      { timeout: 3_000 },
    );
    expect(screen.queryByText("Mapping 2 tags")).not.toBeInTheDocument();
  });
});

describe("AutoQtoTab — authoritative workflow reconciliation cannot abort mapping (Q-22)", () => {
  it("fresh semantically-equal PUT row keeps the optimistic map POST alive through review", async () => {
    setViewerStoreStateForTest({
      isDemo: false,
      numPages: 5,
      pageNames: { 4: "A-401" },
    });
    const configureWorkflow = mapWorkflow(18);
    configureWorkflow.step = "confirm-tags";
    configureWorkflow.userEdits = {
      quantityOverrides: {},
      selectedPages: [4],
    };

    const controlled = controlledAbortAwareFetch({ results: MAP_RESULTS });
    const network = vi.fn((url: string, opts?: { signal?: AbortSignal }) => {
      if (url === `/api/qto-workflows?projectId=pid`) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [configureWorkflow],
        });
      }
      if (url === `/api/projects/pid/map-tags-batch`) {
        return controlled.fetch(url, opts);
      }
      throw new Error(`unexpected Q-22 fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", network);

    let resolvePut!: () => void;
    persistFetchMock.mockImplementationOnce((_url, updates) =>
      new Promise((resolve) => {
        // A real server JSON round-trip returns fresh nested identities even when every value is
        // semantically identical to the optimistic row installed immediately before this PUT.
        const authoritative = JSON.parse(JSON.stringify({
          ...configureWorkflow,
          ...(updates as object),
          // Not part of mapping identity. Completion must merge onto this latest server row rather
          // than the optimistic render snapshot that originally dispatched the request.
          materialLabel: "Server Doors",
        })) as QtoWorkflow;
        resolvePut = () => resolve(authoritative);
      }),
    );

    renderTab();
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "Run Mapping (count all door_single, 1 pages)",
    }));
    await waitFor(() => expect(screen.getByText("Mapping 2 tags")).toBeInTheDocument());
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
    expect(persistFetchMock).toHaveBeenCalledTimes(1);
    expect(resolvePut).toBeTypeOf("function");

    // Reconciliation replaces both the active workflow and collection row with fresh objects.
    // It must not restart/abort the already-owned semantic mapping request.
    await act(async () => {
      resolvePut();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
    expect(controlled.signal()).toBeDefined();
    expect(controlled.signal()?.aborted).toBe(false);

    await act(async () => controlled.resolve());
    await waitFor(
      () => expect(screen.getByText(/instances of 1 tags/)).toBeInTheDocument(),
      { timeout: 3_000 },
    );
    expect(screen.getByText("Server Doors")).toBeInTheDocument();
    expect(screen.queryByText("Mapping 2 tags")).not.toBeInTheDocument();
  });
});

describe("AutoQtoTab — workflow persistence is serialized through mapping (Q-24)", () => {
  it("keeps review optimistic, waits PUT2 behind PUT1, and sends a cumulative final snapshot", async () => {
    setViewerStoreStateForTest({
      isDemo: false,
      numPages: 5,
      pageNames: { 4: "A-401" },
    });
    const configureWorkflow = mapWorkflow(20);
    configureWorkflow.step = "confirm-tags";
    configureWorkflow.userEdits = {
      quantityOverrides: {},
      selectedPages: [4],
    };

    const controlled = controlledAbortAwareFetchSequence();
    const network = vi.fn((url: string, opts?: RequestInit) => {
      if (url === "/api/qto-workflows?projectId=pid") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [configureWorkflow],
        });
      }
      if (url === "/api/projects/pid/map-tags-batch") {
        return controlled.fetch(url, opts);
      }
      throw new Error(`unexpected Q-24 fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", network);

    type PendingPut = {
      url: string;
      body: Partial<QtoWorkflow>;
      method: string | undefined;
      resolve: (row: QtoWorkflow) => void;
    };
    const puts: PendingPut[] = [];
    persistFetchMock.mockImplementation((url, body, method) =>
      new Promise((resolve) => {
        puts.push({
          url,
          body: body as Partial<QtoWorkflow>,
          method,
          resolve: (row) => resolve(row),
        });
      }),
    );

    renderTab();
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "Run Mapping (count all door_single, 1 pages)",
    }));

    await waitFor(() => {
      expect(screen.getByText("Step: map-tags")).toBeInTheDocument();
      expect(controlled.fetch).toHaveBeenCalledTimes(1);
      expect(puts).toHaveLength(1);
    });
    expect(controlled.request(0).url).toBe("/api/projects/pid/map-tags-batch");
    expect(controlled.request(0).opts).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(controlled.request(0).opts?.body))).toEqual({
      tags: ["door_single"],
      yoloClass: "door_single",
      itemType: "yolo-only",
      selectedPages: [4],
      strictnessMode: "strict",
    });
    expect(puts[0]).toMatchObject({
      url: "/api/qto-workflows/20",
      method: "PUT",
      body: {
        step: "map-tags",
        yoloClassFilter: "door_single",
        itemType: "yolo-only",
        userEdits: { quantityOverrides: {}, selectedPages: [4] },
      },
    });
    expect(puts[0].body).not.toHaveProperty("materialLabel");
    expect(puts[0].body).not.toHaveProperty("schedulePageNumber");

    // Mapping may finish while the configure PUT is pending. Review is published immediately,
    // but the final database write must remain queued so the server can never settle backward.
    await act(async () => {
      controlled.resolve(0, { results: MAP_RESULTS });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText("Step: review")).toBeInTheDocument();
      expect(screen.getByText("2 instances of 1 tags across 2 pages")).toBeInTheDocument();
    });
    expect(puts).toHaveLength(1);
    expect(useUiStore.getState().activeQtoWorkflow?.step).toBe("review");
    expect(
      qc.getQueryData<QtoWorkflow[]>(queryKeys.qtoWorkflows.all("pid"))?.[0],
    ).toMatchObject({ id: 20, step: "review" });

    const put1Row = JSON.parse(JSON.stringify({
      ...configureWorkflow,
      ...puts[0].body,
    })) as QtoWorkflow;
    await act(async () => {
      puts[0].resolve(put1Row);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(puts).toHaveLength(2));
    // The stale server response cannot transiently regress either active UI or the cache while
    // PUT2 is pending. This is the dangerous intermediate point that an eventual-only test misses.
    expect(screen.getByText("Step: review")).toBeInTheDocument();
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().activeQtoWorkflow?.step).toBe("review");
    expect(
      qc.getQueryData<QtoWorkflow[]>(queryKeys.qtoWorkflows.all("pid"))?.[0],
    ).toMatchObject({ id: 20, step: "review", lineItems: expect.any(Array) });

    expect(puts[1]).toMatchObject({
      url: "/api/qto-workflows/20",
      method: "PUT",
      body: {
        step: "review",
        yoloClassFilter: "door_single",
        itemType: "yolo-only",
        tagShapeClass: null,
        userEdits: { quantityOverrides: {}, selectedPages: [4] },
      },
    });
    expect(puts[1].body).not.toHaveProperty("materialLabel");
    expect(puts[1].body).not.toHaveProperty("schedulePageNumber");
    expect(puts[1].body.parsedSchedule).toEqual(configureWorkflow.parsedSchedule);
    expect(puts[1].body.lineItems?.[0]).toMatchObject({
      tag: "door_single",
      autoQuantity: 2,
      pages: [4, 5],
    });

    const put2Row = JSON.parse(JSON.stringify({
      ...configureWorkflow,
      ...puts[1].body,
    })) as QtoWorkflow;
    await act(async () => {
      puts[1].resolve(put2Row);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(persistFetchMock).toHaveBeenCalledTimes(2);
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Step: review")).toBeInTheDocument();
    expect(useUiStore.getState().activeQtoWorkflow).toMatchObject({
      id: 20,
      step: "review",
      yoloClassFilter: "door_single",
    });
    expect(
      qc.getQueryData<QtoWorkflow[]>(queryKeys.qtoWorkflows.all("pid"))?.[0],
    ).toMatchObject({ id: 20, step: "review" });
  });
});

describe("AutoQtoTab — changed mapping inputs replace the owned request (Q-23)", () => {
  it("same workflow id + new YOLO class aborts the old POST and only the replacement reaches review", async () => {
    await activateDemoForTest();
    const original = mapWorkflow(19);
    seedQtoWorkflows([original]);
    const controlled = controlledAbortAwareFetchSequence();
    vi.stubGlobal("fetch", controlled.fetch);
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    await waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(controlled.request(0).opts?.body))).toEqual({
      tags: ["door_single"],
      yoloClass: "door_single",
      itemType: "yolo-only",
      strictnessMode: "strict",
    });
    expect(controlled.request(0).signal?.aborted).toBe(false);

    // This is not reconciliation identity churn: the active row keeps the same durable id but its
    // semantic request input genuinely changes. Publishing both views models an authoritative row
    // update while preserving the active working-draft contract of the facade.
    const changed = JSON.parse(JSON.stringify({
      ...original,
      yoloClassFilter: "window",
    })) as QtoWorkflow;
    act(() => {
      qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [changed]);
      useUiStore.getState().setActiveQtoWorkflow(changed);
    });

    await waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(2));
    expect(controlled.request(0).signal?.aborted).toBe(true);
    expect(controlled.request(1).signal?.aborted).toBe(false);
    expect(JSON.parse(String(controlled.request(1).opts?.body))).toEqual({
      tags: ["window"],
      yoloClass: "window",
      itemType: "yolo-only",
      strictnessMode: "strict",
    });
    expect(screen.getByText("Step: map-tags")).toBeInTheDocument();

    // An aborted native fetch cannot publish its stale result. Exercising its resolver explicitly
    // proves the review transition below is owned by request #2, not a loose promise-only mock.
    await act(async () => {
      controlled.resolve(0, { results: MAP_RESULTS });
      await Promise.resolve();
    });
    expect(screen.getByText("Step: map-tags")).toBeInTheDocument();
    expect(screen.getByText("Mapping 2 tags")).toBeInTheDocument();
    expect(screen.queryByText(/instances of 1 tags/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByText(/operation was aborted/i)).not.toBeInTheDocument();

    await act(async () => {
      controlled.resolve(1, {
        results: {
          window: [
            { pageNumber: 3, bbox: [0.1, 0.2, 0.3, 0.4], confidence: 1, confidenceTier: "high" },
          ],
        },
      });
    });
    await waitFor(() => expect(screen.getByText("Step: review")).toBeInTheDocument());
    expect(screen.getByText("1 instances of 1 tags across 1 pages")).toBeInTheDocument();
    expect(screen.getByText("window")).toBeInTheDocument();
    expect(controlled.fetch).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().activeQtoWorkflow).toMatchObject({
      id: 19,
      step: "review",
      yoloClassFilter: "window",
    });
    expect(useUiStore.getState().activeQtoWorkflow?.lineItems?.[0]?.tag).toBe("window");
  });
});

describe("AutoQtoTab — mapping ownership ends on unmount (Q-25)", () => {
  it("unmount aborts the pending request", async () => {
    await activateDemoForTest();
    seedQtoWorkflows([mapWorkflow(21)]);
    const controlled = controlledAbortAwareFetchSequence();
    vi.stubGlobal("fetch", controlled.fetch);
    const view = renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    await waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(1));
    expect(controlled.request(0).signal?.aborted).toBe(false);

    view.unmount();

    expect(controlled.request(0).signal?.aborted).toBe(true);
  });
});

describe("AutoQtoTab — schedule-backed mapping builds per-tag review rows (Q-26)", () => {
  it("trims schedule tags, preserves row order/specs, and retains an unmatched tag", async () => {
    await activateDemoForTest();
    seedQtoWorkflows([wf({
      id: 22,
      step: "map-tags",
      itemType: "yolo-with-inner-text",
      yoloClassFilter: "door_single",
      parsedSchedule: {
        headers: ["MARK", "WIDTH", "RATING"],
        rows: [
          { MARK: " D-102 ", WIDTH: "4-0", RATING: "90 min" },
          { MARK: "D-101", WIDTH: "3-0", RATING: "20 min" },
        ],
        tagColumn: "MARK",
        tableName: "DOOR SCHEDULE",
        scheduleCategory: "door-schedule",
        sourcePageNumber: 4,
      },
    })]);
    const controlled = controlledAbortAwareFetch({
      results: {
        "D-102": [{
          pageNumber: 5,
          bbox: [0.1, 0.2, 0.3, 0.4],
          confidence: 1,
          confidenceTier: "high",
        }],
      },
    });
    vi.stubGlobal("fetch", controlled.fetch);
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    await waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(1));
    expect(controlled.fetch.mock.calls[0][0]).toBe("/api/projects/pid/map-tags-batch");
    expect(controlled.fetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(controlled.fetch.mock.calls[0][1]?.body))).toEqual({
      tags: ["D-102", "D-101"],
      yoloClass: "door_single",
      itemType: "yolo-with-inner-text",
      strictnessMode: "strict",
    });

    await act(async () => controlled.resolve());
    await waitFor(() => expect(screen.getByText("Step: review")).toBeInTheDocument());

    const active = useUiStore.getState().activeQtoWorkflow;
    expect(active).toMatchObject({ id: 22, step: "review" });
    expect(active?.lineItems).toMatchObject([
      {
        tag: "D-102",
        specs: { WIDTH: "4-0", RATING: "90 min" },
        autoQuantity: 1,
        instances: [{
          pageNumber: 5,
          bbox: [0.1, 0.2, 0.3, 0.4],
          confidence: 1,
          confidenceTier: "high",
        }],
        pages: [5],
        flags: [],
        notes: "",
      },
      {
        tag: "D-101",
        specs: { WIDTH: "3-0", RATING: "20 min" },
        autoQuantity: 0,
        instances: [],
        pages: [],
        flags: ["not-found"],
        notes: "",
      },
    ]);
    expect(active?.lineItems?.[0].specs).not.toHaveProperty("MARK");
    expect(active?.lineItems?.[1].specs).not.toHaveProperty("MARK");
  });
});

describe("AutoQtoTab — Retry re-arms a failed mapping (Q-20)", () => {
  it("first attempt errors → Retry → second attempt completes to review (retryTick pin)", async () => {
    await activateDemoForTest();
    seedQtoWorkflows([mapWorkflow(16)]);
    // attempt 1 → server error (shows Retry); attempt 2 → success
    const retryFetch = abortAwareFetch((n) =>
      n === 1 ? { ok: false, status: 500 } : { ok: true, body: { results: MAP_RESULTS } },
    );
    vi.stubGlobal("fetch", retryFetch);
    renderTab();

    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Doors")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Doors"));
    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
    expect(screen.getByText("Server error 500")).toBeInTheDocument();
    expect(retryFetch).toHaveBeenCalledTimes(1);
    const expectedRequest = {
      tags: ["door_single"],
      yoloClass: "door_single",
      itemType: "yolo-only",
      strictnessMode: "strict",
    };
    expect(retryFetch.mock.calls[0][0]).toBe("/api/projects/pid/map-tags-batch");
    expect(retryFetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(retryFetch.mock.calls[0][1]?.body))).toEqual(expectedRequest);

    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(retryFetch).toHaveBeenCalledTimes(2));
    expect(retryFetch.mock.calls[1][0]).toBe("/api/projects/pid/map-tags-batch");
    expect(retryFetch.mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(retryFetch.mock.calls[1][1]?.body))).toEqual(expectedRequest);
    // Full-suite worker contention can delay the abort-aware zero-timeout mock beyond RTL's 1s
    // default even though the focused case completes immediately. This remains an eventual-state
    // contract, not a latency assertion (the 3s ceiling only removes scheduler flake).
    await waitFor(
      () => expect(screen.getByText(/instances of 1 tags/)).toBeInTheDocument(),
      { timeout: 3_000 },
    );
    expect(retryFetch).toHaveBeenCalledTimes(2);
  });
});

describe("AutoQtoTab — project switch swaps the visible list (Q-11)", () => {
  // Models the final identity/list state under either backing. Production project switches now run
  // through shared openProject, which owns reset, empty seed, activation, and auth-list refetch;
  // this legacy characterization intentionally asserts only final rendered states.
  it("open A → A's rows; switch to B → B's rows; back to A → A's rows", async () => {
    mockQtoGet({
      A: [wf({ id: 1, materialLabel: "A-only" })],
      B: [wf({ id: 2, materialLabel: "B-only" })],
    });

    function openProject(publicId: string) {
      resetProjectData();
      setViewerStoreStateForTest({ publicId, isDemo: false });
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

describe("AutoQtoTab — P2.5 delayed create ownership", () => {
  async function startDelayedAuthenticatedCreate() {
    mockQtoGet({ pid: [] });
    const create = deferred<QtoWorkflow | null>();
    persistFetchMock.mockReturnValueOnce(create.promise);
    renderTab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));
    await waitFor(() => expect(persistFetchMock).toHaveBeenCalledTimes(1));
    return create;
  }

  async function settleCreate(
    create: ReturnType<typeof deferred<QtoWorkflow | null>>,
    workflow: QtoWorkflow,
  ) {
    await act(async () => {
      create.resolve(workflow);
      await create.promise;
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
  }

  async function rejectCreate(
    create: ReturnType<typeof deferred<QtoWorkflow | null>>,
    error: Error,
  ) {
    await act(async () => {
      create.reject(error);
      await create.promise.catch(() => undefined);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
  }

  it("fails closed before authenticated create when the session has no lifecycle authority", async () => {
    lifecycleHandle.dispose();
    mockQtoGet({ pid: [] });
    persistFetchMock.mockReturnValue(new Promise(() => {}));
    renderTab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));

    expect(persistFetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Pick a material to take off")).toBeInTheDocument();
  });

  it("rejects an old click handler when a different lifecycle is current before POST", async () => {
    mockQtoGet({ pid: [] });
    persistFetchMock.mockReturnValue(new Promise(() => {}));
    renderTab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const oldDoorsButton = screen.getByRole("button", { name: /^D ?Doors$/ });

    // Navigation installs lifecycle B and synchronously clears session A before React commits the
    // replacement view. A queued click on the old DOM handler must not write using A's closure.
    const replacementFetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", replacementFetch);
    act(() => {
      lifecycleHandle = openProject(qc, "replacement", { demo: false });
      oldDoorsButton.click();
    });

    expect(persistFetchMock).not.toHaveBeenCalled();
    lifecycleHandle.dispose();
  });

  it("same-publicId reopen rejects the previous generation's delayed POST adoption", async () => {
    const create = await startDelayedAuthenticatedCreate();

    // A real same-id/same-mode lifecycle generation supersedes the captured POST authority even
    // when React can observe the same final session selector values after the reset/adoption batch.
    await act(async () => {
      lifecycleHandle = await activateLifecycle(false);
      seedPreflightOk();
    });
    await waitFor(() =>
      expect(qc.getQueryState(queryKeys.qtoWorkflows.all("pid"))?.fetchStatus).toBe("idle"),
    );
    const liveRows = [wf({ id: 900, materialLabel: "Fresh reopen" })];
    act(() => seedQtoWorkflows(liveRows));

    await settleCreate(create, wf({ id: 41, materialLabel: "Stale auth create" }));

    expect.soft(useUiStore.getState().activeQtoWorkflow).toBeNull();
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual(liveRows);
  });

  it("same-publicId auth -> demo rejects the authenticated generation's delayed POST adoption", async () => {
    const create = await startDelayedAuthenticatedCreate();

    await act(async () => {
      lifecycleHandle = await activateLifecycle(true);
      seedPreflightOk();
    });
    const liveRows = [wf({ id: -900, projectId: 0, materialLabel: "Fresh demo" })];
    act(() => seedQtoWorkflows(liveRows));

    await settleCreate(create, wf({ id: 42, materialLabel: "Stale auth create" }));

    expect.soft(useUiStore.getState().activeQtoWorkflow).toBeNull();
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual(liveRows);
  });

  it("same-publicId successor restores create liveness when stale POST settles", async () => {
    const staleCreate = await startDelayedAuthenticatedCreate();
    expect(screen.getByRole("button", { name: /^D ?Doors$/ })).toBeDisabled();

    // Model a batched same-id/same-mode successor: B installs a new lifecycle generation, while
    // the subscribed session selectors finish the batch with A's same publicId/mode values. The
    // pageNames change forces a render that captures B without giving [publicId,isDemo] effects a
    // dependency change. B starts no create of its own, so its picker must become live again.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    act(() => {
      lifecycleHandle = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        pageNames: { 1: "Successor generation B" },
      });
      seedPreflightOk();
    });

    await settleCreate(staleCreate, wf({ id: 43, materialLabel: "Stale auth create" }));

    expect(useUiStore.getState().activeQtoWorkflow).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^D ?Doors$/ })).not.toBeDisabled(),
    );
  });

  it("same-publicId successor suppresses a rejected POST's error and finally publications", async () => {
    const staleCreate = await startDelayedAuthenticatedCreate();

    // Same-id/same-mode B must retire A's local `creating` ownership even though both session
    // selectors finish with identical values. Start a B create after that reset and leave it
    // pending: A's eventual `finally` must not re-enable B's material buttons.
    await act(async () => {
      lifecycleHandle = await activateLifecycle(false);
      seedPreflightOk();
    });
    await waitFor(() =>
      expect(qc.getQueryState(queryKeys.qtoWorkflows.all("pid"))?.fetchStatus).toBe("idle"),
    );
    const liveRows = [wf({ id: 906, materialLabel: "Successor row" })];
    act(() => seedQtoWorkflows(liveRows));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^F ?Finishes$/ })).not.toBeDisabled(),
    );

    const successorCreate = deferred<QtoWorkflow | null>();
    persistFetchMock.mockReturnValueOnce(successorCreate.promise);
    fireEvent.click(screen.getByRole("button", { name: /^F ?Finishes$/ }));
    await waitFor(() => expect(persistFetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /^F ?Finishes$/ })).toBeDisabled();

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    alertMock.mockClear();
    await rejectCreate(staleCreate, new Error("late stale create failure"));

    expect(consoleError).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeQtoWorkflow).toBeNull();
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual(liveRows);
    // B still owns the in-flight create. A's stale finally cannot publish `creating=false`.
    expect(screen.getByRole("button", { name: /^F ?Finishes$/ })).toBeDisabled();
  });

  it("stops a demo create when its active-pointer write synchronously opens a successor", async () => {
    await activateDemoForTest();
    seedQtoWorkflows([]);
    renderTab();

    const live = wf({ id: 705, materialLabel: "Auth successor" });
    let startedSuccessor = false;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const unsubscribe = useUiStore.subscribe((state) => {
      if (!startedSuccessor && (state.activeQtoWorkflow?.id ?? 0) < 0) {
        startedSuccessor = true;
        lifecycleHandle = openProject(qc, "pid", { demo: false });
        qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [live]);
        useUiStore.setState({ activeQtoWorkflow: live });
      }
    });

    try {
      fireEvent.click(screen.getByRole("button", { name: /^D ?Doors$/ }));

      expect(startedSuccessor).toBe(true);
      expect(useUiStore.getState().activeQtoWorkflow).toEqual(live);
      expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([live]);
      expect(persistFetchMock).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      lifecycleHandle.dispose();
    }
  });
});

describe("AutoQtoTab — P2.5 render-bound workflow selection ownership", () => {
  it("an old same-id demo list button cannot install its private workflow into the successor", async () => {
    await activateDemoForTest();
    const privateA = wf({ id: -801, projectId: 0, materialLabel: "Private A" });
    seedQtoWorkflows([privateA]);
    renderTab();
    const oldPrivateButton = await screen.findByRole("button", { name: /Private A/ });

    const successorRows = [wf({ id: -802, projectId: 0, materialLabel: "Demo B" })];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    act(() => {
      lifecycleHandle = openProject(qc, "pid", { demo: true });
      seedPreflightOk();
      qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), successorRows);
      useUiStore.setState({ activeQtoWorkflow: null });
      // Click while React still has A's delegated handler installed. B's lifecycle record and
      // successor state are already synchronous, but the replacement commit is still batched.
      oldPrivateButton.click();
    });

    expect(useUiStore.getState().activeQtoWorkflow).toBeNull();
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual(successorRows);
  });

  it("an old same-id Back button cannot clear the successor's active workflow", async () => {
    await activateDemoForTest();
    const privateA = wf({ id: -803, projectId: 0, materialLabel: "Private A" });
    seedQtoWorkflows([privateA]);
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /Private A/ }));
    const oldBackButton = screen.getByRole("button", { name: "← Back" });

    const liveB = wf({ id: -804, projectId: 0, materialLabel: "Demo B", step: "confirm-tags" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    act(() => {
      lifecycleHandle = openProject(qc, "pid", { demo: true });
      seedPreflightOk();
      qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [liveB]);
      useUiStore.setState({ activeQtoWorkflow: liveB });
      oldBackButton.click();
    });

    expect(useUiStore.getState().activeQtoWorkflow).toEqual(liveB);
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([liveB]);
  });

  it("an old same-id Done handler cannot borrow the authenticated successor for a PUT", async () => {
    const reviewA = wf({ id: 805, materialLabel: "Auth A", step: "review", lineItems: [] });
    mockQtoGet({ pid: [reviewA] });
    persistFetchMock.mockReturnValue(new Promise(() => {}));
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /Auth A/ }));
    const oldDoneButton = screen.getByRole("button", { name: "Done" });

    const liveB = wf({ id: 805, materialLabel: "Auth B", step: "confirm-tags" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    act(() => {
      lifecycleHandle = openProject(qc, "pid", { demo: false });
      qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [liveB]);
      useUiStore.setState({ activeQtoWorkflow: liveB });
      oldDoneButton.click();
    });

    expect(persistFetchMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeQtoWorkflow).toEqual(liveB);
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([liveB]);
  });
});

describe("AutoQtoTab — P2.5 delayed update ownership", () => {
  async function startDelayedAuthenticatedUpdate(id: number, label: string) {
    const source = wf({ id, materialLabel: label, step: "review", lineItems: [] });
    const save = deferred<QtoWorkflow | null>();
    mockQtoGet({ pid: [source] });
    persistFetchMock.mockReturnValueOnce(save.promise).mockResolvedValue(null);
    renderTab();
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText(label)).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText(label));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(persistFetchMock).toHaveBeenCalledTimes(1));
    return { save, source };
  }

  async function installSameIdSuccessor(demo: boolean, live: QtoWorkflow) {
    await act(async () => {
      lifecycleHandle = await activateLifecycle(demo);
      seedPreflightOk();
    });
    if (!demo) {
      await waitFor(() =>
        expect(qc.getQueryState(queryKeys.qtoWorkflows.all("pid"))?.fetchStatus).toBe("idle"),
      );
    }
    act(() => {
      seedQtoWorkflows([live]);
      useUiStore.setState({ activeQtoWorkflow: live });
    });
  }

  async function settleDelayedUpdate(
    save: ReturnType<typeof deferred<QtoWorkflow | null>>,
    serverRow: QtoWorkflow,
  ) {
    await act(async () => {
      save.resolve(serverRow);
      await save.promise;
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
  }

  async function rejectDelayedUpdate(
    save: ReturnType<typeof deferred<QtoWorkflow | null>>,
    error: Error,
  ) {
    await act(async () => {
      save.reject(error);
      await save.promise.catch(() => undefined);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
  }

  it("same-publicId auth -> demo suppresses the old PUT's active and cache reconciliation", async () => {
    const { save, source } = await startDelayedAuthenticatedUpdate(701, "Auth A");
    const live = wf({ id: 701, projectId: 0, materialLabel: "Demo B", step: "confirm-tags" });
    await installSameIdSuccessor(true, live);

    await settleDelayedUpdate(save, { ...source, materialLabel: "Stale auth response", step: "done" });

    expect(useUiStore.getState().activeQtoWorkflow).toEqual(live);
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([live]);
  });

  it("same-publicId auth -> auth suppresses the old PUT's active and cache reconciliation", async () => {
    const { save, source } = await startDelayedAuthenticatedUpdate(702, "Auth generation A");
    const live = wf({ id: 702, materialLabel: "Auth generation B", step: "confirm-tags" });
    await installSameIdSuccessor(false, live);

    await settleDelayedUpdate(save, { ...source, materialLabel: "Stale auth response", step: "done" });

    expect(useUiStore.getState().activeQtoWorkflow).toEqual(live);
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([live]);
  });

  it("same-publicId successor suppresses a rejected PUT's stale error publication", async () => {
    const { save } = await startDelayedAuthenticatedUpdate(707, "Rejected generation A");
    const live = wf({ id: 707, materialLabel: "Live generation B", step: "confirm-tags" });
    await installSameIdSuccessor(false, live);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    alertMock.mockClear();
    await rejectDelayedUpdate(save, new Error("late stale update failure"));

    expect(consoleError).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeQtoWorkflow).toEqual(live);
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([live]);
    expect(screen.getByText("Live generation B")).toBeInTheDocument();
    expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument();
  });

  it("rechecks lifecycle authority before dispatching a write queued behind an older PUT", async () => {
    const { save, source } = await startDelayedAuthenticatedUpdate(703, "Queued A");

    // Done is PUT1. Back is optimistically published but its PUT2 must wait behind PUT1.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument());
    expect(persistFetchMock).toHaveBeenCalledTimes(1);

    const live = wf({ id: 703, materialLabel: "Successor B", step: "select-schedule" });
    await installSameIdSuccessor(false, live);
    await settleDelayedUpdate(save, { ...source, materialLabel: "Stale PUT1", step: "done" });

    // A generation-blind queued closure would dispatch PUT2 as soon as PUT1 releases its tail.
    expect(persistFetchMock).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().activeQtoWorkflow).toEqual(live);
    expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([live]);
  });

  it("stops a demo update when its active-pointer write synchronously opens a successor", async () => {
    await activateDemoForTest();
    const source = wf({ id: -704, projectId: 0, materialLabel: "Demo A", step: "review", lineItems: [] });
    const live = wf({ id: -704, materialLabel: "Auth B", step: "confirm-tags" });
    seedQtoWorkflows([source]);
    renderTab();
    await waitFor(() => expect(within(prevWorkflowsRegion()).getByText("Demo A")).toBeInTheDocument());
    fireEvent.click(within(prevWorkflowsRegion()).getByText("Demo A"));

    let startedSuccessor = false;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const unsubscribe = useUiStore.subscribe((state) => {
      if (!startedSuccessor && state.activeQtoWorkflow?.step === "done") {
        startedSuccessor = true;
        lifecycleHandle = openProject(qc, "pid", { demo: false });
        qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [live]);
        useUiStore.setState({ activeQtoWorkflow: live });
      }
    });

    try {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      expect(startedSuccessor).toBe(true);
      expect(useUiStore.getState().activeQtoWorkflow).toEqual(live);
      expect(qc.getQueryData(queryKeys.qtoWorkflows.all("pid"))).toEqual([live]);
      expect(persistFetchMock).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      lifecycleHandle.dispose();
    }
  });
});
