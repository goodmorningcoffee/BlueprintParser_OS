// @vitest-environment jsdom
// [refactor jul12 P2.4 A2b] TableCompare modal-instance save/close authority witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TableCompareModal from "@/components/viewer/TableCompareModal";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

vi.mock("@/components/viewer/EditableGrid", () => ({
  default: ({
    onCellChange,
    onHeaderRename,
  }: {
    onCellChange: (row: number, column: string, value: string) => void;
    onHeaderRename?: (column: number, value: string) => void;
  }) => (
    <div>
      <button onClick={() => onCellChange(0, "Tag", "B2")}>edit modal cell</button>
      <button onClick={() => onHeaderRename?.(0, "Mark")}>edit modal header</button>
    </div>
  ),
}));

const PUBLIC_ID = "modal-operation-project";
const PAGE = 4;
const BBOX = [0.1, 0.2, 0.8, 0.7] as [number, number, number, number];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function response(ok: boolean, marker: string): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(ok ? {
      ok: true,
      parsedRegion: {},
      updatedIntelligence: { rejectedTextRegionIds: [marker] },
      summaries: null,
    } : { error: { code: "FAIL", message: marker } }),
  } as unknown as Response;
}

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
let pending: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function ModalHarness() {
  const show = useUiStore((state) => state.showTableCompareModal);
  return show ? <TableCompareModal pdfDoc={pdfDoc} /> : <div>modal closed</div>;
}

function seedModal(label: string): void {
  const grid = {
    headers: ["Tag", "Description"],
    rows: [{ Tag: label, Description: `${label} door` }],
    tagColumn: "Tag",
    tableName: `${label} Schedule`,
  };
  useParseFlowStore.setState({ tableParseRegion: BBOX, tableParsedGrid: grid });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: {
      [PAGE]: {
        parsedRegions: [{
          id: `region-${label}`,
          type: "schedule",
          bbox: BBOX,
          csiTags: [],
          data: grid,
        }],
      },
    },
  });
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/regions/promote") {
      throw new Error(`unexpected modal request: ${String(url)}`);
    }
    const request = deferred<Response>();
    pending.push(request);
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    showTableCompareModal: true,
  });
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), { lines: [], words: [] });
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE + 1), { lines: [], words: [] });
  seedModal("A");
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2b TableCompare modal operation authority", () => {
  it("admits only one same-turn Done save", async () => {
    render(<ModalHarness />, { wrapper });
    await screen.findByRole("button", { name: "edit modal cell" });
    const done = screen.getByRole("button", { name: "Done" });
    act(() => {
      (done as HTMLButtonElement).click();
      (done as HTMLButtonElement).click();
    });
    expect(pending).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(true);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("prevents late A from toggling closed or clearing pending modal B", async () => {
    render(<ModalHarness />, { wrapper });
    await screen.findByRole("button", { name: "edit modal cell" });
    act(() => { (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(1);

    // Manual close invalidates A and unmounts that modal instance.
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(screen.getByText("modal closed")).toBeInTheDocument();

    act(() => {
      seedModal("B");
      useUiStore.setState({ showTableCompareModal: true });
    });
    const doneB = await screen.findByRole("button", { name: "Done" });
    await screen.findByRole("button", { name: "edit modal cell" });
    act(() => { (doneB as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.table };

    await act(async () => {
      pending[0].resolve(response(true, "server-A"));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().parseOperations.table).toEqual(tokenB);
    expect(screen.getByRole("heading", { name: /Table Compare/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    await act(async () => {
      pending[1].resolve(response(true, "server-B"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText("modal closed")).toBeInTheDocument());
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
  });

  it("shows a current error, releases admission, and permits retry", async () => {
    render(<ModalHarness />, { wrapper });
    await screen.findByRole("button", { name: "edit modal cell" });
    act(() => { (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).click(); });
    await act(async () => {
      pending[0].resolve(response(false, "modal save boom"));
      await flushCompletion();
    });

    await waitFor(() => expect(screen.getByText("modal save boom")).toBeInTheDocument());
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();

    act(() => { (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(2);
  });

  it("invalidates a pending save on page change and suppresses its late close", async () => {
    render(<ModalHarness />, { wrapper });
    await screen.findByRole("button", { name: "edit modal cell" });
    act(() => { (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).click(); });
    const revision = useParseFlowStore.getState().parseOperations.table.revision;

    act(() => { useViewerCoreStore.setState({ pageNumber: PAGE + 1 }); });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revision + 1,
      busy: false,
    }));

    await act(async () => {
      pending[0].resolve(response(true, "late-page-A"));
      await flushCompletion();
    });
    expect(screen.getByRole("heading", { name: /Table Compare/ })).toBeInTheDocument();
  });

  it("invalidates a pending save when the source grid changes", async () => {
    useParseFlowStore.setState({
      tableParseMeta: {
        baseMethod: "merged",
        mergedSnapshot: {
          headers: ["Tag", "Description"],
          rows: [{ Tag: "A", Description: "A door" }],
          tagColumn: "Tag",
        },
        methodResults: [{
          method: "alternate",
          headers: ["Tag", "Description"],
          rows: [{ Tag: "B", Description: "B door" }],
          confidence: 0.8,
          tagColumn: "Tag",
        }],
      },
    });
    render(<ModalHarness />, { wrapper });
    await screen.findByRole("button", { name: "edit modal cell" });
    act(() => { (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).click(); });
    const revision = useParseFlowStore.getState().parseOperations.table.revision;

    fireEvent.change(screen.getByTitle(/Swap between the auto-merged grid/), {
      target: { value: "alternate" },
    });
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revision + 1,
      busy: false,
    });
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("B");

    await act(async () => {
      pending[0].resolve(response(true, "late-source-A"));
      await flushCompletion();
    });
    expect(screen.getByRole("heading", { name: /Table Compare/ })).toBeInTheDocument();
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("B");
  });

  it("invalidates a pending save when its modal instance unmounts", async () => {
    const view = render(<ModalHarness />, { wrapper });
    await screen.findByRole("button", { name: "edit modal cell" });
    act(() => { (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).click(); });
    const revision = useParseFlowStore.getState().parseOperations.table.revision;

    act(() => view.unmount());
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revision + 1,
      busy: false,
    });
    await act(async () => {
      pending[0].resolve(response(true, "late-unmount-A"));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revision + 1,
      busy: false,
    });
  });

  it.each([
    ["cell", "edit modal cell"],
    ["header", "edit modal header"],
  ])("invalidates a pending save before the %s mutation", async (_label, name) => {
    render(<ModalHarness />, { wrapper });
    await screen.findByRole("button", { name: "edit modal cell" });
    act(() => { (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).click(); });
    const revision = useParseFlowStore.getState().parseOperations.table.revision;

    fireEvent.click(await screen.findByRole("button", { name }));
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revision + 1,
      busy: false,
    });
  });
});
