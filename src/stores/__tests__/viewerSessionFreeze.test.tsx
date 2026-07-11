// [refactor jul11 P2.3 S0] Backing-specific characterization for the legacy viewerStore session
// slice. This suite flips to sessionStore at the atomic ownership commit; until then it records the
// exact defaults, reference semantics, reset output, compatibility hook, and live demo policy.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDemoFeatureEnabled,
  useProject,
  useViewerStore,
} from "@/stores/viewerStore";
import {
  SESSION_TEST_STATE_KEYS,
  partitionViewerStoreTestState,
  setViewerStoreStateForTest,
} from "@/test/viewer-store-state";

function sessionData() {
  const state = useViewerStore.getState();
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
  useViewerStore.getState().resetProjectData();
});

describe("P2.3 legacy viewerStore session characterization", () => {
  it("pins the exact session defaults and the separate PI bootstrap default", () => {
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
    expect(useViewerStore.getState().projectIntelligenceData).toBeNull();
  });

  it("preserves replacement setters and setPageName's immutable one-key merge", () => {
    const pageNames = { 1: "Cover", 2: "Plans" };
    const drawingNumbers = { 1: "A-001", 2: null };
    const demoConfig = { bucketFill: false };
    const sessions = [
      { labelStudioUrl: "https://labels.test/projects/1", pageRange: "1-3", taskCount: 3 },
    ];
    const credentials = { email: "labeler@example.test", password: "secret" };
    const state = useViewerStore.getState();

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
    expect(useViewerStore.getState().pageNames).toBe(pageNames);
    expect(useViewerStore.getState().pageDrawingNumbers).toBe(drawingNumbers);
    expect(useViewerStore.getState().demoFeatureConfig).toBe(demoConfig);
    expect(useViewerStore.getState().labelingSessions).toBe(sessions);
    expect(useViewerStore.getState().labelingCredentials).toBe(credentials);

    state.setPageName(2, "Floor Plans");
    expect(pageNames).toEqual({ 1: "Cover", 2: "Plans" });
    expect(useViewerStore.getState().pageNames).not.toBe(pageNames);
    expect(useViewerStore.getState().pageNames).toEqual({ 1: "Cover", 2: "Floor Plans" });

    state.setLabelingCredentials(null);
    expect(useViewerStore.getState().labelingCredentials).toBeNull();
  });

  it("resetProjectData clears every session field plus PI and allocates fresh containers", () => {
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
      projectIntelligenceData: { csiGraph: { nodes: [1] } },
    });

    useViewerStore.getState().resetProjectData();

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
    expect(useViewerStore.getState().projectIntelligenceData).toBeNull();
    expect(useViewerStore.getState().pageNames).not.toBe(oldPageNames);
    expect(useViewerStore.getState().pageDrawingNumbers).not.toBe(oldDrawingNumbers);
    expect(useViewerStore.getState().labelingSessions).not.toBe(oldSessions);
  });

  it("keeps the useProject compatibility projection exact and live", () => {
    const projectIntelligenceData = { csiGraph: { nodes: ["node-1"] } };
    const hook = renderHook(() => useProject());

    act(() => {
      setViewerStoreStateForTest({
        projectId: 8,
        publicId: "public-8",
        dataUrl: "projects/8.pdf",
        isDemo: true,
        demoFeatureConfig: { labeling: false },
        pageNames: { 1: "A-101" },
        projectIntelligenceData,
      });
    });

    expect(hook.result.current).toEqual({
      projectId: 8,
      publicId: "public-8",
      dataUrl: "projects/8.pdf",
      isDemo: true,
      demoFeatureConfig: { labeling: false },
      pageNames: { 1: "A-101" },
      projectIntelligenceData,
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

    useViewerStore.getState().setIsDemo(true);
    useViewerStore.setState({ demoFeatureConfig: null });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);

    useViewerStore.getState().setDemoFeatureConfig({ chat: false });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);
    expect(isDemoFeatureEnabled("chat")).toBe(false);

    useViewerStore.getState().setDemoFeatureConfig({ chat: true });
    expect(isDemoFeatureEnabled("chat")).toBe(true);
  });
});

describe("P2.3 test state partition seam", () => {
  it("partitions future session keys while keeping PI in the remaining viewer/bootstrap bucket", () => {
    const projectIntelligenceData = { csiGraph: { nodes: [] } };
    expect(
      partitionViewerStoreTestState({
        publicId: "P",
        isDemo: true,
        pageNumber: 6,
        projectIntelligenceData,
      }),
    ).toEqual({
      session: { publicId: "P", isDemo: true },
      viewer: { pageNumber: 6, projectIntelligenceData },
    });
  });

  it("publishes a mixed setup atomically while viewerStore is the sole owner", () => {
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);

    setViewerStoreStateForTest({ publicId: "P", isDemo: true, pageNumber: 6 });

    expect(useViewerStore.getState()).toMatchObject({
      publicId: "P",
      isDemo: true,
      pageNumber: 6,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
