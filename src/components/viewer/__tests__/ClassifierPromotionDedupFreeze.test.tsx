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
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { PageIntelligence, TextRegion, TextRegionType } from "@/types";

const PUBLIC_ID = "classifier-project";
const PAGE_NUMBER = 4;

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
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedRegions(regions: TextRegion[]): void {
  const intelligence: PageIntelligence = { textRegions: regions };
  const window: ActivePageWindow = {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: { [PAGE_NUMBER]: intelligence },
  };
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), window);
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
  return fetchMock.mock.calls.map(([, init]) =>
    JSON.parse(String((init as RequestInit).body)),
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/regions/promote") {
      throw new Error(`unexpected classifier request: ${String(url)}`);
    }
    const request = deferred<Response>();
    pending.push(request);
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
});
