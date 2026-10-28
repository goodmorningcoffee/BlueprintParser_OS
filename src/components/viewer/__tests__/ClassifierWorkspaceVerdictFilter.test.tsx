// [table pipeline WP-3.F, C2-M12] The classic Notes/Spec cards honour workspace verdicts: a text region the
// workspace rejected leaves the card list, matched by content (type + IoU), not by the positional id. The
// verdicts are read only while the cached parse-engine flags say the workspace is on, so a classic card on its
// own adds no request. All strings are synthetic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import NotesClassifier from "@/components/viewer/NotesClassifier";
import SpecClassifier from "@/components/viewer/SpecClassifier";
import { textRegionKey } from "@/lib/parse-engine/text-region-verdicts";
import { EMPTY_ACTIVE_PAGE_WINDOW, type ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { parseEngineFlagsKey } from "@/queries/useTextRegionVerdicts";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { PageIntelligence, TextRegion, TextRegionType } from "@/types";

const PUBLIC_ID = "verdict-filter-project";
const PAGE_NUMBER = 2;

function region(id: string, type: TextRegionType, index: number): TextRegion {
  return {
    id, type, bbox: [0.1, 0.1 + index * 0.3, 0.6, 0.2], confidence: 0.9, wordCount: 4, lineCount: 1,
    headerText: `Block ${id}`, containedText: `Content ${id}`,
  };
}

const cases: Array<{ label: string; Component: ComponentType<{ onEditInParser: () => void }>; regionType: TextRegionType }> = [
  { label: "NotesClassifier", Component: NotesClassifier, regionType: "notes-numbered" },
  { label: "SpecClassifier", Component: SpecClassifier, regionType: "spec-dense-columns" },
];

const FLAGS_ON = {
  killSwitch: false, cropCache: true,
  tools: { tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy", notesAuto: "legacy", specAuto: "legacy", workspace: "engine" },
};

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

const verdictCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/parse-engine/verdicts"));

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  setViewerStoreStateForTest({ projectId: 51, publicId: PUBLIC_ID, isDemo: false, pageNumber: PAGE_NUMBER });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(cases)("$label honours workspace verdicts (C2-M12)", ({ Component, regionType }) => {
  it("hides a workspace-rejected region matched by content, keeps the others", async () => {
    // The workspace rejected block A at a slightly different box (re-OCR wobble) and under no id at all.
    const keyA = textRegionKey(regionType, [0.1, 0.1, 0.7, 0.3]);
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (String(url).includes("/parse-engine/verdicts")
        ? { page: PAGE_NUMBER, verdicts: { [keyA]: { verdict: "reject", type: regionType, b: [0.1, 0.1, 0.705, 0.3], at: "t" } } }
        : { ok: true }),
    }) as Response);
    // Seeded under the tuple the workspace host's flags fetch fills (WP-3.L `workspaceKeys.flags`), spelled
    // out here so this test fails if the two keys drift apart again (verify HIGH-2).
    queryClient.setQueryData(["project", PUBLIC_ID, "parseEngine", "flags"], FLAGS_ON);
    expect(parseEngineFlagsKey(PUBLIC_ID)).toEqual(["project", PUBLIC_ID, "parseEngine", "flags"]);
    seed({ textRegions: [region("A", regionType, 0), region("B", regionType, 1)], parsedRegions: [] } as unknown as PageIntelligence);
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1));
    expect(verdictCalls()).toHaveLength(1);
    expect(String(verdictCalls()[0][0])).toBe(`/api/projects/${PUBLIC_ID}/parse-engine/verdicts?page=${PAGE_NUMBER}`);
  });

  it("adds no request and hides nothing while the workspace flag is not cached (or off)", async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response);
    seed({ textRegions: [region("A", regionType, 0), region("B", regionType, 1)], parsedRegions: [] } as unknown as PageIntelligence);
    const { unmount } = render(<Component onEditInParser={vi.fn()} />, { wrapper });
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(2);
    unmount();
    queryClient.setQueryData(parseEngineFlagsKey(PUBLIC_ID), { ...FLAGS_ON, tools: { ...FLAGS_ON.tools, workspace: "legacy" } });
    render(<Component onEditInParser={vi.fn()} />, { wrapper });
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(2);
    queryClient.setQueryData(parseEngineFlagsKey(PUBLIC_ID), { ...FLAGS_ON, killSwitch: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(verdictCalls()).toHaveLength(0);
  });
});
