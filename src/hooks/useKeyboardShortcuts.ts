"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useToolStore } from "@/stores/toolStore";
import { takeoffRedo, takeoffUndo } from "@/queries/useAnnotations";
import { navigateYoloTag } from "@/queries/useYoloTags";

export function useKeyboardShortcuts() {
  // [refactor jul10 P2.2⑥] Providers constructs this client once. Keep the listener mount-once;
  // the module actions use qc for annotations and re-read the mutable owners on keydown.
  const qc = useQueryClient();
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Keep all owner snapshots adjacent at the original event-time boundary.
      const session = useSessionStore.getState();
      const ui = useUiStore.getState();
      const core = useViewerCoreStore.getState();
      const tool = useToolStore.getState();

      // Don't capture if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      // Tag browse: Left/Right arrows cycle instances when browsing
      if (ui.tagBrowseId && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        // Event-time publicId + exact cache read preserve the mount-once listener without leaving
        // tag collection ownership in Zustand.
        navigateYoloTag(
          qc,
          session.publicId,
          ui.tagBrowseId,
          ui.tagBrowseIndex + (e.key === "ArrowLeft" ? -1 : 1),
        );
        return;
      }
      if (ui.tagBrowseId && e.key === "Escape") {
        e.preventDefault();
        ui.setLlmHighlight(null);
        useUiStore.getState().setYoloBrowseState({ tagBrowseId: null, tagBrowseIndex: 0 });
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          core.setPage(core.pageNumber - 1);
          break;
        case "ArrowRight":
        case "PageDown":
          e.preventDefault();
          core.setPage(core.pageNumber + 1);
          break;
        case "Home":
          e.preventDefault();
          core.setPage(1);
          break;
        case "End":
          e.preventDefault();
          core.setPage(core.numPages);
          break;
      }

      // Takeoff undo/redo (Z/W keys, only when placing)
      if (tool.activeTakeoffItemId !== null && !e.ctrlKey && !e.metaKey) {
        if (e.key === "z" || e.key === "Z") {
          e.preventDefault();
          takeoffUndo(qc);
          return;
        }
        if (e.key === "w" || e.key === "W") {
          e.preventDefault();
          takeoffRedo(qc);
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          core.zoomIn();
        } else if (e.key === "-") {
          e.preventDefault();
          core.zoomOut();
        } else if (e.key === "0") {
          e.preventDefault();
          core.zoomFit();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- provider-stable qc; mount-once parity
}
