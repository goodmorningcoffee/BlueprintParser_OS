// @vitest-environment jsdom
// [refactor jul11 P2.4 C2] Real-component witnesses for the atomic ParsedRegion tail migration.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import KeynoteItem from "@/components/viewer/KeynoteItem";
import KeynotePanel from "@/components/viewer/KeynotePanel";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import {
  clearYoloTagsProject,
  readYoloTags,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { PageIntelligence, ProjectSummaries } from "@/types";

const PUBLIC_ID = "project-A";
const PAGE = 4;
const BBOX = [0.1, 0.2, 0.7, 0.8] as [number, number, number, number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function response(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
  } as unknown as Response;
}

function summaries(marker: string): ProjectSummaries {
  return {
    schedules: [],
    parsedTables: [],
    keynoteTablePages: [],
    notesRegions: [],
    specRegions: [],
    csiPageIndex: {},
    tradePageIndex: {},
    keynotePageIndex: {},
    textAnnotationPageIndex: {},
    pageClassifications: {},
    annotationSummary: {
      modelNames: [],
      categoryCounts: {},
      pageAnnotationCounts: {},
    },
    takeoffTotals: {},
    allTrades: [marker],
    allCsiCodes: [],
  };
}

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedProject(intelligence: PageIntelligence = {}): void {
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: { [PAGE]: intelligence },
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  queryClient.setQueryData(queryKeys.summaries.all(PUBLIC_ID), summaries("prior"));
}

function tracePersistentTail(
  trace: string[],
  serverMarker: string,
): () => void {
  const pageKey = JSON.stringify(queryKeys.pagesWindow.active(PUBLIC_ID));
  const summariesKey = JSON.stringify(queryKeys.summaries.all(PUBLIC_ID));
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const key = JSON.stringify(event.query.queryKey);
    if (key === summariesKey) {
      trace.push("S");
      return;
    }
    if (key !== pageKey) return;
    const intelligence = readPageIntelligence(queryClient, PUBLIC_ID, PAGE);
    if (intelligence?.csiSpatialMap) trace.push("X");
    else if (intelligence?.rejectedTextRegionIds?.includes(serverMarker)) trace.push("A");
    else trace.push("O");
  });
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    pageDrawingNumbers: {},
  });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("C2 ParsedRegion real caller convergence", () => {
  it("publishes Keynote auto-wizard O -> P -> A -> S -> X with no pre-persist spatial write", async () => {
    seedProject();
    setViewerStoreStateForTest({
      keynoteParseTab: "auto",
      keynoteParseRegion: BBOX,
    });
    const serverMarker = "server-wizard";
    const serverRegion = {
      id: "pr-4-100-200-700-800",
      type: "keynote",
      category: "keynote-table",
      bbox: BBOX,
      confidence: 0.98,
      csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
      data: {
        headers: ["Key", "Description"],
        rows: [{ Key: "D1", Description: "Door" }],
        tableName: "Keynotes p.4",
      },
      source: "user",
    };
    const authoritative = {
      rejectedTextRegionIds: [serverMarker],
      // A distinct, differently ordered copy witnesses property-order-independent membership.
      parsedRegions: [{
        source: "user",
        data: {
          tableName: "Keynotes p.4",
          rows: [{ Description: "Door", Key: "D1" }],
          headers: ["Key", "Description"],
        },
        csiTags: [{ description: "Hollow Metal Doors", code: "08 11 13" }],
        confidence: 0.98,
        bbox: BBOX,
        category: "keynote-table",
        type: "keynote",
        id: "pr-4-100-200-700-800",
      } as never],
    } satisfies PageIntelligence;
    const serverSummaries = summaries("wizard-server");
    const promotion = deferred<Response>();
    const trace: string[] = [];

    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/table-parse") {
        return Promise.resolve(response({
          headers: ["Key", "Description"],
          rows: [{ Key: "D1", Description: "Door" }],
          csiTags: [],
        }));
      }
      if (url === "/api/regions/promote") {
        trace.push("P");
        return promotion.promise;
      }
      if (url === `/api/projects/${PUBLIC_ID}/map-tags-batch`) {
        return Promise.resolve(response({
          results: {
            D1: [{
              pageNumber: PAGE,
              annotationId: 41,
              bbox: [0.2, 0.3, 0.25, 0.35],
              confidence: 0.96,
            }],
          },
          dropCounts: {},
          strictnessMode: "balanced",
        }));
      }
      throw new Error(`unexpected Keynote wizard fetch: ${url}`);
    });

    render(<KeynotePanel />, { wrapper });
    const unsubscribe = tracePersistentTail(trace, serverMarker);
    fireEvent.click(screen.getByRole("button", { name: "Auto Parse Keynotes" }));

    await waitFor(() => expect(trace).toEqual(["O", "P"]));
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.csiSpatialMap).toBeUndefined();

    await act(async () => {
      promotion.resolve(response({
        ok: true,
        parsedRegion: serverRegion,
        updatedIntelligence: authoritative,
        summaries: serverSummaries,
      }));
    });
    await waitFor(() => expect(trace).toEqual(["O", "P", "A", "S", "X"]));
    unsubscribe();

    const codes = readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.csiSpatialMap?.zones.flatMap(
      (zone) => zone.divisions.flatMap((division) => division.codes),
    );
    expect(codes).toContain("08 11 13");
    expect(queryClient.getQueryData(queryKeys.summaries.all(PUBLIC_ID))).toEqual(serverSummaries);
    await waitFor(() => expect(readYoloTags(queryClient, PUBLIC_ID)).toHaveLength(1));
    const mapCall = fetchMock.mock.calls.find(([url]) =>
      url === `/api/projects/${PUBLIC_ID}/map-tags-batch`
    );
    if (!mapCall) throw new Error("Expected KeynotePanel map transport call");
    expect(JSON.parse(String((mapCall[1] as RequestInit).body))).toEqual({
      tags: ["D1"],
      itemType: "text-only",
      selectedPages: [PAGE],
    });
    expect(readYoloTags(queryClient, PUBLIC_ID)[0]).toMatchObject({
      tagText: "D1",
      source: "keynote",
      scope: "page",
      pageNumber: PAGE,
      description: "Door",
      instances: [{ annotationId: 41 }],
    });
  });

  it("keeps the Keynote demo wizard on its synchronous local O -> X branch", async () => {
    seedProject();
    setViewerStoreStateForTest({
      isDemo: true,
      keynoteParseTab: "auto",
      keynoteParseRegion: BBOX,
    });
    const trace: string[] = [];
    const nonOkJson = vi.fn().mockRejectedValue(new Error("must not parse"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/table-parse") {
        return Promise.resolve(response({
          headers: ["Key", "Description"],
          rows: [{ Key: "D1", Description: "Door" }],
          csiTags: [{ code: "03 30 00", description: "Cast-in-Place Concrete" }],
        }));
      }
      if (url === `/api/projects/${PUBLIC_ID}/map-tags-batch`) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: nonOkJson,
        } as unknown as Response);
      }
      throw new Error(`unexpected demo wizard fetch: ${url}`);
    });

    render(<KeynotePanel />, { wrapper });
    const pageKey = JSON.stringify(queryKeys.pagesWindow.active(PUBLIC_ID));
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || JSON.stringify(event.query.queryKey) !== pageKey) return;
      if (readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.csiSpatialMap) {
        trace.push("X");
      } else {
        trace.push("O");
        // A local command await would yield here and change O,X,microtask into O,microtask,X.
        queueMicrotask(() => trace.push("microtask"));
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Auto Parse Keynotes" }));

    await waitFor(() => expect(trace).toEqual(["O", "X", "microtask"]));
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      "[KeynotePanel] Map Tags failed: HTTP 503",
    ));
    unsubscribe();
    expect(nonOkJson).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("/api/regions/promote");
    expect(readYoloTags(queryClient, PUBLIC_ID)).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Auto Parse Keynotes" }))
      .not.toBeInTheDocument());
    const codes = readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.csiSpatialMap?.zones.flatMap(
      (zone) => zone.divisions.flatMap((division) => division.codes),
    );
    expect(codes).toContain("03 30 00");
  });

  it("keeps a KeynoteItem optimistic rename before deferred P, then publishes A -> S -> X", async () => {
    const originalRegion = {
      id: "keynote-region",
      type: "keynote",
      category: "Original Keynotes",
      bbox: BBOX,
      confidence: 0.9,
      csiTags: [],
      data: {
        headers: ["Key", "Description"],
        rows: [{ Key: "D1", Description: "Door" }],
        tableName: "Original Keynotes",
      },
    };
    seedProject({ parsedRegions: [originalRegion as never] });
    const serverMarker = "server-edit";
    const authoritativeRegion = {
      ...originalRegion,
      category: "Renamed Keynotes",
      csiTags: [{ code: "09 29 00", description: "Gypsum Board" }],
      data: { ...originalRegion.data, tableName: "Renamed Keynotes" },
    };
    const authoritative = {
      rejectedTextRegionIds: [serverMarker],
      // A distinct, differently ordered copy witnesses property-order-independent membership.
      parsedRegions: [{
        data: {
          tableName: "Renamed Keynotes",
          rows: [{ Description: "Door", Key: "D1" }],
          headers: ["Key", "Description"],
        },
        csiTags: [{ description: "Gypsum Board", code: "09 29 00" }],
        confidence: 0.9,
        bbox: BBOX,
        category: "Renamed Keynotes",
        type: "keynote",
        id: "keynote-region",
      } as never],
    } satisfies PageIntelligence;
    const serverSummaries = summaries("edit-server");
    const promotion = deferred<Response>();
    const trace: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/regions/promote") {
        trace.push("P");
        return promotion.promise;
      }
      throw new Error(`unexpected Keynote edit fetch: ${url}`);
    });

    render(
      <KeynoteItem
        keynote={{
          pageNumber: PAGE,
          tableName: "Original Keynotes",
          keys: [{ key: "D1", description: "Door" }],
        }}
        pageNames={{}}
        isCurrentPage
        onNavigate={vi.fn()}
        activeHighlight={null}
        onHighlight={vi.fn()}
        onDelete={vi.fn()}
        publicId={PUBLIC_ID}
        yoloTags={[]}
      />,
      { wrapper },
    );
    const unsubscribe = tracePersistentTail(trace, serverMarker);

    fireEvent.click(screen.getByText("Original Keynotes"));
    const input = screen.getByDisplayValue("Original Keynotes");
    fireEvent.change(input, { target: { value: "Renamed Keynotes" } });
    fireEvent.blur(input);

    expect(trace).toEqual(["O", "P"]);
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.parsedRegions?.[0].data)
      .toMatchObject({ tableName: "Renamed Keynotes" });
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.csiSpatialMap).toBeUndefined();

    await act(async () => {
      promotion.resolve(response({
        ok: true,
        parsedRegion: authoritativeRegion,
        updatedIntelligence: authoritative,
        summaries: serverSummaries,
      }));
    });
    await waitFor(() => expect(trace).toEqual(["O", "P", "A", "S", "X"]));
    unsubscribe();

    const codes = readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.csiSpatialMap?.zones.flatMap(
      (zone) => zone.divisions.flatMap((division) => division.codes),
    );
    expect(codes).toContain("09 29 00");
    expect(queryClient.getQueryData(queryKeys.summaries.all(PUBLIC_ID))).toEqual(serverSummaries);
  });
});
