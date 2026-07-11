// [refactor jul11 P2.3 S0] One test-side seam for mixed viewer/session setup.
//
// The helper accepts one logical test setup patch, but publishes the two ownership partitions to
// their real leaf stores. This keeps tests explicit about production ownership without making every
// mixed setup repeat routing boilerplate. CSI bootstrap data is intentionally absent because its
// residual graph now has a dedicated Query facade instead of either Zustand owner.

import { useSessionStore } from "@/stores/sessionStore";
import { useViewerStore } from "@/stores/viewerStore";

export type ViewerStoreTestState = ReturnType<typeof useViewerStore.getState>;
export type SessionStoreTestState = ReturnType<typeof useSessionStore.getState>;

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
] as const satisfies readonly (keyof SessionStoreTestState)[];

export type SessionTestStateKey = (typeof SESSION_TEST_STATE_KEYS)[number];
export type SessionStoreTestPatch = Partial<
  Pick<SessionStoreTestState, SessionTestStateKey>
>;
export type RemainingViewerStoreTestPatch = Partial<ViewerStoreTestState>;
export type ViewerStoreTestPatch = RemainingViewerStoreTestPatch & SessionStoreTestPatch;

const SESSION_TEST_STATE_KEY_SET = new Set<string>(
  SESSION_TEST_STATE_KEYS,
);

export function partitionViewerStoreTestState(patch: ViewerStoreTestPatch): {
  session: SessionStoreTestPatch;
  viewer: RemainingViewerStoreTestPatch;
} {
  const sessionEntries: [string, unknown][] = [];
  const viewerEntries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(patch)) {
    const target = SESSION_TEST_STATE_KEY_SET.has(key)
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

  // Identity/policy must be visible before viewer state is published because Query subscribers can
  // react to viewer writes and derive keys/guards from the live session store.
  if (Object.keys(session).length > 0) useSessionStore.setState(session);
  if (Object.keys(viewer).length > 0) useViewerStore.setState(viewer);
}
