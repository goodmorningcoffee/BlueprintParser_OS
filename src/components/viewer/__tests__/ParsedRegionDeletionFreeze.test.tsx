// @vitest-environment jsdom
// [refactor jul13 P2.4 W1] Real retained-row deletion witnesses. These deliberately mount the
// Table orchestrator: the pre-W1 cache-only filter must fail the deferred server-first cases.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TableParsePanel from "@/components/viewer/TableParsePanel";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import {
  clearYoloTagsProject,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { PageIntelligence, ParsedRegion } from "@/types";

const PUBLIC_ID = "10000000-0000-4000-8000-000000000001";
const PAGE = 9;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function region(id: string, name: string): ParsedRegion {
  return {
    id,
    type: "schedule" as const,
    category: name.toLowerCase().replaceAll(" ", "-"),
    bbox: [0.1, 0.2, 0.8, 0.9],
    confidence: 0.85,
    csiTags: [],
    data: {
      tableName: name,
      headers: ["Mark"],
      rows: [{ Mark: id }],
      rowCount: 1,
      columnCount: 1,
    },
  };
}

const REGION_A = region("region-A", "A Schedule");
const REGION_B = region("region-B", "B Schedule");

function successResponse(intelligence: PageIntelligence): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      deleted: true,
      updatedIntelligence: intelligence,
      summaries: null,
    }),
  } as unknown as Response;
}

function failureResponse(message: string): Response {
  return {
    ok: false,
    status: 503,
    json: vi.fn().mockResolvedValue({ error: { code: "UNAVAILABLE", message } }),
  } as unknown as Response;
}

let queryClient: QueryClient;
let pending: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedProject(isDemo = false): void {
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 31,
    publicId: PUBLIC_ID,
    isDemo,
    pageNumber: 1,
    numPages: PAGE,
    pageNames: { [PAGE]: "Schedule page" },
    pageDrawingNumbers: {},
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: 1, to: PAGE },
    pageIntelligence: {
      [PAGE]: {
        retainedUnknownKey: { keep: true },
        parsedRegions: [REGION_A, REGION_B],
      } as unknown as PageIntelligence,
    },
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData(queryKeys.summaries.all(PUBLIC_ID), null);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  fetchMock.mockReset().mockImplementation((url: unknown) => {
    if (url !== "/api/regions") throw new Error(`unexpected W1 request: ${String(url)}`);
    const request = deferred<Response>();
    pending.push(request);
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  seedProject();
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("W1 retained ParsedRegion deletion", () => {
  it("is server-first, admits one same-turn click, targets the retained row page/id, and preserves stable sibling UI identity", async () => {
    render(<TableParsePanel />, { wrapper });
    expect(screen.getByText("A Schedule")).toBeInTheDocument();
    expect(screen.getByText("B Schedule")).toBeInTheDocument();

    // Open state on A. After A disappears, index keys would leak this panel into B.
    act(() => { (screen.getAllByTitle("Table settings")[0] as HTMLButtonElement).click(); });
    expect(screen.getByText("CSI Codes")).toBeInTheDocument();

    const deleteA = screen.getAllByTitle("Delete table")[0] as HTMLButtonElement;
    act(() => {
      deleteA.click();
      deleteA.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    expect(screen.getByText("A Schedule")).toBeInTheDocument();
    expect(deleteA).toBeDisabled();
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.parsedRegions)
      .toHaveLength(2);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({
      publicId: PUBLIC_ID,
      pageNumber: PAGE,
      regionId: REGION_A.id,
    });

    await act(async () => {
      pending[0].resolve(successResponse({
        retainedUnknownKey: { keep: true },
        parsedRegions: [REGION_B],
      } as unknown as PageIntelligence));
      await flushCompletion();
    });

    await waitFor(() => expect(screen.queryByText("A Schedule")).not.toBeInTheDocument());
    expect(screen.getByText("B Schedule")).toBeInTheDocument();
    expect(screen.queryByText("CSI Codes")).not.toBeInTheDocument();
  });

  it("retains the row and exact cache on failure, surfaces the error, and releases authority for retry", async () => {
    render(<TableParsePanel />, { wrapper });
    const before = queryClient.getQueryData(queryKeys.pagesWindow.active(PUBLIC_ID));
    act(() => { (screen.getAllByTitle("Delete table")[0] as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0].resolve(failureResponse("delete unavailable"));
      await flushCompletion();
    });

    await waitFor(() => expect(screen.getByText("delete unavailable")).toBeInTheDocument());
    expect(screen.getByText("A Schedule")).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.pagesWindow.active(PUBLIC_ID))).toBe(before);
    expect(screen.getAllByTitle("Delete table")[0]).not.toBeDisabled();

    act(() => { (screen.getAllByTitle("Delete table")[0] as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(2);
    expect(screen.queryByText("delete unavailable")).not.toBeInTheDocument();
    await act(async () => {
      pending[1].resolve(successResponse({ parsedRegions: [REGION_B] } as PageIntelligence));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.queryByText("A Schedule")).not.toBeInTheDocument());
  });

  it("keeps demo deletion local, removes every duplicate target id, retains siblings, and performs zero transport", async () => {
    seedProject(true);
    queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
      ...EMPTY_ACTIVE_PAGE_WINDOW,
      loadedRange: { from: 1, to: PAGE },
      pageIntelligence: {
        [PAGE]: {
          retainedUnknownKey: { keep: true },
          parsedRegions: [REGION_A, { ...REGION_A }, REGION_B],
        } as unknown as PageIntelligence,
      },
    });
    render(<TableParsePanel />, { wrapper });

    act(() => { (screen.getAllByTitle("Delete table")[0] as HTMLButtonElement).click(); });
    await waitFor(() => expect(screen.queryByText("A Schedule")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    const after = readPageIntelligence(queryClient, PUBLIC_ID, PAGE)!;
    expect(after.parsedRegions?.map((candidate) => candidate.id)).toEqual([REGION_B.id]);
    expect((after as PageIntelligence & { retainedUnknownKey: unknown }).retainedUnknownKey)
      .toEqual({ keep: true });
    expect(after.csiSpatialMap).toBeDefined();
  });
});
