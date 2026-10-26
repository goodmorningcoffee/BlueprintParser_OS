// @vitest-environment jsdom
// [TP-1 WP-1.A K01, fix round] The Keynotes panel names each legend by its region id.
// Before: each card on the "All Keynotes" list found its region with
// `pk.name === kn.tableName || pk.name === "Keynotes"`, and every parser names a legend
// `Keynotes p.N`, so with two legends on one page legend B's card opened, renamed and deleted
// legend A. Every parser now records the id it saved under on the list entry, and the list's
// opener, rename and delete match by that id. Also pins the Compare/Edit opener
// (`loadExistingKeynote`). All text here is synthetic.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import KeynotePanel from "@/components/viewer/KeynotePanel";
import { regionIdFor } from "@/lib/client-persist";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore, type ParsedKeynoteEntry } from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

type Box = [number, number, number, number];
const PUBLIC_ID = "keynote-list-identity";
const PAGE = 4;
const BBOX_A: Box = [0.05, 0.1, 0.3, 0.4];
const BBOX_B: Box = [0.55, 0.1, 0.8, 0.4];
const NAME = `Keynotes p.${PAGE}`;

function legend(id: string, bbox: Box, prefix: string, rows: number) {
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
      rows: Array.from({ length: rows }, (_, i) => ({ Key: String(i + 1), Description: `${prefix} item ${i + 1}` })),
      tagColumn: "Key",
      tableName: NAME,
    },
  };
}

const LEGEND_A = legend("kn-A", BBOX_A, "alpha", 1);
const LEGEND_B = legend("kn-B", BBOX_B, "beta", 2);

function entry(region: typeof LEGEND_A): ParsedKeynoteEntry {
  return {
    pageNumber: PAGE,
    tableName: NAME,
    regionId: region.id,
    keys: region.data.rows.map((row) => ({ key: row.Key, description: row.Description })),
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

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

function seedLegends(): void {
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: { [PAGE]: { parsedRegions: [LEGEND_A, LEGEND_B] } },
  });
}

function cardWith(text: RegExp): HTMLElement {
  return screen.getByText(text).closest(".rounded.border") as HTMLElement;
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
        category: body.overrides.category ?? "keynote-table",
        bbox: body.overrides.bbox,
        confidence: 1,
        csiTags: [],
        data: body.overrides.data,
        source: "user",
      };
      return ok({ ok: true, parsedRegion: region, updatedIntelligence: { parsedRegions: [region] }, summaries: null });
    }
    if (url === `/api/projects/${PUBLIC_ID}/map-tags-batch`) {
      return ok({ results: {}, dropCounts: {}, strictnessMode: "balanced" });
    }
    if (url === "/api/table-parse") {
      return ok({ headers: ["Key", "Description"], rows: [{ Key: "1", Description: "gamma item" }], csiTags: [] });
    }
    if (url === "/api/csi/detect") return ok({ csiTags: [] });
    throw new Error(`unexpected request: ${String(url)}`);
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
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), { ...EMPTY_ACTIVE_PAGE_WINDOW });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
    lines: [],
    words: [
      { text: "K1", confidence: 99, bbox: [0.1, 0.1, 0.1, 0.1] },
      { text: "Gamma", confidence: 99, bbox: [0.55, 0.1, 0.1, 0.1] },
    ],
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

describe("every keynote parser records the region id it saved under", () => {
  async function parsedEntryAndPromote(click: () => void) {
    render(<KeynotePanel embedded />, { wrapper });
    await act(async () => {
      click();
      await flush();
    });
    await waitFor(() => expect(promoteBodies).toHaveLength(1));
    const entries = useParseFlowStore.getState().parsedKeynoteData ?? [];
    expect(entries).toHaveLength(1);
    return { entry: entries[0], promotedId: promoteBodies[0].overrides.regionId as string };
  }

  it("Manual", async () => {
    useParseFlowStore.setState({
      keynoteParseTab: "manual",
      keynoteParseStep: "idle",
      keynoteParseRegion: BBOX_B,
      keynoteColumnBBs: [[0, 0, 0.4, 1], [0.4, 0, 1, 1]],
      keynoteRowBBs: [[0, 0, 1, 1]],
    });
    const { entry: parsed, promotedId } = await parsedEntryAndPromote(() =>
      fireEvent.click(screen.getByRole("button", { name: "Parse Keynotes (1 entries)" })));
    expect(promotedId).toBe(regionIdFor(PAGE, BBOX_B));
    expect(parsed.regionId).toBe(promotedId);
  });

  it("Auto", async () => {
    useParseFlowStore.setState({
      keynoteParseTab: "auto",
      keynoteParseStep: "idle",
      keynoteParseRegion: BBOX_B,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
    });
    const { entry: parsed, promotedId } = await parsedEntryAndPromote(() =>
      fireEvent.click(screen.getByRole("button", { name: "Auto Parse Keynotes" })));
    expect(promotedId).toBe(regionIdFor(PAGE, BBOX_B));
    expect(parsed.regionId).toBe(promotedId);
  });

  it("Guided", async () => {
    useParseFlowStore.setState({
      keynoteParseTab: "guided",
      keynoteParseStep: "idle",
      keynoteParseRegion: BBOX_B,
      guidedParseActive: true,
      guidedParseOwner: "keynote",
      guidedParseRegion: BBOX_B,
      guidedParseRows: [0, 0.5],
      guidedParseCols: [0, 0.4, 1],
    });
    const { entry: parsed, promotedId } = await parsedEntryAndPromote(() =>
      fireEvent.click(screen.getByRole("button", { name: "Parse Keynotes" })));
    expect(promotedId).toBe(regionIdFor(PAGE, BBOX_B));
    expect(parsed.regionId).toBe(promotedId);
  });
});

describe("the All Keynotes list acts on the legend its card names", () => {
  beforeEach(() => {
    seedLegends();
    useParseFlowStore.setState({ keynoteParseTab: "all", parsedKeynoteData: [entry(LEGEND_A), entry(LEGEND_B)] });
  });

  it("View / Edit on legend B opens B's id and rows, not legend A's", () => {
    render(<KeynotePanel embedded />, { wrapper });
    const cardB = cardWith(/2 keys/);
    fireEvent.click(within(cardB).getByRole("button", { name: "▶" }));
    fireEvent.click(within(cardB).getByRole("button", { name: "View / Edit" }));
    const grid = useParseFlowStore.getState().tableParsedGrid;
    expect(grid?.regionId).toBe("kn-B");
    expect(grid?.rows.map((row) => row.Description)).toEqual(["beta item 1", "beta item 2"]);
  });

  it("renaming legend B persists B and leaves legend A and its list entry alone", async () => {
    render(<KeynotePanel embedded />, { wrapper });
    const cardB = cardWith(/2 keys/);
    fireEvent.click(within(cardB).getByTitle("Click to rename, double-click to navigate"));
    const input = within(cardB).getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Second legend" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await flush();
    });

    await waitFor(() => expect(promoteBodies).toHaveLength(1));
    expect(promoteBodies[0].overrides.regionId).toBe("kn-B");
    expect(promoteBodies[0].overrides.data.tableName).toBe("Second legend");
    const entries = useParseFlowStore.getState().parsedKeynoteData ?? [];
    expect(entries.map((kn) => [kn.regionId, kn.tableName])).toEqual([["kn-A", NAME], ["kn-B", "Second legend"]]);
  });

  it("deleting legend B's card removes only B's entry", () => {
    render(<KeynotePanel embedded />, { wrapper });
    fireEvent.click(within(cardWith(/2 keys/)).getByTitle("Delete keynote table"));
    expect((useParseFlowStore.getState().parsedKeynoteData ?? []).map((kn) => kn.regionId)).toEqual(["kn-A"]);
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.parsedRegions).toHaveLength(2);
  });
});

describe("Compare/Edit opener (loadExistingKeynote)", () => {
  it("publishes the clicked legend's id on the grid", () => {
    seedLegends();
    useParseFlowStore.setState({ keynoteParseTab: "compare" });
    render(<KeynotePanel embedded />, { wrapper });
    const buttons = screen.getAllByRole("button", { name: new RegExp(NAME) });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(useParseFlowStore.getState().tableParsedGrid?.regionId).toBe("kn-B");
  });
});
