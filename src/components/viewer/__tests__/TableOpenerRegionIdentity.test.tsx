// @vitest-environment jsdom
// [TP-1 WP-1.A K01, fix round] The Table panel's openers put the saved region's id on the grid.
// Compare/Edit "Done" refuses a grid without an id, so an opener that drops it turns every Done
// from that opener into a refusal. Pins `loadExistingParsed` (Compare/Edit Cells) and the Auto
// Parse review grid, whose id must equal the one `detectCsiAndPersist` promotes. Synthetic text.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TableParsePanel from "@/components/viewer/TableParsePanel";
import { regionIdFor } from "@/lib/client-persist";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useUiStore } from "@/stores/uiStore";
import { acceptTableParseRegion, resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

type Box = [number, number, number, number];
const PUBLIC_ID = "table-opener-identity";
const PAGE = 4;
const BBOX_A: Box = [0.05, 0.1, 0.45, 0.5];
const BBOX_B: Box = [0.55, 0.1, 0.95, 0.5];

function schedule(id: string, bbox: Box, tag: string) {
  return {
    id,
    type: "schedule" as const,
    category: "door-schedule",
    bbox,
    confidence: 1,
    csiTags: [],
    source: "user",
    data: {
      headers: ["TAG", "SIZE"],
      rows: [{ TAG: tag, SIZE: "S" }],
      tagColumn: "TAG",
      tableName: "Door Schedule",
      rowCount: 1,
      columnCount: 2,
    },
  };
}

let queryClient: QueryClient;
let promoteBodies: Record<string, any>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  promoteBodies = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (url === "/api/regions/promote") {
      const body = JSON.parse(String(init?.body));
      promoteBodies.push(body);
      const region = {
        id: body.overrides.regionId,
        type: body.type,
        category: body.overrides.category ?? "door-schedule",
        bbox: body.overrides.bbox,
        confidence: 1,
        csiTags: [],
        data: body.overrides.data,
        source: "user",
      };
      return ok({ ok: true, parsedRegion: region, updatedIntelligence: { parsedRegions: [region] }, summaries: null });
    }
    if (url === "/api/table-parse") {
      return ok({
        headers: ["TAG", "SIZE"],
        rows: [{ TAG: "D-7", SIZE: "S7" }],
        tagColumn: "TAG",
        methods: [],
        methodResults: [],
        infraErrors: [],
      });
    }
    if (url === "/api/csi/detect") return ok({ csiTags: [] });
    throw new Error(`unexpected request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
  useUiStore.setState({ showTableCompareModal: false });
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    numPages: PAGE,
    pageDrawingNumbers: {},
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: { [PAGE]: { parsedRegions: [schedule("sched-A", BBOX_A, "D-1"), schedule("sched-B", BBOX_B, "D-2")] } },
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), { lines: [], words: [] });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Table openers name the saved region (K01)", () => {
  it("Compare/Edit Cells (loadExistingParsed) publishes the clicked table's id", () => {
    useParseFlowStore.setState({ tableParseTab: "compare" });
    render(<TableParsePanel />, { wrapper });
    const buttons = screen.getAllByRole("button", { name: /Door Schedule/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    const grid = useParseFlowStore.getState().tableParsedGrid;
    expect(grid?.regionId).toBe("sched-B");
    expect(grid?.rows).toEqual([{ TAG: "D-2", SIZE: "S" }]);
  });

  it("the Auto Parse review grid names the id its auto-save promotes", async () => {
    useParseFlowStore.setState({ tableParseTab: "auto" });
    render(<TableParsePanel />, { wrapper });
    const box: Box = [0.2, 0.6, 0.7, 0.9];
    act(() => acceptTableParseRegion([...box] as Box));
    await waitFor(() => expect(screen.getByRole("button", { name: "Process Region" })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Process Region" }));
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });

    await waitFor(() => expect(promoteBodies).toHaveLength(1));
    const promotedId = promoteBodies[0].overrides.regionId;
    expect(promotedId).toBe(regionIdFor(PAGE, box));
    expect(useParseFlowStore.getState().tableParsedGrid?.regionId).toBe(promotedId);
  });
});
