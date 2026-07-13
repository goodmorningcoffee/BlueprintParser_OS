// @vitest-environment jsdom
// [refactor jul12 P2.4 A2d] Real Spec duplicate, inherited-save, stale, and retry witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import SpecParser from "@/components/viewer/SpecParser";
import type { ParseOperationToken } from "@/hooks/useParseOperation";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "spec-operation-project";
const PAGE = 4;
const BBOX_A = [0.1, 0.2, 0.7, 0.8] as [number, number, number, number];
const BBOX_B = [0.2, 0.25, 0.8, 0.85] as [number, number, number, number];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function parseSuccessResponse(label: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      sections: [{ sectionHeader: `${label} PART 1`, body: `${label} scope` }],
      rowBoundaries: [0.2, 0.8],
      csiTags: [{ code: "03 00 00", description: "Concrete" }],
    }),
  } as unknown as Response;
}

function promotionSuccessResponse(marker: string): Response {
  const parsedRegion = {
    id: `spec-${marker}`,
    type: "spec",
    category: `${marker} spec`,
    bbox: BBOX_A,
    confidence: 0.96,
    csiTags: [{ code: "03 00 00", description: "Concrete" }],
    data: {
      sections: [{ sectionHeader: `${marker} PART 1`, body: `${marker} scope` }],
      tableName: `${marker} spec`,
    },
    source: "user",
  };
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      parsedRegion,
      updatedIntelligence: {
        rejectedTextRegionIds: [marker],
        parsedRegions: [parsedRegion],
      },
      summaries: null,
    }),
  } as unknown as Response;
}

function promotionFailureResponse(message: string): Response {
  return {
    ok: false,
    status: 500,
    json: vi.fn().mockResolvedValue({ error: { code: "FAIL", message } }),
  } as unknown as Response;
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

let queryClient: QueryClient;
let parses: Deferred<Response>[];
let promotions: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedSpecRegion(region = BBOX_A): void {
  useParseFlowStore.setState({
    specParseStep: "idle",
    specParseRegion: [...region] as typeof region,
    paragraphBatch: [],
    parseDraftRegion: null,
  });
}

function autoButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Run Auto-Parse" }) as HTMLButtonElement;
}

function startSyntheticB(): ParseOperationToken<"spec"> {
  const started = useParseFlowStore.getState().beginParseOperation("spec");
  if (started.status !== "started") throw new Error("could not start synthetic Spec B");
  return started.token;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  parses = [];
  promotions = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url === "/api/spec-parse") {
      const request = deferred<Response>();
      parses.push(request);
      return request.promise;
    }
    if (url === "/api/regions/promote") {
      const request = deferred<Response>();
      promotions.push(request);
      return request.promise;
    }
    throw new Error(`unexpected Spec operation request: ${String(url)}`);
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
  seedSpecRegion();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2d Spec operation authority", () => {
  it("admits one same-turn Auto root through the synchronous Spec barrier", () => {
    const beforeRevision = useParseFlowStore.getState().parseOperations.spec.revision;
    render(<SpecParser />, { wrapper });
    const run = autoButton();

    act(() => {
      run.click();
      run.click();
    });

    expect(parses).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.spec).toEqual({
      revision: beforeRevision + 1,
      busy: true,
    });
  });

  it("holds one Auto revision through its inherited fire-and-forget promotion", async () => {
    const beforeRevision = useParseFlowStore.getState().parseOperations.spec.revision;
    render(<SpecParser />, { wrapper });
    act(() => { autoButton().click(); });
    expect(parses).toHaveLength(1);

    await act(async () => {
      parses[0].resolve(parseSuccessResponse("A"));
      await flushCompletion();
    });

    expect(promotions).toHaveLength(1);
    // persistPreview inherits Auto's token: it neither begins revision +2 nor lets Auto finish while
    // the captured durable request is pending.
    expect(useParseFlowStore.getState().parseOperations.spec).toEqual({
      revision: beforeRevision + 1,
      busy: true,
    });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("blocks a stale parse response from dispatching promotion or changing synthetic B", async () => {
    render(<SpecParser />, { wrapper });
    act(() => { autoButton().click(); });
    expect(parses).toHaveLength(1);

    let tokenB!: ParseOperationToken<"spec">;
    act(() => {
      useParseFlowStore.getState().resetSpecParse();
      seedSpecRegion(BBOX_B);
      tokenB = startSyntheticB();
    });

    await act(async () => {
      parses[0].resolve(parseSuccessResponse("stale A"));
      await flushCompletion();
    });

    expect.soft(promotions).toHaveLength(0);
    expect.soft(screen.queryByText(/Preview:/)).not.toBeInTheDocument();
    expect.soft(useParseFlowStore.getState().parseOperations.spec).toEqual({
      revision: tokenB.revision,
      busy: true,
    });
    expect(useParseFlowStore.getState().specParseRegion).toEqual(BBOX_B);
  });

  it("allows dispatched A promotion to adopt its captured Query result without resetting B", async () => {
    render(<SpecParser />, { wrapper });
    act(() => { autoButton().click(); });
    await act(async () => {
      parses[0].resolve(parseSuccessResponse("A"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);

    let tokenB!: ParseOperationToken<"spec">;
    act(() => {
      useParseFlowStore.getState().resetSpecParse();
      seedSpecRegion(BBOX_B);
      tokenB = startSyntheticB();
    });

    await act(async () => {
      promotions[0].resolve(promotionSuccessResponse("captured-A"));
      await flushCompletion();
    });

    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.rejectedTextRegionIds)
      .toEqual(["captured-A"]);
    expect.soft(useParseFlowStore.getState().parseOperations.spec).toEqual({
      revision: tokenB.revision,
      busy: true,
    });
    expect.soft(useParseFlowStore.getState().specParseRegion).toEqual(BBOX_B);
    expect(screen.queryByText(/Save failed/)).not.toBeInTheDocument();
  });

  it("suppresses a dispatched stale A promotion failure while B remains current", async () => {
    render(<SpecParser />, { wrapper });
    act(() => { autoButton().click(); });
    await act(async () => {
      parses[0].resolve(parseSuccessResponse("A"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);

    let tokenB!: ParseOperationToken<"spec">;
    act(() => {
      useParseFlowStore.getState().resetSpecParse();
      seedSpecRegion(BBOX_B);
      tokenB = startSyntheticB();
    });

    await act(async () => {
      promotions[0].resolve(promotionFailureResponse("stale A promotion failed"));
      await flushCompletion();
    });

    expect.soft(screen.queryByText("stale A promotion failed")).not.toBeInTheDocument();
    expect.soft(useParseFlowStore.getState().parseOperations.spec).toEqual({
      revision: tokenB.revision,
      busy: true,
    });
    expect(useParseFlowStore.getState().specParseRegion).toEqual(BBOX_B);
  });

  it("releases a current failed save and admits a successful manual retry", async () => {
    render(<SpecParser />, { wrapper });
    act(() => { autoButton().click(); });
    await act(async () => {
      parses[0].resolve(parseSuccessResponse("retryable"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);

    await act(async () => {
      promotions[0].resolve(promotionFailureResponse("current save failed"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText("current save failed")).toBeInTheDocument());
    expect(useParseFlowStore.getState().parseOperations.spec.busy).toBe(false);
    const retry = screen.getByRole("button", { name: "Save Spec" });
    expect(retry).toBeEnabled();

    act(() => { (retry as HTMLButtonElement).click(); });
    expect(promotions).toHaveLength(2);
    expect(useParseFlowStore.getState().parseOperations.spec.busy).toBe(true);

    await act(async () => {
      promotions[1].resolve(promotionSuccessResponse("retry-success"));
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().specParseRegion).toBeNull());
    expect(useParseFlowStore.getState().parseOperations.spec.busy).toBe(false);
    expect(screen.queryByText("current save failed")).not.toBeInTheDocument();
  });
});
