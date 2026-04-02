"use client";

import { useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";

export function useKeyboardShortcuts() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const store = useViewerStore.getState();

      // Don't capture if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          store.setPage(store.pageNumber - 1);
          break;
        case "ArrowRight":
        case "PageDown":
          e.preventDefault();
          store.setPage(store.pageNumber + 1);
          break;
        case "Home":
          e.preventDefault();
          store.setPage(1);
          break;
        case "End":
          e.preventDefault();
          store.setPage(store.numPages);
          break;
      }

      // Takeoff undo/redo (Z/W keys, only when placing)
      if (store.activeTakeoffItemId !== null && !e.ctrlKey && !e.metaKey) {
        if (e.key === "z" || e.key === "Z") {
          e.preventDefault();
          store.takeoffUndo();
          return;
        }
        if (e.key === "w" || e.key === "W") {
          e.preventDefault();
          store.takeoffRedo();
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          store.zoomIn();
        } else if (e.key === "-") {
          e.preventDefault();
          store.zoomOut();
        } else if (e.key === "0") {
          e.preventDefault();
          store.zoomFit();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
