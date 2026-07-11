// [refactor jul11 P2.3 S0] One test-side seam for mixed viewer/session setup.
//
// The production session slice still lives in viewerStore at this characterization point, so both
// partitions are deliberately published in one Zustand write. At the S2 ownership flip, only this
// function needs to route `session` to sessionStore; callers can keep describing one logical setup
// patch while the two production stores remain explicit (there is no production compatibility
// proxy). `projectIntelligenceData` is intentionally NOT a session key: the P2.3 census assigns that
// server bootstrap payload to a Query facade instead of relabeling it as client session state.

import { useViewerStore } from "@/stores/viewerStore";

export type ViewerStoreTestState = ReturnType<typeof useViewerStore.getState>;
export type ViewerStoreTestPatch = Partial<ViewerStoreTestState>;

export const SESSION_TEST_STATE_KEYS = [
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
] as const satisfies readonly (keyof ViewerStoreTestState)[];

export type SessionTestStateKey = (typeof SESSION_TEST_STATE_KEYS)[number];
export type SessionStoreTestPatch = Partial<
  Pick<ViewerStoreTestState, SessionTestStateKey>
>;
export type RemainingViewerStoreTestPatch = Partial<
  Omit<ViewerStoreTestState, SessionTestStateKey>
>;

const SESSION_TEST_STATE_KEY_SET = new Set<keyof ViewerStoreTestState>(
  SESSION_TEST_STATE_KEYS,
);

export function partitionViewerStoreTestState(patch: ViewerStoreTestPatch): {
  session: SessionStoreTestPatch;
  viewer: RemainingViewerStoreTestPatch;
} {
  const sessionEntries: [string, unknown][] = [];
  const viewerEntries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(patch)) {
    const target = SESSION_TEST_STATE_KEY_SET.has(key as keyof ViewerStoreTestState)
      ? sessionEntries
      : viewerEntries;
    target.push([key, value]);
  }

  return {
    session: Object.fromEntries(sessionEntries) as SessionStoreTestPatch,
    viewer: Object.fromEntries(viewerEntries) as RemainingViewerStoreTestPatch,
  };
}

export function setViewerStoreStateForTest(patch: ViewerStoreTestPatch): void {
  const { session, viewer } = partitionViewerStoreTestState(patch);

  // Preserve today's one-publication setup semantics while both partitions share one owner. S2
  // changes this body to two explicit leaf-store writes, in the required session/core order.
  useViewerStore.setState({ ...viewer, ...session });
}
