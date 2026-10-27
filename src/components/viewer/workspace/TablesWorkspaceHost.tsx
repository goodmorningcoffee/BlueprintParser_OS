"use client";

// [TP-3 WP-3.L] Always mounted in PDFViewer's ViewerPanels; renders nothing while the workspace is closed.
//   • reads GET …/parse-engine/flags and publishes `enabled` to the leaf store (classic toggles while it is off,
//     loading, failed, or the project is a demo — the items route refuses demo projects);
//   • restores this project's mirrored drafts whenever the project changes (C3-m6);
//   • keeps the panels from stacking: a classic Tables or Specs/Notes panel opened by any other path (Auto QTO,
//     a deep link) closes the workspace;
//   • wraps the panel in an error boundary, so a workspace crash leaves the viewer and the classic tools usable.

import { Component, useEffect, type ReactNode } from "react";
import { useParseEngineFlags, workspaceOn } from "@/queries/useParseEngineFlags";
import { useProject } from "@/stores/sessionStore";
import { useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { useUiStore } from "@/stores/uiStore";
import { openClassicTools } from "@/stores/workspaceCommands";
import TablesWorkspacePanel from "./TablesWorkspacePanel";

class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="w-80 flex flex-col gap-2 h-full border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
        <p className="text-[var(--fg)]">The Tables &amp; Notes workspace hit an error.</p>
        <button
          type="button"
          onClick={() => {
            this.setState({ failed: false });
            openClassicTools();
          }}
          className="self-start px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
        >
          Classic tools ▸
        </button>
      </div>
    );
  }
}

export default function TablesWorkspaceHost() {
  const { publicId, isDemo } = useProject();
  const flags = useParseEngineFlags(publicId);
  const enabled = workspaceOn(flags, isDemo);
  const open = useTablesWorkspaceStore((s) => s.open);
  const classicTables = useUiStore((s) => s.showTableParsePanel);
  const classicNotes = useUiStore((s) => s.showSpecsNotesPanel);

  useEffect(() => {
    useTablesWorkspaceStore.getState().setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    useTablesWorkspaceStore.getState().hydrateDrafts(publicId);
  }, [publicId]);

  useEffect(() => {
    if ((classicTables || classicNotes) && useTablesWorkspaceStore.getState().open) {
      useTablesWorkspaceStore.getState().closeWorkspace();
    }
  }, [classicTables, classicNotes]);

  if (!open || !enabled) return null;
  return (
    <WorkspaceErrorBoundary>
      <TablesWorkspacePanel />
    </WorkspaceErrorBoundary>
  );
}
