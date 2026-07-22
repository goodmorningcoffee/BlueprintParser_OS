"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { canPersist, persistFetch } from "@/lib/client-persist";
import { isEditableKeyboardTarget } from "@/lib/keyboard-target";
import {
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { takeoffRedo, takeoffUndo } from "@/queries/useAnnotations";
import { readTakeoffItems } from "@/queries/useTakeoff";
import { navigateYoloTag } from "@/queries/useYoloTags";
import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore, type ToolStoreState } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import {
  setKeynoteParseStepWithTool,
  setNotesParseStepWithTool,
  setSpecParseStepWithTool,
  setTableParseStepWithTool,
} from "@/stores/viewerCommands";

import type { AnnotationDragSession } from "./useAnnotationDragMachine";

export type OverlayKeyboardDispatcherOptions = Readonly<{
  canAdoptProjectLifecycle: () => boolean;
  cancelDeferredDrawing: () => void;
  acceptSplit: () => void;
  prepareBucketFillPolygon: () => void;
  savePolygon: () => void;
  saveLinearPolyline: () => void;
  setMousePos: ToolStoreState["_setMousePos"];
  selectedId: number | null;
  isDemo: boolean;
  removeAnnotation: (id: number) => void;
  setSelectedId: (id: number | null) => void;
  readActiveAnnotationDrag: () => AnnotationDragSession | null;
  finishAnnotationDrag: (session: AnnotationDragSession, persist: boolean) => boolean;
  publishTransientError: (message: string) => void;
}>;

/**
 * The single AnnotationOverlay keyboard axis.
 *
 * Keyboard ownership follows eight ActiveTool activation kinds rather than the 13 mousedown
 * controller identities. Global page/zoom shortcuts and exact drag rollback remain with their
 * existing owners.
 */
export function useOverlayKeyboardDispatcher(
  options: OverlayKeyboardDispatcherOptions,
): void {
  const qc = useQueryClient();
  const {
    canAdoptProjectLifecycle,
    cancelDeferredDrawing,
    acceptSplit,
    prepareBucketFillPolygon,
    savePolygon,
    saveLinearPolyline,
    setMousePos,
    selectedId,
    isDemo,
    removeAnnotation,
    setSelectedId,
    readActiveAnnotationDrag,
    finishAnnotationDrag,
    publishTransientError,
  } = options;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return;
      if (!canAdoptProjectLifecycle()) return;

      // Modal tag browsing owns only its three keys. The project-page Arrow listeners cooperate
      // through the same live truthy browse predicate, so listener registration order is irrelevant.
      const ui = useUiStore.getState();
      if (ui.tagBrowseId) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          navigateYoloTag(
            qc,
            useSessionStore.getState().publicId,
            ui.tagBrowseId,
            ui.tagBrowseIndex + (event.key === "ArrowLeft" ? -1 : 1),
          );
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          ui.setLlmHighlight(null);
          if (!canAdoptProjectLifecycle()) return;
          useUiStore.getState().setYoloBrowseState({ tagBrowseId: null, tagBrowseIndex: 0 });
          return;
        }
      }

      // An exact drag terminal outranks every tool-local Enter command.
      if (event.key === "Enter") {
        const annotationDrag = readActiveAnnotationDrag();
        if (
          annotationDrag?.operation.kind === "vertex" ||
          annotationDrag?.operation.kind === "bbox"
        ) {
          event.preventDefault();
          invalidateToolTailAuthority();
          finishAnnotationDrag(annotationDrag, true);
          return;
        }
      }

      if (
        selectedId !== null &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        invalidateToolTailAuthority();
        const livePublicId = useSessionStore.getState().publicId;
        if (canPersist(livePublicId, isDemo) && selectedId > 0) {
          const deleteId = selectedId;
          void (async () => {
            try {
              await persistFetch(`/api/annotations/${deleteId}`, undefined, "DELETE");
            } catch (error) {
              publishTransientError(
                error instanceof Error
                  ? `Failed to delete: ${error.message}`
                  : "Failed to delete annotation",
              );
            }
          })();
        }
        removeAnnotation(selectedId);
        if (!canAdoptProjectLifecycle()) return;
        setSelectedId(null);
        return;
      }

      if (event.key === "Escape") {
        const splitAtEscape = useToolStore.getState();
        if (
          splitAtEscape.activeTool?.kind === "split" &&
          splitAtEscape.splitPreview?.commitPending === true
        ) return;
        const expectedActiveTool = useToolStore.getState().activeTool;
        cancelDeferredDrawing();
        const tool = useToolStore.getState();
        if (tool.activeTool !== expectedActiveTool) return;
        const activeTool = expectedActiveTool;
        if (activeTool?.kind === "split") {
          if (tool.splitPreview) {
            invalidateToolTailAuthority();
            tool.setSplitPreview(null);
          } else {
            tool.setSplitAreaActive(false);
          }
        } else if (activeTool?.kind === "bucketFill") {
          if (tool.bucketFillPendingPolygon) {
            invalidateToolTailAuthority();
            invalidateLatestToolOperation("bucketFill");
            tool.setBucketFillPendingPolygon(null);
          } else if (tool.bucketFillPreview) {
            invalidateToolTailAuthority();
            invalidateLatestToolOperation("bucketFill");
            tool.setBucketFillPreview(null);
          } else if (tool.bucketFillBarrierMode) {
            invalidateLatestToolOperation("bucketFill");
            tool.setBucketFillBarrierMode(false);
          } else {
            tool.setBucketFillActive(false);
          }
        } else if (activeTool?.kind === "parseRect") {
          if (activeTool.flow === "table") setTableParseStepWithTool("idle", "move");
          else if (activeTool.flow === "keynote") setKeynoteParseStepWithTool("idle", "move");
          else if (activeTool.flow === "notes") setNotesParseStepWithTool("idle", "move");
          else setSpecParseStepWithTool("idle", "move");
        } else if (activeTool?.kind === "takeoffPlacement") {
          if (tool.polygonDrawingMode === "drawing") {
            tool.resetPolygonDrawing();
            if (!canAdoptProjectLifecycle()) return;
            setMousePos(null);
          } else {
            tool.setActiveTakeoffItemId(null);
          }
        } else if (activeTool?.kind === "calibration") {
          tool.resetCalibration();
        } else if (activeTool?.kind === "symbolTemplate") {
          tool.setSymbolSearchActive(false);
        } else if (activeTool?.kind === "tagPick") {
          tool.setYoloTagPickingMode(false);
        } else if (activeTool?.kind === "tagAdd") {
          tool.setTagAddingMode(null);
        }
        return;
      }

      if (event.key === "Enter") {
        const tool = useToolStore.getState();
        if (tool.activeTool?.kind === "split" && tool.splitPreview) {
          event.preventDefault();
          if (tool.splitPreview.commitPending === true) return;
          invalidateToolTailAuthority();
          acceptSplit();
          return;
        }
        if (tool.activeTool?.kind === "bucketFill" && tool.bucketFillPreview) {
          event.preventDefault();
          invalidateToolTailAuthority();
          invalidateLatestToolOperation("bucketFill");
          prepareBucketFillPolygon();
          return;
        }
        if (
          tool.activeTool?.kind === "takeoffPlacement" &&
          tool.polygonDrawingMode === "drawing"
        ) {
          event.preventDefault();
          invalidateToolTailAuthority();
          const vertices = tool.polygonVertices;
          const activeItem = readTakeoffItems(
            qc,
            useSessionStore.getState().publicId,
          ).find((item) => item.id === tool.activeTakeoffItemId);
          if (activeItem?.shape === "linear") {
            if (vertices.length >= 2) saveLinearPolyline();
          } else if (vertices.length >= 3) {
            savePolygon();
          }
          return;
        }
      }

      if (event.key === "b" || event.key === "B") {
        const tool = useToolStore.getState();
        if (tool.activeTool?.kind === "bucketFill" && !tool.bucketFillPreview) {
          event.preventDefault();
          invalidateLatestToolOperation("bucketFill");
          tool.setBucketFillBarrierMode(!tool.bucketFillBarrierMode);
          return;
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "z") {
        const tool = useToolStore.getState();
        if (tool.activeTool?.kind === "bucketFill" && tool.bucketFillBarriers.length > 0) {
          event.preventDefault();
          invalidateToolTailAuthority();
          invalidateLatestToolOperation("bucketFill");
          tool.undoLastBarrier();
          return;
        }
        if (
          tool.activeTool?.kind === "takeoffPlacement" &&
          tool.polygonDrawingMode === "drawing"
        ) {
          event.preventDefault();
          invalidateToolTailAuthority();
          tool.undoLastVertex();
          return;
        }
      }

      if (
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "z" || event.key === "Z" || event.key === "w" || event.key === "W")
      ) {
        const tool = useToolStore.getState();
        if (tool.activeTool?.kind !== "takeoffPlacement") return;
        event.preventDefault();
        if (event.key === "z" || event.key === "Z") takeoffUndo(qc);
        else takeoffRedo(qc);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [acceptSplit, canAdoptProjectLifecycle, cancelDeferredDrawing, finishAnnotationDrag, isDemo,
    prepareBucketFillPolygon, publishTransientError, qc, readActiveAnnotationDrag,
    removeAnnotation, saveLinearPolyline, savePolygon, selectedId, setMousePos, setSelectedId]);
}
