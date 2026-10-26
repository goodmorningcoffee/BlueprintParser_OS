// [TP-1 WP-1.A K11] A summary-only continuation schedule copies its OWN rows into Auto-QTO.
// Before: the region was re-found with `tableName === name || category === category`, so the
// "(CONT.)" entry matched the first same-category table and copied its rows. Synthetic text only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import AutoQtoTab from "@/components/viewer/AutoQtoTab";
import { openProject, type OpenProjectHandle, type ProjectResponse } from "@/lib/project-lifecycle";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedSummaries } from "@/test/seed-summaries";
import type { ProjectSummaries, QtoWorkflow } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { useUiStore } from "@/stores/uiStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
let lifecycleHandle: OpenProjectHandle;
const fetchMock = vi.fn();

const workflow = {
  id: -72,
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

function entry(name: string, regionId: string | undefined) {
  return { pageNum: 9, name, category: "door-schedule", rowCount: 1, colCount: 2, regionId };
}

function summariesWith(parsedTables: ProjectSummaries["parsedTables"]): ProjectSummaries {
  return {
    schedules: [],
    parsedTables,
    keynoteTablePages: [],
    csiPageIndex: {},
    tradePageIndex: {},
    keynotePageIndex: {},
    textAnnotationPageIndex: {},
    pageClassifications: {},
    annotationSummary: { modelNames: [], categoryCounts: {}, pageAnnotationCounts: {} },
    takeoffTotals: {},
    allTrades: [],
    allCsiCodes: [],
  };
}

const SERVER_INTEL = {
  parsedRegions: [
    {
      id: "pr-first",
      type: "schedule",
      category: "door-schedule",
      data: { tableName: "Door Schedule", headers: ["TAG", "SIZE"], rows: [{ TAG: "D-1", SIZE: "S1" }], tagColumn: "TAG" },
    },
    {
      id: "pr-cont",
      type: "schedule",
      category: "door-schedule",
      data: { tableName: "Door Schedule (CONT.)", headers: ["TAG", "SIZE"], rows: [{ TAG: "D-9", SIZE: "S9" }], tagColumn: "TAG" },
    },
  ],
};

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function projectResponse(): ProjectResponse {
  return {
    id: "pid",
    dbId: 1,
    name: "Continuation identity",
    assetBaseUrl: "projects/pid",
    pdfUrl: "https://example.test/pid.pdf",
    numPages: 9,
    status: "completed",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 9, name: "A-009", drawingNumber: null }],
    demoConfig: { autoQto: true },
  };
}

async function open(summaries: ProjectSummaries): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/demo/projects/pid") {
      return { ok: true, json: async () => projectResponse() } as Response;
    }
    if (url === "/api/demo/projects/pid/pages?from=1&to=15") {
      return { ok: true, json: async () => ({ from: 1, to: 9, pages: [], annotations: [] }) } as Response;
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  }));
  lifecycleHandle = openProject(qc, "pid", { demo: true });
  expect((await lifecycleHandle.result).status).toBe("opened");
  vi.stubGlobal("fetch", fetchMock);
  setViewerStoreStateForTest({ pageNames: { 9: "A-009" }, activeQtoWorkflow: workflow });
  qc.setQueryData(queryKeys.pagesWindow.active("pid"), { ...EMPTY_ACTIVE_PAGE_WINDOW });
  qc.setQueryData(queryKeys.qtoWorkflows.all("pid"), [workflow]);
  seedSummaries(qc, summaries);
}

beforeEach(() => {
  qc = new QueryClient();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/demo/projects/pid/pages?from=9&to=9") {
      throw new Error(`unexpected request: ${String(input)}`);
    }
    return {
      ok: true,
      json: async () => ({ from: 9, to: 9, pages: [{ pageNumber: 9, pageIntelligence: SERVER_INTEL }], annotations: [] }),
    } as Response;
  });
  resetProjectData();
});

afterEach(() => {
  cleanup();
  lifecycleHandle.dispose();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function pick(name: RegExp): Promise<NonNullable<QtoWorkflow["parsedSchedule"]>> {
  render(<AutoQtoTab />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() => expect(screen.getByText("Step: confirm-tags")).toBeInTheDocument());
  const schedule = useUiStore.getState().activeQtoWorkflow?.parsedSchedule;
  expect(schedule).toBeTruthy();
  return schedule!;
}

describe("Auto-QTO summary-only schedule identity (K11)", () => {
  it("the (CONT.) entry copies its own rows, not the first same-category table's", async () => {
    await open(summariesWith([
      entry("Door Schedule", "pr-first"),
      entry("Door Schedule (CONT.)", "pr-cont"),
    ]));
    const schedule = await pick(/^Door Schedule \(CONT\.\)/);
    expect(schedule.rows).toEqual([{ TAG: "D-9", SIZE: "S9" }]);
    expect(schedule.tableName).toBe("Door Schedule (CONT.)");
  });

  it("[fix round] two schedules with the SAME name are told apart by the summary's region id", async () => {
    // The page holds two "Door Schedule" regions; the summary names the second. A name match
    // would copy the first one's rows, so only the id path (summary → Source 2 → lookup) passes.
    const twin = { ...SERVER_INTEL.parsedRegions[1], data: { ...SERVER_INTEL.parsedRegions[1].data, tableName: "Door Schedule" } };
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        from: 9, to: 9, annotations: [],
        pages: [{ pageNumber: 9, pageIntelligence: { parsedRegions: [SERVER_INTEL.parsedRegions[0], twin] } }],
      }),
    }) as Response);
    await open(summariesWith([entry("Door Schedule", "pr-cont")]));
    const schedule = await pick(/^Door Schedule/);
    expect(schedule.rows).toEqual([{ TAG: "D-9", SIZE: "S9" }]);
  });

  it("a summary computed before TP-1 (no regionId) still matches by name, not by category", async () => {
    await open(summariesWith([
      entry("Door Schedule", undefined),
      entry("Door Schedule (CONT.)", undefined),
    ]));
    const schedule = await pick(/^Door Schedule \(CONT\.\)/);
    expect(schedule.rows).toEqual([{ TAG: "D-9", SIZE: "S9" }]);
  });
});
