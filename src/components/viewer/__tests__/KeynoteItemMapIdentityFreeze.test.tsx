// @vitest-environment jsdom

// [refactor jul11 P2.4 B3b] One retained-event identity witness for KeynoteItem Map Tags.
// The row's render identity owns its duplicate read, request, and guarded publication callback.
// A same-turn project change must not splice the new session cache into the old row's request.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import KeynoteItem from "@/components/viewer/KeynoteItem";
import {
  readYoloTags,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { useSessionStore } from "@/stores/sessionStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { YoloTag } from "@/types";

const PROJECT_A = "project-A";
const PROJECT_B = "project-B";

function tag(id: string, tagText: string): YoloTag {
  return {
    id,
    name: tagText,
    tagText,
    yoloClass: "",
    yoloModel: "",
    source: "keynote",
    scope: "project",
    pageNumber: 4,
    instances: [],
  };
}

function match(annotationId: number) {
  return {
    pageNumber: 4,
    annotationId,
    bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number],
    confidence: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    publicId: PROJECT_A,
    projectId: 41,
    isDemo: true,
    pageNumber: 4,
    pageDrawingNumbers: {},
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KeynoteItem Map Tags identity", () => {
  it("uses the retained row's project for duplicate filtering and request after a same-turn switch", async () => {
    const aExisting = tag("a-existing", "A-EXISTING");
    const bExisting = tag("b-existing", "B-EXISTING");
    seedYoloTagsFromBootstrap(queryClient, PROJECT_A, { yoloTags: [aExisting] });
    seedYoloTagsFromBootstrap(queryClient, PROJECT_B, { yoloTags: [bExisting] });

    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    render(
      <KeynoteItem
        keynote={{
          pageNumber: 4,
          tableName: "Keynotes",
          keys: [
            { key: "A-EXISTING", description: "Already mapped in A" },
            { key: "B-EXISTING", description: "Only mapped in B" },
            { key: "NEW", description: "New in both" },
          ],
        }}
        pageNames={{}}
        isCurrentPage
        onNavigate={vi.fn()}
        activeHighlight={null}
        onHighlight={vi.fn()}
        onDelete={vi.fn()}
        publicId={PROJECT_A}
        yoloTags={[aExisting]}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "▶" }));
    fireEvent.click(screen.getByRole("button", { name: /Map Tags/ }));
    const retainedRunButton = screen.getByRole("button", { name: "Run Mapping" });
    const projectABefore = readYoloTags(queryClient, PROJECT_A);
    const projectBBefore = readYoloTags(queryClient, PROJECT_B);

    // Zustand publishes synchronously, while React commits this subscribed render after the act.
    // Dispatching the retained DOM node in the same act exercises the old A handler with live B.
    act(() => {
      useSessionStore.setState({ publicId: PROJECT_B });
      retainedRunButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/projects/${PROJECT_A}/map-tags-batch`);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      tags: ["B-EXISTING", "NEW"],
      itemType: "text-only",
      strictnessMode: "balanced",
      drawingNumberPrefixes: [],
    });

    const responseJson = vi.fn(async () => ({
      results: {
        "B-EXISTING": [match(1)],
        NEW: [match(2)],
      },
    }));
    await act(async () => {
      pending.resolve({
        ok: true,
        status: 200,
        json: responseJson,
      } as unknown as Response);
    });

    // The retained A action's existing epoch/live guard rejects adoption after the switch.
    expect(responseJson).toHaveBeenCalledTimes(1);
    expect(readYoloTags(queryClient, PROJECT_A)).toBe(projectABefore);
    expect(readYoloTags(queryClient, PROJECT_B)).toBe(projectBBefore);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("undefined"))).toBe(false);
  });
});
