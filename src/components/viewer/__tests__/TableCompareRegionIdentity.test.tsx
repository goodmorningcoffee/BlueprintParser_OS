// @vitest-environment jsdom
// [TP-1 WP-1.A K01] Compare/Edit "Done" writes the region its opener named, and only that one.
// Before: Done picked the first schedule/keynote region on the page with equal headers OR equal
// row count, so editing keynote legend B overwrote legend A (both read ["Key","Description"]),
// and an unmatched grid was written locally and closed as if saved. All text here is synthetic.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import KeynoteItem from "@/components/viewer/KeynoteItem";
import ParsedTableItem from "@/components/viewer/ParsedTableItem";
import TableCompareModal from "@/components/viewer/TableCompareModal";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

vi.mock("@/components/viewer/EditableGrid", () => ({
  default: () => <div>grid</div>,
}));

const PUBLIC_ID = "region-identity-project";
const PAGE = 4;
const BBOX_A = [0.05, 0.1, 0.3, 0.4] as [number, number, number, number];
const BBOX_B = [0.55, 0.1, 0.8, 0.4] as [number, number, number, number];

function legend(id: string, bbox: typeof BBOX_A, prefix: string) {
  return {
    id,
    type: "keynote" as const,
    category: "keynote-table",
    bbox,
    confidence: 1,
    csiTags: [],
    source: "user",
    data: {
      headers: ["Key", "Description"],
      rows: [
        { Key: "1", Description: `${prefix} first item` },
        { Key: "2", Description: `${prefix} second item` },
      ],
      tagColumn: "Key",
      tableName: "Keynotes",
    },
  };
}

const LEGEND_A = legend("kn-A", BBOX_A, "alpha");
const LEGEND_B = legend("kn-B", BBOX_B, "beta");

function noopContext(): CanvasRenderingContext2D {
  return new Proxy({ drawImage: () => undefined }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => undefined;
    },
    set(target, property, value) {
      Reflect.set(target, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const pdfDoc = {
  getPage: vi.fn(async () => ({
    getViewport: () => ({ width: 100, height: 100 }),
    render: () => ({ promise: Promise.resolve() }),
  })),
} as never;

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function ModalHarness() {
  const show = useUiStore((state) => state.showTableCompareModal);
  return show ? <TableCompareModal pdfDoc={pdfDoc} /> : <div>modal closed</div>;
}

function promoteResponse(region: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      parsedRegion: region,
      updatedIntelligence: { parsedRegions: [LEGEND_A, region] },
      summaries: null,
    }),
  } as unknown as Response;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    numPages: PAGE + 1,
    pageDrawingNumbers: {},
  });
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), { lines: [], words: [] });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: { [PAGE]: { parsedRegions: [LEGEND_A, LEGEND_B] } },
  });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openModalWith(grid: Record<string, unknown>, bbox: typeof BBOX_A) {
  useParseFlowStore.setState({ tableParseRegion: bbox, tableParsedGrid: grid as never });
  useUiStore.setState({ showTableCompareModal: true });
}

describe("Compare/Edit Done writes only the named region (K01)", () => {
  it("KeynoteItem View/Edit on legend B names B's id on the grid", () => {
    render(
      <KeynoteItem
        keynote={{ pageNumber: PAGE, tableName: "Keynotes", keys: [{ key: "1", description: "beta" }] }}
        pageNames={{}}
        isCurrentPage
        onNavigate={vi.fn()}
        activeHighlight={null}
        onHighlight={vi.fn()}
        onDelete={vi.fn()}
        region={LEGEND_B}
        publicId={PUBLIC_ID}
        yoloTags={[]}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "▶" }));
    fireEvent.click(screen.getByRole("button", { name: "View / Edit" }));
    expect(useParseFlowStore.getState().tableParsedGrid?.regionId).toBe("kn-B");
    expect(useUiStore.getState().showTableCompareModal).toBe(true);
  });

  it("ParsedTableItem View/Edit names the retained region's id on the grid", () => {
    render(
      <ParsedTableItem
        table={{
          pageNum: PAGE,
          region: { ...LEGEND_B, id: "schedule-B", type: "schedule" },
          name: "Schedule B",
          category: "schedule",
          rowCount: 2,
          colCount: 2,
          csiTags: [],
        }}
        pageNames={{}}
        isCurrentPage
        onNavigate={vi.fn()}
        yoloTags={[]}
        pageNumber={PAGE}
        publicId={PUBLIC_ID}
        isDemo={false}
        cellStructureOperation={{
          detect: vi.fn(), clear: vi.fn(), loadingKey: null, busy: false, errorKey: null, error: null,
        }}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "▶" }));
    fireEvent.click(screen.getByRole("button", { name: "View / Edit" }));
    expect(useParseFlowStore.getState().tableParsedGrid?.regionId).toBe("schedule-B");
  });

  it("editing legend B saves B's id and never touches legend A", async () => {
    const editedB = {
      ...LEGEND_B.data,
      rows: [{ Key: "1", Description: "beta edited" }, { Key: "2", Description: "beta second item" }],
      regionId: "kn-B",
    };
    const { regionId: _gridOnly, ...savedB } = editedB;
    fetchMock.mockImplementation(async () => promoteResponse({ ...LEGEND_B, data: savedB }));
    openModalWith(editedB, BBOX_B);
    render(<ModalHarness />, { wrapper });
    await screen.findByText("grid");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/regions/promote");
    const body = JSON.parse(String(init.body));
    expect(body.type).toBe("keynote");
    expect(body.overrides.regionId).toBe("kn-B");
    expect(body.overrides.bbox).toEqual(BBOX_B);
    expect(body.overrides.data.rows[0].Description).toBe("beta edited");
    expect(body.overrides.data).not.toHaveProperty("regionId");
    const regions = readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.parsedRegions as never[];
    expect(regions.find((r: { id: string }) => r.id === "kn-A")).toEqual(LEGEND_A);
    await waitFor(() => expect(screen.getByText("modal closed")).toBeInTheDocument());
  });

  it("[fix round] the Keynotes list entry of legend A keeps its keys when legend B is edited", async () => {
    const keysOf = (prefix: string) => [{ key: "1", description: `${prefix} first item` }, { key: "2", description: `${prefix} second item` }];
    useParseFlowStore.setState({
      parsedKeynoteData: [
        { pageNumber: PAGE, tableName: "Keynotes", regionId: "kn-A", keys: keysOf("alpha") },
        { pageNumber: PAGE, tableName: "Keynotes", regionId: "kn-B", keys: keysOf("beta") },
      ],
    });
    const editedB = { ...LEGEND_B.data, rows: [{ Key: "1", Description: "beta edited" }], regionId: "kn-B" };
    fetchMock.mockImplementation(async () => promoteResponse({ ...LEGEND_B, data: { ...LEGEND_B.data, rows: editedB.rows } }));
    openModalWith(editedB, BBOX_B);
    render(<ModalHarness />, { wrapper });
    await screen.findByText("grid");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await flush();
    });

    const entries = useParseFlowStore.getState().parsedKeynoteData ?? [];
    expect(entries[0].keys).toEqual(keysOf("alpha"));
    expect(entries[1].keys.map((k) => k.description)).toEqual(["beta edited"]);
  });

  it("[fix round] a matched region without a bbox is refused, not closed as saved", async () => {
    const { bbox: _dropped, ...noBox } = LEGEND_B;
    queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
      ...EMPTY_ACTIVE_PAGE_WINDOW,
      pageIntelligence: { [PAGE]: { parsedRegions: [LEGEND_A, noBox] } },
    });
    openModalWith({ ...LEGEND_B.data, regionId: "kn-B" }, BBOX_B);
    const before = readPageIntelligence(queryClient, PUBLIC_ID, PAGE);
    render(<ModalHarness />, { wrapper });
    await screen.findByText("grid");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await flush();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)).toBe(before);
    expect(screen.getByText(/no saved position/)).toBeInTheDocument();
    expect(useUiStore.getState().showTableCompareModal).toBe(true);
  });

  it("a grid with no region id shows an error and writes nothing", async () => {
    openModalWith({ ...LEGEND_B.data }, BBOX_B);
    const before = readPageIntelligence(queryClient, PUBLIC_ID, PAGE);
    render(<ModalHarness />, { wrapper });
    await screen.findByText("grid");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await flush();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)).toBe(before);
    expect(screen.getByText(/not linked to a saved table/)).toBeInTheDocument();
    expect(useUiStore.getState().showTableCompareModal).toBe(true);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
  });

  it("a region id that is not on the page shows an error and writes nothing", async () => {
    openModalWith({ ...LEGEND_B.data, regionId: "kn-gone" }, BBOX_B);
    const before = readPageIntelligence(queryClient, PUBLIC_ID, PAGE);
    render(<ModalHarness />, { wrapper });
    await screen.findByText("grid");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await flush();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)).toBe(before);
    expect(screen.getByText(/not saved on this page/)).toBeInTheDocument();
  });
});
