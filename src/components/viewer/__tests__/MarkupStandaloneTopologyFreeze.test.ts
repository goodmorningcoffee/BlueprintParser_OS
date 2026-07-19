import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const MARKUP = readFileSync(
  join(process.cwd(), "src/components/viewer/tools/markup.ts"),
  "utf8",
);
const POINTER = readFileSync(
  join(process.cwd(), "src/components/viewer/tools/pointerGroup.ts"),
  "utf8",
);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function compact(source: string): string {
  return source.replace(/\s+/g, "");
}

function expectOrdered(source: string, label: string, needles: readonly string[]): void {
  let cursor = 0;
  for (const needle of needles) {
    const index = source.indexOf(needle, cursor);
    expect(index, `${label}: ${needle}`).toBeGreaterThanOrEqual(cursor);
    cursor = index + needle.length;
  }
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

describe("P3 standalone markup topology and finding dispositions", () => {
  it("requires one shared reset terminal to clear all five controlled fields", () => {
    const state = AO.slice(
      AO.indexOf("// Markup modal: the first CSI entry is editable"),
      AO.indexOf("const {\n    showDetections"),
    );
    expect(compact(state)).toContain(compact(`
      const clearMarkupDialog = useCallback(() => {
        setPendingMarkup(null);
        setMarkupName("");
        setMarkupNote("");
        setMarkupCsi("");
        setEditingAnnotationId(null);
      }, []);
    `));
    const jsx = AO.slice(AO.indexOf("{/* Markup name + notes + CSI dialog */"));
    expect(compact(jsx)).toContain("onCancel={clearMarkupDialog}");
    expect(count(jsx, "onCancel=")).toBe(1);
  });

  it("pins #13 already retired instead of manufacturing replacement provenance", () => {
    expect(AO).not.toContain("saveVertexEdit");
    expect(AO).not.toContain("split-area persistence code at L941");
    expect(AO).not.toContain("Pattern cloned from the split-area persistence");
  });

  it("pins the only two non-null dialog openers and the shared save tail", () => {
    expect(count(AO, "setPendingMarkup(selAnn.bbox as [number, number, number, number]);")).toBe(0);
    expect(count(POINTER, "markupEdit.setPendingMarkup(")).toBe(1);
    expect(count(AO, "setPendingMarkup(bbox);")).toBe(1);
    expect(count(AO, "const saveMarkup = useCallback(() => {")).toBe(1);
    expect(count(AO, "<MarkupDialog")).toBe(1);
    expect(count(AO, "void persistCreate({")).toBe(4);
  });

  it("discharges K12 with exact parent provenance and S1-S7 transposition evidence", () => {
    expect(AO).not.toContain("// Pointer mode (and Group mode");
    expect(POINTER).toContain(
      "Parent provenance: AO SHA-256 d96515838b125e4d20ccca71bc5c5179f5c5f5cfb098de9c297d65d2d4eefa6e;",
    );
    expect(POINTER).toContain(
      "marker slice 15,617 bytes / 327 newlines / SHA-256",
    );
    expect(POINTER).toContain(
      "fd0b1e5c54a1c808e365ec34b7e15903d5c013f78ac727c69867ea7aac6c2dee.",
    );
    const transposition = [
      {
        label: "S1 TATR",
        start: "// TATR cell click:",
        end: "// Double-click: universal annotation filter",
        returns: 1,
        effects: [
          "toggleCellHighlight(cell.row, cell.col);",
          "setSearch(cell.text);",
        ],
      },
      {
        label: "S2 detail-2",
        start: "// Double-click: universal annotation filter",
        end: "// If an annotation is already selected",
        returns: 14,
        effects: [
          "hit = pointInPolygonWithHoles(",
          "hit = pointNearPolyline(",
          "hit = pointInNormalizedBbox(",
          "event.stopPropagation();",
          "const store = context.stores.ui.getState();",
          "setSearch(\"\");",
          "setAnnotationFilter(null);",
          "store.setActiveMarkupId(null);",
          "setSearch(ann.name);",
          "setAnnotationFilter(ann.name);",
          "store.setActiveMarkupId(ann.id);",
          "store.setTextPanelTab(\"markups\");",
          "if (!store.showTextPanel) store.toggleTextPanel();",
          "const { takeoffItems } = context;",
          "pointerGroup takeoff detail-2 requires the takeoffItems capability",
          "setTakeoffFilter(null);",
          "setTakeoffFilter(itemId);",
          "readPageIntelligence(",
          "event.stopPropagation();",
          "focusParsedTableRegionInCatalog(region.id);",
          "readTextractForPage(",
          "const searchQuery = context.stores.ui.getState().searchQuery;",
          "event.stopPropagation();",
        ],
      },
      {
        label: "S3 selected controls",
        start: "// If an annotation is already selected",
        end: "// Check area polygons first",
        returns: 6,
        effects: [
          "const { annotationDrag } = context;",
          "pointerGroup vertex drag requires the annotationDrag capability",
          "event.stopPropagation();",
          'kind: "vertex",',
          "dragUi.setDraggingVertex({ annId: selectedAnnotation.id, idx: index });",
          "selection.setDragging(true);",
          "const { annotationDrag } = context;",
          "pointerGroup corner resize requires the annotationDrag capability",
          "event.stopPropagation();",
          'kind: "bbox",',
          "selection.setResizeCorner(key);",
          "selection.setDragging(true);",
          "canvasContext.font =",
          "canvasContext.measureText(selectedAnnotation.name)",
          "event.stopPropagation();",
          "markupEdit.setPendingMarkup(",
          "markupEdit.setMarkupName(selectedAnnotation.name);",
          'markupEdit.setMarkupNote(selectedAnnotation.note || "");',
          "markupEdit.setMarkupCsi(existingCsi);",
          "markupEdit.setEditingAnnotationId(selectedAnnotation.id);",
          "setTimeout(() => markupEdit.nameInputRef.current?.focus(), 50);",
          "const deleteStart =",
          "event.stopPropagation();",
          "selection.deleteSelected();",
        ],
      },
      {
        label: "S4 precise area",
        start: "// Check area polygons first",
        end: "// Check linear polylines",
        returns: 1,
        effects: [
          "pointInPolygonWithHoles(clickNorm, data.vertices, data.holes)",
          "event.stopPropagation();",
          "selection.setSelectedId(ann.id);",
        ],
      },
      {
        label: "S4 precise linear",
        start: "// Check linear polylines",
        end: "// Check annotations (bbox-based)",
        returns: 1,
        effects: [
          "pointNearPolyline(pos, data.vertices, width, height)",
          "event.stopPropagation();",
          "selection.setSelectedId(ann.id);",
        ],
      },
      {
        label: "S4 bbox",
        start: "// Check annotations (bbox-based)",
        end: "// Check keynotes.",
        returns: 8,
        effects: [
          "event.stopPropagation();",
          "multiSelect.handleAnnotationClick(ann.id, event)",
          "if (!context.canAdoptProjectLifecycle()) return true;",
          "if (handled) return true;",
          "multiSelect.expandSelectionViaGroups(ann.id);",
          "if (!context.canAdoptProjectLifecycle()) return true;",
          "selection.setSelectedId(ann.id);",
          "setSearch(ann.name);",
          "if (!context.canAdoptProjectLifecycle()) return true;",
          "instance.annotationId === ann.id &&",
          "instance.pageNumber === pageNumber",
          "setActiveYoloTagId(matchingTag.id);",
          "if (!context.canAdoptProjectLifecycle()) return true;",
          "setYoloTagFilter(matchingTag.id);",
          "if (!context.canAdoptProjectLifecycle()) return true;",
          "const { annotationDrag } = context;",
          "pointerGroup generic drag requires the annotationDrag capability",
          "annotationDrag.begin(ann, {",
          "selection.setDragging(true);",
          "selection.setResizeCorner(null);",
          "dragUi.setDragOffset(nextDragOffset);",
        ],
      },
      {
        label: "S5 keynote",
        start: "// Check keynotes.",
        end: "// Clicked empty space",
        returns: 2,
        effects: [
          "event.stopPropagation();",
          "setKeynoteFilter({ shape: keynote.shape, text: keynote.text });",
          "if (!context.canAdoptProjectLifecycle()) return true;",
          "if (keynote.text) setSearch(keynote.text);",
        ],
      },
      {
        label: "S6/S7 empty",
        start: "// Clicked empty space",
        end: "  },\n} satisfies ToolController",
        returns: 2,
        effects: [
          "pointerGroup empty Group requires the deferredDrawing capability",
          "deferredDrawing.start(pos, false);",
          "selection.setSelectedId(null);",
          "multiSelect.clearSelection();",
        ],
      },
    ] as const;
    let prior = -1;
    for (const row of transposition) {
      const start = POINTER.indexOf(row.start);
      const end = POINTER.indexOf(row.end, start + row.start.length);
      expect(start, `${row.label} start`).toBeGreaterThan(prior);
      expect(end, `${row.label} end`).toBeGreaterThan(start);
      const section = POINTER.slice(start, end);
      expect(count(section, "return true;"), `${row.label} returns`).toBe(row.returns);
      expectOrdered(section, row.label, row.effects);
      prior = start;
    }
    const invalidation = POINTER.indexOf("invalidateToolTailAuthority();");
    expect(invalidation).toBeGreaterThan(POINTER.indexOf("pointerGroup capabilities"));
    expect(invalidation).toBeLessThan(POINTER.indexOf(transposition[0].start));
    expect(count(POINTER, "return true;")).toBe(35);
    expect(POINTER).not.toContain("return false;");
    expect(POINTER).not.toMatch(/return;\s*$/m);
    expect(POINTER).toContain("selection.deleteSelected();");
    expect(POINTER).toContain(
      "setTimeout(() => markupEdit.nameInputRef.current?.focus(), 50);",
    );
    expect(Buffer.byteLength(MARKUP, "utf8")).toBe(4543);
    expect(sha256(MARKUP)).toBe(
      "b73291e6f81070d4d412eed13b329a6b2657d5986af8a3bb301aa92f4c5044d6",
    );
  });

  it("pins the sacred handleMouseDown dependency contract", () => {
    const callbackStart = AO.indexOf("  const handleMouseDown = useCallback(");
    const callbackEnd = AO.indexOf("\n  );", callbackStart);
    const callback = AO.slice(callbackStart, callbackEnd + "\n  );".length);
    const dependencyStart = callback.lastIndexOf("\n    [") + 1;
    const dependencyEnd = callback.indexOf("]\n  );", dependencyStart) + 2;
    const raw = callback.slice(dependencyStart, dependencyEnd);
    const members = raw.trim().slice(1, -1).split(",").map((member) => member.trim()).filter(Boolean);

    expect(members).toHaveLength(37);
    expect(createHash("md5").update(raw).digest("hex")).toBe(
      "dada8bf65ea7834550cc1e5fc221d5ee",
    );
  });

  it("keeps the ratcheted AO ceiling through the first two P3.3 render extractions", () => {
    expect(AO.split("\n").length - 1).toBeLessThanOrEqual(2086);
  });
});
