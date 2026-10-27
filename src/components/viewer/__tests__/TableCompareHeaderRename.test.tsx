// @vitest-environment jsdom
// [table pipeline WP-2.A] K06 on rename in Compare/Edit: rows are `Record<header, string>`, so a
// rename onto another column's name used to overwrite that column's values while `headers` kept
// both. The modal now gives the renamed column a free name ("X (2)"), so both columns survive.
// EditableGrid is mocked to hand the test its `onHeaderRename`. All text is synthetic.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TableCompareModal from "@/components/viewer/TableCompareModal";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const gridProps: { onHeaderRename?: (colIndex: number, newName: string) => void } = {};
vi.mock("@/components/viewer/EditableGrid", () => ({
  default: (props: { onHeaderRename?: (colIndex: number, newName: string) => void }) => {
    gridProps.onHeaderRename = props.onHeaderRename;
    return <div>grid</div>;
  },
}));

const PUBLIC_ID = "header-rename-project";
const PAGE = 2;

function noopContext(): CanvasRenderingContext2D {
  return new Proxy({ drawImage: () => undefined }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => undefined;
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

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 7, publicId: PUBLIC_ID, isDemo: false, pageNumber: PAGE, numPages: PAGE + 1, pageDrawingNumbers: {},
  });
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), { lines: [], words: [] });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW, pageIntelligence: { [PAGE]: { parsedRegions: [] } },
  });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  gridProps.onHeaderRename = undefined;
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openWith(grid: Record<string, unknown>) {
  useParseFlowStore.setState({ tableParseRegion: [0.1, 0.1, 0.5, 0.5], tableParsedGrid: grid as never });
  useUiStore.setState({ showTableCompareModal: true });
  render(<TableCompareModal pdfDoc={pdfDoc} />, { wrapper });
  await screen.findByText("grid");
  expect(gridProps.onHeaderRename).toBeTypeOf("function");
}

describe("Compare/Edit header rename (K06)", () => {
  it("renaming a column to a name another column has keeps both columns and their values", async () => {
    await openWith({
      headers: ["ZK", "ZA", "ZB"],
      rows: [{ ZK: "Q-1", ZA: "a1", ZB: "b1" }, { ZK: "Q-2", ZA: "a2", ZB: "b2" }],
      tagColumn: "ZK",
      regionId: "r1",
    });
    act(() => gridProps.onHeaderRename!(2, "ZA"));
    const grid = useParseFlowStore.getState().tableParsedGrid!;
    expect(grid.headers).toEqual(["ZK", "ZA", "ZA (2)"]);
    expect(grid.rows).toEqual([{ ZK: "Q-1", ZA: "a1", "ZA (2)": "b1" }, { ZK: "Q-2", ZA: "a2", "ZA (2)": "b2" }]);
    expect(grid.tagColumn).toBe("ZK");
  });

  it("renaming the tag column to a taken name moves tagColumn to the suffixed name", async () => {
    await openWith({ headers: ["ZK", "ZA"], rows: [{ ZK: "Q-1", ZA: "a1" }], tagColumn: "ZK", regionId: "r1" });
    act(() => gridProps.onHeaderRename!(0, "ZA"));
    const grid = useParseFlowStore.getState().tableParsedGrid!;
    expect(grid.headers).toEqual(["ZA (2)", "ZA"]);
    expect(grid.rows).toEqual([{ "ZA (2)": "Q-1", ZA: "a1" }]);
    expect(grid.tagColumn).toBe("ZA (2)");
  });

  it("a free name is used as typed", async () => {
    await openWith({ headers: ["ZK", "ZA"], rows: [{ ZK: "Q-1", ZA: "a1" }], tagColumn: "ZK", regionId: "r1" });
    act(() => gridProps.onHeaderRename!(1, "ZN"));
    expect(useParseFlowStore.getState().tableParsedGrid!.headers).toEqual(["ZK", "ZN"]);
    expect(useParseFlowStore.getState().tableParsedGrid!.rows).toEqual([{ ZK: "Q-1", ZN: "a1" }]);
  });
});
