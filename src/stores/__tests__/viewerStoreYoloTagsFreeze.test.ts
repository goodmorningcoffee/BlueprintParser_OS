// [refactor jul11 P2.2⑨ C1] YOLO TAGS BEHAVIOR FREEZE.
//
// These cases pin the old Zustand-backed domain before ownership moves to the project-keyed Query
// cache. The basic merge/dedup cases remain in viewerStore.test.ts until C3 moves them beside the
// facade. This file covers the load-bearing timing and mixed data/UI action behavior that was
// previously untested: local-first writes, the exact trailing debounce, demo gating, and browse
// navigation. C3 changes only the backing seam used by these assertions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerStore } from "@/stores/viewerStore";
import type { YoloTag } from "@/types";

const fetchMock = vi.fn();

function tag(id: string, instances: YoloTag["instances"] = []): YoloTag {
  return {
    id,
    name: id,
    tagText: id,
    yoloClass: "door",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    instances,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({ publicId: "project-A", isDemo: false });
});

afterEach(() => {
  // The legacy timer has no public cancel seam. Draining the fake queue here makes every test
  // hermetic; C2's coordinator will gain an exact project cleanup API.
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("viewerStore yoloTags — debounced whole-array persistence", () => {
  it("publishes locally in the same tick, waits 500ms, and sends the exact project/body", async () => {
    useViewerStore.getState().addYoloTag(tag("D-101"));

    expect(useViewerStore.getState().yoloTags.map((row) => row.id)).toEqual(["D-101"]);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-A", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yoloTags: [tag("D-101")] }),
    });
  });

  it("coalesces a burst and persists the latest aggregate snapshot", async () => {
    useViewerStore.getState().addYoloTag(tag("D-101"));
    await vi.advanceTimersByTimeAsync(300);
    useViewerStore.getState().addYoloTag(tag("D-102"));
    useViewerStore.getState().updateYoloTag("D-101", { name: "Door 101" });
    useViewerStore.getState().removeYoloTag("D-102");

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      yoloTags: [{ ...tag("D-101"), name: "Door 101" }],
    });
  });

  it("keeps demo edits local and never sends their whole-array PUT", async () => {
    useViewerStore.setState({ isDemo: true });
    useViewerStore.getState().addYoloTag(tag("demo-local"));

    expect(useViewerStore.getState().yoloTags).toEqual([tag("demo-local")]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps optimistic rows when the transport rejects and logs the failure", async () => {
    const error = new Error("offline");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(error);

    useViewerStore.getState().addYoloTag(tag("local-survivor"));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(useViewerStore.getState().yoloTags).toEqual([tag("local-survivor")]);
    expect(consoleError).toHaveBeenCalledWith("[yoloTags] Save failed:", error);
  });
});

describe("viewerStore yoloTags — browse navigation", () => {
  it("is a full no-op for a missing tag", () => {
    useViewerStore.setState({ pageNumber: 7, activeYoloTagId: "keep", tagBrowseIndex: 3 });
    useViewerStore.getState().tagBrowseNavigate("missing", 9);
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 7,
      activeYoloTagId: "keep",
      tagBrowseIndex: 3,
    });
  });

  it("opens a zero-instance tag without navigating and clears a stale highlight", () => {
    useViewerStore.setState({
      yoloTags: [tag("empty")],
      pageNumber: 7,
      llmHighlight: { pageNumber: 7, bbox: [0, 0, 1, 1], label: "stale" },
    });

    useViewerStore.getState().tagBrowseNavigate("empty", 99);
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 7,
      activeYoloTagId: "empty",
      tagBrowseId: "empty",
      tagBrowseIndex: 0,
      llmHighlight: null,
    });
  });

  it("wraps negative/positive indices and publishes page plus the exact label", () => {
    const instances: YoloTag["instances"] = [
      { pageNumber: 2, annotationId: 11, bbox: [0.1, 0.1, 0.2, 0.2], confidence: 1 },
      { pageNumber: 5, annotationId: 12, bbox: [0.3, 0.3, 0.4, 0.4], confidence: 1 },
    ];
    useViewerStore.setState({ yoloTags: [tag("D-201", instances)] });

    useViewerStore.getState().tagBrowseNavigate("D-201", -1);
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 5,
      activeYoloTagId: "D-201",
      tagBrowseId: "D-201",
      tagBrowseIndex: 1,
      llmHighlight: {
        pageNumber: 5,
        bbox: [0.3, 0.3, 0.4, 0.4],
        label: "D-201 — 2 of 2",
      },
    });

    useViewerStore.getState().tagBrowseNavigate("D-201", 2);
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 2,
      tagBrowseIndex: 0,
      llmHighlight: { label: "D-201 — 1 of 2" },
    });
  });
});

