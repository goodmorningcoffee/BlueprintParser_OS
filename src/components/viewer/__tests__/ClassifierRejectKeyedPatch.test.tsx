// [TP-1 WP-1.B 2026-10-26] K03 (classic): Notes/Spec Reject and the automatic stale-id prune used to
// PATCH the WHOLE cached page intelligence. The server merges PATCH bodies shallowly, so every key in
// a stale cache (parsedRegions, textRegions, classifiedTables, …) was written back — Accept card A
// then Reject card B deleted A's committed region. Both now send only `rejectedTextRegionIds`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import NotesClassifier from "@/components/viewer/NotesClassifier";
import SpecClassifier from "@/components/viewer/SpecClassifier";
import { EMPTY_ACTIVE_PAGE_WINDOW, type ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { PageIntelligence, TextRegion, TextRegionType } from "@/types";

const PUBLIC_ID = "keyed-patch-project";
const PAGE_NUMBER = 3;

function region(id: string, type: TextRegionType, index: number): TextRegion {
  return {
    id, type, bbox: [0.1, 0.1 + index * 0.2, 0.7, 0.15], confidence: 0.9, wordCount: 4, lineCount: 1,
    headerText: `Region ${id}`, containedText: `Content for ${id}`,
  };
}

const cases: Array<{ label: string; Component: ComponentType<{ onEditInParser: () => void }>; regionType: TextRegionType }> = [
  { label: "NotesClassifier", Component: NotesClassifier, regionType: "notes-numbered" },
  { label: "SpecClassifier", Component: SpecClassifier, regionType: "spec-dense-columns" },
];

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seed(intelligence: PageIntelligence): void {
  const window: ActivePageWindow = { ...EMPTY_ACTIVE_PAGE_WINDOW, pageIntelligence: { [PAGE_NUMBER]: intelligence } };
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), window);
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData(queryKeys.yoloTags.all(PUBLIC_ID), []);
}

function patchBodies(): unknown[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/api/pages/intelligence")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  setViewerStoreStateForTest({ projectId: 41, publicId: PUBLIC_ID, isDemo: false, pageNumber: PAGE_NUMBER });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(cases)("$label PATCHes one key only (K03)", ({ Component, regionType }) => {
  it("Reject sends only rejectedTextRegionIds — never the cached parsedRegions or other keys", async () => {
    // A stale cache: it still has the pre-Accept parsedRegions and computed keys.
    seed({
      textRegions: [region("A", regionType, 0), region("B", regionType, 1)],
      parsedRegions: [],
      rejectedTextRegionIds: ["earlier"],
      classifiedTables: [],
    } as unknown as PageIntelligence);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    // "earlier" is stale (no such text region) → the one-shot prune fires first, also keyed.
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({
      publicId: PUBLIC_ID, pageNumber: PAGE_NUMBER, intelligence: { rejectedTextRegionIds: [] },
    });

    const rejects = screen.getAllByRole("button", { name: "Reject" });
    await act(async () => { rejects[1].click(); });
    await waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toEqual({
      publicId: PUBLIC_ID, pageNumber: PAGE_NUMBER, intelligence: { rejectedTextRegionIds: ["B"] },
    });
  });
});
