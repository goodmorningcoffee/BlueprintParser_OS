// [refactor jul11 P2.3 S0] Backing-specific characterization for the page/zoom/dimensions core.
// This file flips to viewerCore at the ownership commit; until then it proves the extraction has an
// exact behavioral target. Tool interaction (`mode`/temp-pan) is deliberately excluded: the fresh
// census assigns it to toolStore because mode changes tear down competing tools.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerStore } from "@/stores/viewerStore";
import { resetProjectData } from "@/stores/viewerCommands";

beforeEach(() => {
  resetProjectData();
  useViewerStore.setState({ pendingCenter: false });
});

describe("P2.3 viewerCore characterization", () => {
  it("pins defaults and page clamping, including the zero-page fallback", () => {
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 1,
      numPages: 0,
      scale: 1,
      pendingCenter: false,
      pageDimensions: {},
    });

    useViewerStore.getState().setPage(99);
    expect(useViewerStore.getState().pageNumber).toBe(1);

    useViewerStore.getState().setNumPages(7);
    useViewerStore.getState().setPage(0);
    expect(useViewerStore.getState().pageNumber).toBe(1);
    useViewerStore.getState().setPage(99);
    expect(useViewerStore.getState().pageNumber).toBe(7);
    useViewerStore.getState().setPage(4);
    expect(useViewerStore.getState().pageNumber).toBe(4);
  });

  it("pins zoom factor/caps and fit's flag-only behavior", () => {
    useViewerStore.getState().setScale(9.99);
    useViewerStore.getState().zoomIn();
    expect(useViewerStore.getState().scale).toBe(10);

    useViewerStore.getState().setScale(0.201);
    useViewerStore.getState().zoomOut();
    expect(useViewerStore.getState().scale).toBe(0.2);

    useViewerStore.getState().setScale(1);
    useViewerStore.getState().zoomIn();
    expect(useViewerStore.getState().scale).toBeCloseTo(1 / 0.95);
    useViewerStore.getState().zoomOut();
    expect(useViewerStore.getState().scale).toBeCloseTo(1);

    useViewerStore.getState().setScale(3.25);
    useViewerStore.getState().zoomFit();
    expect(useViewerStore.getState()).toMatchObject({ scale: 3.25, pendingCenter: true });
    useViewerStore.getState().clearPendingCenter();
    expect(useViewerStore.getState().pendingCenter).toBe(false);
  });

  it("preserves page-dimension identity for an equal measurement", () => {
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);

    useViewerStore.getState().setPageDimensions(2, 1000, 700);
    const firstMap = useViewerStore.getState().pageDimensions;
    expect(firstMap).toEqual({ 2: { width: 1000, height: 700 } });
    expect(listener).toHaveBeenCalledTimes(1);

    useViewerStore.getState().setPageDimensions(2, 1000, 700);
    expect(useViewerStore.getState().pageDimensions).toBe(firstMap);
    expect(listener).toHaveBeenCalledTimes(1);

    useViewerStore.getState().setPageDimensions(2, 1001, 700);
    expect(useViewerStore.getState().pageDimensions).not.toBe(firstMap);
    expect(useViewerStore.getState().pageDimensions[2]).toEqual({ width: 1001, height: 700 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("reset returns every core value to its current project-open default", () => {
    useViewerStore.setState({
      pageNumber: 8,
      numPages: 20,
      scale: 2.5,
      pendingCenter: true,
      pageDimensions: { 8: { width: 900, height: 1200 } },
    });

    resetProjectData();
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 1,
      numPages: 0,
      scale: 1,
      pageDimensions: {},
    });
    // Current resetProjectData intentionally omits pendingCenter. Preserve that oddity in P2.3;
    // P2.5's explicit reset-policy ledger decides whether it should change.
    expect(useViewerStore.getState().pendingCenter).toBe(true);
  });
});
