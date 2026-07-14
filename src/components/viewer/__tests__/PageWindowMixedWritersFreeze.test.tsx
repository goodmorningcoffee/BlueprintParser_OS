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
import SpecClassifier from "@/components/viewer/SpecClassifier";
import TableParsePanel from "@/components/viewer/TableParsePanel";
import TextPanel from "@/components/viewer/TextPanel";
import { useShapeParseInteraction } from "@/hooks/useShapeParseInteraction";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
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
import type {
  ClientAnnotation,
  KeynoteShapeData,
  PageIntelligence,
  ProjectSummaries,
  TextAnnotation,
  TextRegion,
} from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
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
  default: ({ detectCsiAndPersist }: { detectCsiAndPersist: (grid: unknown, opts: unknown) => Promise<boolean> }) => (
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

function lifecycleJsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lifecycleProjectResponse(): ProjectResponse {
  return {
    id: "pid",
    dbId: 1,
    name: "Lifecycle project",
    assetBaseUrl: "s3://private/project.json",
    pdfUrl: "s3://private/project.pdf",
    numPages: 12,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 4, name: "Page 4", drawingNumber: null }],
  };
}

async function activateLifecycle(): Promise<OpenProjectHandle> {
  const lifecycleFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects/pid") return lifecycleJsonResponse(lifecycleProjectResponse());
    if (url === "/api/projects/pid/pages?from=1&to=15") {
      return lifecycleJsonResponse({ from: 1, to: 12, pages: [], annotations: [] });
    }
    if (url === "/api/annotation-groups?projectId=pid") {
      return lifecycleJsonResponse({ groups: [], memberships: [] });
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", lifecycleFetch);
  const handle = openProject(qc, "pid", { demo: false });
  expect((await handle.result).status).toBe("opened");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

function seedWindow(publicId: string, overrides: Partial<ActivePageWindow> = {}): void {
  qc.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active(publicId), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    ...overrides,
  });
  qc.setQueryData(queryKeys.annotations.all(publicId), []);
}

function summariesFixture(marker: string): ProjectSummaries {
  return {
    schedules: [],
    parsedTables: [],
    keynoteTablePages: [],
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

  it("Notes reject failure does not roll captured A over a same-ID successor page", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    setViewerStoreStateForTest({
      projectId: 1,
      publicId: "pid",
      isDemo: false,
      pageNumber: 4,
      numPages: 12,
    });
    seedWindow("pid");
    setPageIntelligenceForPage(qc, "pid", 4, { textRegions: [noteRegion] });
    let resolveReject!: (response: Response) => void;
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/pages/intelligence") {
        return new Promise<Response>((resolve) => { resolveReject = resolve; });
      }
      return successorPending;
    });
    render(<NotesClassifier onEditInParser={() => undefined} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/pages/intelligence",
      expect.any(Object),
    ));

    const successorIntel = {
      textRegions: [noteRegion],
      noteBlocks: [],
    } satisfies PageIntelligence;
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        projectId: 1,
        publicId: "pid",
        isDemo: false,
        pageNumber: 4,
        numPages: 12,
      });
      seedWindow("pid", { pageIntelligence: { 4: successorIntel } });
      resolveReject({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "FAILED", message: "obsolete reject failed" } }),
      } as Response);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    // The page-window seed is structurally shared by Query; freeze the successor value, not the
    // fixture object's incidental reference identity.
    expect.soft(readPageIntelligence(qc, "pid", 4)).toEqual(successorIntel);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("classifier settles promotion but publishes no client state after switching to B", async () => {
    const projectA = "pid";
    const projectB = "other";
    const serverRegion = {
      id: "promoted-note",
      type: "notes",
      category: "notes",
      bbox: [0.1, 0.1, 0.3, 0.2],
      confidence: 0.95,
      csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
      data: { headers: ["Key"], rows: [{ Key: "N1" }] },
      source: "user",
      sourceTextRegionId: noteRegion.id,
    };
    const authoritative = {
      rejectedTextRegionIds: ["server-authoritative"],
      parsedRegions: [serverRegion as never],
    } satisfies PageIntelligence;
    const serverSummaries = summariesFixture("server-A");
    const stableASummaries = summariesFixture("stable-A");
    const stableBSummaries = summariesFixture("stable-B");

    setPageIntelligenceForPage(qc, projectA, 4, {
      textRegions: [noteRegion],
      classifiedTables: [{ category: "stale-server-deleted-field" }] as never,
    });
    qc.setQueryData(queryKeys.summaries.all(projectA), stableASummaries);
    const aWindowBefore = readActivePageWindow(qc, projectA);
    seedWindow(projectB, {
      pageIntelligence: { 4: { rejectedTextRegionIds: ["B-sentinel"] } },
    });
    qc.setQueryData(queryKeys.summaries.all(projectB), stableBSummaries);
    const bWindowBefore = readActivePageWindow(qc, projectB);

    let resolvePromotion!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolvePromotion = resolve;
    }));
    render(<NotesClassifier onEditInParser={() => undefined} />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      setViewerStoreStateForTest({ projectId: 2, publicId: projectB });
    });
    const responseJson = vi.fn(async () => ({
      ok: true,
      parsedRegion: serverRegion,
      updatedIntelligence: authoritative,
      summaries: serverSummaries,
    }));
    await act(async () => {
      resolvePromotion({
        ok: true,
        status: 200,
        json: responseJson,
      } as unknown as Response);
    });

    // The durable request still settles and its response graph is parsed/validated. Render A is
    // retired, however, so page adoption, summaries, and spatial recompute are all client no-ops.
    await waitFor(() => expect(responseJson).toHaveBeenCalledTimes(1));
    expect(readActivePageWindow(qc, projectA)).toBe(aWindowBefore);
    expect(qc.getQueryData(queryKeys.summaries.all(projectA))).toBe(stableASummaries);
    expect(readActivePageWindow(qc, projectB)).toBe(bWindowBefore);
    expect(qc.getQueryData(queryKeys.summaries.all(projectB))).toBe(stableBSummaries);
  });

  it("classifier success does not adopt or spatially recompute into a same-ID demo successor", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    setViewerStoreStateForTest({
      projectId: 1,
      publicId: "pid",
      isDemo: false,
      pageNumber: 4,
      numPages: 12,
    });
    seedWindow("pid", { pageIntelligence: { 4: { textRegions: [noteRegion] } } });
    let resolvePromotion!: (response: Response) => void;
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/regions/promote") {
        return new Promise<Response>((resolve) => { resolvePromotion = resolve; });
      }
      return successorPending;
    });
    render(<NotesClassifier onEditInParser={() => undefined} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/regions/promote",
      expect.any(Object),
    ));

    const successorIntel = {
      textRegions: [noteRegion],
      noteBlocks: [],
    } satisfies PageIntelligence;
    const successorSummaries = summariesFixture("successor-B");
    const obsoleteRegion = {
      id: "obsolete-promoted-note",
      type: "notes",
      category: "notes",
      bbox: [0.1, 0.1, 0.3, 0.2],
      confidence: 0.95,
      csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
      data: { headers: ["Key"], rows: [{ Key: "N1" }] },
      source: "user",
      sourceTextRegionId: noteRegion.id,
    };
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: true });
      // B's demo lifecycle is current before activation. Preserve the old render values so the
      // event closure must rely on its A snapshot rather than a late capture of B.
      setViewerStoreStateForTest({
        projectId: 1,
        publicId: "pid",
        isDemo: false,
        pageNumber: 4,
        numPages: 12,
      });
      seedWindow("pid", { pageIntelligence: { 4: successorIntel } });
      qc.setQueryData(queryKeys.summaries.all("pid"), successorSummaries);
      resolvePromotion({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          parsedRegion: obsoleteRegion,
          updatedIntelligence: { parsedRegions: [obsoleteRegion] },
          summaries: summariesFixture("obsolete-A"),
        }),
      } as Response);
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(readPageIntelligence(qc, "pid", 4)).toEqual(successorIntel);
    expect.soft(qc.getQueryData(queryKeys.summaries.all("pid")))
      .toEqual(successorSummaries);
    expect.soft(readPageIntelligence(qc, "pid", 4)?.csiSpatialMap).toBeUndefined();
    lifecycleB.dispose();
    lifecycleA.dispose();
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
    const projectAPageBefore = readPageIntelligence(qc, projectA, pageA);
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
    const promotedRegion = {
      id: "pr-4-100-200-800-700",
      type: "schedule",
      category: "Project A Schedule",
      bbox: regionA,
      confidence: 1,
      csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
      data: {
        headers: ["Tag", "Description"],
        rows: [{ Tag: "A-101", Description: "Project A door" }],
        tagColumn: "Tag",
        tableName: "Project A Schedule",
        rowCount: 1,
        columnCount: 2,
      },
      source: "user",
    };
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/csi/detect") return delayedCsi;
      if (url === "/api/regions/promote") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            parsedRegion: promotedRegion,
            updatedIntelligence: {
              rejectedTextRegionIds: ["server-A"],
              parsedRegions: [promotedRegion],
            },
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
    // The captured durable request settles, but render A is no longer current and therefore owns
    // no authoritative adoption, summaries, spatial recompute, or caller-local completion.
    expect(readPageIntelligence(qc, projectA, pageA)).toBe(projectAPageBefore);
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

  it("shape completion cannot append, warn, or toggle a same-ID successor lifecycle", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    setViewerStoreStateForTest({
      projectId: 1,
      publicId: "pid",
      isDemo: false,
      pageNumber: 4,
      numPages: 12,
      showKeynotes: false,
    });
    seedWindow("pid", {
      keynotes: { 4: [{ shape: "rectangle", text: "lifecycle-A", bbox: [0, 0, 1, 1] }] },
    });
    let resolveFetch!: (response: Response) => void;
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/shape-parse") {
        return new Promise<Response>((resolve) => { resolveFetch = resolve; });
      }
      return successorPending;
    });
    const hook = renderHook(
      () => useShapeParseInteraction({ detectionTab: "shape" }),
      { wrapper },
    );
    let request!: Promise<void>;
    act(() => {
      request = hook.result.current.runOnPage();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/shape-parse",
      expect.any(Object),
    ));

    const successorShapes = [{
      shape: "circle",
      text: "successor-B",
      bbox: [0.4, 0.4, 0.5, 0.5],
    }] satisfies KeynoteShapeData[];
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        projectId: 1,
        publicId: "pid",
        isDemo: false,
        pageNumber: 4,
        numPages: 12,
        showKeynotes: false,
      });
      seedWindow("pid", { keynotes: { 4: successorShapes } });
      useUiStore.setState({ showKeynotes: false });
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({
          keynotes: [{ shape: "square", text: "obsolete-A", bbox: [0.2, 0.2, 0.3, 0.3] }],
          warnings: ["obsolete A warning"],
        }),
      } as Response);
      await request;
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(readActivePageWindow(qc, "pid").keynotes[4]).toEqual(successorShapes);
    expect.soft(useUiStore.getState().showKeynotes).toBe(false);
    expect.soft(hook.result.current.warnings).toEqual([]);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("does not let A's retained drawing flag consume a region published by same-ID lifecycle B", async () => {
    const lifecycleA = await activateLifecycle();
    setViewerStoreStateForTest({
      projectId: 1,
      publicId: "pid",
      isDemo: false,
      pageNumber: 4,
      numPages: 12,
    });
    const hook = renderHook(
      () => useShapeParseInteraction({ detectionTab: "shape" }),
      { wrapper },
    );
    act(() => hook.result.current.startRegionDraw());
    expect(hook.result.current.drawing).toBe(true);

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorRegion = [0.55, 0.56, 0.85, 0.86] as [number, number, number, number];
    let lifecycleB!: OpenProjectHandle;
    act(() => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        projectId: 1,
        publicId: "pid",
        isDemo: false,
        pageNumber: 4,
        numPages: 12,
      });
      useParseFlowStore.setState({
        tableParseStep: "select-region",
        tableParseRegion: successorRegion,
      });
    });

    expect(useParseFlowStore.getState().tableParseRegion).toBe(successorRegion);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("does not let A's retained drawing flag cancel same-ID lifecycle B when leaving Shape", async () => {
    const lifecycleA = await activateLifecycle();
    setViewerStoreStateForTest({
      projectId: 1,
      publicId: "pid",
      isDemo: false,
      pageNumber: 4,
      numPages: 12,
    });
    const hook = renderHook(
      ({ tab }: { tab: "shape" | "models" }) =>
        useShapeParseInteraction({ detectionTab: tab }),
      { wrapper, initialProps: { tab: "shape" as "shape" | "models" } },
    );
    act(() => hook.result.current.startRegionDraw());
    expect(hook.result.current.drawing).toBe(true);

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorTool = { kind: "parseRect", flow: "table" } as const;
    let lifecycleB!: OpenProjectHandle;
    act(() => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        projectId: 1,
        publicId: "pid",
        isDemo: false,
        pageNumber: 4,
        numPages: 12,
        activeTool: successorTool,
        mode: "pointer",
        tableParseStep: "select-region",
        tableParseRegion: null,
      });
    });
    act(() => hook.rerender({ tab: "models" }));

    expect.soft(useParseFlowStore.getState().tableParseStep).toBe("select-region");
    expect.soft(useToolStore.getState().activeTool).toBe(successorTool);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });
});

describe("TextPanel synchronous publication tails — same-ID lifecycle retirement", () => {
  const successorSearch = "successor B search";
  const successorFilter = "successor B markup filter";

  function textAnnotation(
    type: TextAnnotation["type"],
    text: string,
  ): TextAnnotation {
    return {
      type,
      category: "contact",
      text,
      bbox: [0.1, 0.1, 0.2, 0.03],
      confidence: 0.99,
      wordIndices: [0],
    };
  }

  function installSameIdSuccessor(seed: () => void): OpenProjectHandle {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const lifecycleB = openProject(qc, "pid", { demo: true });
    setViewerStoreStateForTest({
      projectId: 0,
      publicId: "pid",
      isDemo: true,
      pageNumber: 4,
      numPages: 12,
    });
    seed();
    return lifecycleB;
  }

  async function activateTextLifecycle(
    textAnnotations: TextAnnotation[] = [],
  ): Promise<OpenProjectHandle> {
    const lifecycleA = await activateLifecycle();
    setViewerStoreStateForTest({
      publicId: "pid",
      isDemo: false,
      pageNumber: 4,
      numPages: 12,
      textPanelTab: "annotations",
    });
    seedWindow("pid", { textAnnotations: { 4: textAnnotations } });
    return lifecycleA;
  }

  it("type initialization stops when its first publication admits successor B", async () => {
    const lifecycleA = await activateTextLifecycle([
      textAnnotation("phone", "555-0100"),
      textAnnotation("email", "a@example.test"),
    ]);
    const successorTypes = { "successor-only": true };
    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeTextAnnotationTypes.phone === true ||
          state.activeTextAnnotationTypes.phone !== true) return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({ activeTextAnnotationTypes: successorTypes });
      });
    });

    render(<TextPanel embedded />, { wrapper });
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeTextAnnotationTypes).toBe(successorTypes);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("category visibility fanout stops when its first type publication admits successor B", async () => {
    const lifecycleA = await activateTextLifecycle([
      textAnnotation("phone", "555-0100"),
      textAnnotation("email", "a@example.test"),
    ]);
    setViewerStoreStateForTest({
      activeTextAnnotationTypes: { phone: true, email: true },
    });
    render(<TextPanel embedded />, { wrapper });

    const successorTypes = { "successor-only": true };
    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeTextAnnotationTypes.phone === false ||
          state.activeTextAnnotationTypes.phone !== false) return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({ activeTextAnnotationTypes: successorTypes });
      });
    });

    fireEvent.click(screen.getByTitle("Hide category"));
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeTextAnnotationTypes).toBe(successorTypes);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("markup row filtering does not publish A search text into successor B", async () => {
    const lifecycleA = await activateTextLifecycle();
    const markup: ClientAnnotation = {
      id: 401,
      pageNumber: 4,
      name: "A markup",
      bbox: [0.1, 0.1, 0.2, 0.2],
      note: null,
      source: "user",
      data: null,
    };
    qc.setQueryData(queryKeys.annotations.all("pid"), [markup]);
    setViewerStoreStateForTest({
      textPanelTab: "markups",
      activeAnnotationFilter: null,
      searchQuery: "",
    });
    render(<TextPanel embedded />, { wrapper });

    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeAnnotationFilter === markup.name ||
          state.activeAnnotationFilter !== markup.name) return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({
          activeAnnotationFilter: successorFilter,
          searchQuery: successorSearch,
        });
      });
    });

    fireEvent.click(screen.getByText(markup.name));
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeAnnotationFilter).toBe(successorFilter);
    expect.soft(useUiStore.getState().searchQuery).toBe(successorSearch);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("markup filter indicator clear does not clear successor B's search", async () => {
    const lifecycleA = await activateTextLifecycle();
    const markup: ClientAnnotation = {
      id: 402,
      pageNumber: 4,
      name: "Active A markup",
      bbox: [0.2, 0.2, 0.3, 0.3],
      note: null,
      source: "user",
      data: null,
    };
    qc.setQueryData(queryKeys.annotations.all("pid"), [markup]);
    setViewerStoreStateForTest({
      textPanelTab: "markups",
      activeAnnotationFilter: markup.name,
      searchQuery: markup.name,
    });
    render(<TextPanel embedded />, { wrapper });

    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeAnnotationFilter !== markup.name ||
          state.activeAnnotationFilter !== null) return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({
          activeAnnotationFilter: successorFilter,
          searchQuery: successorSearch,
        });
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "x" }));
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeAnnotationFilter).toBe(successorFilter);
    expect.soft(useUiStore.getState().searchQuery).toBe(successorSearch);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });
});

describe("classifier row liveness — same-ID lifecycle retirement", () => {
  const specRegion = {
    ...noteRegion,
    id: "spec-region",
    type: "spec-dense-columns",
    headerText: "Specifications",
  } satisfies TextRegion;

  it.each([
    {
      label: "NotesClassifier",
      Component: NotesClassifier,
      region: noteRegion,
      title: "Accept the classifier-proposed grid as a committed ParsedRegion",
    },
    {
      label: "SpecClassifier",
      Component: SpecClassifier,
      region: specRegion,
      title: "Accept the classifier-proposed spec sections as a committed ParsedRegion",
    },
  ])("$label does not leave successor B's same-key row busy", async ({
    Component,
    region,
    title,
  }) => {
    const lifecycleA = await activateLifecycle();
    setViewerStoreStateForTest({
      projectId: 1,
      publicId: "pid",
      isDemo: false,
      pageNumber: 4,
      numPages: 12,
    });
    seedWindow("pid", { pageIntelligence: { 4: { textRegions: [region] } } });
    const promotion = deferred<Response>();
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/regions/promote") return promotion.promise;
      return successorPending;
    });
    render(<Component onEditInParser={() => undefined} />, { wrapper });
    fireEvent.click(screen.getByTitle(title));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/regions/promote",
      expect.any(Object),
    ));

    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        projectId: 1,
        publicId: "pid",
        isDemo: false,
        pageNumber: 4,
        numPages: 12,
      });
      seedWindow("pid", { pageIntelligence: { 4: { textRegions: [region] } } });
      promotion.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "FAILED", message: "obsolete A failed" } }),
      } as Response);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    const successorAccept = screen.getByTitle(title);
    expect.soft(successorAccept).toHaveTextContent("Accept");
    expect.soft(successorAccept).toBeEnabled();
    lifecycleB.dispose();
    lifecycleA.dispose();
  });
});
