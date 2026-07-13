// @vitest-environment jsdom
// [refactor jul12 P2.4 A2c] Keynote deferred promotion, map, and Auto-response authority witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import KeynotePanel from "@/components/viewer/KeynotePanel";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { resetKeynoteGuidedParse, resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "keynote-deferred-authority-project";
const PAGE = 6;
const BBOX_A = [0.1, 0.2, 0.7, 0.8] as [number, number, number, number];
const BBOX_B = [0.2, 0.25, 0.8, 0.85] as [number, number, number, number];
const COLS = [
  [0, 0, 0.4, 1],
  [0.4, 0, 1, 1],
] as [number, number, number, number][];
const ROWS = [[0, 0, 1, 1]] as [number, number, number, number][];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function promotionResponse(marker: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      parsedRegion: {},
      updatedIntelligence: { rejectedTextRegionIds: [marker] },
      summaries: null,
    }),
  } as unknown as Response;
}

function mapResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      results: {},
      dropCounts: {},
      strictnessMode: "balanced",
    }),
  } as unknown as Response;
}

function autoResponse(marker: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      headers: ["Key", "Description"],
      rows: [{ Key: marker, Description: `${marker} description` }],
      csiTags: [],
    }),
  } as unknown as Response;
}

function csiResponse(marker: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      csiTags: [{ code: marker, description: `${marker} CSI` }],
    }),
  } as unknown as Response;
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 18; index += 1) await Promise.resolve();
}

let queryClient: QueryClient;
let promotions: Deferred<Response>[];
let maps: Deferred<Response>[];
let autoParses: Deferred<Response>[];
let csiDetections: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedManual(bbox: [number, number, number, number]): void {
  useParseFlowStore.setState({
    keynoteParseTab: "manual",
    keynoteParseStep: "idle",
    keynoteParseRegion: bbox,
    keynoteColumnBBs: COLS.map((entry) => [...entry] as typeof entry),
    keynoteRowBBs: ROWS.map((entry) => [...entry] as typeof entry),
  });
}

function seedAuto(bbox: [number, number, number, number]): void {
  useParseFlowStore.setState({
    keynoteParseTab: "auto",
    keynoteParseStep: "idle",
    keynoteParseRegion: bbox,
    keynoteColumnBBs: [],
    keynoteRowBBs: [],
  });
}

function seedGuided(
  bbox: [number, number, number, number],
  marker: string,
): void {
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
    lines: [],
    words: [
      { text: marker, confidence: 99, bbox: [0.1, 0.1, 0.1, 0.1] },
      { text: `${marker} description`, confidence: 99, bbox: [0.55, 0.1, 0.1, 0.1] },
    ],
  });
  useParseFlowStore.setState({
    keynoteParseTab: "guided",
    keynoteParseStep: "idle",
    keynoteParseRegion: bbox,
    guidedParseActive: true,
    guidedParseOwner: "keynote",
    guidedParseRegion: bbox,
    guidedParseRows: [0, 0.5],
    guidedParseCols: [0, 0.4, 1],
  });
}

function manualParseButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Parse Keynotes (1 entries)" }) as HTMLButtonElement;
}

function autoParseButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Auto Parse Keynotes" }) as HTMLButtonElement;
}

function guidedParseButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Parse Keynotes" }) as HTMLButtonElement;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  promotions = [];
  maps = [];
  autoParses = [];
  csiDetections = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    const request = deferred<Response>();
    if (url === "/api/regions/promote") {
      promotions.push(request);
      return request.promise;
    }
    if (url === `/api/projects/${PUBLIC_ID}/map-tags-batch`) {
      maps.push(request);
      return request.promise;
    }
    if (url === "/api/table-parse") {
      autoParses.push(request);
      return request.promise;
    }
    if (url === "/api/csi/detect") {
      csiDetections.push(request);
      return request.promise;
    }
    throw new Error(`unexpected deferred Keynote request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
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
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
    lines: [],
    words: [
      { text: "K1", confidence: 99, bbox: [0.1, 0.1, 0.1, 0.1] },
      { text: "Door", confidence: 99, bbox: [0.55, 0.1, 0.1, 0.1] },
    ],
  });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  seedManual(BBOX_A);
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2c Keynote deferred promotion and map authority", () => {
  it("denies Guided CSI when peer revocation synchronously hands Keynote to B", () => {
    seedGuided(BBOX_A, "A");
    render(<KeynotePanel embedded />, { wrapper });
    const table = useParseFlowStore.getState().beginParseOperation("table");
    const notes = useParseFlowStore.getState().beginParseOperation("notes");
    expect(table.status).toBe("started");
    expect(notes.status).toBe("started");
    let armed = true;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (
        !armed ||
        !previous.parseOperations.notes.busy ||
        state.parseOperations.notes.busy ||
        !state.parseOperations.keynote.busy
      ) return;
      armed = false;
      state.invalidateParseOperation("keynote");
      const started = useParseFlowStore.getState().beginParseOperation("keynote");
      if (started.status !== "started") throw new Error("peer subscriber could not start B");
      useParseFlowStore.setState({ keynoteParseRegion: BBOX_B });
    });

    try {
      act(() => { guidedParseButton().click(); });
      expect(csiDetections).toHaveLength(0);
      expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);
      expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("captures each Guided grid and drops late A after deferred CSI before promotion/map", async () => {
    seedGuided(BBOX_A, "A");
    render(<KeynotePanel embedded />, { wrapper });
    const table = useParseFlowStore.getState().beginParseOperation("table");
    const notes = useParseFlowStore.getState().beginParseOperation("notes");
    expect(table.status).toBe("started");
    expect(notes.status).toBe("started");

    act(() => { guidedParseButton().click(); });
    expect(csiDetections).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
    expect(useParseFlowStore.getState().parseOperations.notes.busy).toBe(false);

    act(() => {
      resetKeynoteGuidedParse();
      seedGuided(BBOX_B, "B");
    });
    const parseB = await screen.findByRole("button", { name: "Parse Keynotes" });
    act(() => { (parseB as HTMLButtonElement).click(); });
    expect(csiDetections).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.keynote };

    const csiBodies = fetchMock.mock.calls
      .filter(([url]) => url === "/api/csi/detect")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(JSON.stringify(csiBodies[0])).toContain("A");
    expect(JSON.stringify(csiBodies[1])).toContain("B");

    await act(async () => {
      csiDetections[1].resolve(csiResponse("B"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);

    await act(async () => {
      csiDetections[0].resolve(csiResponse("A"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);
    expect(maps).toHaveLength(0);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual(tokenB);
    expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);
    expect(useParseFlowStore.getState().parsedKeynoteData).toEqual([
      expect.objectContaining({
        pageNumber: PAGE,
        keys: [expect.objectContaining({ key: "B" })],
      }),
    ]);

    await act(async () => {
      promotions[0].resolve(promotionResponse("B"));
      await flushCompletion();
    });
    expect(maps).toHaveLength(1);
    await act(async () => {
      maps[0].resolve(mapResponse());
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false));
    expect(useParseFlowStore.getState().keynoteParseRegion).toBeNull();
  });

  it("does not launch Guided promotion when the optimistic Query write hands authority to B", async () => {
    seedGuided(BBOX_A, "A");
    render(<KeynotePanel embedded />, { wrapper });
    let armed = true;
    const activeKey = JSON.stringify(queryKeys.pagesWindow.active(PUBLIC_ID));
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        !armed ||
        event.type !== "updated" ||
        JSON.stringify(event.query.queryKey) !== activeKey
      ) return;
      const window = event.query.state.data as typeof EMPTY_ACTIVE_PAGE_WINDOW | undefined;
      if (!window?.pageIntelligence?.[PAGE]?.parsedRegions?.length) return;
      armed = false;
      useParseFlowStore.getState().invalidateParseOperation("keynote");
      seedGuided(BBOX_B, "B");
    });

    try {
      act(() => { guidedParseButton().click(); });
      expect(csiDetections).toHaveLength(1);
      await act(async () => {
        csiDetections[0].resolve(csiResponse("A"));
        await flushCompletion();
      });

      expect(promotions).toHaveLength(0);
      expect(maps).toHaveLength(0);
      expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);
      expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("lets current B finish its map first and blocks late A map settlement from resetting newer live state", async () => {
    render(<KeynotePanel embedded />, { wrapper });
    act(() => { manualParseButton().click(); });
    expect(promotions).toHaveLength(1);

    await act(async () => {
      promotions[0].resolve(promotionResponse("A"));
      await flushCompletion();
    });
    expect(maps).toHaveLength(1);

    act(() => {
      useParseFlowStore.getState().resetKeynoteParse();
      seedManual(BBOX_B);
    });
    const parseB = await screen.findByRole("button", { name: "Parse Keynotes (1 entries)" });
    act(() => { (parseB as HTMLButtonElement).click(); });
    expect(promotions).toHaveLength(2);

    await act(async () => {
      promotions[1].resolve(promotionResponse("B"));
      await flushCompletion();
    });
    expect(maps).toHaveLength(2);

    await act(async () => {
      maps[1].resolve(mapResponse());
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().keynoteParseRegion).toBeNull());
    expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
    expect(useToolStore.getState().mode).toBe("move");

    act(() => {
      seedManual(BBOX_B);
      useToolStore.getState().setMode("pointer");
    });
    const liveRevision = useParseFlowStore.getState().parseOperations.keynote.revision;

    await act(async () => {
      maps[0].resolve(mapResponse());
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual({
      revision: liveRevision,
      busy: false,
    });
    expect(useToolStore.getState().mode).toBe("pointer");
  });

  it("allows stale A promotion to settle but does not let it launch a map behind current B", async () => {
    render(<KeynotePanel embedded />, { wrapper });
    act(() => { manualParseButton().click(); });

    act(() => {
      useParseFlowStore.getState().resetKeynoteParse();
      seedManual(BBOX_B);
    });
    const parseB = await screen.findByRole("button", { name: "Parse Keynotes (1 entries)" });
    act(() => { (parseB as HTMLButtonElement).click(); });
    expect(promotions).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.keynote };

    await act(async () => {
      promotions[1].resolve(promotionResponse("B"));
      await flushCompletion();
    });
    expect(maps).toHaveLength(1);

    await act(async () => {
      promotions[0].resolve(promotionResponse("A"));
      await flushCompletion();
    });
    expect(maps).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual(tokenB);
    expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);

    await act(async () => {
      maps[0].resolve(mapResponse());
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false));
    expect(useParseFlowStore.getState().keynoteParseRegion).toBeNull();
    expect(useToolStore.getState().mode).toBe("move");
  });

  it("drops a reverse-order stale Auto response before it can append, promote, or map", async () => {
    seedAuto(BBOX_A);
    render(<KeynotePanel embedded />, { wrapper });
    act(() => { autoParseButton().click(); });
    expect(autoParses).toHaveLength(1);

    act(() => {
      useParseFlowStore.getState().resetKeynoteParse();
      seedAuto(BBOX_B);
    });
    const parseB = await screen.findByRole("button", { name: "Auto Parse Keynotes" });
    act(() => { (parseB as HTMLButtonElement).click(); });
    expect(autoParses).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.keynote };

    await act(async () => {
      autoParses[1].resolve(autoResponse("B"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);

    await act(async () => {
      autoParses[0].resolve(autoResponse("A"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);
    expect(maps).toHaveLength(0);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual(tokenB);
    expect(screen.getByText("Auto-parsing keynotes...")).toBeInTheDocument();
    expect(useParseFlowStore.getState().parsedKeynoteData).toEqual([
      expect.objectContaining({
        pageNumber: PAGE,
        keys: [{ key: "B", description: "B description" }],
      }),
    ]);

    await act(async () => {
      promotions[0].resolve(promotionResponse("B"));
      await flushCompletion();
    });
    expect(maps).toHaveLength(1);
    await act(async () => {
      maps[0].resolve(mapResponse());
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false));
    expect(useParseFlowStore.getState().keynoteParseRegion).toBeNull();
  });
});
