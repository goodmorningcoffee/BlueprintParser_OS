// [fix 2026-10-21 reprocess-persistence] The viewer cache mirrors what /api/shape-parse STORED.
// Before: runOnPage APPENDED the response to the page's keynotes (a repeat run doubled them)
// and nothing reached the DB, so a reload lost the run. Now a non-demo response carries
// `persisted`; the hook replaces the page keynotes with it and swaps the page's shape-parse
// annotations in the annotations cache. A demo (compute-only) response keeps the old append.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useShapeParseInteraction } from "@/hooks/useShapeParseInteraction";
import { openProject, type OpenProjectHandle, type ProjectResponse } from "@/lib/project-lifecycle";
import { EMPTY_ACTIVE_PAGE_WINDOW, type ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readActivePageWindow } from "@/queries/usePageWindow";
import type { ClientAnnotation, KeynoteShapeData } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

function projectResponse(): ProjectResponse {
  return {
    id: "pid", dbId: 1, name: "P", assetBaseUrl: "s3://private/p.json", pdfUrl: "s3://private/p.pdf",
    numPages: 12, status: "ready", summaries: null, projectIntelligence: null,
    pages: [{ pageNumber: 4, name: "Page 4", drawingNumber: null }],
  };
}

async function activateLifecycle(): Promise<OpenProjectHandle> {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects/pid") return json(projectResponse());
    if (url === "/api/projects/pid/pages?from=1&to=15") return json({ from: 1, to: 12, pages: [], annotations: [] });
    if (url === "/api/annotation-groups?projectId=pid") return json({ groups: [], memberships: [] });
    throw new Error(`unexpected lifecycle request: ${url}`);
  }));
  const handle = openProject(qc, "pid", { demo: false });
  expect((await handle.result).status).toBe("opened");
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

const OLD: KeynoteShapeData = { shape: "circle", text: "OLD", bbox: [0.1, 0.1, 0.2, 0.2] };
const NEW: KeynoteShapeData = { shape: "hexagon", text: "NEW", bbox: [0.5, 0.5, 0.6, 0.6] };
const ann = (id: number, source: ClientAnnotation["source"]): ClientAnnotation => ({
  id, pageNumber: 4, name: "x", bbox: [0.1, 0.1, 0.2, 0.2], note: null, source, data: null,
});

function seed(): void {
  qc.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active("pid"), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    keynotes: { 4: [OLD] },
  });
  qc.setQueryData(queryKeys.annotations.all("pid"), [ann(1, "shape-parse"), ann(2, "yolo")]);
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  resetProjectData();
  setViewerStoreStateForTest({ projectId: 1, publicId: "pid", isDemo: false, pageNumber: 4, numPages: 12 });
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

describe("useShapeParseInteraction — persisted responses", () => {
  it("runOnPage REPLACES the page keynotes and swaps the page's shape-parse annotations", async () => {
    const lifecycle = await activateLifecycle();
    seed();
    fetchMock.mockResolvedValue(json({
      keynotes: [NEW],
      warnings: [],
      persisted: { pages: { 4: [OLD, NEW] }, annotations: [ann(9, "shape-parse")], removedAnnotationIds: [1] },
    }));
    const hook = renderHook(() => useShapeParseInteraction({ detectionTab: "shape" }), { wrapper });

    await act(async () => { await hook.result.current.runOnPage(); });

    expect(readActivePageWindow(qc, "pid").keynotes[4]).toEqual([OLD, NEW]); // stored state, not OLD+append
    expect((qc.getQueryData(queryKeys.annotations.all("pid")) as ClientAnnotation[]).map((a) => a.id)).toEqual([2, 9]);
    lifecycle.dispose();
  });

  it("runOnAll adopts persisted pages and warns about pages that could not be scanned", async () => {
    const lifecycle = await activateLifecycle();
    seed();
    fetchMock.mockResolvedValue(json({
      keynotes: [], byPage: {}, totalPages: 2,
      failedPages: ["k2"],
      persisted: { pages: { 4: null }, annotations: [], removedAnnotationIds: [1] },
    }));
    const hook = renderHook(() => useShapeParseInteraction({ detectionTab: "shape" }), { wrapper });

    await act(async () => { await hook.result.current.runOnAll(); });

    expect(readActivePageWindow(qc, "pid").keynotes[4]).toEqual([]);
    expect((qc.getQueryData(queryKeys.annotations.all("pid")) as ClientAnnotation[]).map((a) => a.id)).toEqual([2]);
    expect(hook.result.current.warnings).toEqual(["1 page(s) could not be scanned — their previous shapes were kept"]);
    lifecycle.dispose();
  });

  it("a compute-only (demo) response keeps the legacy append and touches no annotations", async () => {
    const lifecycle = await activateLifecycle();
    seed();
    fetchMock.mockResolvedValue(json({ keynotes: [NEW], warnings: [] }));
    const hook = renderHook(() => useShapeParseInteraction({ detectionTab: "shape" }), { wrapper });

    await act(async () => { await hook.result.current.runOnPage(); });

    // The hook runs on the navigation store's current page (1 here; the store patch's
    // pageNumber does not reach useNavigation), so the append lands there; page 4 is untouched.
    const sentPage = JSON.parse(String(fetchMock.mock.calls[0][1].body)).pageNumber as number;
    expect(readActivePageWindow(qc, "pid").keynotes[sentPage]).toEqual(sentPage === 4 ? [OLD, NEW] : [NEW]);
    expect((qc.getQueryData(queryKeys.annotations.all("pid")) as ClientAnnotation[]).map((a) => a.id)).toEqual([1, 2]);
    lifecycle.dispose();
  });
});
