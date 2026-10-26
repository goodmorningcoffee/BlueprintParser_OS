// [refactor jul11 P2.2⑥] ANNOTATIONS MIGRATION FREEZE NET — the two raw-fetch
// annotation-save surfaces hosted by DetectionPanel and SymbolSearchPanel.
//
// WHY this file exists: these handlers write only after a successful raw-fetch POST and then clear
// their own pending UI, but their read timing intentionally differs. Detection single-page re-reads
// live state after await; Detection Save-all and Symbol save use pre-await snapshots (existing
// lost-update behavior). P2.2⑥ moves that array from zustand to TanStack Query; these behavior pins
// must stay unchanged across that backing-store flip. `seedAnnotations` is the only sanctioned seed
// divergence point. A second,
// models-locked DetectionPanel is deliberately used as the annotation observer instead of reading
// the deleted viewer-store annotations field, so the assertions exercise a real subscribed production
// read path and stayed backing-agnostic through C3.
//
// The default global fetch mock is FAIL-LOUD. Each success/failure case opens only the exact raw
// `/api/annotations` POST it owns; a future accidental GET, persist-helper swap, or extra request
// therefore fails at the call site. Demo/pre-bootstrap guards never open that route.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { useToolStore } from "@/stores/toolStore";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import { readKeynotesForPage, setKeynotesForPage } from "@/queries/usePageWindow";
import type {
  ClientAnnotation,
  KeynoteShapeData,
  SymbolSearchResult,
} from "@/types";
import DetectionPanel from "../DetectionPanel";
import SymbolSearchPanel from "../SymbolSearchPanel";
import { resetProjectData } from "@/stores/viewerCommands";
import { useSessionStore } from "@/stores/sessionStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
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

function lifecycleJsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function lifecycleProjectResponse(): ProjectResponse {
  return {
    id: "pid",
    dbId: 41,
    name: "Lifecycle project",
    assetBaseUrl: "s3://private/project.json",
    pdfUrl: "s3://private/project.pdf",
    numPages: 2,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 1, name: "A-101", drawingNumber: null }],
  };
}

async function activateLifecycle(): Promise<OpenProjectHandle> {
  const lifecycleFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects/pid") return lifecycleJsonResponse(lifecycleProjectResponse());
    if (url === "/api/projects/pid/pages?from=1&to=15") {
      return lifecycleJsonResponse({ from: 1, to: 2, pages: [], annotations: [] });
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

function annotation(
  over: Partial<ClientAnnotation> & Pick<ClientAnnotation, "id" | "name" | "source">,
): ClientAnnotation {
  return {
    pageNumber: 1,
    bbox: [0.1, 0.1, 0.2, 0.2],
    note: null,
    data: { modelName: `${over.source}-model`, confidence: 0.95 },
    ...over,
  };
}

const survivor = (): ClientAnnotation =>
  annotation({ id: 1, name: "existing-door", source: "yolo", data: { modelName: "existing-model", confidence: 0.95 } });

const concurrent = (): ClientAnnotation =>
  annotation({ id: 2, name: "concurrent-window-row", source: "yolo", data: { modelName: "concurrent-model", confidence: 1 } });

const pendingShape: KeynoteShapeData = {
  shape: "circle",
  text: "A1",
  bbox: [0.1, 0.2, 0.3, 0.4],
  contour: [[0.1, 0.2], [0.3, 0.4]],
};

const symbolResults: SymbolSearchResult = {
  templateBbox: [0.1, 0.1, 0.2, 0.2],
  sourcePageNumber: 1,
  matches: [
    {
      id: "match-1",
      pageNumber: 1,
      bbox: [0.25, 0.25, 0.25, 0.25],
      confidence: 0.91,
      method: "template",
    },
  ],
  totalMatches: 1,
  pagesWithMatches: [1],
  searchedAt: "2026-07-11T00:00:00.000Z",
};

const fetchMock = vi.fn();
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let successBannerTimers: Array<ReturnType<typeof setTimeout>>;

function failUnexpectedFetch(url: unknown): never {
  throw new Error(`unexpected raw fetch in annotation-save panel freeze test: ${String(url)}`);
}

function routeAnnotationPost(response: Promise<unknown>) {
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    if (url === "/api/annotations" && init?.method === "POST") return response;
    return failUnexpectedFetch(url);
  });
}

function renderDetectionSaveSurface() {
  return render(
    <>
      <DetectionPanel embedded lockedTab="shape" />
      {/* [refactor jul11 P2.2⑥] Real subscribed read-path probe; see file header. */}
      <DetectionPanel embedded lockedTab="models" />
    </>,
    { wrapper },
  );
}

function renderSymbolSaveSurface() {
  return render(
    <>
      <SymbolSearchPanel pdfDoc={null} embedded />
      {/* [refactor jul11 P2.2⑥] Real subscribed read-path probe; see file header. */}
      <DetectionPanel embedded lockedTab="models" />
    </>,
    { wrapper },
  );
}

function seedPendingShape() {
  setKeynotesForPage(qc, useSessionStore.getState().publicId, 1, [pendingShape]);
}

function seedPendingSymbolSearch() {
  useToolStore.setState({
    activeTool: { kind: "symbolTemplate" },
    symbolSearchLoading: false,
    symbolSearchResults: symbolResults,
    symbolSearchError: null,
    symbolSearchTemplateBbox: [0.1, 0.1, 0.3, 0.3],
    symbolSearchSourcePage: 1,
    dismissedSymbolMatches: new Set<string>(),
  });
}

beforeEach(() => {
  successBannerTimers = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    ((...args: Parameters<typeof setTimeout>) => {
      const timer = realSetTimeout(...args);
      // [refactor jul11 P2.2⑥] DetectionPanel owns two success-banner timers but does not
      // clear them on unmount. A focused run exits before they fire; the full suite tears down
      // jsdom first and would then receive a React state update against `window === undefined`.
      // Track only the production 3 s banner timers (never RTL's polling timers) and cancel any
      // still pending in afterEach. This is harness lifetime control, not a product-code change.
      if (args[1] === 3000) successBannerTimers.push(timer);
      return timer;
    }) as typeof setTimeout,
  );

  qc = new QueryClient(); // pure defaults, matching production Providers.tsx
  resetProjectData();
  // P2.5 resetProjectData deliberately preserves approved presentation preferences. Pin the
  // required destination choices here so another test cannot hide the model probe or perturb the
  // post-save lifecycle.
  setViewerStoreStateForTest({
    publicId: "pid",
    projectId: 41,
    isDemo: false,
    pageNumber: 1,
    pageNames: { 1: "A-101" },
    mode: "move",
    showKeynotes: false,
    hiddenClasses: {},
  });
  seedAnnotations(qc, []); // AFTER publicId: the post-C3 cache key derives from it

  fetchMock.mockReset();
  fetchMock.mockImplementation(failUnexpectedFetch);
  vi.stubGlobal("fetch", fetchMock);
  // Save failures intentionally report through console.error + inline panel state. Suppress the
  // expected output while asserting its prefix in the failure cases; do not assert cleanliness.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const timer of successBannerTimers) clearTimeout(timer);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  qc.clear();
});

describe("DetectionPanel shape-save — guard, raw-fetch failure, and append+clear", () => {
  it.each([
    { label: "demo", publicId: "pid", isDemo: true, error: "Cannot save in demo mode" },
    { label: "pre-bootstrap", publicId: "", isDemo: false, error: "Project not loaded" },
  ])("$label guard keeps pending shapes and performs no annotation write", async ({ publicId, isDemo, error }) => {
    // [refactor jul11 P2.2⑥] The guard is BEFORE raw fetch and BEFORE the annotation-array write.
    // Demo and the unresolved-publicId bootstrap window intentionally share that inert lifecycle.
    setViewerStoreStateForTest({ publicId, isDemo });
    seedAnnotations(qc, [survivor()]);
    seedPendingShape();
    renderDetectionSaveSurface();

    fireEvent.click(screen.getByRole("button", { name: "Save page 1 (1 shapes)" }));

    expect(await screen.findByText(error)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save page 1 (1 shapes)" })).toBeEnabled();
    expect(screen.getByText("1 shape detected")).toBeInTheDocument();
    expect(screen.getByText("1 detection shown")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs through raw fetch; non-ok envelope is inline+console and keeps pending/data", async () => {
    seedAnnotations(qc, [survivor()]);
    seedPendingShape();
    routeAnnotationPost(Promise.resolve({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "CONFLICT", message: "shape save conflict" } }),
    }));
    renderDetectionSaveSurface();

    fireEvent.click(screen.getByRole("button", { name: "Save page 1 (1 shapes)" }));

    expect(await screen.findByText("shape save conflict")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save page 1 (1 shapes)" })).toBeEnabled();
    expect(screen.getByText("1 shape detected")).toBeInTheDocument();
    expect(screen.getByText("1 detection shown")).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith("[SHAPE_PARSE] Save failed:", expect.any(Error));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("[fix 2026-10-24] a page whose shapes are all stored as shape-parse annotations offers no Save", async () => {
    // The server persists non-demo scans itself; the client Save must not double those rows.
    const stored = annotation({ id: 9, name: "circle", source: "shape-parse", bbox: [0.10000001, 0.2, 0.3, 0.4] }); // float4 of the keynote bbox
    seedAnnotations(qc, [survivor(), stored]);
    seedPendingShape();
    renderDetectionSaveSurface();

    expect(screen.getByText("1 shape detected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save page 1/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[fix 2026-10-24] only the unsaved shapes of a page are offered and posted", async () => {
    const stored = annotation({ id: 9, name: "circle", source: "shape-parse", bbox: [0.10000001, 0.2, 0.3, 0.4] });
    seedAnnotations(qc, [survivor(), stored]);
    const fresh: KeynoteShapeData = { shape: "hexagon", text: "H2", bbox: [0.5, 0.5, 0.6, 0.6] };
    setKeynotesForPage(qc, "pid", 1, [pendingShape, fresh]);
    const response = deferred<unknown>();
    routeAnnotationPost(response.promise);
    renderDetectionSaveSurface();

    expect(screen.getByText("2 shapes detected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save page 1 (1 shapes)" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const posted = JSON.parse(String(init.body)).annotations;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ pageNumber: 1, name: "hexagon", bbox: [0.5, 0.5, 0.6, 0.6], source: "shape-parse" });
    response.resolve({ ok: true, json: async () => ({ annotations: [annotation({ id: 10, name: "hexagon", source: "shape-parse", bbox: [0.5, 0.5, 0.6, 0.6] })] }) });
    await waitFor(() => expect(readSeededAnnotations(qc).map((row) => row.id)).toEqual([1, 9, 10]));
  });

  it("is server-first, appends the returned annotation, then clears pending shapes", async () => {
    const initial = survivor();
    seedAnnotations(qc, [initial]);
    seedPendingShape();
    const saved = annotation({
      id: 42,
      name: "circle",
      source: "shape-parse",
      bbox: pendingShape.bbox,
      data: {
        modelName: "shape-parse",
        shapeType: "circle",
        text: "A1",
        contour: pendingShape.contour,
        confidence: 0.9,
      },
    });
    const response = deferred<unknown>();
    routeAnnotationPost(response.promise);
    renderDetectionSaveSurface();

    fireEvent.click(screen.getByRole("button", { name: "Save page 1 (1 shapes)" }));

    // Mock-call-anchored server-first pin: the POST has fired, but its unresolved response has
    // not yet appended anything or cleared the pending-shape panel.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByText("1 shape detected")).toBeInTheDocument();
    expect(screen.getByText("1 detection shown")).toBeInTheDocument();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/annotations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "pid",
      annotations: [
        {
          pageNumber: 1,
          name: "circle",
          bbox: [0.1, 0.2, 0.3, 0.4],
          source: "shape-parse",
          threshold: 0.9,
          data: {
            modelName: "shape-parse",
            shapeType: "circle",
            text: "A1",
            contour: [[0.1, 0.2], [0.3, 0.4]],
            confidence: 0.9,
          },
        },
      ],
    });

    // [refactor jul11 P2.2⑥] Detection single-page re-reads getState AFTER await. A concurrent
    // chunk/write therefore survives; converting this site to a captured value-replace would lose it.
    await act(async () => { seedAnnotations(qc, [initial, concurrent()]); });
    expect(readSeededAnnotations(qc).map((row) => row.id)).toEqual([1, 2]);
    response.resolve({ ok: true, json: async () => ({ annotations: [saved] }) });

    await waitFor(() => expect(screen.getByText("3 detections shown")).toBeInTheDocument());
    expect(readSeededAnnotations(qc).map((row) => row.id)).toEqual([1, 2, 42]);
    expect(screen.getByText("existing-model")).toBeInTheDocument();
    expect(screen.getByText("concurrent-model")).toBeInTheDocument();
    expect(screen.getByText("shape-parse")).toBeInTheDocument();
    expect(screen.getByText("No shapes parsed for page", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save page 1/ })).not.toBeInTheDocument();
  });

  it("does not append or clear shape state after a same-ID successor lifecycle opens", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    setViewerStoreStateForTest({
      publicId: "pid",
      projectId: 41,
      isDemo: false,
      pageNumber: 1,
      pageNames: { 1: "A-101" },
      mode: "move",
      showKeynotes: false,
      hiddenClasses: {},
    });
    seedAnnotations(qc, [survivor()]);
    seedPendingShape();
    const response = deferred<unknown>();
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      if (url === "/api/annotations" && init?.method === "POST") return response.promise;
      return successorPending;
    });
    renderDetectionSaveSurface();
    fireEvent.click(screen.getByRole("button", { name: "Save page 1 (1 shapes)" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/annotations",
      expect.any(Object),
    ));

    const successorRows = [annotation({
      id: 142,
      name: "successor-row",
      source: "yolo",
      data: { modelName: "successor-model", confidence: 1 },
    })];
    const successorShapes = [{
      shape: "square",
      text: "successor-shape",
      bbox: [0.6, 0.6, 0.7, 0.7],
    }] satisfies KeynoteShapeData[];
    const obsoleteSaved = annotation({
      id: 42,
      name: "obsolete-A-shape",
      source: "shape-parse",
      data: { modelName: "shape-parse", confidence: 0.9 },
    });
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        projectId: 41,
        isDemo: false,
        pageNumber: 1,
        pageNames: { 1: "B-101" },
        mode: "move",
        showKeynotes: false,
        hiddenClasses: {},
      });
      seedAnnotations(qc, successorRows);
      setKeynotesForPage(qc, "pid", 1, successorShapes);
      response.resolve({ ok: true, json: async () => ({ annotations: [obsoleteSaved] }) });
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(readSeededAnnotations(qc)).toEqual(successorRows);
    expect.soft(readKeynotesForPage(qc, "pid", 1)).toEqual(successorShapes);
    const successorSave = screen.getByRole("button", {
      name: /^(Saving\.\.\.|Save page 1 \(1 shapes\))$/,
    });
    expect.soft(successorSave).toHaveTextContent("Save page 1 (1 shapes)");
    expect.soft(successorSave).toBeEnabled();
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("does not carry lifecycle A's shape-save success banner into successor B", async () => {
    const lifecycleA = await activateLifecycle();
    setViewerStoreStateForTest({
      publicId: "pid",
      projectId: 41,
      isDemo: false,
      pageNumber: 1,
      pageNames: { 1: "A-101" },
      mode: "move",
      showKeynotes: false,
      hiddenClasses: {},
    });
    seedPendingShape();
    const saved = annotation({
      id: 143,
      name: "circle",
      source: "shape-parse",
      data: { modelName: "shape-parse", confidence: 0.9 },
    });
    routeAnnotationPost(Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ annotations: [saved] }),
    }));
    renderDetectionSaveSurface();
    fireEvent.click(screen.getByRole("button", { name: "Save page 1 (1 shapes)" }));
    await waitFor(() => expect(readKeynotesForPage(qc, "pid", 1)).toEqual([]));

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorShapes = [{
      shape: "square",
      text: "successor-shape",
      bbox: [0.6, 0.6, 0.7, 0.7],
    }] satisfies KeynoteShapeData[];
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        projectId: 41,
        isDemo: false,
        pageNumber: 1,
        pageNames: { 1: "B-101" },
        mode: "move",
        showKeynotes: false,
        hiddenClasses: {},
      });
      setKeynotesForPage(qc, "pid", 1, successorShapes);
    });

    const successorSave = screen.getByRole("button", {
      name: /^(Saved 1 annotations|Save page 1 \(1 shapes\))$/,
    });
    expect.soft(successorSave).toHaveTextContent("Save page 1 (1 shapes)");
    expect.soft(successorSave).toBeEnabled();
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("save-all preserves its pre-await snapshot semantics and drops a concurrent annotation write", async () => {
    // [refactor jul11 P2.2⑥] Unlike the single-page sibling, save-all captures the whole zustand
    // snapshot at click time (`store`) and reads `store.annotations` after await. This lost-update
    // hazard is existing behavior. The migration must use a value replacement here, not a functional
    // updater, until ANNOTATIONS-W1 is taken as a deliberate behavior change.
    const initial = survivor();
    seedAnnotations(qc, [initial]);
    setKeynotesForPage(qc, "pid", 1, [pendingShape]);
    setKeynotesForPage(qc, "pid", 2, [
      { ...pendingShape, text: "B2", bbox: [0.4, 0.4, 0.5, 0.5] },
    ]);
    const savedPage1 = annotation({ id: 43, name: "circle", source: "shape-parse", data: { modelName: "shape-parse", confidence: 0.9 } });
    const savedPage2 = annotation({ id: 44, name: "circle", source: "shape-parse", pageNumber: 2, data: { modelName: "shape-parse", confidence: 0.9 } });
    const response = deferred<unknown>();
    routeAnnotationPost(response.promise);
    renderDetectionSaveSurface();

    fireEvent.click(screen.getByRole("button", { name: "Save all pages (2 shapes)" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getAllByRole("button", { name: "Saving..." })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Saving..." }).every((button) => button.hasAttribute("disabled"))).toBe(true);

    await act(async () => { seedAnnotations(qc, [initial, concurrent()]); });
    expect(readSeededAnnotations(qc).map((row) => row.id)).toEqual([1, 2]);

    response.resolve({
      ok: true,
      json: async () => ({ annotations: [savedPage1, savedPage2] }),
    });

    await waitFor(() => expect(screen.getByText("3 detections shown")).toBeInTheDocument());
    expect(readSeededAnnotations(qc).map((row) => row.id)).toEqual([1, 43, 44]);
    expect(screen.getByText("existing-model")).toBeInTheDocument();
    expect(screen.getByText("shape-parse")).toBeInTheDocument();
    expect(screen.queryByText("concurrent-model")).not.toBeInTheDocument();
    expect(screen.getByText("No shapes parsed for page", { exact: false })).toBeInTheDocument();
  });
});

describe("SymbolSearchPanel annotation-save — guard, raw-fetch failure, and append+clear", () => {
  it.each([
    { label: "demo", publicId: "pid", isDemo: true, error: "Cannot save in demo mode" },
    { label: "pre-bootstrap", publicId: "", isDemo: false, error: "Project not loaded" },
  ])("$label guard keeps search results and performs no annotation write", async ({ publicId, isDemo, error }) => {
    // [refactor jul11 P2.2⑥] As with Shape Parse, this guard must remain ahead of both the raw
    // POST and the replace/append write when annotations move to the cache.
    setViewerStoreStateForTest({ publicId, isDemo });
    seedAnnotations(qc, [survivor()]);
    seedPendingSymbolSearch();
    renderSymbolSaveSurface();

    fireEvent.click(screen.getByRole("button", { name: "Save 1 matches as annotations" }));

    expect(await screen.findByText(error)).toBeInTheDocument();
    expect(screen.getByText("1 detection shown")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    // The error state temporarily masks RESULTS. Clearing only the error reveals the same pending
    // match and save affordance, proving the guard did not run the success-only pending clear.
    fireEvent.click(screen.getByRole("button", { name: "Back to Config" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save 1 matches as annotations" })).toBeEnabled(),
    );
  });

  it("POSTs through raw fetch; non-ok envelope is inline+console and keeps results/data", async () => {
    seedAnnotations(qc, [survivor()]);
    seedPendingSymbolSearch();
    routeAnnotationPost(Promise.resolve({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "UNAVAILABLE", message: "symbol save unavailable" } }),
    }));
    renderSymbolSaveSurface();

    fireEvent.click(screen.getByRole("button", { name: "Save 1 matches as annotations" }));

    expect(await screen.findByText("symbol save unavailable")).toBeInTheDocument();
    expect(screen.getByText("1 detection shown")).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith("[SYMBOL_SEARCH] Save failed:", expect.any(Error));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to Config" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save 1 matches as annotations" })).toBeEnabled(),
    );
  });

  it("is server-first, appends the returned annotation, then clears the search pending UI", async () => {
    const initial = survivor();
    // [TP-1 WP-1.C, K12] the save replaces only rows the new match covers (same page, same spot),
    // so the replacement bait sits where the match lands; page-wide deletion is gone.
    const samePageReplacementBait = annotation({
      id: 3,
      name: "old-same-page-symbol",
      source: "symbol-search",
      bbox: [0.26, 0.26, 0.5, 0.5],
      data: { modelName: "old-symbol-same", confidence: 0.8 },
    });
    const otherPageSymbolBait = annotation({
      id: 4,
      name: "old-other-page-symbol",
      source: "symbol-search",
      pageNumber: 2,
      data: { modelName: "old-symbol-other-page", confidence: 0.8 },
    });
    seedAnnotations(qc, [initial, samePageReplacementBait, otherPageSymbolBait]);
    seedPendingSymbolSearch();
    const saved = annotation({
      id: 84,
      name: "symbol-match",
      source: "symbol-search",
      bbox: [0.25, 0.25, 0.5, 0.5],
      data: {
        modelName: "symbol-search",
        method: "template",
        confidence: 0.91,
        scale: 1,
        templateSourcePage: 1,
      },
    });
    const response = deferred<unknown>();
    routeAnnotationPost(response.promise);
    renderSymbolSaveSurface();

    fireEvent.click(screen.getByRole("button", { name: "Save 1 matches as annotations" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByText("3 detections shown")).toBeInTheDocument();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/annotations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "pid",
      annotations: [
        {
          pageNumber: 1,
          name: "symbol-match",
          bbox: [0.25, 0.25, 0.5, 0.5],
          source: "symbol-search",
          threshold: 0.91,
          data: {
            modelName: "symbol-search",
            method: "template",
            confidence: 0.91,
            scale: 1,
            templateSourcePage: 1,
          },
        },
      ],
      deleteSource: "symbol-search",
      deleteIds: [3],
    });

    // Symbol save also captures `store.annotations` before await. Freeze the visible lost-update
    // policy so C3 does not silently functionalize it while changing the backing store.
    await act(async () => {
      seedAnnotations(qc, [initial, samePageReplacementBait, otherPageSymbolBait, concurrent()]);
    });
    expect(readSeededAnnotations(qc).map((row) => row.id)).toEqual([1, 3, 4, 2]);
    response.resolve({ ok: true, json: async () => ({ annotations: [saved], deletedIds: [3] }) });

    await waitFor(() => expect(screen.getByText("3 detections shown")).toBeInTheDocument());
    expect(readSeededAnnotations(qc).map((row) => row.id)).toEqual([1, 4, 84]);
    expect(screen.getByText("existing-model")).toBeInTheDocument();
    expect(screen.getByText("symbol-search")).toBeInTheDocument();
    expect(screen.getByText("old-symbol-other-page")).toBeInTheDocument();
    expect(screen.queryByText("old-symbol-same")).not.toBeInTheDocument();
    expect(screen.queryByText("concurrent-model")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save 1 matches/ })).not.toBeInTheDocument();
  });

  it("does not replace annotations or clear symbol state across a same-ID auth-to-demo lifecycle", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    setViewerStoreStateForTest({
      publicId: "pid",
      projectId: 41,
      isDemo: false,
      pageNumber: 1,
      pageNames: { 1: "A-101" },
      mode: "move",
      hiddenClasses: {},
    });
    seedAnnotations(qc, [survivor()]);
    seedPendingSymbolSearch();
    const response = deferred<unknown>();
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      if (url === "/api/annotations" && init?.method === "POST") return response.promise;
      return successorPending;
    });
    renderSymbolSaveSurface();
    fireEvent.click(screen.getByRole("button", { name: "Save 1 matches as annotations" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/annotations",
      expect.any(Object),
    ));

    const successorRows = [annotation({
      id: 184,
      name: "successor-symbol-row",
      source: "yolo",
      data: { modelName: "successor-symbol-model", confidence: 1 },
    })];
    const successorResults = {
      ...symbolResults,
      matches: [{
        ...symbolResults.matches[0],
        id: "successor-match",
        confidence: 0.99,
      }],
      searchedAt: "2026-07-14T00:00:00.000Z",
    } satisfies SymbolSearchResult;
    const obsoleteSaved = annotation({
      id: 84,
      name: "obsolete-A-symbol",
      source: "symbol-search",
      data: { modelName: "symbol-search", confidence: 0.91 },
    });
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: true });
      // The successor demo token is already authoritative; keep the stale render's selectors
      // value-equal until settlement so it cannot pass by capturing B after the click.
      setViewerStoreStateForTest({
        publicId: "pid",
        projectId: 41,
        isDemo: false,
        pageNumber: 1,
        pageNames: { 1: "B-101" },
        mode: "move",
        hiddenClasses: {},
      });
      seedAnnotations(qc, successorRows);
      useToolStore.setState({
        activeTool: { kind: "symbolTemplate" },
        symbolSearchLoading: false,
        symbolSearchResults: successorResults,
        symbolSearchError: null,
        symbolSearchTemplateBbox: [0.4, 0.4, 0.5, 0.5],
        symbolSearchSourcePage: 1,
        dismissedSymbolMatches: new Set<string>(),
      });
      response.resolve({ ok: true, json: async () => ({ annotations: [obsoleteSaved] }) });
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(readSeededAnnotations(qc)).toEqual(successorRows);
    expect.soft(useToolStore.getState().symbolSearchResults).toBe(successorResults);
    expect.soft(useToolStore.getState().activeTool).toEqual({ kind: "symbolTemplate" });
    const successorSave = screen.getByRole("button", {
      name: /^(Saving\.\.\.|Save 1 matches as annotations)$/,
    });
    expect.soft(successorSave).toHaveTextContent("Save 1 matches as annotations");
    expect.soft(successorSave).toBeEnabled();
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("does not carry lifecycle A's symbol-save success banner into successor B", async () => {
    const lifecycleA = await activateLifecycle();
    setViewerStoreStateForTest({
      publicId: "pid",
      projectId: 41,
      isDemo: false,
      pageNumber: 1,
      pageNames: { 1: "A-101" },
      mode: "move",
      hiddenClasses: {},
    });
    seedPendingSymbolSearch();
    const saved = annotation({
      id: 185,
      name: "symbol-match",
      source: "symbol-search",
      data: { modelName: "symbol-search", confidence: 0.91 },
    });
    routeAnnotationPost(Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ annotations: [saved] }),
    }));
    renderSymbolSaveSurface();
    fireEvent.click(screen.getByRole("button", { name: "Save 1 matches as annotations" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument());

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorResults = {
      ...symbolResults,
      searchedAt: "2026-07-14T12:00:00.000Z",
    } satisfies SymbolSearchResult;
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        projectId: 41,
        isDemo: false,
        pageNumber: 1,
        pageNames: { 1: "B-101" },
        mode: "move",
        hiddenClasses: {},
        activeTool: { kind: "symbolTemplate" },
        symbolSearchLoading: false,
        symbolSearchResults: successorResults,
        symbolSearchError: null,
        symbolSearchTemplateBbox: [0.4, 0.4, 0.5, 0.5],
        symbolSearchSourcePage: 1,
        dismissedSymbolMatches: new Set<string>(),
      });
    });

    const successorSave = screen.getByRole("button", {
      name: /^(Saved 1 annotations|Save 1 matches as annotations)$/,
    });
    expect.soft(successorSave).toHaveTextContent("Save 1 matches as annotations");
    expect.soft(successorSave).toBeEnabled();
    lifecycleB.dispose();
    lifecycleA.dispose();
  });
});
