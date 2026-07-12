// [refactor jul11 P2.4 B3c] RED regression net for Table Map Tags completion identity.
//
// The YOLO-tag action already rejects a callback captured by another project/demo/bootstrap
// epoch, but TableParsePanel separately publishes its local "Mapped N" result. These cases keep
// the transport deliberately abort-ignoring so project/run identity—not friendly fetch behavior—
// must protect BOTH cache adoption and the local done/count/drop-count publications.

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
import TableParsePanel from "@/components/viewer/TableParsePanel";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  clearYoloTagsProject,
  readYoloTags,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ScoredMatch } from "@/lib/tag-mapping";
import type { YoloTag } from "@/types";
import { useParseFlowStore } from "@/stores/parseFlowStore";

// Mount the real TableParsePanel orchestration but replace its large Auto tab with a narrow surface
// that exposes the callback and all three local completion publications under test.
vi.mock("@/components/viewer/AutoParseTab", () => ({
  default: ({
    handleMapTags,
    tagMappingDone,
    tagMappingCount,
    lastDropCounts,
    setTagYoloClass,
    setMapTagsStrictness,
    setDrawingNumberPrefixes,
    onTagColumnChange,
  }: {
    handleMapTags: () => void;
    tagMappingDone: boolean;
    tagMappingCount: number;
    lastDropCounts: Record<string, number> | null;
    setTagYoloClass: (value: { model: string; className: string } | null) => void;
    setMapTagsStrictness: (value: "strict" | "balanced" | "lenient") => void;
    setDrawingNumberPrefixes: (value: string[]) => void;
    onTagColumnChange: (value: string) => void;
  }) => (
    <div>
      <button onClick={handleMapTags}>run table map tags</button>
      <button onClick={() => setTagYoloClass({ model: "next-model", className: "door" })}>
        change table map class
      </button>
      <button onClick={() => setMapTagsStrictness("strict")}>change table map strictness</button>
      <button onClick={() => setDrawingNumberPrefixes(["A-"])}>change table map scope</button>
      <button onClick={() => onTagColumnChange("Description")}>change table map tag column</button>
      <span data-testid="mapping-done">{String(tagMappingDone)}</span>
      <span data-testid="mapping-count">{String(tagMappingCount)}</span>
      <span data-testid="mapping-drops">
        {lastDropCounts === null ? "null" : JSON.stringify(lastDropCounts)}
      </span>
    </div>
  ),
}));

const PROJECT_A = "table-map-project-a";
const PROJECT_B = "table-map-project-b";
const PAGE_NUMBER = 4;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

interface PendingRequest {
  url: string;
  init: RequestInit;
  response: Deferred<Response>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function scoredMatch(annotationId: number): ScoredMatch {
  return {
    pageNumber: 9,
    annotationId,
    bbox: [0.1, 0.2, 0.3, 0.4],
    confidence: 1,
    confidenceTier: "high",
  };
}

function mapResponse(annotationIds: number[], dropCounts: Record<string, number>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: { D1: annotationIds.map(scoredMatch) },
      dropCounts,
    }),
  } as Response;
}

function bootstrapTag(id: string): YoloTag {
  return {
    id,
    name: id,
    tagText: id,
    yoloClass: "door",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    instances: [],
  };
}

let queryClient: QueryClient;
let pendingRequests: PendingRequest[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedWindow(publicId: string): void {
  queryClient.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active(publicId), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
  });
  queryClient.setQueryData(queryKeys.annotations.all(publicId), []);
}

function renderPanel() {
  return render(<TableParsePanel />, { wrapper });
}

function expectLocalCompletion(
  done: boolean,
  count: number,
  drops: Record<string, number> | null,
): void {
  expect(screen.getByTestId("mapping-done")).toHaveTextContent(String(done));
  expect(screen.getByTestId("mapping-count")).toHaveTextContent(String(count));
  expect(screen.getByTestId("mapping-drops")).toHaveTextContent(
    drops === null ? "null" : JSON.stringify(drops),
  );
}

async function flushAsyncCompletion(): Promise<void> {
  // fetch + response.json + Query publication + React notification each add a microtask edge.
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pendingRequests = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    const textUrl = String(url);
    if (!textUrl.endsWith("/map-tags-batch")) {
      throw new Error(`unexpected Table Map Tags request: ${textUrl}`);
    }
    const response = deferred<Response>();
    pendingRequests.push({ url: textUrl, init: init ?? {}, response });
    // Deliberately do not listen to init.signal: identity guards must survive a transport that
    // resolves after abort (also models a response already queued when abort occurs).
    return response.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PROJECT_A,
    // Map Tags is a read/computation route and supports demo. Demo keeps these completion tests
    // isolated from the YOLO cache facade's unrelated trailing persistence timer.
    isDemo: true,
    pageNumber: PAGE_NUMBER,
    tableParseTab: "auto",
    tableParseRegion: [0.1, 0.1, 0.8, 0.7],
    tableParsedGrid: {
      headers: ["Tag", "Description"],
      rows: [{ Tag: "D1", Description: "Door one" }],
      tagColumn: "Tag",
      tableName: "Door Schedule",
    },
  });
  seedWindow(PROJECT_A);
  seedWindow(PROJECT_B);
  seedYoloTagsFromBootstrap(queryClient, PROJECT_A, { yoloTags: [] });
  seedYoloTagsFromBootstrap(queryClient, PROJECT_B, { yoloTags: [] });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PROJECT_A);
  clearYoloTagsProject(queryClient, PROJECT_B);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TableParsePanel Map Tags completion identity", () => {
  it("does not publish old-project completion after the guarded cache action rejects it", async () => {
    renderPanel();
    expectLocalCompletion(false, 0, null);

    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));
    expect(pendingRequests).toHaveLength(1);
    expect(pendingRequests[0].url).toBe(`/api/projects/${PROJECT_A}/map-tags-batch`);

    act(() => setViewerStoreStateForTest({ publicId: PROJECT_B }));
    await act(async () => {
      pendingRequests[0].response.resolve(mapResponse([101], { old_project: 4 }));
      await flushAsyncCompletion();
    });

    expect(readYoloTags(queryClient, PROJECT_A)).toEqual([]);
    expect(readYoloTags(queryClient, PROJECT_B)).toEqual([]);
    expectLocalCompletion(false, 0, null);
  });

  it("does not publish completion across a same-publicId bootstrap epoch", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));
    expect(pendingRequests).toHaveLength(1);

    const reopenedRows = [bootstrapTag("bootstrap-row")];
    act(() => {
      seedYoloTagsFromBootstrap(queryClient, PROJECT_A, { yoloTags: reopenedRows });
    });
    // Bootstrap validation creates the canonical cache array. Pin that exact adopted reference so
    // a late response cannot replace it while avoiding an assumption about the caller's wire array.
    const reopenedCacheRows = readYoloTags(queryClient, PROJECT_A);
    await act(async () => {
      pendingRequests[0].response.resolve(mapResponse([202], { old_epoch: 3 }));
      await flushAsyncCompletion();
    });

    expect(readYoloTags(queryClient, PROJECT_A)).toBe(reopenedCacheRows);
    expectLocalCompletion(false, 0, null);
  });

  it("rejects a same-turn duplicate map begin without replacing the admitted request", async () => {
    renderPanel();
    const runButton = screen.getByRole("button", { name: "run table map tags" });

    act(() => {
      (runButton as HTMLButtonElement).click();
      (runButton as HTMLButtonElement).click();
    });
    expect(pendingRequests).toHaveLength(1);
    expect((pendingRequests[0].init.signal as AbortSignal).aborted).toBe(false);
    expect(JSON.parse(String(pendingRequests[0].init.body))).toEqual({
      tags: ["D1"],
      itemType: "text-only",
      strictnessMode: "balanced",
      drawingNumberPrefixes: [],
    });

    await act(async () => {
      pendingRequests[0].response.resolve(mapResponse([302, 303], { admitted: 2 }));
      await flushAsyncCompletion();
    });
    await waitFor(() => expectLocalCompletion(true, 1, { admitted: 2 }));
    const admittedRows = readYoloTags(queryClient, PROJECT_A);
    expect(admittedRows[0].instances.map((instance) => instance.annotationId)).toEqual([302, 303]);
    expect(admittedRows[0]).toMatchObject({
      tagText: "D1",
      source: "schedule",
      scope: "project",
      description: "Door one",
      mapScope: { strictness: "balanced" },
    });
  });

  it("allows B after a map-input invalidation and suppresses late A in reverse order", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));
    expect(pendingRequests).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "change table map strictness" }));
    expect((pendingRequests[0].init.signal as AbortSignal).aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));
    expect(pendingRequests).toHaveLength(2);
    expect((pendingRequests[1].init.signal as AbortSignal).aborted).toBe(false);
    expect(JSON.parse(String(pendingRequests[1].init.body))).toMatchObject({
      strictnessMode: "strict",
    });

    await act(async () => {
      pendingRequests[1].response.resolve(mapResponse([402, 403], { current_b: 2 }));
      await flushAsyncCompletion();
    });
    await waitFor(() => expectLocalCompletion(true, 1, { current_b: 2 }));
    const bRows = readYoloTags(queryClient, PROJECT_A);

    await act(async () => {
      pendingRequests[0].response.resolve(mapResponse([401], { stale_a: 9 }));
      await flushAsyncCompletion();
    });

    expect(readYoloTags(queryClient, PROJECT_A)).toBe(bRows);
    expectLocalCompletion(true, 1, { current_b: 2 });
  });

  it.each([
    ["class", "change table map class"],
    ["strictness", "change table map strictness"],
    ["scope", "change table map scope"],
    ["tag-column draft", "change table map tag column"],
  ])("invalidates pending local completion when the %s input changes", async (_label, buttonName) => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));
    expect(pendingRequests).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    expect((pendingRequests[0].init.signal as AbortSignal).aborted).toBe(true);
    await act(async () => {
      pendingRequests[0].response.resolve(mapResponse([501], { stale_input: 1 }));
      await flushAsyncCompletion();
    });

    expectLocalCompletion(false, 0, null);
  });

  it("allows captured Query adoption after reset but suppresses reset-stale local completion", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));
    expect(pendingRequests).toHaveLength(1);

    act(() => useParseFlowStore.getState().resetTableParse());
    expect((pendingRequests[0].init.signal as AbortSignal).aborted).toBe(false);
    await act(async () => {
      pendingRequests[0].response.resolve(mapResponse([601], { after_reset: 1 }));
      await flushAsyncCompletion();
    });

    expect(readYoloTags(queryClient, PROJECT_A)[0].instances[0].annotationId).toBe(601);
    expectLocalCompletion(false, 0, null);
  });

  it("invalidates an unmounted run even when its transport resolves after abort", async () => {
    const view = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));
    expect(pendingRequests).toHaveLength(1);

    view.unmount();
    expect((pendingRequests[0].init.signal as AbortSignal).aborted).toBe(true);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
    await act(async () => {
      pendingRequests[0].response.resolve(mapResponse([401], { after_unmount: 1 }));
      await flushAsyncCompletion();
    });

    expect(readYoloTags(queryClient, PROJECT_A)).toEqual([]);
  });
});
