// @vitest-environment jsdom
//
// [refactor jul17 P3.2] EXECUTABLE behavior freeze for the LINEAR identity of the legacy
// takeoffPlacement mousedown branch, landed test-only at parent 8bad066 BEFORE the takeoffLinear
// controller extraction.
//
// Why this file exists (TAKEOFF_LINEAR_IMPL/RECON_CENSUS.md): after the count extraction the
// legacy branch (AO:1753-1826) still serves TWO controller identities discriminated by
// activeItem.shape (polygon / linear). The linear identity — idle-start (mode write, lifecycle
// fence, first vertex), finish-snap to the LAST vertex (anisotropic px scaling, strict < 10,
// >= 2-vertex gate) into the saveLinearPolyline composite, and the e.detail < 2 vertex append —
// has only two executable oracles today: TakeoffCountGestureFreeze W12 (one idle press) and
// AnnotationOverlayLifecyclePublicationsFreeze :641 (the mode-write -> fence -> append
// publication ordering). Everything else is unfrozen. The load-bearing behaviors frozen here
// through the PRODUCTION mousedown handler:
//   (1) idle-start: setPolygonDrawingMode("drawing") then EXACTLY ONE vertex at the
//       props-normalized press point, prelude (invalidate + stopPropagation) exactly once;
//   (2) finish-snap: with >= 2 vertices, a press strictly < 10px from the LAST vertex's
//       ANISOTROPIC pixel position (v.x by PROPS width, v.y by height) calls
//       saveLinearPolyline() — optimistic "linear-polyline" row from the LIVE store vertices
//       (press point NOT appended), settled reset to idle/[] — while exactly 10px falls through
//       to the vertex append; the snap check runs ONLY at >= 2 vertices (a distance-0 press on
//       the sole vertex appends);
//   (3) the double-click second press (e.detail >= 2) appends NOTHING yet still consumes the
//       press (silent-consume arm);
//   (4) the optimistic seam through the mousedown finish: demo never touches either network
//       channel (temp negative id); non-demo failure keeps the row and publishes the exact
//       "Failed to save line: <message>" transient (the composite STAYS in AO — these pin the
//       mousedown -> composite wiring end-to-end);
//   (5) the sibling identities stay SINGLE-EXECUTION contrasts (polygon: one vertex, one
//       invalidation, one stop; count: marker placed, no vertex) — post-move these witness that
//       the controller's eligible-DECLINE re-enters its consumer without doubling the prelude;
//   (6) the two SURVIVING saveLinearPolyline call sites (Enter keydown, double-click) keep
//       finishing polylines — the extraction moves only the mousedown call site.
//
// The final describe pins the PRE-move source topology; the extraction commit rewrites ONLY that
// describe to the post-move topology (linear identity absent from the overlay, controller file
// the sole home, factory carries the takeoffDrawing capability).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { persistFetch } from "@/lib/client-persist";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { seedAnnotations, readSeededAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation, ClientTakeoffItem } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));

// The persistFetch module mock (importOriginal spread — canPersist stays REAL) is the only
// sanctioned write channel for the optimistic-create seam; demo witnesses assert it stays cold.
vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: vi.fn() };
});
const persistFetchMock = vi.mocked(persistFetch);

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "takeoff-linear-fixture";

let queryClient: QueryClient;
const parentMouseDown = vi.fn();
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div onMouseDown={parentMouseDown}>{children}</div>
    </QueryClientProvider>
  );
}

function noopContext(): CanvasRenderingContext2D {
  const target = { measureText: () => ({ width: 0 }) };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => {};
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function canvasRect(width: number, height: number): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  } as DOMRect;
}

function linearItem(over: Partial<ClientTakeoffItem> & { id: number }): ClientTakeoffItem {
  return { name: "Conduit", shape: "linear", color: "#3b82f6", size: 10, sortOrder: 0, groupId: null, ...over };
}

function seedLinearState(
  rows: ClientAnnotation[],
  items: ClientTakeoffItem[],
  over: {
    activeTakeoffItemId?: number | null;
    isDemo?: boolean;
    activeTool?: { kind: "takeoffPlacement" } | null;
  } = {},
): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  parentMouseDown.mockClear();
  fetchMock.mockReset();
  persistFetchMock.mockReset();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: over.isDemo ?? true,
    pageNumber: 1,
    numPages: 1,
    pageNames: { 1: "A-101" },
    mode: "pointer",
    activeTool: over.activeTool === undefined ? { kind: "takeoffPlacement" } : over.activeTool,
    activeTakeoffItemId: over.activeTakeoffItemId === undefined ? 6 : over.activeTakeoffItemId,
    polygonDrawingMode: "idle",
    polygonVertices: [],
  });
  seedAnnotations(queryClient, rows);
  seedTakeoff(queryClient, items, []);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
}

async function mountCanvas(width = 200, height = 100) {
  const { container } = render(
    <AnnotationOverlay width={width} height={height} cssScale={1} />,
    { wrapper },
  );
  const canvas = await waitFor(() => {
    const candidate = container.querySelector("canvas");
    if (!(candidate instanceof HTMLCanvasElement)) {
      throw new Error("Expected AnnotationOverlay canvas");
    }
    return candidate;
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect(width, height));
  return canvas;
}

function press(canvas: HTMLCanvasElement, clientX: number, clientY: number, detail = 1): void {
  act(() => {
    fireEvent.mouseDown(canvas, { clientX, clientY, button: 0, detail });
  });
}

// Drawing-state fixtures must be installed AFTER mount (LifecyclePublicationsFreeze recipe): the
// overlay's mount-time item-cleanup effect (AO "Reset polygon drawing if active item changes")
// publishes a settled polygon reset whenever it sees a pre-seeded "drawing" mode, so seeding
// through the pre-mount store patch would be silently wiped.
function enterDrawing(vertices: { x: number; y: number }[]): void {
  act(() => {
    useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: vertices.map((v) => ({ ...v })),
    });
  });
}

function polylineRows(): ClientAnnotation[] {
  return readSeededAnnotations(queryClient).filter(
    (a) => (a.data as { type?: string } | null)?.type === "linear-polyline",
  );
}

// Two seeded vertices whose LAST sits at norm (0.5, 0.5) → pixel (100, 50) on the 200×100
// canvas. The strict-<10 finish boundary is witnessed at presses (109,50)=9px and (110,50)=10px.
const TWO_VERTS = [
  { x: 0.1, y: 0.2 },
  { x: 0.5, y: 0.5 },
];

describe("takeoff linear gesture freeze (real overlay, production mousedown)", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("W1: an idle press starts drawing with exactly one props-normalized vertex and one prelude", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 50, 50); // norm (0.25, 0.5) — 200×100 discriminates the axis scaling
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(useToolStore.getState().polygonVertices).toEqual([{ x: 0.25, y: 0.5 }]);
    expect(parentMouseDown).not.toHaveBeenCalled(); // prelude stopped propagation
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1); // exactly one prelude invalidation
    expect(readSeededAnnotations(queryClient)).toHaveLength(0); // no save on start
  });

  it("W2: a drawing press far from the last vertex appends at exact norm coords and never saves", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(TWO_VERTS);

    press(canvas, 180, 20); // 81px from last vertex px (100,50) — no snap
    expect(useToolStore.getState().polygonVertices).toEqual([
      ...TWO_VERTS,
      { x: 180 / 200, y: 20 / 100 },
    ]);
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing"); // still drawing
    expect(polylineRows()).toHaveLength(0);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("W3a: a press strictly inside 10px of the last vertex finishes — save from LIVE store verts, settled reset", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(TWO_VERTS);

    press(canvas, 109, 50); // dist from (100,50) = 9 < 10
    const rows = polylineRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBeLessThan(0); // optimistic temp id
    expect(row.name).toBe("Conduit");
    expect(row.source).toBe("takeoff");
    // The composite copies the LIVE store vertices — the finishing press point is NOT appended.
    expect(row.data).toEqual({
      type: "linear-polyline",
      takeoffItemId: 6,
      color: "#3b82f6",
      vertices: TWO_VERTS,
      totalLength: 0, // no calibration seeded
      unit: "ft",
      segmentLengths: [],
    });
    expect(row.bbox).toEqual([0.1, 0.2, 0.5, 0.5]); // min/max of the vertices
    // Settled reset: drawing state cleared synchronously after the optimistic publication.
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(useToolStore.getState()._mousePos).toBeNull();
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it("W3b: exactly 10px away is NOT a finish (strict <) — the press appends instead", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(TWO_VERTS);

    press(canvas, 110, 50); // dist from (100,50) is exactly 10
    expect(polylineRows()).toHaveLength(0);
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(useToolStore.getState().polygonVertices).toEqual([
      ...TWO_VERTS,
      { x: 110 / 200, y: 50 / 100 },
    ]);
  });

  it("W4: the last-vertex pixel position is anisotropic (x by width, y by height) — the transposed point appends, the true point finishes", async () => {
    const verts = [
      { x: 0.8, y: 0.9 },
      { x: 0.2, y: 0.4 }, // true px (40, 40) on 200×100; transposed scaling would put it at (20, 80)
    ];
    seedLinearState([], [linearItem({ id: 6 })]);
    let canvas = await mountCanvas();
    enterDrawing(verts);

    press(canvas, 20, 80); // 44.7px from the true (40,40) — appends
    expect(polylineRows()).toHaveLength(0);
    expect(useToolStore.getState().polygonVertices).toHaveLength(3);

    cleanup();
    seedLinearState([], [linearItem({ id: 6 })]);
    canvas = await mountCanvas();
    enterDrawing(verts);
    press(canvas, 40, 40); // distance zero from the true pixel position — finishes
    expect(polylineRows()).toHaveLength(1);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
  });

  it("W5: the snap check is gated on >= 2 vertices — a distance-zero press on the sole vertex appends", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing([{ x: 0.5, y: 0.5 }]);

    press(canvas, 100, 50); // exactly on the only vertex
    expect(polylineRows()).toHaveLength(0); // no premature finish
    expect(useToolStore.getState().polygonVertices).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ]);
  });

  it("W6: the double-click second press (detail 2) appends nothing, saves nothing, still consumes", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(TWO_VERTS);
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 180, 20, 2); // far from last vertex; e.detail >= 2 skips the append
    expect(useToolStore.getState().polygonVertices).toEqual(TWO_VERTS);
    expect(polylineRows()).toHaveLength(0);
    expect(parentMouseDown).not.toHaveBeenCalled(); // prelude still ran (silent consume)
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("W8: a demo finish never touches either network channel and keeps the temp id", async () => {
    seedLinearState([], [linearItem({ id: 6 })], { isDemo: true });
    const canvas = await mountCanvas();
    enterDrawing(TWO_VERTS);

    press(canvas, 109, 50);
    expect(polylineRows()).toHaveLength(1);
    expect(polylineRows()[0].id).toBeLessThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("W9: a non-demo failure keeps the optimistic row and publishes the exact transient line error", async () => {
    seedLinearState([], [linearItem({ id: 6 })], { isDemo: false });
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    const canvas = await mountCanvas();
    enterDrawing(TWO_VERTS);

    press(canvas, 109, 50);
    expect(polylineRows()).toHaveLength(1);
    expect(persistFetchMock).toHaveBeenCalledWith("/api/annotations", {
      projectId: PUBLIC_ID,
      pageNumber: 1,
      name: "Conduit",
      bbox: [0.1, 0.2, 0.5, 0.5],
      source: "takeoff",
      data: {
        type: "linear-polyline",
        takeoffItemId: 6,
        color: "#3b82f6",
        vertices: TWO_VERTS,
        totalLength: 0,
        unit: "ft",
        segmentLengths: [],
      },
    });
    await waitFor(() =>
      expect(useToolStore.getState().bucketFillError).toBe("Failed to save line: boom"),
    );
    // Alert-and-keep: the rejection leaves the temp row in place (no rollback opt-in).
    expect(polylineRows()).toHaveLength(1);
    expect(polylineRows()[0].id).toBeLessThan(0);
  });

  it.each([
    { label: "null active id", activeTakeoffItemId: null },
    { label: "id not in items", activeTakeoffItemId: 999 },
  ])("W10 ($label): unresolved activeItem returns silently — no invalidate, no stop, no work", async ({ activeTakeoffItemId }) => {
    seedLinearState([], [linearItem({ id: 6 })], { activeTakeoffItemId });
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 50, 50);
    expect(parentMouseDown).toHaveBeenCalledTimes(1); // NO stopPropagation on the silent return
    expect(ownsToolTailAuthority(token)).toBe(true); // tail authority RETAINED
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).not.toHaveBeenCalled();
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(readSeededAnnotations(queryClient)).toHaveLength(0);
  });

  it("W11: the polygon sibling runs its prelude and vertex append exactly once (single-execution contrast)", async () => {
    seedLinearState([], [linearItem({ id: 6, shape: "polygon" })]);
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 50, 50);
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(useToolStore.getState().polygonVertices).toEqual([{ x: 0.25, y: 0.5 }]);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(readSeededAnnotations(queryClient)).toHaveLength(0);
  });

  it("W12: the count sibling places its marker without any vertex work (single-execution contrast)", async () => {
    seedLinearState([], [linearItem({ id: 6, shape: "circle", name: "Door", color: "#ef4444" })]);
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 120, 70); // no marker nearby → placement
    const rows = readSeededAnnotations(queryClient);
    expect(rows).toHaveLength(1);
    expect((rows[0].data as { type?: string } | null)?.type).toBe("count-marker");
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle"); // no vertex work
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1); // exactly one prelude invalidation
  });

  it("W13: without the takeoffPlacement activation the same press does no vertex work", async () => {
    seedLinearState([], [linearItem({ id: 6 })], { activeTool: null });
    const canvas = await mountCanvas();

    press(canvas, 50, 50); // empty-canvas pointer press → deselect cascade, not drawing
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(readSeededAnnotations(queryClient)).toHaveLength(0);
  });

  it("W14a: the SURVIVING double-click finish still saves (>= 2 verts, spaced last pair)", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(TWO_VERTS); // last pair spaced > 0.005 → no duplicate-vertex undo

    act(() => {
      fireEvent.doubleClick(canvas);
    });
    expect(polylineRows()).toHaveLength(1);
    expect((polylineRows()[0].data as { vertices: unknown }).vertices).toEqual(TWO_VERTS);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
  });

  it("W14b: the SURVIVING Enter-keydown finish still saves", async () => {
    seedLinearState([], [linearItem({ id: 6 })]);
    await mountCanvas();
    enterDrawing(TWO_VERTS);

    act(() => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    expect(polylineRows()).toHaveLength(1);
    expect((polylineRows()[0].data as { vertices: unknown }).vertices).toEqual(TWO_VERTS);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
  });
});

describe("takeoff linear seam topology pins (post-move: controller registered, linear identity extracted)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const CTRL = readFileSync(
    join(process.cwd(), "src/components/viewer/tools/takeoffLinear.ts"),
    "utf8",
  );
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("pins the linear identity fully extracted from the overlay", () => {
    expect(count(AO, 'if (activeItem.shape === "linear") {')).toBe(0);
    expect(count(AO, "if (dist < 10) {")).toBe(0);
    expect(count(AO, "const lastV = toolAtDown.polygonVertices[toolAtDown.polygonVertices.length - 1];")).toBe(0);
    // The two SURVIVING call sites: Enter keydown + dblclick (the mousedown site moved).
    expect(count(AO, "saveLinearPolyline();")).toBe(2);
    // The polygon identity still lives in the branch until its own extraction.
    expect(count(AO, 'if (activeItem.shape === "polygon") {')).toBe(1);
    // The factory carries the takeoffLinear-proven capability exactly once.
    expect(count(AO, "takeoffDrawing: { setPolygonDrawingMode, addPolygonVertex, saveLinearPolyline },")).toBe(1);
  });

  it("pins the controller as the sole home of the linear gesture", () => {
    expect(existsSync(join(process.cwd(), "src/components/viewer/tools/takeoffLinear.ts"))).toBe(true);
    expect(count(CTRL, 'press.toolAtDown.activeTool?.kind === "takeoffPlacement"')).toBe(1);
    expect(count(CTRL, "if (!activeItem) return false;")).toBe(1);
    expect(count(CTRL, 'if (activeItem.shape !== "linear") return false;')).toBe(1);
    expect(count(CTRL, "invalidateToolTailAuthority();")).toBe(1);
    expect(count(CTRL, "event.stopPropagation();")).toBe(1);
    expect(count(CTRL, "if (dist < 10) {")).toBe(1);
    expect(count(CTRL, "takeoffDrawing.saveLinearPolyline();")).toBe(1);
    expect(count(CTRL, "if (event.detail < 2) {")).toBe(1);
    // The claim/decline values are pinned BEHAVIORALLY in TakeoffLinearControllerFreeze.test.ts.
  });
});
