// [refactor jul11 P2.4 B2] RED regression net for classifier Accept re-entry.
//
// React state cannot guard two native clicks delivered in the same task: both handlers observe the
// last committed `idle` render before either setRowStates publication disables the button. These
// tests deliberately keep the requests pending and dispatch native events inside ONE act so the
// DOM disabled state cannot hide that gap. The intended guard is keyed per text-region row: it must
// suppress one row's duplicate, release after failure, and never serialize distinct rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import NotesClassifier from "@/components/viewer/NotesClassifier";
import SpecClassifier from "@/components/viewer/SpecClassifier";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { PageIntelligence, TextRegion, TextRegionType } from "@/types";

const PUBLIC_ID = "classifier-project";
const OTHER_PUBLIC_ID = "classifier-project-B";
const PAGE_NUMBER = 4;
const OTHER_PAGE_NUMBER = 7;

type ClassifierProps = { onEditInParser: () => void };
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(ok: boolean, body: unknown, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function region(id: string, type: TextRegionType, index: number): TextRegion {
  return {
    id,
    type,
    bbox: [0.1, 0.1 + index * 0.2, 0.7, 0.15],
    confidence: 0.9,
    wordCount: 4,
    lineCount: 1,
    headerText: `Region ${id}`,
    containedText: `Content for ${id}`,
  };
}

const classifierCases: Array<{
  label: string;
  Component: ComponentType<ClassifierProps>;
  regionType: TextRegionType;
  promotionType: "notes" | "spec";
}> = [
  {
    label: "NotesClassifier",
    Component: NotesClassifier,
    regionType: "notes-numbered",
    promotionType: "notes",
  },
  {
    label: "SpecClassifier",
    Component: SpecClassifier,
    regionType: "spec-dense-columns",
    promotionType: "spec",
  },
];

let queryClient: QueryClient;
let pending: Deferred<Response>[];
let pendingUrls: string[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedRegionsFor(publicId: string, pageNumber: number, regions: TextRegion[]): void {
  const intelligence: PageIntelligence = { textRegions: regions };
  const window: ActivePageWindow = {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: { [pageNumber]: intelligence },
  };
  queryClient.setQueryData(queryKeys.pagesWindow.active(publicId), window);
  queryClient.setQueryData(queryKeys.annotations.all(publicId), []);
  queryClient.setQueryData(queryKeys.yoloTags.all(publicId), []);
}

function seedRegions(regions: TextRegion[]): void {
  seedRegionsFor(PUBLIC_ID, PAGE_NUMBER, regions);
}

function dispatchNativeClick(button: HTMLElement): void {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function promotionBodies(): Array<{
  publicId: string;
  pageNumber: number;
  type: string;
  sourceTextRegionId: string;
}> {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/api/regions/promote")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

function promotionSuccess(id: string, type: "notes" | "spec"): Response {
  const parsedRegion = {
    id: `parsed-${id}`,
    type,
    category: `${type}-fixture`,
    bbox: [0.1, 0.1, 0.8, 0.3],
    confidence: 0.85,
    data: {},
    sourceTextRegionId: id,
  };
  return response(true, {
    ok: true,
    parsedRegion,
    updatedIntelligence: { parsedRegions: [parsedRegion] },
    summaries: null,
  });
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  pendingUrls = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/regions/promote" && url !== "/api/pages/intelligence") {
      throw new Error(`unexpected classifier request: ${String(url)}`);
    }
    const request = deferred<Response>();
    pending.push(request);
    pendingUrls.push(String(url));
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE_NUMBER,
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(classifierCases)("$label Accept in-flight guard", ({
  Component,
  regionType,
  promotionType,
}) => {
  it("suppresses two same-task Accept events for the same row", () => {
    seedRegions([region("row-1", regionType, 0)]);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    const accept = screen.getByRole("button", { name: "Accept" });

    act(() => {
      dispatchNativeClick(accept);
      dispatchNativeClick(accept);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    expect(promotionBodies()).toEqual([{
      publicId: PUBLIC_ID,
      pageNumber: PAGE_NUMBER,
      type: promotionType,
      sourceTextRegionId: "row-1",
    }]);
  });

  it("releases the row after failure so Accept can retry", async () => {
    seedRegions([region("row-1", regionType, 0)]);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    const firstAccept = screen.getByRole("button", { name: "Accept" });

    act(() => dispatchNativeClick(firstAccept));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0].resolve(response(false, { error: "first promotion failed" }));
    });
    await waitFor(() => {
      expect(screen.getByText("first promotion failed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Accept" })).not.toBeDisabled();
    });

    act(() => dispatchNativeClick(screen.getByRole("button", { name: "Accept" })));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(2);
    expect(screen.queryByText("first promotion failed")).not.toBeInTheDocument();
    expect(promotionBodies().map((body) => body.sourceTextRegionId)).toEqual([
      "row-1",
      "row-1",
    ]);
  });

  it("allows two distinct rows to promote concurrently", () => {
    seedRegions([
      region("row-1", regionType, 0),
      region("row-2", regionType, 1),
    ]);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    const accepts = screen.getAllByRole("button", { name: "Accept" });

    act(() => {
      dispatchNativeClick(accepts[0]);
      dispatchNativeClick(accepts[1]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(2);
    expect(promotionBodies().map((body) => body.sourceTextRegionId)).toEqual([
      "row-1",
      "row-2",
    ]);
  });

  it.each(["succeeds", "fails"] as const)(
    "keeps same-id project B pending and error-free when project A Accept %s",
    async (settlement) => {
    const sharedId = "same-id";
    seedRegions([region(sharedId, regionType, 0)]);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    act(() => dispatchNativeClick(screen.getByRole("button", { name: "Accept" })));

    seedRegionsFor(
      OTHER_PUBLIC_ID,
      OTHER_PAGE_NUMBER,
      [region(sharedId, regionType, 0)],
    );
    act(() => {
      setViewerStoreStateForTest({
        projectId: 42,
        publicId: OTHER_PUBLIC_ID,
        isDemo: false,
        pageNumber: OTHER_PAGE_NUMBER,
      });
    });
    const acceptB = await screen.findByRole("button", { name: "Accept" });
    act(() => dispatchNativeClick(acceptB));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();

    await act(async () => {
      pending[0].resolve(
        settlement === "succeeds"
          ? promotionSuccess(sharedId, promotionType)
          : response(false, { error: "project A failed" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();
      expect(screen.queryByText("project A failed")).not.toBeInTheDocument();
    });

    await act(async () => {
      pending[1].resolve(promotionSuccess(sharedId, promotionType));
    });
    },
  );

  it("keeps same-id project B rejected when project A Reject rolls back", async () => {
    const sharedId = "same-id-reject";
    seedRegions([region(sharedId, regionType, 0)]);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    act(() => dispatchNativeClick(screen.getByRole("button", { name: "Reject" })));
    expect(pendingUrls).toEqual(["/api/pages/intelligence"]);

    seedRegionsFor(
      OTHER_PUBLIC_ID,
      OTHER_PAGE_NUMBER,
      [region(sharedId, regionType, 0)],
    );
    act(() => {
      setViewerStoreStateForTest({
        projectId: 42,
        publicId: OTHER_PUBLIC_ID,
        isDemo: false,
        pageNumber: OTHER_PAGE_NUMBER,
      });
    });
    act(() => dispatchNativeClick(screen.getByRole("button", { name: "Reject" })));
    expect(pendingUrls).toEqual([
      "/api/pages/intelligence",
      "/api/pages/intelligence",
    ]);
    expect(readPageIntelligence(queryClient, OTHER_PUBLIC_ID, OTHER_PAGE_NUMBER)
      ?.rejectedTextRegionIds).toEqual([sharedId]);

    await act(async () => {
      pending[0].resolve(response(false, { error: "project A reject failed" }));
    });
    expect(readPageIntelligence(queryClient, OTHER_PUBLIC_ID, OTHER_PAGE_NUMBER)
      ?.rejectedTextRegionIds).toEqual([sharedId]);
    expect(screen.queryByText("project A reject failed")).not.toBeInTheDocument();

    await act(async () => {
      pending[1].resolve(response(true, { ok: true }));
    });
  });

  it.each([
    ["Accept", "Reject", "/api/regions/promote"],
    ["Reject", "Accept", "/api/pages/intelligence"],
  ] as const)("gives the first same-task %s action authority over %s", async (
    firstLabel,
    secondLabel,
    expectedUrl,
  ) => {
    seedRegions([region("row-1", regionType, 0)]);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    const first = screen.getByRole("button", { name: firstLabel });
    const second = screen.getByRole("button", { name: secondLabel });

    act(() => {
      dispatchNativeClick(first);
      dispatchNativeClick(second);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pendingUrls).toEqual([expectedUrl]);
    await act(async () => {
      pending[0].resolve(
        expectedUrl === "/api/regions/promote"
          ? promotionSuccess("row-1", promotionType)
          : response(true, { ok: true }),
      );
    });
  });
});
