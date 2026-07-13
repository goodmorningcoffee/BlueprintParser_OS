// @vitest-environment jsdom
// [refactor jul11 P2.4 C3] Real ParsedTableItem witness for the typed map transport flip.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ParsedTableItem from "@/components/viewer/ParsedTableItem";
import { queryKeys } from "@/queries/queryKeys";
import {
  clearYoloTagsProject,
  readYoloTags,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { YoloTag } from "@/types";

const PUBLIC_ID = "project-A";
const PAGE = 4;

function existingTag(): YoloTag {
  return {
    id: "existing-D1",
    name: "D1",
    tagText: "D1",
    yoloClass: "",
    yoloModel: "",
    source: "schedule",
    scope: "project",
    pageNumber: PAGE,
    instances: [],
  };
}

const table = {
  pageNum: PAGE,
  name: "Door Schedule",
  category: "door-schedule",
  rowCount: 2,
  colCount: 2,
  csiTags: [],
  region: {
    id: "schedule-region",
    type: "schedule",
    category: "door-schedule",
    bbox: [0.1, 0.2, 0.7, 0.8],
    csiTags: [],
    data: {
      headers: ["Tag", "Description"],
      rows: [
        { Tag: "D1", Description: "Existing door" },
        { Tag: "D2", Description: "New door" },
      ],
      tagColumn: "Tag",
      tableName: "Door Schedule",
    },
  },
};

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderItem(): void {
  render(
    <ParsedTableItem
      table={table}
      pageNames={{}}
      isCurrentPage
      onNavigate={vi.fn()}
      yoloTags={[existingTag()]}
      pageNumber={PAGE}
      publicId={PUBLIC_ID}
      isDemo={false}
      cellStructureOperation={{
        detect: vi.fn(async () => false),
        clear: vi.fn(),
        loadingKey: null,
        busy: false,
        errorKey: null,
        error: null,
      }}
    />,
    { wrapper },
  );
  fireEvent.click(screen.getByRole("button", { name: "▶" }));
  fireEvent.click(screen.getByRole("button", { name: /Map Tags/ }));
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    pageDrawingNumbers: {},
  });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [existingTag()] });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ParsedTableItem C3 map transport", () => {
  it("filters live duplicates, sends the exact body, creates a project tag, and closes on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        results: {
          D2: [{
            pageNumber: PAGE,
            annotationId: 22,
            bbox: [0.2, 0.3, 0.25, 0.35],
            confidence: 0.97,
          }],
        },
        dropCounts: {},
        strictnessMode: "balanced",
      }),
    } as unknown as Response);
    renderItem();

    fireEvent.click(screen.getByRole("button", { name: "Run Mapping" }));

    await waitFor(() => expect(readYoloTags(queryClient, PUBLIC_ID)).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/projects/${PUBLIC_ID}/map-tags-batch`);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      tags: ["D2"],
      itemType: "text-only",
      strictnessMode: "balanced",
      drawingNumberPrefixes: [],
    });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("signal");
    expect(readYoloTags(queryClient, PUBLIC_ID)[1]).toMatchObject({
      tagText: "D2",
      source: "schedule",
      scope: "project",
      description: "New door",
      instances: [{ annotationId: 22 }],
    });
    expect(screen.queryByRole("button", { name: "Run Mapping" })).not.toBeInTheDocument();
  });

  it("surfaces the exact non-OK status, consumes no body, writes nothing, and keeps retry UI", async () => {
    const json = vi.fn().mockRejectedValue(new Error("must not parse"));
    fetchMock.mockResolvedValue({ ok: false, status: 503, json } as unknown as Response);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderItem();
    const before = readYoloTags(queryClient, PUBLIC_ID);

    fireEvent.click(screen.getByRole("button", { name: "Run Mapping" }));

    expect(await screen.findByText("Server error: 503")).toBeInTheDocument();
    expect(json).not.toHaveBeenCalled();
    expect(readYoloTags(queryClient, PUBLIC_ID)).toBe(before);
    expect(screen.getByRole("button", { name: "Run Mapping" })).toBeEnabled();
  });
});
