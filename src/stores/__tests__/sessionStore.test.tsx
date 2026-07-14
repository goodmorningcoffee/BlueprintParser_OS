import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  initialSessionState,
  isDemoFeatureEnabled,
  useProjectIdentity,
  useSessionStore,
} from "@/stores/sessionStore";

function sessionData() {
  const {
    setProjectId: _setProjectId,
    setPublicId: _setPublicId,
    setAssetBaseUrl: _setAssetBaseUrl,
    setIsDemo: _setIsDemo,
    setDemoFeatureConfig: _setDemoFeatureConfig,
    setPageNames: _setPageNames,
    setPageName: _setPageName,
    setPageDrawingNumbers: _setPageDrawingNumbers,
    setShowLabelingWizard: _setShowLabelingWizard,
    setLabelingWizardStep: _setLabelingWizardStep,
    setLabelingSessions: _setLabelingSessions,
    resetSession: _resetSession,
    ...data
  } = useSessionStore.getState();
  return data;
}

beforeEach(() => {
  useSessionStore.getState().resetSession();
});

describe("sessionStore — additive session ownership", () => {
  it("has the exact legacy session defaults", () => {
    expect(sessionData()).toEqual(initialSessionState);
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

  it("preserves the existing replacement-setter semantics", () => {
    const pageNames = { 1: "Cover" };
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
    state.setAssetBaseUrl("company/project");
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
      assetBaseUrl: "company/project",
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
  });

  it("setPageName clones the map, retains siblings, and does not mutate the prior map", () => {
    const previous = { 1: "Cover", 2: "Plans" };
    useSessionStore.getState().setPageNames(previous);

    useSessionStore.getState().setPageName(2, "Floor Plans");

    const next = useSessionStore.getState().pageNames;
    expect(next).not.toBe(previous);
    expect(previous).toEqual({ 1: "Cover", 2: "Plans" });
    expect(next).toEqual({ 1: "Cover", 2: "Floor Plans" });
  });

  it("reset restores every field and allocates fresh collection containers", () => {
    const state = useSessionStore.getState();
    state.setProjectId(7);
    state.setPublicId("old-project");
    state.setAssetBaseUrl("old/data");
    state.setIsDemo(true);
    state.setDemoFeatureConfig({ chat: false });
    state.setPageNames({ 1: "Old" });
    state.setPageDrawingNumbers({ 1: "M-101" });
    state.setShowLabelingWizard(true);
    state.setLabelingWizardStep(4);
    state.setLabelingSessions([
      {
        labelStudioUrl: "https://labels.test/projects/9",
        pageRange: "all",
        taskCount: 1,
      },
    ]);
    const oldNames = useSessionStore.getState().pageNames;
    const oldNumbers = useSessionStore.getState().pageDrawingNumbers;
    const oldSessions = useSessionStore.getState().labelingSessions;

    state.resetSession();

    expect(sessionData()).toEqual(initialSessionState);
    expect(useSessionStore.getState().pageNames).not.toBe(oldNames);
    expect(useSessionStore.getState().pageDrawingNumbers).not.toBe(oldNumbers);
    expect(useSessionStore.getState().labelingSessions).not.toBe(oldSessions);
  });

  it("allocates fresh construction containers on consecutive resets without replacing actions", () => {
    const construction = useSessionStore.getInitialState();
    const beforeReset = useSessionStore.getState();

    beforeReset.resetSession();
    const firstReset = useSessionStore.getState();
    firstReset.resetSession();
    const secondReset = useSessionStore.getState();

    for (const key of [
      "pageNames",
      "pageDrawingNumbers",
      "labelingSessions",
    ] as const) {
      expect(firstReset[key]).not.toBe(construction[key]);
      expect(secondReset[key]).not.toBe(construction[key]);
      expect(secondReset[key]).not.toBe(firstReset[key]);
      expect(secondReset[key]).toEqual(construction[key]);
    }

    for (const key of [
      "setProjectId",
      "setPublicId",
      "setAssetBaseUrl",
      "setIsDemo",
      "setDemoFeatureConfig",
      "setPageNames",
      "setPageName",
      "setPageDrawingNumbers",
      "setShowLabelingWizard",
      "setLabelingWizardStep",
      "setLabelingSessions",
      "resetSession",
    ] as const) {
      expect(firstReset[key]).toBe(beforeReset[key]);
      expect(secondReset[key]).toBe(beforeReset[key]);
    }
  });
});

describe("sessionStore — demo feature policy", () => {
  it("enables every feature outside demo regardless of config", () => {
    useSessionStore.getState().setDemoFeatureConfig({ bucketFill: false });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);
  });

  it("defaults demo features on when config or a key is omitted", () => {
    useSessionStore.getState().setIsDemo(true);
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);

    useSessionStore.getState().setDemoFeatureConfig({ chat: false });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);
  });

  it("disables only an explicitly false demo feature and reads live state", () => {
    useSessionStore.getState().setIsDemo(true);
    useSessionStore
      .getState()
      .setDemoFeatureConfig({ bucketFill: false, chat: true });
    expect(isDemoFeatureEnabled("bucketFill")).toBe(false);
    expect(isDemoFeatureEnabled("chat")).toBe(true);

    useSessionStore.getState().setIsDemo(false);
    expect(isDemoFeatureEnabled("bucketFill")).toBe(true);
  });
});

describe("sessionStore — narrow projections", () => {
  it("does not re-render the identity hook for page-label changes", () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useProjectIdentity();
    });
    const initialRenders = renders;

    act(() => useSessionStore.getState().setPageName(1, "Cover"));
    expect(renders).toBe(initialRenders);

    act(() => useSessionStore.getState().setPublicId("next-project"));
    expect(renders).toBe(initialRenders + 1);
    expect(hook.result.current.publicId).toBe("next-project");
  });
});
