// [refactor jul19 P3.2] Pointer/Group mousedown controller. This is a mechanical lift of the
// complete base-interaction board from AnnotationOverlay at parent b915a3d. Shared drag
// publication/settlement, lasso finalization, keyboard, render, dialog-save, and lifecycle owners
// remain in the overlay under ACCEPT-PARTIAL. Every matched press claims; event propagation stays
// branch-specific and no button/default policy is introduced.
// Parent provenance: AO SHA-256 d96515838b125e4d20ccca71bc5c5179f5c5f5cfb098de9c297d65d2d4eefa6e;
// marker slice 15,617 bytes / 327 newlines / SHA-256
// fd0b1e5c54a1c808e365ec34b7e15903d5c013f78ac727c69867ea7aac6c2dee.
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";
import { readTextractForPage } from "@/queries/textractCache";
import { readPageIntelligence } from "@/queries/usePageWindow";
import { focusParsedTableRegionInCatalog } from "@/stores/viewerCommands";
import type { AreaPolygonData, LinearPolylineData } from "@/types";

import {
  pointInHandle,
  pointInNormalizedBbox,
  pointInPolygonWithHoles,
  pointNearPolyline,
} from "../hitTest";
import type { ToolController } from "./types";

const HANDLE = 8;

export const pointerGroupController: ToolController = Object.freeze({
  kind: "pointerGroup",
  wantsEvents: (state) =>
    state.activeTool === null &&
    (state.mode === "pointer" || state.mode === "group"),
  matches: (press) =>
    press.toolAtDown.activeTool === null &&
    (press.toolAtDown.mode === "pointer" || press.toolAtDown.mode === "group"),
  onMouseDown(event, context) {
    const { selection, pageAnnotations, pointerGroup } = context;
    if (!selection || !pageAnnotations || !pointerGroup) {
      throw new Error(
        "pointerGroup controller requires the selection/pageAnnotations/pointerGroup capabilities",
      );
    }

    const { toolAtDown, position: pos } = context.press;
    const { publicId, number: pageNumber, width, height } = context.page;
    const {
      queryClient,
      tableCellStructure,
      showTableCellStructure,
      toggleCellHighlight,
      pageKeynotes,
      yoloTags,
      multiSelect,
      ui,
      dragUi,
      markupEdit,
    } = pointerGroup;
    const {
      setSearch,
      setAnnotationFilter,
      setTakeoffFilter,
      setKeynoteFilter,
      setActiveYoloTagId,
      setYoloTagFilter,
    } = ui;

    invalidateToolTailAuthority();

    // TATR cell click: single click = search by text, double click = toggle highlight.
    // Gated on showTableCellStructure so the user can disable cell-level
    // interaction without losing the underlying data.
    if (
      tableCellStructure &&
      tableCellStructure.pageNumber === pageNumber &&
      showTableCellStructure
    ) {
      const normX = pos.x / width;
      const normY = pos.y / height;
      for (const cell of tableCellStructure.cells) {
        if (
          normX >= cell.bbox[0] &&
          normX <= cell.bbox[2] &&
          normY >= cell.bbox[1] &&
          normY <= cell.bbox[3]
        ) {
          if (event.detail === 2) {
            toggleCellHighlight(cell.row, cell.col);
          } else if (cell.text) {
            setSearch(cell.text);
          }
          return true;
        }
      }
    }

    // Double-click: universal annotation filter — filter pages + search + highlights
    if (event.detail === 2) {
      for (const ann of pageAnnotations) {
        // Hit test — check area polygons with point-in-polygon, linear polylines with
        // point-near-line, others with bbox.
        let hit = false;
        if (
          ann.source === "takeoff" &&
          (ann.data as any)?.type === "area-polygon"
        ) {
          const data = ann.data as unknown as AreaPolygonData;
          const clickNorm = { x: pos.x / width, y: pos.y / height };
          // Clicking inside a hole (courtyard) should NOT select the polygon.
          hit = pointInPolygonWithHoles(clickNorm, data.vertices, data.holes);
        } else if (
          ann.source === "takeoff" &&
          (ann.data as any)?.type === "linear-polyline"
        ) {
          const data = ann.data as unknown as LinearPolylineData;
          hit = pointNearPolyline(pos, data.vertices, width, height);
        } else {
          hit = pointInNormalizedBbox(pos, ann.bbox, width, height);
        }
        if (!hit) continue;
        event.stopPropagation();

        const store = context.stores.ui.getState();
        const currentSearch = store.searchQuery;
        const isToggleOff =
          currentSearch.toLowerCase() === ann.name.toLowerCase();

        if (ann.source === "user") {
          // User markup: filter + open TextPanel → Markups tab
          if (isToggleOff) {
            setSearch("");
            if (!context.canAdoptProjectLifecycle()) return true;
            setAnnotationFilter(null);
            if (!context.canAdoptProjectLifecycle()) return true;
            store.setActiveMarkupId(null);
          } else {
            setSearch(ann.name);
            if (!context.canAdoptProjectLifecycle()) return true;
            setAnnotationFilter(ann.name);
            if (!context.canAdoptProjectLifecycle()) return true;
            store.setActiveMarkupId(ann.id);
            if (!context.canAdoptProjectLifecycle()) return true;
            store.setTextPanelTab("markups");
            if (!context.canAdoptProjectLifecycle()) return true;
            if (!store.showTextPanel) store.toggleTextPanel();
          }
        } else if (ann.source === "takeoff") {
          // QTO marker: filter by takeoff item
          const { takeoffItems } = context;
          if (!takeoffItems) {
            throw new Error(
              "pointerGroup takeoff detail-2 requires the takeoffItems capability",
            );
          }
          const itemId = (ann.data as any)?.takeoffItemId;
          const item = takeoffItems.find((candidate) => candidate.id === itemId);
          const itemName = item?.name || ann.name;
          if (
            isToggleOff ||
            currentSearch.toLowerCase() === itemName.toLowerCase()
          ) {
            setSearch("");
            if (!context.canAdoptProjectLifecycle()) return true;
            setTakeoffFilter(null);
          } else {
            setSearch(itemName);
            if (!context.canAdoptProjectLifecycle()) return true;
            setTakeoffFilter(itemId);
          }
        } else {
          // YOLO or other: annotation name filter
          if (isToggleOff) {
            setSearch("");
            if (!context.canAdoptProjectLifecycle()) return true;
            setAnnotationFilter(null);
          } else {
            setSearch(ann.name);
            if (!context.canAdoptProjectLifecycle()) return true;
            setAnnotationFilter(ann.name);
          }
        }
        return true;
      }

      // No annotation hit — try parsed table region hit-test.
      const pageIntelligence = readPageIntelligence(
        queryClient,
        publicId,
        pageNumber,
      ) as any;
      if (pageIntelligence?.parsedRegions) {
        const normX = pos.x / width;
        const normY = pos.y / height;
        for (const region of pageIntelligence.parsedRegions) {
          if (!region.bbox || region.type !== "schedule") continue;
          const [minX, minY, maxX, maxY] = region.bbox;
          if (
            normX >= minX &&
            normX <= maxX &&
            normY >= minY &&
            normY <= maxY
          ) {
            event.stopPropagation();
            // Stored-tab/new-flow handoff. Keep the canvas hot path subscription-free.
            focusParsedTableRegionInCatalog(region.id);
            return true;
          }
        }
      }

      // No parsed region hit — try OCR word fallback. This action-only reader must see live cache
      // replacements without subscribing the canvas.
      const pageWords = readTextractForPage(queryClient, publicId, pageNumber)?.words;
      if (pageWords) {
        const normX = pos.x / width;
        const normY = pos.y / height;
        for (const word of pageWords) {
          const [left, top, wordWidth, wordHeight] = word.bbox;
          if (
            normX >= left &&
            normX <= left + wordWidth &&
            normY >= top &&
            normY <= top + wordHeight
          ) {
            const searchQuery = context.stores.ui.getState().searchQuery;
            if (event.shiftKey && searchQuery) {
              const existing = searchQuery.toLowerCase().split(/\s+/);
              const newWord = word.text.toLowerCase();
              if (existing.includes(newWord)) {
                setSearch(existing.filter((value) => value !== newWord).join(" "));
              } else {
                setSearch(searchQuery + " " + word.text);
              }
            } else if (
              searchQuery.toLowerCase() === word.text.toLowerCase()
            ) {
              setSearch("");
            } else {
              setSearch(word.text);
            }
            event.stopPropagation();
            return true;
          }
        }
      }
      return true;
    }

    // If an annotation is already selected, check corners for resize.
    if (selection.selectedId !== null) {
      const selectedAnnotation = pageAnnotations.find(
        (annotation) => annotation.id === selection.selectedId,
      );
      if (selectedAnnotation) {
        const [minX, minY, maxX, maxY] = selectedAnnotation.bbox;
        const isAreaPolygon =
          selectedAnnotation.source === "takeoff" &&
          (selectedAnnotation.data as any)?.type === "area-polygon";

        // Vertex drag for selected area polygons runs before every other click path.
        if (isAreaPolygon) {
          const polygon = selectedAnnotation.data as unknown as AreaPolygonData;
          for (let index = 0; index < polygon.vertices.length; index++) {
            const vertexX = polygon.vertices[index].x * width;
            const vertexY = polygon.vertices[index].y * height;
            if (pointInHandle(pos, { x: vertexX, y: vertexY }, HANDLE)) {
              const { annotationDrag } = context;
              if (!annotationDrag) {
                throw new Error(
                  "pointerGroup vertex drag requires the annotationDrag capability",
                );
              }
              event.stopPropagation();
              if (!annotationDrag.begin(selectedAnnotation, {
                kind: "vertex",
                vertexIndex: index,
              })) {
                return true;
              }
              dragUi.setDraggingVertex({ annId: selectedAnnotation.id, idx: index });
              selection.setDragging(true);
              return true;
            }
          }
        }

        if (!isAreaPolygon) {
          const corners = {
            tl: { x: minX * width, y: minY * height },
            tr: { x: maxX * width, y: minY * height },
            bl: { x: minX * width, y: maxY * height },
            br: { x: maxX * width, y: maxY * height },
          };

          for (const [key, corner] of Object.entries(corners)) {
            if (pointInHandle(pos, corner, HANDLE)) {
              const { annotationDrag } = context;
              if (!annotationDrag) {
                throw new Error(
                  "pointerGroup corner resize requires the annotationDrag capability",
                );
              }
              event.stopPropagation();
              if (!annotationDrag.begin(selectedAnnotation, {
                kind: "bbox",
                resizeCorner: key,
                dragOffset: { x: 0, y: 0 },
              })) {
                return true;
              }
              selection.setResizeCorner(key);
              selection.setDragging(true);
              return true;
            }
          }
        }

        // Check label bar area for pencil (edit) or x (delete) click.
        const anchorX = minX * width;
        const anchorY = minY * height;
        if (
          pos.y >= anchorY - 18 &&
          pos.y <= anchorY &&
          pos.x >= anchorX
        ) {
          const fontSize = Math.max(
            10,
            Math.min(13, (maxY - minY) * height * 0.3),
          );
          const canvas = markupEdit.canvasRef.current;
          const canvasContext = canvas?.getContext("2d");
          if (canvasContext) {
            canvasContext.font = `bold ${fontSize}px sans-serif`;
            const textWidth = canvasContext.measureText(selectedAnnotation.name).width;
            const iconStart = anchorX + textWidth + 8;
            const isUserSource = selectedAnnotation.source === "user";

            if (
              isUserSource &&
              pos.x >= iconStart &&
              pos.x < iconStart + 16
            ) {
              // Pencil icon clicked — edit markup.
              event.stopPropagation();
              markupEdit.setPendingMarkup(
                selectedAnnotation.bbox as [number, number, number, number],
              );
              markupEdit.setMarkupName(selectedAnnotation.name);
              markupEdit.setMarkupNote(selectedAnnotation.note || "");
              const existingCsi =
                (selectedAnnotation.data as { csiCodes?: string[] } | null)
                  ?.csiCodes?.[0] ?? "";
              markupEdit.setMarkupCsi(existingCsi);
              markupEdit.setEditingAnnotationId(selectedAnnotation.id);
              setTimeout(() => markupEdit.nameInputRef.current?.focus(), 50);
              return true;
            }
            const deleteStart = isUserSource ? iconStart + 16 : iconStart;
            if (pos.x >= deleteStart) {
              // Delete "x" clicked.
              event.stopPropagation();
              selection.deleteSelected();
              return true;
            }
          }
        }
      }
    }

    // Check area polygons first (point-in-polygon test). A hole falls through to what is below.
    for (const ann of pageAnnotations) {
      if (
        ann.source !== "takeoff" ||
        (ann.data as any)?.type !== "area-polygon"
      ) {
        continue;
      }
      const data = ann.data as unknown as AreaPolygonData;
      const clickNorm = { x: pos.x / width, y: pos.y / height };
      if (pointInPolygonWithHoles(clickNorm, data.vertices, data.holes)) {
        event.stopPropagation();
        selection.setSelectedId(ann.id);
        return true;
      }
    }

    // Check linear polylines (point-near-line test).
    for (const ann of pageAnnotations) {
      if (
        ann.source !== "takeoff" ||
        (ann.data as any)?.type !== "linear-polyline"
      ) {
        continue;
      }
      const data = ann.data as unknown as LinearPolylineData;
      if (pointNearPolyline(pos, data.vertices, width, height)) {
        event.stopPropagation();
        selection.setSelectedId(ann.id);
        return true;
      }
    }

    // Check annotations (bbox-based) — select and start drag.
    for (const ann of pageAnnotations) {
      const [minX, minY] = ann.bbox;
      const anchorX = minX * width;
      const anchorY = minY * height;
      if (pointInNormalizedBbox(pos, ann.bbox, width, height)) {
        event.stopPropagation();
        const { handled } = multiSelect.handleAnnotationClick(ann.id, event);
        if (!context.canAdoptProjectLifecycle()) return true;
        if (handled) return true;
        multiSelect.expandSelectionViaGroups(ann.id);
        if (!context.canAdoptProjectLifecycle()) return true;
        selection.setSelectedId(ann.id);
        setSearch(ann.name);
        if (!context.canAdoptProjectLifecycle()) return true;
        if (ann.source === "yolo") {
          const matchingTag = yoloTags.find((tag) =>
            tag.instances.some(
              (instance) =>
                instance.annotationId === ann.id &&
                instance.pageNumber === pageNumber,
            ),
          );
          if (matchingTag) {
            setActiveYoloTagId(matchingTag.id);
            if (!context.canAdoptProjectLifecycle()) return true;
            setYoloTagFilter(matchingTag.id);
            if (!context.canAdoptProjectLifecycle()) return true;
          }
        }
        const nextDragOffset = {
          x: pos.x - anchorX,
          y: pos.y - anchorY,
        };
        const { annotationDrag } = context;
        if (!annotationDrag) {
          throw new Error(
            "pointerGroup generic drag requires the annotationDrag capability",
          );
        }
        if (!annotationDrag.begin(ann, {
          kind: "bbox",
          resizeCorner: null,
          dragOffset: nextDragOffset,
        })) {
          return true;
        }
        selection.setDragging(true);
        selection.setResizeCorner(null);
        dragUi.setDragOffset(nextDragOffset);
        return true;
      }
    }

    // Check keynotes.
    const clickX = pos.x / width;
    const clickY = pos.y / height;
    for (const keynote of pageKeynotes) {
      const [left, top, right, bottom] = keynote.bbox;
      if (
        clickX >= left &&
        clickX <= right &&
        clickY >= top &&
        clickY <= bottom
      ) {
        event.stopPropagation();
        setKeynoteFilter({ shape: keynote.shape, text: keynote.text });
        if (!context.canAdoptProjectLifecycle()) return true;
        if (keynote.text) setSearch(keynote.text);
        return true;
      }
    }

    // Clicked empty space — deselect, OR start a lasso in Group mode.
    if (toolAtDown.mode === "group") {
      const { deferredDrawing } = context;
      if (!deferredDrawing) {
        throw new Error(
          "pointerGroup empty Group requires the deferredDrawing capability",
        );
      }
      deferredDrawing.start(pos, false);
      return true;
    }
    selection.setSelectedId(null);
    multiSelect.clearSelection();
    return true;
  },
} satisfies ToolController);
