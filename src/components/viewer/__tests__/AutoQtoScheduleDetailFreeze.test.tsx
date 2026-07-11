// [refactor jul11 P2.2⑦ C1] AutoQto's summary-only schedule row has a third `/pages`
// consumer outside the navigation loader. These component-level pins preserve its matching-region
// decision and error UX while allowing the backing write to flip from Zustand to pagesWindow cache.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import AutoQtoTab from "@/components/viewer/AutoQtoTab";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  readActivePageWindow,
  setPageIntelligenceForPage,
} from "@/queries/usePageWindow";
import { useViewerStore } from "@/stores/viewerStore";
import { seedSummaries } from "@/test/seed-summaries";
import type { ProjectSummaries, QtoWorkflow } from "@/types";

let qc: QueryClient;
const fetchMock = vi.fn();

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

beforeEach(() => {
  qc = new QueryClient();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({
    publicId: "pid",
    isDemo: true,
    pageNames: { 9: "A-009" },
    activeQtoWorkflow: workflow,
  });
  seedActivePageWindow();
  qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [workflow]);
  seedSummaries(qc, summaries);
});

afterEach(() => {
  cleanup();
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
    expect(fetchMock).toHaveBeenCalledWith("/api/demo/projects/pid/pages?from=9&to=9");
    const activeWindow = readActivePageWindow(qc, "pid");
    expect(activeWindow.pageIntelligence[9]).toEqual(serverIntel);
    expect(activeWindow.pageIntelligence[4]).toEqual({ marker: "unrelated-page" });
    expect(activeWindow.loadedRange).toEqual({ from: 1, to: 15 });
  });

  it("uses the authenticated detail route outside demo mode", async () => {
    const serverIntel = matchingPageIntelligence("authenticated");
    useViewerStore.setState({ isDemo: false });
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
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/pid/pages?from=9&to=9");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/demo/projects/pid/pages?from=9&to=9");
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
    expect(fetchMock).toHaveBeenCalledWith("/api/demo/projects/pid/pages?from=9&to=9");
    expect(screen.getByText("Step: select-schedule")).toBeInTheDocument();
  });
});
