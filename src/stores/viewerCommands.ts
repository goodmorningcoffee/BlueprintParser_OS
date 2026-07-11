// [refactor jul11 P2.3] Temporary cross-store project reset coordinator.
//
// Leaf stores must not import one another. Keeping the old reset as a viewerStore action would make
// the UI/tool store own session lifetime; duplicating it in loaders/tests would reopen reset drift.
// P2.3 therefore preserves today's reset output behind this neutral command. P2.5 replaces it with
// the generation/AbortController-aware openProject orchestrator and an explicit survival policy.

import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerStore } from "@/stores/viewerStore";

export function resetProjectData(): void {
  // Session first: every Query observer immediately re-keys away from the old project before the
  // remaining UI/viewer reset publishes. All writes are synchronous; there is no await/paint gap.
  useSessionStore.getState().resetSession();
  useUiStore.getState().resetProjectUiState();
  useViewerStore.getState().resetViewerState();
}

/**
 * Cross-store panel commands preserve the legacy destination and publication timing while keeping
 * uiStore dependency-free. These are product commands, not leaf-store toggles: each one may
 * coordinate presentation with a tool or parse draft still owned by viewerStore during P2.3.
 */
export function toggleTakeoffPanel(): void {
  const ui = useUiStore.getState();

  if (ui.showTakeoffPanel) {
    // This is deliberately a raw write. setActiveTakeoffItemId also clears undo/redo history,
    // whereas the legacy panel close retained both stacks.
    useViewerStore.setState({ activeTakeoffItemId: null });
    useUiStore.getState().setPanelVisibility({ showTakeoffPanel: false });
    return;
  }

  useUiStore.getState().setPanelVisibility({
    showTakeoffPanel: true,
    ...(ui.showChatPanel ? { showChatPanel: false } : {}),
  });
}

export function toggleDetectionPanel(): void {
  const ui = useUiStore.getState();
  const closing = ui.showDetectionPanel;
  const peerWasClosed = !ui.showParsePanel;

  useUiStore.getState().setPanelVisibility({ showDetectionPanel: !closing });
  if (closing && peerWasClosed) {
    // Resolve the action at execution time just as the old get().resetAllTools() microtask did.
    queueMicrotask(() => useViewerStore.getState().resetAllTools());
  }
}

export function toggleParsePanel(): void {
  const ui = useUiStore.getState();
  const closing = ui.showParsePanel;
  const peerWasClosed = !ui.showDetectionPanel;

  useUiStore.getState().setPanelVisibility({ showParsePanel: !closing });
  if (closing && peerWasClosed) {
    queueMicrotask(() => useViewerStore.getState().resetAllTools());
  }
}

export function toggleTableParsePanel(): void {
  const closing = useUiStore.getState().showTableParsePanel;

  if (closing) {
    // Preserve the old raw mode transition. Calling setMode would clear additional live tools.
    useViewerStore.setState({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseMeta: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
      tableParseTab: "all",
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
      mode: "move",
    });
  }
  useUiStore.getState().setPanelVisibility({ showTableParsePanel: !closing });
}

export function toggleKeynoteParsePanel(): void {
  const closing = useUiStore.getState().showKeynoteParsePanel;

  if (closing) {
    useViewerStore.setState({
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      keynoteParseTab: "all",
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
      mode: "move",
    });
  }
  useUiStore.getState().setPanelVisibility({ showKeynoteParsePanel: !closing });
}
