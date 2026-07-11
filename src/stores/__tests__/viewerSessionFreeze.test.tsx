// [refactor jul11 P2.3] Ownership-flip characterization for the dedicated sessionStore. It pins
// exact defaults, reference semantics, coordinated reset output, compatibility hooks, and the live
// demo policy without reaching back through the UI/tool store.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerStore } from "@/stores/viewerStore";
import {
  SESSION_TEST_STATE_KEYS,
  partitionViewerStoreTestState,
  setViewerStoreStateForTest,
} from "@/test/viewer-store-state";
import { resetProjectData } from "@/stores/viewerCommands";
import {
  isDemoFeatureEnabled,
  useProject,
  useSessionStore,
} from "@/stores/sessionStore";

function sessionData() {
  const state = useSessionStore.getState();
  return {
    projectId: state.projectId,
    publicId: state.publicId,
    dataUrl: state.dataUrl,
    isDemo: state.isDemo,
    demoFeatureConfig: state.demoFeatureConfig,
    pageNames: state.pageNames,
    pageDrawingNumbers: state.pageDrawingNumbers,
    showLabelingWizard: state.showLabelingWizard,
    labelingWizardStep: state.labelingWizardStep,
    labelingSessions: state.labelingSessions,
    labelingCredentials: state.labelingCredentials,
  };
}

beforeEach(() => {
  resetProjectData();
});

describe("P2.3 sessionStore ownership characterization", () => {
  it("pins the exact session defaults", () => {
    expect(SESSION_TEST_STATE_KEYS).toEqual([
      "projectId",
      "publicId",
      "dataUrl",
      "isDemo",
      "demoFeatureConfig",
      "pageNames",
      "pageDrawingNumbers",
      "showLabelingWizard",
      "labelingWizardStep",
      "labelingSessions",
      "labelingCredentials",
    ]);
    expect(sessionData()).toEqual({
      projectId: 0,
      publicId: "",
      dataUrl: "",
      isDemo: false,
      demoFeatureConfig: null,
      pageNames: {},
      pageDrawingNumbers: {},
      showLabelingWizard: false,
      labelingWizardStep: 1,
      labelingSessions: [],
      labelingCredentials: null,
    });
  });

  it("preserves replacement setters and setPageName's immutable one-key merge", () => {
    const pageNames = { 1: "Cover", 2: "Plans" };
    const drawingNumbers = { 1: "A-001", 2: null };
    const demoConfig = { bucketFill: false };
    const sessions = [
      { labelStudioUrl: "https://labels.test/projects/1", pageRange: "1-3", taskCount: 3 },
    ];
    const credentials = { email: "labeler@example.test", password: "secret" };
    const state = useSessionStore.getState();

    state.setProjectId(42);
    state.setPublicId("project-public-id");
    state.setDataUrl("company/project.pdf");
    state.setIsDemo(true);
    state.setDemoFeatureConfig(demoConfig);
    state.setPageNames(pageNames);
    state.setPageDrawingNumbers(drawingNumbers);
    state.setShowLabelingWizard(true);
    state.setLabelingWizardStep(3);
    state.setLabelingSessions(sessions);
    state.setLabelingCredentials(credentials);

    expect(sessionData()).toEqual({
      projectId: 42,
      publicId: "project-public-id",
      dataUrl: "company/project.pdf",
      isDemo: true,
      demoFeatureConfig: demoConfig,
      pageNames,
      pageDrawingNumbers: drawingNumbers,
      showLabelingWizard: true,
      labelingWizardStep: 3,
      labelingSessions: sessions,
      labelingCredentials: credentials,
    });
    expect(useSessionStore.getState().pageNames).toBe(pageNames);
    expect(useSessionStore.getState().pageDrawingNumbers).toBe(drawingNumbers);
    expect(useSessionStore.getState().demoFeatureConfig).toBe(demoConfig);
    expect(useSessionStore.getState().labelingSessions).toBe(sessions);
    expect(useSessionStore.getState().labelingCredentials).toBe(credentials);

    state.setPageName(2, "Floor Plans");
    expect(pageNames).toEqual({ 1: "Cover", 2: "Plans" });
    expect(useSessionStore.getState().pageNames).not.toBe(pageNames);
    expect(useSessionStore.getState().pageNames).toEqual({ 1: "Cover", 2: "Floor Plans" });

    state.setLabelingCredentials(null);
    expect(useSessionStore.getState().labelingCredentials).toBeNull();
  });

  it("resetProjectData clears every session field and allocates fresh containers", () => {
    const oldPageNames = { 1: "Old" };
    const oldDrawingNumbers = { 1: "M-101" };
    const oldSessions = [
      { labelStudioUrl: "https://labels.test/projects/9", pageRange: "all", taskCount: 1 },
    ];
    setViewerStoreStateForTest({
      projectId: 7,
      publicId: "old-project",
      dataUrl: "old/data.pdf",
      isDemo: true,
      demoFeatureConfig: { chat: false },
      pageNames: oldPageNames,
      pageDrawingNumbers: oldDrawingNumbers,
      showLabelingWizard: true,
      labelingWizardStep: 4,
      labelingSessions: oldSessions,
      labelingCredentials: { email: "old@example.test", password: "old" },
    });

    resetProjectData();

    expect(sessionData()).toEqual({
      projectId: 0,
      publicId: "",
      dataUrl: "",
      isDemo: false,
      demoFeatureConfig: null,
      pageNames: {},
      pageDrawingNumbers: {},
      showLabelingWizard: false,
      labelingWizardStep: 1,
      labelingSessions: [],
      labelingCredentials: null,
    });
    expect(useSessionStore.getState().pageNames).not.toBe(oldPageNames);
    expect(useSessionStore.getState().pageDrawingNumbers).not.toBe(oldDrawingNumbers);
    expect(useSessionStore.getState().labelingSessions).not.toBe(oldSessions);
  });

  it("keeps the useProject compatibility projection exact and live", () => {
    const hook = renderHook(() => useProject());

    act(() => {
      setViewerStoreStateForTest({
        projectId: 8,
        publicId: "public-8",
        dataUrl: "projects/8.pdf",
        isDemo: true,
        demoFeatureConfig: { labeling: false },
        pageNames: { 1: "A-101" },
      });
    });

    expect(hook.result.current).toEqual({
      projectId: 8,
      publicId: "public-8",
      dataUrl: "projects/8.pdf",
      isDemo: true,
      demoFeatureConfig: { labeling: false },
      pageNames: { 1: "A-101" },
    });
  });
});

describe("P2.3 demo feature compatibility policy", () => {
  it("is live, non-demo enabled, and default-enabled for missing demo keys", () => {
    setViewerStoreStateForTest({
      isDemo: false,
      demoFeatureConfig: { bucketFill: false },
    });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);

    useSessionStore.getState().setIsDemo(true);
    setViewerStoreStateForTest({ demoFeatureConfig: null });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);

    useSessionStore.getState().setDemoFeatureConfig({ chat: false });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);
    expect(isDemoFeatureEnabled("chat")).toBe(false);

    useSessionStore.getState().setDemoFeatureConfig({ chat: true });
    expect(isDemoFeatureEnabled("chat")).toBe(true);
  });
});

describe("P2.3 test state partition seam", () => {
  it("partitions session keys while keeping viewer navigation in the viewer bucket", () => {
    expect(
      partitionViewerStoreTestState({
        publicId: "P",
        isDemo: true,
        pageNumber: 6,
      }),
    ).toEqual({
      session: { publicId: "P", isDemo: true },
      viewer: { pageNumber: 6 },
    });
  });

  it("publishes each side of a mixed setup to its real leaf owner", () => {
    const publications: string[] = [];
    const sessionListener = vi.fn(() => {
      publications.push(
        `session:${useSessionStore.getState().publicId}:${useViewerStore.getState().pageNumber}`,
      );
    });
    const viewerListener = vi.fn(() => {
      publications.push(
        `viewer:${useSessionStore.getState().publicId}:${useViewerStore.getState().pageNumber}`,
      );
    });
    const unsubscribeSession = useSessionStore.subscribe(sessionListener);
    const unsubscribeViewer = useViewerStore.subscribe(viewerListener);

    setViewerStoreStateForTest({ publicId: "P", isDemo: true, pageNumber: 6 });

    expect(useSessionStore.getState()).toMatchObject({
      publicId: "P",
      isDemo: true,
    });
    expect(useViewerStore.getState()).toMatchObject({
      pageNumber: 6,
    });
    // Zustand accepts undeclared runtime keys, so positive assertions alone would not prove that
    // the helper stopped republishing a hidden session copy into viewerStore.
    for (const key of SESSION_TEST_STATE_KEYS) {
      expect(useViewerStore.getState()).not.toHaveProperty(key);
    }
    expect(useSessionStore.getState()).not.toHaveProperty("pageNumber");

    // Query keys/guards read sessionStore from viewer subscribers. Preserve the helper's explicit
    // session-first contract and prove each logical patch produces exactly one leaf publication.
    expect(sessionListener).toHaveBeenCalledTimes(1);
    expect(viewerListener).toHaveBeenCalledTimes(1);
    expect(publications).toEqual(["session:P:1", "viewer:P:6"]);
    unsubscribeSession();
    unsubscribeViewer();
  });

  it("does not publish an empty sibling-store patch", () => {
    const sessionListener = vi.fn();
    const viewerListener = vi.fn();
    const unsubscribeSession = useSessionStore.subscribe(sessionListener);
    const unsubscribeViewer = useViewerStore.subscribe(viewerListener);

    setViewerStoreStateForTest({ publicId: "session-only" });
    expect(sessionListener).toHaveBeenCalledTimes(1);
    expect(viewerListener).not.toHaveBeenCalled();

    sessionListener.mockClear();
    viewerListener.mockClear();
    setViewerStoreStateForTest({ pageNumber: 4 });
    expect(sessionListener).not.toHaveBeenCalled();
    expect(viewerListener).toHaveBeenCalledTimes(1);

    unsubscribeSession();
    unsubscribeViewer();
  });
});
