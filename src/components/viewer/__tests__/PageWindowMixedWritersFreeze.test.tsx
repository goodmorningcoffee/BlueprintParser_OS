// [refactor jul11 P2.2⑦ C3] Call-site freezes for the mixed writer batch. These tests use the
// public page-window facade rather than store fixtures so deleting Zustand ownership cannot make
// them pass accidentally while production handlers keep stale read/write semantics.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import NotesClassifier from "@/components/viewer/NotesClassifier";
import TableParsePanel from "@/components/viewer/TableParsePanel";
import { useShapeParseInteraction } from "@/hooks/useShapeParseInteraction";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  appendKeynotesForPage,
  readActivePageWindow,
  readPageIntelligence,
  setPageIntelligenceForPage,
} from "@/queries/usePageWindow";
import { useViewerStore } from "@/stores/viewerStore";
import type {
  ClientAnnotation,
  KeynoteShapeData,
  PageIntelligence,
  TextAnnotation,
  TextRegion,
} from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const tableSaveHarness = vi.hoisted(() => ({
  delayedGrid: {
    headers: ["Tag", "Description"],
    rows: [{ Tag: "A-101", Description: "Project A door" }],
    tagColumn: "Tag",
    tableName: "Project A Schedule",
    csiTags: [] as { code: string; description: string }[],
  },
}));

// Drive TableParsePanel through its real orchestration callback without mounting the large parser
// child. The grid already has CSI tags, so this isolates the local append path from CSI networking.
vi.mock("@/components/viewer/AutoParseTab", () => ({
  default: ({ detectCsiAndPersist }: { detectCsiAndPersist: (grid: unknown, opts: unknown) => Promise<void> }) => (
    <>
      <button
        onClick={() => void detectCsiAndPersist({
          headers: ["Tag", "Description"],
          rows: [{ Tag: "D1", Description: "Door" }],
          tagColumn: "Tag",
          tableName: "Door Schedule",
          csiTags: [{ code: "08 10 00", description: "Doors" }],
        }, { resetAfter: false })}
      >
        save local table
      </button>
      <button
        onClick={() => void detectCsiAndPersist(tableSaveHarness.delayedGrid, { resetAfter: false })}
      >
        save table after CSI
      </button>
    </>
  ),
}));

let qc: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seedWindow(publicId: string, overrides: Partial<ActivePageWindow> = {}): void {
  qc.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active(publicId), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    ...overrides,
  });
  qc.setQueryData(queryKeys.annotations.all(publicId), []);
}

const noteRegion = {
  id: "note-region",
  type: "notes-numbered",
  bbox: [0.1, 0.1, 0.3, 0.2],
  confidence: 0.9,
  headerText: "General Notes",
  containedText: "1. Coordinate all work.",
} as TextRegion;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  tableSaveHarness.delayedGrid.headers = ["Tag", "Description"];
  tableSaveHarness.delayedGrid.rows = [{ Tag: "A-101", Description: "Project A door" }];
  tableSaveHarness.delayedGrid.tagColumn = "Tag";
  tableSaveHarness.delayedGrid.tableName = "Project A Schedule";
  tableSaveHarness.delayedGrid.csiTags = [];
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 1,
    publicId: "pid",
    isDemo: false,
    pageNumber: 4,
  });
  seedWindow("pid");
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mixed page-window writer semantics", () => {
  it("Notes reject restores the exact render-captured value over a concurrent cache write", async () => {
    const captured: PageIntelligence = { textRegions: [noteRegion] };
    setPageIntelligenceForPage(qc, "pid", 4, captured);

    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    render(<NotesClassifier onEditInParser={() => undefined} />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(readPageIntelligence(qc, "pid", 4)?.rejectedTextRegionIds).toEqual([
      "note-region",
    ]);

    // This arrives after the optimistic write but before PATCH failure. The deliberately stale
    // rollback must replace it, matching the pre-migration handler rather than conflict-merging.
    act(() => {
      setPageIntelligenceForPage(qc, "pid", 4, {
        rejectedTextRegionIds: ["concurrent"],
        noteBlocks: [],
      });
    });
    await act(async () => {
      resolveFetch({
        ok: false,
        status: 500,
        json: async () => ({ error: "reject failed" }),
      } as Response);
    });

    await waitFor(() => expect(readPageIntelligence(qc, "pid", 4)).toEqual(captured));
    expect(readPageIntelligence(qc, "pid", 4)?.rejectedTextRegionIds).toBeUndefined();
  });

  it("classifier server adoption replaces the whole page before spatial refresh merges its field", async () => {
    setPageIntelligenceForPage(qc, "pid", 4, {
      textRegions: [noteRegion],
      classifiedTables: [{ category: "stale-server-deleted-field" }] as never,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        updatedIntelligence: { rejectedTextRegionIds: ["server-authoritative"] },
      }),
    } as Response);
    render(<NotesClassifier onEditInParser={() => undefined} />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(readPageIntelligence(qc, "pid", 4)?.rejectedTextRegionIds).toEqual([
        "server-authoritative",
      ]);
    });
    const adopted = readPageIntelligence(qc, "pid", 4);
    expect(adopted?.classifiedTables).toBeUndefined();
    expect(adopted).toHaveProperty("csiSpatialMap");
  });

  it("TableParse local save appends against invocation-live regions and creates one stable id", async () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    setViewerStoreStateForTest({
      isDemo: true,
      tableParseTab: "auto",
      tableParseRegion: [0.1, 0.2, 0.8, 0.7],
    });
    const existing = { id: "concurrent-existing", type: "schedule", data: {} };
    setPageIntelligenceForPage(qc, "pid", 4, {
      parsedRegions: [existing] as never,
    });
    render(<TableParsePanel />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "save local table" }));

    await waitFor(() => {
      expect(readPageIntelligence(qc, "pid", 4)?.parsedRegions?.map((r) => r.id)).toEqual([
        "concurrent-existing",
        "parsed-12345",
      ]);
    });
  });

  it("TableParse captures project, page, region, and grid before delayed CSI detection", async () => {
    const projectA = "project-A";
    const projectB = "project-B";
    const pageA = 4;
    const pageB = 9;
    const regionA = [0.1, 0.2, 0.8, 0.7] as [number, number, number, number];
    const regionB = [0.25, 0.3, 0.9, 0.95] as [number, number, number, number];

    seedWindow(projectA, {
      pageIntelligence: { [pageA]: { rejectedTextRegionIds: ["A-before"] } },
    });
    seedWindow(projectB, {
      // The stale A completion currently targets B at A's render-captured page. Seed that exact
      // key so the adoption assertion cannot pass merely because B's visible page changed.
      pageIntelligence: { [pageA]: { rejectedTextRegionIds: ["B-sentinel"] } },
    });
    const projectBPageBefore = readPageIntelligence(qc, projectB, pageA);
    setViewerStoreStateForTest({
      projectId: 101,
      publicId: projectA,
      pageNumber: pageA,
      tableParseTab: "auto",
      tableParseRegion: regionA,
      tableParsedGrid: {
        headers: ["Tag"],
        rows: [{ Tag: "A-store-grid" }],
      },
    });

    let resolveCsi!: (response: Response) => void;
    const delayedCsi = new Promise<Response>((resolve) => {
      resolveCsi = resolve;
    });
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/csi/detect") return delayedCsi;
      if (url === "/api/regions/promote") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            parsedRegion: {},
            updatedIntelligence: { rejectedTextRegionIds: ["server-A"] },
            summaries: null,
          }),
        } as Response);
      }
      throw new Error(`unexpected fetch in delayed-CSI identity test: ${String(url)}`);
    });

    render(<TableParsePanel />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "save table after CSI" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/csi/detect");

    // Switch every live identity/input while A's CSI request is unresolved. The in-flight save
    // must continue using its invocation snapshot; it must never combine A's grid with B's project
    // or region, nor adopt A's server response into B's cache.
    act(() => {
      setViewerStoreStateForTest({
        projectId: 202,
        publicId: projectB,
        isDemo: true,
        pageNumber: pageB,
        tableParseRegion: regionB,
        tableParsedGrid: {
          headers: ["Tag"],
          rows: [{ Tag: "B-store-grid" }],
        },
      });
      // The caller owns this same object in production. A later edit must not change the pending
      // request payload, and CSI detection must not mutate it behind Zustand's publication model.
      tableSaveHarness.delayedGrid.rows[0].Tag = "B-mutated-input";
      tableSaveHarness.delayedGrid.tableName = "Project B mutated input";
    });

    await act(async () => {
      resolveCsi({
        ok: true,
        status: 200,
        json: async () => ({
          csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
        }),
      } as Response);
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/regions/promote"))
        .toHaveLength(1);
    });
    const promoteCall = fetchMock.mock.calls.find(([url]) => url === "/api/regions/promote");
    if (!promoteCall) throw new Error("Expected the delayed save to promote");
    const request = JSON.parse(String((promoteCall[1] as RequestInit).body));

    expect(request).toMatchObject({
      publicId: projectA,
      pageNumber: pageA,
      type: "schedule",
      overrides: {
        regionId: "pr-4-100-200-800-700",
        bbox: regionA,
        data: {
          headers: ["Tag", "Description"],
          rows: [{ Tag: "A-101", Description: "Project A door" }],
          tagColumn: "Tag",
          tableName: "Project A Schedule",
        },
        csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
      },
    });
    await waitFor(() => {
      expect(readPageIntelligence(qc, projectA, pageA)?.rejectedTextRegionIds)
        .toEqual(["server-A"]);
    });
    expect(readPageIntelligence(qc, projectB, pageA)).toBe(projectBPageBefore);
    expect(tableSaveHarness.delayedGrid).toEqual({
      headers: ["Tag", "Description"],
      rows: [{ Tag: "B-mutated-input", Description: "Project A door" }],
      tagColumn: "Tag",
      tableName: "Project B mutated input",
      csiTags: [],
    });
  });

  it("CSI refresh consumes the same project's live cache inputs and changes only its PI map", () => {
    const textAnnotations = [{
      type: "csi-code",
      category: "csi",
      text: "08 10 00",
      bbox: [0.1, 0.1, 0.1, 0.1],
      confidence: 1,
      wordIndices: [0],
      csiTags: [{
        code: "08 10 00",
        description: "Doors",
        trade: "Openings",
        division: "08",
      }],
    }] satisfies TextAnnotation[];
    const parsedRegion = {
      id: "parsed-live",
      type: "schedule",
      bbox: [0.2, 0.2, 0.4, 0.4],
      csiTags: [{
        code: "09 20 00",
        description: "Plaster and Gypsum Board",
        trade: "Finishes",
        division: "09",
      }],
      data: {},
    };
    const annotation = {
      id: 7,
      pageNumber: 4,
      name: "concrete",
      bbox: [0.5, 0.5, 0.6, 0.6],
      note: null,
      source: "user",
      data: { csiCodes: ["03 30 00"] },
    } satisfies ClientAnnotation;
    const keynotes = {
      4: [{ shape: "rectangle", text: "K", bbox: [0, 0, 1, 1] }],
    } satisfies Record<number, KeynoteShapeData[]>;
    const csiCodes = { 4: [] };
    const otherPage = { rejectedTextRegionIds: ["stable"] };
    seedWindow("pid", {
      keynotes,
      csiCodes,
      textAnnotations: { 4: textAnnotations },
      pageIntelligence: {
        4: { parsedRegions: [parsedRegion] as never },
        8: otherPage,
      },
    });
    seedWindow("other", {
      pageIntelligence: { 4: { rejectedTextRegionIds: ["other-project"] } },
    });
    qc.setQueryData(queryKeys.annotations.all("pid"), [annotation]);
    const sameProjectBefore = readActivePageWindow(qc, "pid");
    const otherBefore = readActivePageWindow(qc, "other");
    const annotationsBefore = qc.getQueryData(queryKeys.annotations.all("pid"));

    refreshPageCsiSpatialMap(qc, "pid", 4);

    const after = readActivePageWindow(qc, "pid");
    const codes = after.pageIntelligence[4]?.csiSpatialMap?.zones.flatMap((zone) =>
      zone.divisions.flatMap((division) => division.codes),
    );
    expect(new Set(codes)).toEqual(new Set(["08 10 00", "09 20 00", "03 30 00"]));
    expect(after.keynotes).toBe(sameProjectBefore.keynotes);
    expect(after.csiCodes).toBe(sameProjectBefore.csiCodes);
    expect(after.textAnnotations).toBe(sameProjectBefore.textAnnotations);
    expect(after.pageIntelligence[8]).toBe(sameProjectBefore.pageIntelligence[8]);
    expect(readActivePageWindow(qc, "other")).toBe(otherBefore);
    expect(qc.getQueryData(queryKeys.annotations.all("pid"))).toBe(annotationsBefore);

    // Explicit request identity is rejected after a project switch; even the target cache object
    // remains untouched, rather than recomputing from the newly active project's YOLO store data.
    const sameProjectBeforeMismatch = readActivePageWindow(qc, "pid");
    setViewerStoreStateForTest({ publicId: "other" });
    refreshPageCsiSpatialMap(qc, "pid", 4);
    expect(readActivePageWindow(qc, "pid")).toBe(sameProjectBeforeMismatch);
  });

  it("shape append stays action-only and appends over the response-time cache value", async () => {
    const original = [{ shape: "rectangle", text: "original", bbox: [0, 0, 1, 1] }] satisfies KeynoteShapeData[];
    seedWindow("pid", { keynotes: { 4: original } });
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const { result } = renderHook(
      () => useShapeParseInteraction({ detectionTab: "shape" }),
      { wrapper },
    );
    const activeQuery = qc.getQueryCache().find({
      queryKey: queryKeys.pagesWindow.active("pid"),
      exact: true,
    });
    expect(activeQuery?.getObserversCount()).toBe(0);

    let request!: Promise<void>;
    act(() => {
      request = result.current.runOnPage();
    });
    appendKeynotesForPage(qc, "pid", 4, [{
      shape: "circle",
      text: "concurrent",
      bbox: [0.1, 0.1, 0.2, 0.2],
    }]);
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({
          keynotes: [{ shape: "square", text: "response", bbox: [0.2, 0.2, 0.3, 0.3] }],
        }),
      } as Response);
      await request;
    });

    expect(readActivePageWindow(qc, "pid").keynotes[4].map((item) => item.text)).toEqual([
      "original",
      "concurrent",
      "response",
    ]);
    expect(activeQuery?.getObserversCount()).toBe(0);
  });
});
