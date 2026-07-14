// [refactor jul11 P2.2⑥] ANNOTATIONS MIGRATION FREEZE NET — takeoff undo/redo call surfaces.
//
// WHY THIS FILE EXISTS: takeoffUndo/takeoffRedo currently update annotations and the two history
// stacks atomically inside zustand. In C3, annotations move to TanStack Query while the stacks stay
// in zustand, so these operations become a deliberately non-atomic cache+store pair. These tests
// freeze the user-visible behavior at BOTH production entry points before that split: the two
// TakeoffPanel buttons and useKeyboardShortcuts' plain Z/W handlers. A refactor that wires only one
// caller, removes the wrong matching marker, restores in the wrong position, or mutates history on a
// guarded undo must therefore fail here.
//
// [refactor jul11 P2.2⑥] MIGRATION DISCIPLINE: QueryClientProvider is present from the first render.
// C3 closes over useQueryClient() in its []-dependency keydown effect; mounting the provider proves
// that wiring without rewriting test
// bodies later. Annotation setup always goes through seedAnnotations(qc, rows), the domain's single
// backing flip point. Likewise, EVERY annotation assertion goes through readCurrentAnnotations()
// below, which delegates to the cache-backed shared test seam. Stack reads
// deliberately remain zustand-backed because the stacks do.
//
// Post-event assertions use waitFor because Query observers notify on a later task; the same read
// barrier prevents same-tick false positives while stack writes remain synchronous zustand updates.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useToolStore } from "@/stores/toolStore";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import type { ClientAnnotation, ClientTakeoffItem } from "@/types";
import TakeoffPanel from "../TakeoffPanel";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function takeoffItem(id = 7): ClientTakeoffItem {
  return {
    id,
    name: `Item ${id}`,
    shape: "circle",
    color: "#ef4444",
    size: 10,
    sortOrder: 0,
    groupId: null,
  };
}

function takeoffAnnotation(id: number, takeoffItemId = 7, pageNumber = 1): ClientAnnotation {
  return {
    id,
    pageNumber,
    name: `takeoff-${id}`,
    bbox: [0, 0, 0.1, 0.1],
    note: null,
    source: "takeoff",
    data: {
      type: "count-marker",
      shape: "circle",
      color: "#ef4444",
      takeoffItemId,
    },
  };
}

function userAnnotation(id: number, pageNumber = 1): ClientAnnotation {
  return {
    id,
    pageNumber,
    name: `user-${id}`,
    bbox: [0.2, 0.2, 0.3, 0.3],
    note: null,
    source: "user",
    data: null,
  };
}

// [refactor jul11 P2.2⑥] WHY this indirection is load-bearing: `annotations` is the field C3
// deletes from viewerStore. The shared test seam owns that backing knowledge so every behavioral
// assertion below remains unchanged across the flip.
function readCurrentAnnotations(): readonly ClientAnnotation[] {
  return readSeededAnnotations(qc);
}

// [refactor jul11 P2.2⑥] The history arrays intentionally bypass the annotation helper: unlike the
// annotation collection, both stacks remain zustand tool state after C3.
function readHistory() {
  const { takeoffUndoStack, takeoffRedoStack } = useToolStore.getState();
  return { takeoffUndoStack, takeoffRedoStack };
}

function annotationIds(): number[] {
  return readCurrentAnnotations().map((annotation) => annotation.id);
}

function historyIds() {
  const { takeoffUndoStack, takeoffRedoStack } = readHistory();
  return {
    undo: takeoffUndoStack.map((annotation) => annotation.id),
    redo: takeoffRedoStack.map((annotation) => annotation.id),
  };
}

function KeyboardHarness() {
  useKeyboardShortcuts();
  return <div data-testid="keyboard-shortcuts-mounted" />;
}

function pressKey(key: "z" | "w"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(window, event);
  return event;
}

const fetchMock = vi.fn();

beforeEach(() => {
  qc = new QueryClient(); // pure production defaults; provider exists from birth for the C3 hook
  resetProjectData();
  // P2.5 resetProjectData clears both history arrays; repeat their destination values here with the
  // rest of this fixture so handler preconditions remain explicit.
  setViewerStoreStateForTest({
    publicId: "pid",
    isDemo: false,
    activeTool: null,
    takeoffUndoStack: [],
    takeoffRedoStack: [],
  });
  seedAnnotations(qc, []); // AFTER publicId: C3's cache key derives from the live project id
  seedTakeoff(qc, [], []);

  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected fetch in takeoff undo/redo freeze test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TakeoffPanel takeoff undo/redo buttons", () => {
  it("Undo removes the last active-item marker on the current page, pushes it, and clears redo", async () => {
    const priorUndo = takeoffAnnotation(90);
    const staleRedo = takeoffAnnotation(91);
    const rows = [
      userAnnotation(1),
      takeoffAnnotation(2), // earlier matching marker: must survive
      takeoffAnnotation(3, 8), // wrong item: must survive
      takeoffAnnotation(4, 7, 2), // right item, wrong page: must survive
      takeoffAnnotation(5), // LAST matching marker: this exact row is removed
      takeoffAnnotation(6, 8), // proves undo is reverse-match, not pop-the-array-tail
    ];

    seedTakeoff(qc, [takeoffItem(7)], []);
    seedAnnotations(qc, rows);
    // [refactor jul11 P2.2⑥] Current button enablement is history-length based. Seed one prior
    // undo row so the REAL button can invoke the action; the action must append, not replace, it.
    setViewerStoreStateForTest({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: 7,
      pageNumber: 1,
      takeoffUndoStack: [priorUndo],
      takeoffRedoStack: [staleRedo],
    });

    render(<TakeoffPanel />, { wrapper });
    const undoButton = await screen.findByTitle("Undo last placement (Z)");
    const redoButton = screen.getByTitle("Redo (W)");
    expect(undoButton).toBeEnabled();

    fireEvent.click(undoButton);

    await waitFor(() => {
      expect(annotationIds()).toEqual([1, 2, 3, 4, 6]);
      expect(historyIds()).toEqual({ undo: [90, 5], redo: [] });
      expect(redoButton).toBeDisabled();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Redo appends the undo-stack top and moves that exact row onto the redo stack", async () => {
    const restored = takeoffAnnotation(5);
    const priorRedo = takeoffAnnotation(91);

    seedTakeoff(qc, [takeoffItem(7)], []);
    seedAnnotations(qc, [userAnnotation(1), takeoffAnnotation(2, 8)]);
    // [refactor jul11 P2.2⑥] The current panel enables Redo from redoStack even though the action
    // restores from undoStack. Seed both independently so the click exercises the production action
    // and freezes its actual append/move semantics without reaching around the disabled button.
    setViewerStoreStateForTest({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: 7,
      pageNumber: 1,
      takeoffUndoStack: [restored],
      takeoffRedoStack: [priorRedo],
    });

    render(<TakeoffPanel />, { wrapper });
    const undoButton = await screen.findByTitle("Undo last placement (Z)");
    const redoButton = screen.getByTitle("Redo (W)");
    expect(redoButton).toBeEnabled();

    fireEvent.click(redoButton);

    await waitFor(() => {
      expect(annotationIds()).toEqual([1, 2, 5]); // restored row is appended, never re-sorted
      expect(historyIds()).toEqual({ undo: [], redo: [91, 5] });
      expect(undoButton).toBeDisabled();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useKeyboardShortcuts takeoff Z/W", () => {
  it("Z undoes through the live qc-ready handler and W restores the same row at the array tail", async () => {
    const staleRedo = takeoffAnnotation(91);
    seedAnnotations(qc, [
      userAnnotation(1),
      takeoffAnnotation(2),
      takeoffAnnotation(3, 8),
      takeoffAnnotation(4), // last active-item/current-page match
      userAnnotation(5), // survives undo and precedes the restored row after W
    ]);
    setViewerStoreStateForTest({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: 7,
      pageNumber: 1,
      takeoffUndoStack: [],
      takeoffRedoStack: [staleRedo],
    });

    render(<KeyboardHarness />, { wrapper });
    expect(await screen.findByTestId("keyboard-shortcuts-mounted")).toBeInTheDocument();

    const undoEvent = pressKey("z");
    await waitFor(() => {
      expect(undoEvent.defaultPrevented).toBe(true);
      expect(annotationIds()).toEqual([1, 2, 3, 5]);
      expect(historyIds()).toEqual({ undo: [4], redo: [] });
    });

    const redoEvent = pressKey("w");
    await waitFor(() => {
      expect(redoEvent.defaultPrevented).toBe(true);
      expect(annotationIds()).toEqual([1, 2, 3, 5, 4]);
      expect(historyIds()).toEqual({ undo: [], redo: [4] });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Z is a full no-op for null-active and active-with-no-current-page-match states", async () => {
    const rows = [takeoffAnnotation(2, 7, 1), userAnnotation(3, 2)];
    const priorUndo = [takeoffAnnotation(90)];
    const priorRedo = [takeoffAnnotation(91)];
    seedAnnotations(qc, rows);
    // Query structural sharing is allowed to retain/copy an equal-deep seed. The guard invariant
    // is that the operation preserves the CACHE'S pre-event reference, not the caller input ref.
    const rowsBefore = readCurrentAnnotations();
    expect(rowsBefore).toEqual(rows);
    setViewerStoreStateForTest({
      activeTool: null,
      activeTakeoffItemId: null,
      pageNumber: 1,
      takeoffUndoStack: priorUndo,
      takeoffRedoStack: priorRedo,
    });

    render(<KeyboardHarness />, { wrapper });
    await screen.findByTestId("keyboard-shortcuts-mounted");

    // [refactor jul11 P2.2⑥] Null-active is rejected by the keyboard gate itself: no preventDefault
    // and no call into undo. C3 must not accidentally make the plain Z key globally captive.
    const nullActiveEvent = pressKey("z");
    await waitFor(() => {
      expect(nullActiveEvent.defaultPrevented).toBe(false);
      expect(readCurrentAnnotations()).toBe(rowsBefore);
      expect(readHistory().takeoffUndoStack).toBe(priorUndo);
      expect(readHistory().takeoffRedoStack).toBe(priorRedo);
    });

    // The effect deliberately has [] deps, so changing these fields after mount also proves that the
    // handler reads live store state. Item 7 exists, but only on page 1; page 2 is the no-match guard.
    setViewerStoreStateForTest({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: 7,
      pageNumber: 2,
    });
    const noMatchEvent = pressKey("z");
    await waitFor(() => {
      expect(noMatchEvent.defaultPrevented).toBe(true); // key recognized; operation itself no-ops
      expect(readCurrentAnnotations()).toBe(rowsBefore);
      expect(readHistory().takeoffUndoStack).toBe(priorUndo);
      // Load-bearing guard: a no-match undo must NOT clear existing redo history.
      expect(readHistory().takeoffRedoStack).toBe(priorRedo);
    });

    // W reaches the action when an item is active, but redo restores from undoStack. An empty
    // undo stack is therefore a second independent no-op guard; deleting it would duplicate or
    // invent a row from redo history during the C2 hoist.
    setViewerStoreStateForTest({ pageNumber: 1, takeoffUndoStack: [], takeoffRedoStack: priorRedo });
    const emptyUndoRedoEvent = pressKey("w");
    await waitFor(() => {
      expect(emptyUndoRedoEvent.defaultPrevented).toBe(true);
      expect(readCurrentAnnotations()).toBe(rowsBefore);
      expect(readHistory().takeoffUndoStack).toEqual([]);
      expect(readHistory().takeoffRedoStack).toBe(priorRedo);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
