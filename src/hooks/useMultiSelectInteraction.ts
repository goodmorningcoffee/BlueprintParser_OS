"use client";

import { useCallback, useMemo } from "react";
import { useViewerStore, useSelection, useAnnotationGroups } from "@/stores/viewerStore";
import type { ClientAnnotation } from "@/types";

/**
 * Shared multi-select interaction state for the Group tool + shift-click +
 * ViewAllPanel checkboxes. Extracted from AnnotationOverlay so that overlay
 * doesn't accumulate new tool logic (per feedback_code_discipline.md).
 *
 * Callers:
 *   - AnnotationOverlay — delegates annotation-click + lasso mouse events here
 *   - GroupActionsBar — reads selection size + clears selection
 *   - ViewAllPanel — sets selection from tree checkboxes
 *
 * Lasso state (`lassoRect`) is local React state (not in the Zustand store)
 * because it's ephemeral render-only data. The persistent selection set
 * lives in useSelection().selectedAnnotationIds.
 */
export function useMultiSelectInteraction() {
  const mode = useViewerStore((s) => s.mode);
  const {
    selectedAnnotationIds,
    toggleSelection,
    setSelectedAnnotationIds,
    clearSelection,
  } = useSelection();
  const {
    annotationGroups,
    annotationGroupMemberships,
    groupMembers,
  } = useAnnotationGroups();

  // O(1) lookup from groupId → color, built from the groups list.
  // Drives the member-outline stroke in the overlay draw loop.
  const groupIdToColor = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of annotationGroups) {
      if (g.color) m.set(g.id, g.color);
    }
    return m;
  }, [annotationGroups]);

  /**
   * Decide what to do when the user clicks an annotation's hitbox.
   *
   * Return shape:
   *   - `handled: true` → caller should NOT run its existing single-select
   *     logic (drag-to-move, yolo-tag-activation, etc.). The click was
   *     consumed by the multi-select layer.
   *   - `handled: false` → caller continues its existing single-select path.
   */
  const handleAnnotationClick = useCallback(
    (annotationId: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      // Group mode: every click is a toggle; no drag-to-move in this tool.
      if (mode === "group") {
        toggleSelection(annotationId);
        return { handled: true };
      }
      // Pointer mode with modifier: additive toggle, block the default path.
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        toggleSelection(annotationId);
        return { handled: true };
      }
      // Plain pointer click: mirror the single-select into the Set so the
      // multi-outline renders consistently, then let the default drag/edit
      // path run.
      setSelectedAnnotationIds(new Set([annotationId]));
      return { handled: false };
    },
    [mode, toggleSelection, setSelectedAnnotationIds],
  );

  /**
   * Click-highlight: when the user clicks a single annotation that belongs
   * to one or more groups, expand the selection to include every sibling
   * across those groups (union across all groups the clicked annotation
   * belongs to — M:N).
   *
   * Caller controls WHEN this fires. Typical usage: in Pointer mode, after
   * a plain click, call this to auto-expand. Shift-click intentionally
   * avoids this expansion so users can toggle single members.
   */
  const expandSelectionViaGroups = useCallback(
    (annotationId: number) => {
      const memberships = annotationGroupMemberships[annotationId];
      if (!memberships || memberships.size === 0) return;
      const next = new Set(selectedAnnotationIds);
      next.add(annotationId);
      for (const groupId of memberships) {
        const members = groupMembers[groupId];
        if (!members) continue;
        for (const aid of members) next.add(aid);
      }
      setSelectedAnnotationIds(next);
    },
    [annotationGroupMemberships, groupMembers, selectedAnnotationIds, setSelectedAnnotationIds],
  );

  /**
   * Finalize the lasso drag given the rectangle's normalized bbox coords.
   * AnnotationOverlay passes the already-normalized values from the store's
   * _drawStart / _drawEnd (same pattern as Symbol Search and Table Parse).
   * Additive — previously-selected IDs remain selected.
   */
  const finalizeLasso = useCallback(
    (
      pageAnnotations: ClientAnnotation[],
      normBox: [number, number, number, number],
    ) => {
      const [minX, minY, maxX, maxY] = normBox;
      // Degenerate rect (tiny drag or click-tap) → noop
      if (maxX - minX < 0.001 || maxY - minY < 0.001) return 0;
      const next = new Set(selectedAnnotationIds);
      let added = 0;
      for (const ann of pageAnnotations) {
        const [a, b, c, d] = ann.bbox;
        // Intersection test (figma-style, not fully-contained)
        if (a < maxX && c > minX && b < maxY && d > minY) {
          if (!next.has(ann.id)) added++;
          next.add(ann.id);
        }
      }
      setSelectedAnnotationIds(next);
      return added;
    },
    [selectedAnnotationIds, setSelectedAnnotationIds],
  );

  /**
   * Returns the first-group color for the given annotation id, or null if
   * the annotation doesn't belong to any group with a color set.
   * Powers the thin member-outline stroke in the draw loop.
   */
  const getGroupOutlineColor = useCallback(
    (annotationId: number): string | null => {
      const memberships = annotationGroupMemberships[annotationId];
      if (!memberships || memberships.size === 0) return null;
      // Set iteration preserves insertion order — first group wins for v1.
      // If users want visible multi-group membership, add ring-layering later.
      for (const gid of memberships) {
        const c = groupIdToColor.get(gid);
        if (c) return c;
      }
      return null;
    },
    [annotationGroupMemberships, groupIdToColor],
  );

  return {
    // State
    selectedAnnotationIds,
    selectionSize: selectedAnnotationIds.size,
    mode,
    // Annotation interactions
    handleAnnotationClick,
    expandSelectionViaGroups,
    // Lasso (marquee state lives in the _drawing store; this hook only
    // provides the finalize computation after mouse-up)
    finalizeLasso,
    // Render helpers
    isSelected: (id: number) => selectedAnnotationIds.has(id),
    getGroupOutlineColor,
    // Convenience
    clearSelection,
  };
}
