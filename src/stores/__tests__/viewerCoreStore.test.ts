import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useViewerCoreStore,
  type ViewerCoreData,
  type ViewerCoreState,
} from "@/stores/viewerCoreStore";

const DATA_FIELDS = [
  "pageNumber",
  "numPages",
  "scale",
  "pendingCenter",
  "pageDimensions",
] as const satisfies readonly (keyof ViewerCoreData)[];

const ACTION_FIELDS = [
  "setPage",
  "setNumPages",
  "zoomIn",
  "zoomOut",
  "zoomFit",
  "clearPendingCenter",
  "setScale",
  "setPageDimensions",
  "resetViewerCoreState",
] as const satisfies readonly (keyof ViewerCoreState)[];

beforeEach(() => {
  useViewerCoreStore.setState(useViewerCoreStore.getInitialState(), true);
});

describe("viewerCoreStore — dedicated geometry owner", () => {
  it("has exactly five data fields, nine actions, and the frozen defaults", () => {
    const state = useViewerCoreStore.getState();
    const dataFields = Object.entries(state)
      .filter(([, value]) => typeof value !== "function")
      .map(([field]) => field)
      .sort();
    const actionFields = Object.entries(state)
      .filter(([, value]) => typeof value === "function")
      .map(([field]) => field)
      .sort();

    expect(dataFields).toEqual([...DATA_FIELDS].sort());
    expect(actionFields).toEqual([...ACTION_FIELDS].sort());
    expect(state).toMatchObject({
      pageNumber: 1,
      numPages: 0,
      scale: 1,
      pendingCenter: false,
      pageDimensions: {},
    });
  });

  it("clamps pages against the live count, including the zero-page fallback", () => {
    const actions = useViewerCoreStore.getState();
    actions.setPage(99);
    expect(useViewerCoreStore.getState().pageNumber).toBe(1);

    actions.setNumPages(7);
    actions.setPage(0);
    expect(useViewerCoreStore.getState().pageNumber).toBe(1);
    actions.setPage(99);
    expect(useViewerCoreStore.getState().pageNumber).toBe(7);
    actions.setPage(4);
    expect(useViewerCoreStore.getState().pageNumber).toBe(4);
  });

  it("keeps setNumPages raw and lets setScale bypass the interactive zoom caps", () => {
    useViewerCoreStore.setState({ pageNumber: 9, numPages: 20 });
    useViewerCoreStore.getState().setNumPages(3);
    expect(useViewerCoreStore.getState()).toMatchObject({ pageNumber: 9, numPages: 3 });

    useViewerCoreStore.getState().setScale(25);
    expect(useViewerCoreStore.getState().scale).toBe(25);
    useViewerCoreStore.getState().setScale(-4);
    expect(useViewerCoreStore.getState().scale).toBe(-4);
  });

  it("preserves the zoom factor, caps, and fit's flag-only behavior", () => {
    const actions = useViewerCoreStore.getState();
    actions.setScale(9.99);
    actions.zoomIn();
    expect(useViewerCoreStore.getState().scale).toBe(10);

    actions.setScale(0.201);
    actions.zoomOut();
    expect(useViewerCoreStore.getState().scale).toBe(0.2);

    actions.setScale(1);
    actions.zoomIn();
    expect(useViewerCoreStore.getState().scale).toBeCloseTo(1 / 0.95);
    actions.zoomOut();
    expect(useViewerCoreStore.getState().scale).toBeCloseTo(1);

    actions.setScale(3.25);
    actions.zoomFit();
    expect(useViewerCoreStore.getState()).toMatchObject({
      scale: 3.25,
      pendingCenter: true,
    });
    actions.clearPendingCenter();
    expect(useViewerCoreStore.getState().pendingCenter).toBe(false);
  });

  it("retains dimension-map identity and publishes nothing for an equal measurement", () => {
    const listener = vi.fn();
    const unsubscribe = useViewerCoreStore.subscribe(listener);
    const actions = useViewerCoreStore.getState();

    actions.setPageDimensions(2, 1000, 700);
    const firstMap = useViewerCoreStore.getState().pageDimensions;
    expect(firstMap).toEqual({ 2: { width: 1000, height: 700 } });
    expect(listener).toHaveBeenCalledTimes(1);

    actions.setPageDimensions(2, 1000, 700);
    expect(useViewerCoreStore.getState().pageDimensions).toBe(firstMap);
    expect(listener).toHaveBeenCalledTimes(1);

    actions.setPageDimensions(2, 1001, 700);
    expect(useViewerCoreStore.getState().pageDimensions).not.toBe(firstMap);
    expect(useViewerCoreStore.getState().pageDimensions[2]).toEqual({
      width: 1001,
      height: 700,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("preserves unrelated dimension entries and their object references", () => {
    useViewerCoreStore.getState().setPageDimensions(1, 800, 600);
    const firstEntry = useViewerCoreStore.getState().pageDimensions[1];

    useViewerCoreStore.getState().setPageDimensions(2, 1000, 700);
    const withSecond = useViewerCoreStore.getState().pageDimensions;
    expect(withSecond).toEqual({
      1: { width: 800, height: 600 },
      2: { width: 1000, height: 700 },
    });
    expect(withSecond[1]).toBe(firstEntry);

    useViewerCoreStore.getState().setPageDimensions(2, 1001, 700);
    expect(useViewerCoreStore.getState().pageDimensions[1]).toBe(firstEntry);
  });

  it("publishes same/clamped values and repeated cap/fit/clear actions", () => {
    useViewerCoreStore.setState({
      pageNumber: 1,
      numPages: 0,
      scale: 10,
      pendingCenter: false,
    });
    const listener = vi.fn();
    const unsubscribe = useViewerCoreStore.subscribe(listener);
    const actions = useViewerCoreStore.getState();

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
    expect(useViewerCoreStore.getState()).toMatchObject({
      pageNumber: 1,
      numPages: 0,
      scale: 0.2,
      pendingCenter: false,
    });
    unsubscribe();
  });

  it("resets all five core values with fresh containers and stable actions", () => {
    const dirtyDimensions = { 8: { width: 900, height: 1200 } };
    useViewerCoreStore.setState({
      pageNumber: 8,
      numPages: 20,
      scale: 2.5,
      pendingCenter: true,
      pageDimensions: dirtyDimensions,
    });
    const before = useViewerCoreStore.getState();
    const actionRefs = Object.fromEntries(ACTION_FIELDS.map((field) => [field, before[field]]));

    before.resetViewerCoreState();
    const after = useViewerCoreStore.getState();
    expect(after).toMatchObject({
      pageNumber: 1,
      numPages: 0,
      scale: 1,
      pendingCenter: false,
      pageDimensions: {},
    });
    expect(after.pageDimensions).not.toBe(dirtyDimensions);
    for (const field of ACTION_FIELDS) {
      expect(after[field], field).toBe(actionRefs[field]);
    }

    const firstResetDimensions = after.pageDimensions;
    after.resetViewerCoreState();
    expect(useViewerCoreStore.getState().pageDimensions).not.toBe(firstResetDimensions);
    expect(useViewerCoreStore.getState().pendingCenter).toBe(false);
  });
});
