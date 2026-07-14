// [refactor jul11 P2.3] Ownership-flip characterization for the dedicated sessionStore. It pins
// exact defaults, reference semantics, coordinated reset output, compatibility hooks, and the live
// demo policy without reaching back through the UI/tool store.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
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
    assetBaseUrl: state.assetBaseUrl,
    isDemo: state.isDemo,
    demoFeatureConfig: state.demoFeatureConfig,
    pageNames: state.pageNames,
    pageDrawingNumbers: state.pageDrawingNumbers,
    showLabelingWizard: state.showLabelingWizard,
    labelingWizardStep: state.labelingWizardStep,
    labelingSessions: state.labelingSessions,
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
      "assetBaseUrl",
      "isDemo",
      "demoFeatureConfig",
      "pageNames",
      "pageDrawingNumbers",
      "showLabelingWizard",
      "labelingWizardStep",
      "labelingSessions",
    ]);
    expect(sessionData()).toEqual({
      projectId: 0,
      publicId: "",
      assetBaseUrl: "",
      isDemo: false,
      demoFeatureConfig: null,
      pageNames: {},
      pageDrawingNumbers: {},
      showLabelingWizard: false,
      labelingWizardStep: 1,
      labelingSessions: [],
    });
  });

  it("preserves replacement setters and setPageName's immutable one-key merge", () => {
    const pageNames = { 1: "Cover", 2: "Plans" };
    const drawingNumbers = { 1: "A-001", 2: null };
    const demoConfig = { bucketFill: false };
    const sessions = [
      {
        labelStudioUrl: "https://labels.test/projects/1",
        pageRange: "1-3",
        taskCount: 3,
      },
    ];
    const state = useSessionStore.getState();

    state.setProjectId(42);
    state.setPublicId("project-public-id");
    state.setAssetBaseUrl("company/project.pdf");
    state.setIsDemo(true);
    state.setDemoFeatureConfig(demoConfig);
    state.setPageNames(pageNames);
    state.setPageDrawingNumbers(drawingNumbers);
    state.setShowLabelingWizard(true);
    state.setLabelingWizardStep(3);
    state.setLabelingSessions(sessions);

    expect(sessionData()).toEqual({
      projectId: 42,
      publicId: "project-public-id",
      assetBaseUrl: "company/project.pdf",
      isDemo: true,
      demoFeatureConfig: demoConfig,
      pageNames,
      pageDrawingNumbers: drawingNumbers,
      showLabelingWizard: true,
      labelingWizardStep: 3,
      labelingSessions: sessions,
    });
    expect(useSessionStore.getState().pageNames).toBe(pageNames);
    expect(useSessionStore.getState().pageDrawingNumbers).toBe(drawingNumbers);
    expect(useSessionStore.getState().demoFeatureConfig).toBe(demoConfig);
    expect(useSessionStore.getState().labelingSessions).toBe(sessions);

    state.setPageName(2, "Floor Plans");
    expect(pageNames).toEqual({ 1: "Cover", 2: "Plans" });
    expect(useSessionStore.getState().pageNames).not.toBe(pageNames);
    expect(useSessionStore.getState().pageNames).toEqual({
      1: "Cover",
      2: "Floor Plans",
    });
  });

  it("resetProjectData clears every session field and allocates fresh containers", () => {
    const oldPageNames = { 1: "Old" };
    const oldDrawingNumbers = { 1: "M-101" };
    const oldSessions = [
      {
        labelStudioUrl: "https://labels.test/projects/9",
        pageRange: "all",
        taskCount: 1,
      },
    ];
    setViewerStoreStateForTest({
      projectId: 7,
      publicId: "old-project",
      assetBaseUrl: "old/data.pdf",
      isDemo: true,
      demoFeatureConfig: { chat: false },
      pageNames: oldPageNames,
      pageDrawingNumbers: oldDrawingNumbers,
      showLabelingWizard: true,
      labelingWizardStep: 4,
      labelingSessions: oldSessions,
    });

    resetProjectData();

    expect(sessionData()).toEqual({
      projectId: 0,
      publicId: "",
      assetBaseUrl: "",
      isDemo: false,
      demoFeatureConfig: null,
      pageNames: {},
      pageDrawingNumbers: {},
      showLabelingWizard: false,
      labelingWizardStep: 1,
      labelingSessions: [],
    });
    expect(useSessionStore.getState().pageNames).not.toBe(oldPageNames);
    expect(useSessionStore.getState().pageDrawingNumbers).not.toBe(
      oldDrawingNumbers,
    );
    expect(useSessionStore.getState().labelingSessions).not.toBe(oldSessions);
  });

  it("keeps the useProject compatibility projection exact and live", () => {
    const hook = renderHook(() => useProject());

    act(() => {
      setViewerStoreStateForTest({
        projectId: 8,
        publicId: "public-8",
        assetBaseUrl: "projects/8.pdf",
        isDemo: true,
        demoFeatureConfig: { labeling: false },
        pageNames: { 1: "A-101" },
      });
    });

    expect(hook.result.current).toEqual({
      projectId: 8,
      publicId: "public-8",
      assetBaseUrl: "projects/8.pdf",
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
  it("partitions session keys and viewer geometry into their exact owners", () => {
    expect(
      partitionViewerStoreTestState({
        publicId: "P",
        isDemo: true,
        pageNumber: 6,
      }),
    ).toEqual({
      session: { publicId: "P", isDemo: true },
      ui: {},
      core: { pageNumber: 6 },
      tool: {},
      parse: {},
      viewer: {},
    });
  });

  it("publishes each side of a mixed setup to its real leaf owner", () => {
    const publications: string[] = [];
    const sessionListener = vi.fn(() => {
      publications.push(
        `session:${useSessionStore.getState().publicId}:${useViewerCoreStore.getState().pageNumber}`,
      );
    });
    const coreListener = vi.fn(() => {
      publications.push(
        `core:${useSessionStore.getState().publicId}:${useViewerCoreStore.getState().pageNumber}`,
      );
    });
    let viewerPublications = 0;
    const viewerListener = () => {
      viewerPublications += 1;
    };
    const unsubscribeSession = useSessionStore.subscribe(sessionListener);
    const unsubscribeCore = useViewerCoreStore.subscribe(coreListener);
    const unsubscribeViewer = useViewerStore.subscribe(viewerListener);

    setViewerStoreStateForTest({ publicId: "P", isDemo: true, pageNumber: 6 });

    expect(useSessionStore.getState()).toMatchObject({
      publicId: "P",
      isDemo: true,
    });
    expect(useViewerCoreStore.getState()).toMatchObject({
      pageNumber: 6,
    });
    // The exact partition above plus a zero-publication residual viewer witness proves the helper
    // stopped republishing a hidden session copy into viewerStore. Core remains safe to inspect
    // directly because this setup intentionally publishes its page patch there.
    for (const key of SESSION_TEST_STATE_KEYS) {
      expect(useViewerCoreStore.getState()).not.toHaveProperty(key);
    }
    expect(useSessionStore.getState()).not.toHaveProperty("pageNumber");

    // Query keys/guards read sessionStore from viewer subscribers. Preserve the helper's explicit
    // session-first contract and prove each logical patch produces exactly one leaf publication.
    expect(sessionListener).toHaveBeenCalledTimes(1);
    expect(coreListener).toHaveBeenCalledTimes(1);
    expect(viewerPublications).toBe(0);
    expect(publications).toEqual(["session:P:1", "core:P:6"]);
    unsubscribeSession();
    unsubscribeCore();
    unsubscribeViewer();
  });

  it("does not publish an empty sibling-store patch", () => {
    const sessionListener = vi.fn();
    const coreListener = vi.fn();
    let viewerPublications = 0;
    const viewerListener = () => {
      viewerPublications += 1;
    };
    const unsubscribeSession = useSessionStore.subscribe(sessionListener);
    const unsubscribeCore = useViewerCoreStore.subscribe(coreListener);
    const unsubscribeViewer = useViewerStore.subscribe(viewerListener);

    setViewerStoreStateForTest({ publicId: "session-only" });
    expect(sessionListener).toHaveBeenCalledTimes(1);
    expect(coreListener).not.toHaveBeenCalled();
    expect(viewerPublications).toBe(0);

    sessionListener.mockClear();
    coreListener.mockClear();
    viewerPublications = 0;
    setViewerStoreStateForTest({ pageNumber: 4 });
    expect(sessionListener).not.toHaveBeenCalled();
    expect(coreListener).toHaveBeenCalledTimes(1);
    expect(viewerPublications).toBe(0);

    unsubscribeSession();
    unsubscribeCore();
    unsubscribeViewer();
  });
});
