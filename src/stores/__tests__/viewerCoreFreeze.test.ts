// [refactor jul11 P2.3 V1] Post-flip characterization for the page/zoom/dimensions owner.
// Tool interaction (`mode`/temp-pan) remains deliberately excluded because mode changes tear down
// competing tools and therefore migrate with toolStore.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerCoreStore as useViewerStore } from "@/stores/viewerCoreStore";
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

  it("keeps setNumPages raw and lets setScale bypass the interactive zoom caps", () => {
    useViewerStore.setState({ pageNumber: 9, numPages: 20 });
    useViewerStore.getState().setNumPages(3);
    expect(useViewerStore.getState()).toMatchObject({ pageNumber: 9, numPages: 3 });

    useViewerStore.getState().setScale(25);
    expect(useViewerStore.getState().scale).toBe(25);
    useViewerStore.getState().setScale(-4);
    expect(useViewerStore.getState().scale).toBe(-4);
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

  it("preserves unrelated dimension entries and their object references", () => {
    useViewerStore.getState().setPageDimensions(1, 800, 600);
    const firstEntry = useViewerStore.getState().pageDimensions[1];

    useViewerStore.getState().setPageDimensions(2, 1000, 700);
    const withSecond = useViewerStore.getState().pageDimensions;
    expect(withSecond).toEqual({
      1: { width: 800, height: 600 },
      2: { width: 1000, height: 700 },
    });
    expect(withSecond[1]).toBe(firstEntry);

    useViewerStore.getState().setPageDimensions(2, 1001, 700);
    expect(useViewerStore.getState().pageDimensions[1]).toBe(firstEntry);
  });

  it("publishes same/clamped values and repeated cap/fit/clear actions", () => {
    useViewerStore.setState({
      pageNumber: 1,
      numPages: 0,
      scale: 10,
      pendingCenter: false,
    });
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);
    const actions = useViewerStore.getState();

    actions.setPage(1);
    actions.setPage(99);
    actions.setNumPages(0);
    actions.zoomIn();
    actions.setScale(0.2);
    actions.zoomOut();
    actions.zoomFit();
    actions.zoomFit();
    actions.clearPendingCenter();
    actions.clearPendingCenter();

    expect(listener).toHaveBeenCalledTimes(10);
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 1,
      numPages: 0,
      scale: 0.2,
      pendingCenter: false,
    });
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
      pendingCenter: false,
      pageDimensions: {},
    });
  });
});
