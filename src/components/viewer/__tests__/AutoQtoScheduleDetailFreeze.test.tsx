// [refactor jul11 P2.2⑦ C1] AutoQto's summary-only schedule row has a third `/pages`
// consumer outside the navigation loader. These component-level pins preserve its matching-region
// decision and error UX while allowing the backing write to flip from Zustand to pagesWindow cache.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import AutoQtoTab from "@/components/viewer/AutoQtoTab";
import {
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  readActivePageWindow,
  setPageIntelligenceForPage,
} from "@/queries/usePageWindow";
import { seedSummaries } from "@/test/seed-summaries";
import type { ProjectSummaries, QtoWorkflow } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { useUiStore } from "@/stores/uiStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
let lifecycleHandle: OpenProjectHandle;
const fetchMock = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const workflow: QtoWorkflow = {
  id: -71,
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
} as QtoWorkflow;

const summaries = {
  schedules: [],
  parsedTables: [
    {
      pageNum: 9,
      name: "Door Schedule",
      category: "door-schedule",
      rowCount: 1,
      colCount: 2,
    },
  ],
  keynoteTablePages: [],
  csiPageIndex: {},
  tradePageIndex: {},
  keynotePageIndex: {},
  textAnnotationPageIndex: {},
  pageClassifications: {},
  annotationSummary: {
    modelNames: [],
    categoryCounts: {
      tables: { count: 1, pages: [9] },
      title_block: { count: 1, pages: [9] },
      drawings: { count: 1, pages: [9] },
    },
    pageAnnotationCounts: {},
  },
  takeoffTotals: {},
  allTrades: [],
  allCsiCodes: [],
} satisfies ProjectSummaries;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function matchingPageIntelligence(marker: string) {
  return {
    marker,
    parsedRegions: [
      {
        id: `region-${marker}`,
        type: "schedule",
        category: "door-schedule",
        data: {
          tableName: "Door Schedule",
          headers: ["TAG", "SIZE"],
          rows: [{ TAG: "D-101", SIZE: "3070" }],
          tagColumn: "TAG",
        },
      },
    ],
  };
}

function renderActiveSchedule() {
  return render(<AutoQtoTab />, { wrapper });
}

function seedActivePageWindow(overrides: Partial<ActivePageWindow> = {}) {
  qc.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active("pid"), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    ...overrides,
  });
}

function clickSummarySchedule() {
  fireEvent.click(screen.getByRole("button", { name: /Door Schedule/ }));
}

function expectOwnedDetailRequest(url: string) {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
  expect(call).toBeDefined();
  const signal = (call?.[1] as RequestInit | undefined)?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
}

function projectResponse(demo: boolean): ProjectResponse {
  return {
    id: "pid",
    dbId: 1,
    name: "Schedule detail freeze",
    dataUrl: "projects/pid",
    pdfUrl: "https://example.test/pid.pdf",
    numPages: 9,
    status: "completed",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 9, name: "A-009", drawingNumber: null }],
    demoConfig: demo ? { autoQto: true } : undefined,
  };
}

async function activateScheduleLifecycle(demo: boolean): Promise<void> {
  const bootstrapFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/${demo ? "demo/" : ""}projects/pid`) {
      return { ok: true, json: async () => projectResponse(demo) } as Response;
    }
    if (url === `/api/${demo ? "demo/" : ""}projects/pid/pages?from=1&to=15`) {
      return {
        ok: true,
        json: async () => ({ from: 1, to: 9, pages: [], annotations: [] }),
      } as Response;
    }
    if (!demo && url === "/api/annotation-groups?projectId=pid") {
      return { ok: true, json: async () => ({ groups: [], memberships: [] }) } as Response;
    }
    if (!demo && url === "/api/qto-workflows?projectId=pid") {
      return { ok: true, json: async () => [workflow] } as Response;
    }
    throw new Error(`unexpected schedule lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", bootstrapFetch);
  lifecycleHandle = openProject(qc, "pid", { demo });
  expect((await lifecycleHandle.result).status).toBe("opened");
  vi.stubGlobal("fetch", fetchMock);

  setViewerStoreStateForTest({
    pageNames: { 9: "A-009" },
    activeQtoWorkflow: workflow,
  });
  seedActivePageWindow();
  qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [workflow]);
  seedSummaries(qc, summaries);
}

beforeEach(async () => {
  qc = new QueryClient();
  fetchMock.mockReset();
  resetProjectData();
  await activateScheduleLifecycle(true);
});

afterEach(() => {
  cleanup();
  lifecycleHandle.dispose();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AutoQto schedule detail fallback — P2.2⑦ freeze", () => {
  it("uses matching local parsed-region data without a `/pages` request", async () => {
    setPageIntelligenceForPage(qc, "pid", 9, matchingPageIntelligence("local") as never);
    renderActiveSchedule();

    clickSummarySchedule();

    await waitFor(() => expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PI-present matching miss still fetches the signed-out demo detail route and adopts PI only", async () => {
    const serverIntel = matchingPageIntelligence("server");
    seedActivePageWindow({
      pageIntelligence: {
        9: { marker: "unmatched-local", parsedRegions: [{ category: "window-schedule" }] },
        4: { marker: "unrelated-page" },
      } as never,
      loadedRange: { from: 1, to: 15 },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        from: 9,
        to: 9,
        pages: [{ pageNumber: 9, pageIntelligence: serverIntel }],
        annotations: [{ id: 999 }],
      }),
    } as Response);
    renderActiveSchedule();

    clickSummarySchedule();

    await waitFor(() => expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectOwnedDetailRequest("/api/demo/projects/pid/pages?from=9&to=9");
    const activeWindow = readActivePageWindow(qc, "pid");
    expect(activeWindow.pageIntelligence[9]).toEqual(serverIntel);
    expect(activeWindow.pageIntelligence[4]).toEqual({ marker: "unrelated-page" });
    expect(activeWindow.loadedRange).toEqual({ from: 1, to: 15 });
  });

  it("uses the authenticated detail route outside demo mode", async () => {
    const serverIntel = matchingPageIntelligence("authenticated");
    await activateScheduleLifecycle(false);
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/qto-workflows?projectId=pid") {
        return { ok: true, json: async () => [workflow] } as Response;
      }
      if (url === "/api/projects/pid/pages?from=9&to=9") {
        return {
          ok: true,
          json: async () => ({
            pages: [{ pageNumber: 9, pageIntelligence: serverIntel }],
            annotations: [],
          }),
        } as Response;
      }
      if (url === "/api/qto-workflows/-71") {
        return {
          ok: true,
          json: async () => ({ ...workflow, step: "confirm-tags" }),
        } as Response;
      }
      throw new Error(`unexpected authenticated AutoQto request: ${url}`);
    });
    renderActiveSchedule();

    clickSummarySchedule();

    await waitFor(() => expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument());
    expectOwnedDetailRequest("/api/projects/pid/pages?from=9&to=9");
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url) === "/api/demo/projects/pid/pages?from=9&to=9",
    )).toBe(false);
    expect(readActivePageWindow(qc, "pid").pageIntelligence[9]).toEqual(serverIntel);
  });

  it("adopts truthy PI even when the named region is still absent, then shows the no-data result", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        pages: [{ pageNumber: 9, pageIntelligence: { marker: "adopted-without-match" } }],
        annotations: [],
      }),
    } as Response);
    renderActiveSchedule();

    clickSummarySchedule();

    await waitFor(() =>
      expect(screen.getByText("Could not load schedule data. Try parsing the schedule first.")).toBeInTheDocument(),
    );
    expect(readActivePageWindow(qc, "pid").pageIntelligence[9]).toEqual({
      marker: "adopted-without-match",
    });
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
  });

  it("keeps the existing final no-data UX after an HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    renderActiveSchedule();

    clickSummarySchedule();

    await waitFor(() =>
      expect(screen.getByText("Could not load schedule data. Try parsing the schedule first.")).toBeInTheDocument(),
    );
    expectOwnedDetailRequest("/api/demo/projects/pid/pages?from=9&to=9");
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
  });

  it("Back retires a pending detail operation even if the same workflow object is reopened", async () => {
    const detail = deferred<Response>();
    let detailSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/demo/projects/pid/pages?from=9&to=9") {
        detailSignal = init?.signal ?? undefined;
        return detail.promise;
      }
      throw new Error(`unexpected Back-retirement request: ${url}`);
    });
    renderActiveSchedule();

    clickSummarySchedule();
    await waitFor(() => expect(detailSignal).toBeDefined());
    expect(screen.getByRole("button", { name: /Door Schedule/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(detailSignal?.aborted).toBe(true);
    const previousWorkflows = screen.getByText("Previous workflows").parentElement;
    if (!previousWorkflows) throw new Error("missing previous-workflows region");
    fireEvent.click(within(previousWorkflows).getByRole("button", { name: /Doors/ }));
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Door Schedule/ })).toBeEnabled();

    const winnerIntel = { marker: "winner-after-Back" };
    seedActivePageWindow({ pageIntelligence: { 9: winnerIntel } as never });
    await act(async () => {
      detail.resolve({
        ok: true,
        json: async () => ({
          pages: [{ pageNumber: 9, pageIntelligence: matchingPageIntelligence("abandoned") }],
          annotations: [],
        }),
      } as Response);
      await detail.promise;
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect(readActivePageWindow(qc, "pid").pageIntelligence[9]).toEqual(winnerIntel);
    expect(useUiStore.getState().activeQtoWorkflow).toBe(workflow);
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load schedule data/)).not.toBeInTheDocument();
  });

  it("a newer empty local schedule retires a pending signal-ignoring detail operation", async () => {
    const detail = deferred<Response>();
    let detailSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/demo/projects/pid/pages?from=9&to=9") {
        detailSignal = init?.signal ?? undefined;
        return detail.promise;
      }
      throw new Error(`unexpected new-operation request: ${url}`);
    });
    setViewerStoreStateForTest({
      pageNames: { 8: "A-008", 9: "A-009" },
    });
    seedActivePageWindow({
      pageIntelligence: {
        8: {
          parsedRegions: [
            {
              id: "empty-local-schedule",
              type: "schedule",
              category: "door-schedule-empty",
              data: {
                tableName: "Empty Door Schedule",
                headers: [],
                rows: [],
                tagColumn: "",
              },
            },
          ],
        },
      } as never,
    });
    renderActiveSchedule();

    fireEvent.click(screen.getByRole("button", { name: /^Door Schedule/ }));
    await waitFor(() => expect(detailSignal).toBeDefined());
    expect(detailSignal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Empty Door Schedule/ }));
    expect(detailSignal?.aborted).toBe(true);
    expect(
      screen.getByText("Could not load schedule data. Try parsing the schedule first."),
    ).toBeInTheDocument();

    const winnerIntel = { marker: "winner-after-new-local-operation" };
    setPageIntelligenceForPage(qc, "pid", 9, winnerIntel as never);
    await act(async () => {
      detail.resolve({
        ok: true,
        json: async () => ({
          pages: [{ pageNumber: 9, pageIntelligence: matchingPageIntelligence("abandoned-A") }],
          annotations: [],
        }),
      } as Response);
      await detail.promise;
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect(readActivePageWindow(qc, "pid").pageIntelligence[9]).toEqual(winnerIntel);
    expect(useUiStore.getState().activeQtoWorkflow).toBe(workflow);
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
  });

  it.each([
    { label: "authenticated", successorDemo: false },
    { label: "demo", successorDemo: true },
  ])(
    "an auth detail response cannot adopt PI or advance after a same-id $label successor",
    async ({ successorDemo }) => {
      await activateScheduleLifecycle(false);
      const detail = deferred<Response>();
      let detailSignal: AbortSignal | undefined;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/qto-workflows?projectId=pid") {
          return Promise.resolve({ ok: true, json: async () => [workflow] } as Response);
        }
        if (url === "/api/projects/pid/pages?from=9&to=9") {
          detailSignal = init?.signal ?? undefined;
          return detail.promise;
        }
        throw new Error(`unexpected delayed schedule request: ${url}`);
      });
      renderActiveSchedule();
      clickSummarySchedule();
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) =>
          String(url) === "/api/projects/pid/pages?from=9&to=9",
        )).toBe(true),
      );
      expect(detailSignal).toBeDefined();

      await act(async () => {
        await activateScheduleLifecycle(successorDemo);
      });
      const liveIntel = { marker: `successor-${successorDemo ? "demo" : "auth"}` };
      const liveWorkflow = {
        ...workflow,
        id: successorDemo ? -901 : 901,
        projectId: successorDemo ? 0 : 1,
        materialLabel: successorDemo ? "Demo B" : "Auth B",
        step: "confirm-tags",
      } as QtoWorkflow;
      act(() => {
        seedActivePageWindow({ pageIntelligence: { 9: liveIntel } as never });
        qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [liveWorkflow]);
        setViewerStoreStateForTest({ activeQtoWorkflow: liveWorkflow });
      });

      expect(detailSignal?.aborted).toBe(true);

      await act(async () => {
        detail.resolve({
          ok: true,
          json: async () => ({
            pages: [{ pageNumber: 9, pageIntelligence: matchingPageIntelligence("stale-A") }],
            annotations: [],
          }),
        } as Response);
        await detail.promise;
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      });

      expect(readActivePageWindow(qc, "pid").pageIntelligence[9]).toEqual(liveIntel);
      expect(useUiStore.getState().activeQtoWorkflow).toEqual(liveWorkflow);
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/qto-workflows/-71")).toBe(false);
      expect(screen.queryByText(/Network error while loading schedule/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Could not load schedule data/)).not.toBeInTheDocument();
    },
  );
});
