// @vitest-environment jsdom
//
// [refactor jul17 P3.2] EXECUTABLE behavior freeze for the POLYGON identity of the legacy
// takeoffPlacement mousedown branch, landed test-only at parent 464176f BEFORE the takeoffPolygon
// controller extraction.
//
// Why this file exists (TAKEOFF_POLYGON_IMPL/RECON_CENSUS.md): after the linear extraction the
// polygon identity (AO:1762-1790) is the LAST identity in the legacy branch — idle-start (mode
// write, lifecycle fence, first vertex), close-snap to the FIRST vertex (anisotropic px scaling,
// strict < 15, >= 3-vertex gate) into the savePolygon composite, and the e.detail < 2 vertex
// append. Its only executable oracles today are the W11-class contrasts in the count/linear
// freezes (one idle press each) and AnnotationOverlayLifecyclePublicationsFreeze :641 (the
// mode-write -> fence -> append publication ordering); NO test pins the close-snap boundary, the
// FIRST-vertex anchor (the polygon/linear discriminator — linear snaps to the LAST vertex at
// < 10), the >= 3 gate, or the savePolygon seam. The load-bearing behaviors frozen here through
// the PRODUCTION mousedown handler:
//   (1) idle-start: setPolygonDrawingMode("drawing") then EXACTLY ONE vertex at the
//       props-normalized press point, prelude (invalidate + stopPropagation) exactly once;
//   (2) close-snap: with >= 3 vertices, a press strictly < 15px from the FIRST vertex's
//       ANISOTROPIC pixel position (v.x by PROPS width, v.y by height) calls savePolygon() —
//       optimistic "area-polygon" row from the LIVE store vertices (press point NOT appended;
//       uncalibrated areaSqUnits 0 / unit "SF"; NO holes field), settled reset to idle/[] —
//       while exactly 15px falls through to the vertex append; the S145 metric canon demands the
//       DIAGONAL 9-12-15 boundary pair (axis-aligned fixtures cannot discriminate
//       Euclidean/Manhattan/Chebyshev); a press near the LAST vertex far from the FIRST must
//       APPEND (anchor discriminator); the snap check runs ONLY at >= 3 vertices (a distance-0
//       press on the first of two vertices appends);
//   (3) the double-click second press (e.detail >= 2) appends NOTHING yet still consumes the
//       press (silent-consume arm);
//   (4) the optimistic seam through the mousedown close: demo never touches either network
//       channel (temp negative id); non-demo failure keeps the row and publishes the exact
//       "Failed to save area: <message>" transient (census §7 — the literal also lives in
//       prepareBucketFillPolygon, so this is pinned behaviorally, never as an AO source count);
//   (5) the sibling identities stay SINGLE-EXECUTION contrasts (linear: one vertex through the
//       EXTRACTED takeoffLinear controller; count: marker placed, no vertex) — post-move these
//       witness that takeoffPolygon's eligible-DECLINE falls through cleanly without doubling
//       the prelude;
//   (6) the two SURVIVING savePolygon call sites (Enter keydown, double-click) keep closing
//       polygons — the extraction moves only the mousedown call site (Enter had NO executable
//       coverage before this file).
//
// The final describe pins the PRE-move source topology; the extraction commit rewrites ONLY that
// describe to the post-move topology (polygon identity absent from the overlay, controller file
// the sole home, factory takeoffDrawing group carries savePolygon).

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

const PUBLIC_ID = "takeoff-polygon-fixture";

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

function polygonItem(over: Partial<ClientTakeoffItem> & { id: number }): ClientTakeoffItem {
  return { name: "Flooring", shape: "polygon", color: "#3b82f6", size: 10, sortOrder: 0, groupId: null, ...over };
}

function seedPolygonState(
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

// Drawing-state fixtures must be installed AFTER mount (LifecyclePublicationsFreeze recipe,
// S145 canon): the overlay's mount-time item-cleanup effect AND the panel-close cleanup (census
// §5.6 — TWO wipe triggers) publish a settled polygon reset whenever they see a pre-seeded
// "drawing" mode, so seeding through the pre-mount store patch would be silently wiped.
function enterDrawing(vertices: { x: number; y: number }[]): void {
  act(() => {
    useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: vertices.map((v) => ({ ...v })),
    });
  });
}

function areaRows(): ClientAnnotation[] {
  return readSeededAnnotations(queryClient).filter(
    (a) => (a.data as { type?: string } | null)?.type === "area-polygon",
  );
}

// Three seeded vertices whose FIRST sits at norm (0.5, 0.5) → pixel (100, 50) on the 200×100
// canvas (the close snap anchors to polygonVertices[0], NOT the last vertex — the polygon/linear
// discriminator). The strict-<15 close boundary is witnessed at presses (114,50)=14px and
// (115,50)=15px, plus the diagonal 9-12-15 pair. The last pair is spaced ≫ 0.005 so the
// double-click duplicate-vertex undo never trips in W14a.
const THREE_VERTS = [
  { x: 0.5, y: 0.5 },
  { x: 0.8, y: 0.2 },
  { x: 0.9, y: 0.8 },
];

describe("takeoff polygon gesture freeze (real overlay, production mousedown)", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("W1: an idle press starts drawing with exactly one props-normalized vertex and one prelude", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
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

  it("W2: a drawing press far from the first vertex appends at exact norm coords and never saves", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS);

    press(canvas, 40, 90); // ~72px from the first vertex px (100,50) — no snap
    expect(useToolStore.getState().polygonVertices).toEqual([
      ...THREE_VERTS,
      { x: 40 / 200, y: 90 / 100 },
    ]);
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing"); // still drawing
    expect(areaRows()).toHaveLength(0);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("W3a: a press strictly inside 15px of the FIRST vertex closes — save from LIVE store verts, settled reset", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS);

    press(canvas, 114, 50); // dist from (100,50) = 14 < 15
    const rows = areaRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBeLessThan(0); // optimistic temp id
    expect(row.name).toBe("Flooring");
    expect(row.source).toBe("takeoff");
    // The composite copies the LIVE store vertices — the closing press point is NOT appended;
    // no calibration seeded → areaSqUnits 0, unit "SF"; NO holes field on the freehand path.
    expect(row.data).toEqual({
      type: "area-polygon",
      takeoffItemId: 6,
      color: "#3b82f6",
      vertices: THREE_VERTS,
      areaSqUnits: 0,
      unit: "SF",
    });
    expect(row.bbox).toEqual([0.5, 0.2, 0.9, 0.8]); // min/max of the vertices
    // Settled reset: drawing state cleared synchronously after the optimistic publication.
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(useToolStore.getState()._mousePos).toBeNull();
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it("W3b: exactly 15px away is NOT a close (strict <) — the press appends instead", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS);

    press(canvas, 115, 50); // dist from (100,50) is exactly 15
    expect(areaRows()).toHaveLength(0);
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(useToolStore.getState().polygonVertices).toEqual([
      ...THREE_VERTS,
      { x: 115 / 200, y: 50 / 100 },
    ]);
  });

  it("W3c: the snap metric is EUCLIDEAN off-axis — the diagonal boundary pair discriminates every rival metric", async () => {
    // S145 metric canon: every axis-aligned or distance-zero fixture is metric-blind
    // (Euclidean/Manhattan/Chebyshev agree there). This diagonal pair kills the whole family:
    // (108,60) is Euclidean sqrt(164) ≈ 12.81 < 15 (closes) but Manhattan 18 (mutant appends)
    // and squared-distance 164 < 15 is false (the dropped-sqrt mutant appends); (109,62) is
    // EXACTLY 15 via the 9-12-15 triangle (appends, exact in doubles: 81+144=225, sqrt 15) but
    // Chebyshev 12 (mutant closes) and a <= widening closes.
    seedPolygonState([], [polygonItem({ id: 6 })]);
    let canvas = await mountCanvas();
    enterDrawing(THREE_VERTS); // first vertex px (100,50)

    press(canvas, 108, 60); // Euclidean 12.81 — closes
    expect(areaRows()).toHaveLength(1);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");

    cleanup();
    seedPolygonState([], [polygonItem({ id: 6 })]);
    canvas = await mountCanvas();
    enterDrawing(THREE_VERTS);
    press(canvas, 109, 62); // Euclidean exactly 15 — appends
    expect(areaRows()).toHaveLength(0);
    expect(useToolStore.getState().polygonVertices).toEqual([
      ...THREE_VERTS,
      { x: 109 / 200, y: 62 / 100 },
    ]);
  });

  it("W4: the first-vertex pixel position is anisotropic (x by width, y by height) — the transposed point appends, the true point closes", async () => {
    const verts = [
      { x: 0.3, y: 0.4 }, // true px (60, 40) on 200×100; transposed scaling would put it at (30, 80)
      { x: 0.8, y: 0.2 },
      { x: 0.9, y: 0.8 },
    ];
    seedPolygonState([], [polygonItem({ id: 6 })]);
    let canvas = await mountCanvas();
    enterDrawing(verts);

    press(canvas, 30, 80); // 50px from the true (60,40) — appends
    expect(areaRows()).toHaveLength(0);
    expect(useToolStore.getState().polygonVertices).toHaveLength(4);

    cleanup();
    seedPolygonState([], [polygonItem({ id: 6 })]);
    canvas = await mountCanvas();
    enterDrawing(verts);
    press(canvas, 60, 40); // distance zero from the true pixel position — closes
    expect(areaRows()).toHaveLength(1);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
  });

  it("W5: the snap anchors to the FIRST vertex, not the last — a press beside the last vertex appends", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS); // first px (100,50), LAST px (180,80)

    press(canvas, 184, 83); // 5px from the LAST vertex, ~90px from the FIRST — must append
    expect(areaRows()).toHaveLength(0);
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(useToolStore.getState().polygonVertices).toEqual([
      ...THREE_VERTS,
      { x: 184 / 200, y: 83 / 100 },
    ]);
  });

  it("W6: the snap check is gated on >= 3 vertices — a distance-zero press on the first of two appends", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing([THREE_VERTS[0], THREE_VERTS[1]]);

    press(canvas, 100, 50); // exactly on the first vertex, but only 2 seeded
    expect(areaRows()).toHaveLength(0); // no premature close
    expect(useToolStore.getState().polygonVertices).toEqual([
      THREE_VERTS[0],
      THREE_VERTS[1],
      { x: 0.5, y: 0.5 },
    ]);
  });

  it("W7: the double-click second press (detail 2) appends nothing, saves nothing, still consumes", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS);
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 40, 90, 2); // far from the first vertex; e.detail >= 2 skips the append
    expect(useToolStore.getState().polygonVertices).toEqual(THREE_VERTS);
    expect(areaRows()).toHaveLength(0);
    expect(parentMouseDown).not.toHaveBeenCalled(); // prelude still ran (silent consume)
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("W8: a demo close never touches either network channel and keeps the temp id", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })], { isDemo: true });
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS);

    press(canvas, 114, 50);
    expect(areaRows()).toHaveLength(1);
    expect(areaRows()[0].id).toBeLessThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("W9: a non-demo failure keeps the optimistic row and publishes the exact transient area error", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })], { isDemo: false });
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS);

    press(canvas, 114, 50);
    expect(areaRows()).toHaveLength(1);
    expect(persistFetchMock).toHaveBeenCalledWith("/api/annotations", {
      projectId: PUBLIC_ID,
      pageNumber: 1,
      name: "Flooring",
      bbox: [0.5, 0.2, 0.9, 0.8],
      source: "takeoff",
      data: {
        type: "area-polygon",
        takeoffItemId: 6,
        color: "#3b82f6",
        vertices: THREE_VERTS,
        areaSqUnits: 0,
        unit: "SF",
      },
    });
    // Census §7: the literal is "Failed to save area" (savePolygon), NOT "save polygon".
    await waitFor(() =>
      expect(useToolStore.getState().bucketFillError).toBe("Failed to save area: boom"),
    );
    // Alert-and-keep: the rejection leaves the temp row in place (no rollback opt-in).
    expect(areaRows()).toHaveLength(1);
    expect(areaRows()[0].id).toBeLessThan(0);
  });

  it.each([
    { label: "null active id", activeTakeoffItemId: null },
    { label: "id not in items", activeTakeoffItemId: 999 },
  ])("W10 ($label): unresolved activeItem returns silently — no invalidate, no stop, no work", async ({ activeTakeoffItemId }) => {
    seedPolygonState([], [polygonItem({ id: 6 })], { activeTakeoffItemId });
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

  it("W11: the linear sibling runs its prelude and vertex append exactly once (single-execution contrast)", async () => {
    seedPolygonState([], [polygonItem({ id: 6, shape: "linear" })]);
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 50, 50); // claims at the EXTRACTED takeoffLinear controller
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
    seedPolygonState([], [polygonItem({ id: 6, shape: "circle", name: "Door", color: "#ef4444" })]);
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
    seedPolygonState([], [polygonItem({ id: 6 })], { activeTool: null });
    const canvas = await mountCanvas();

    press(canvas, 50, 50); // empty-canvas pointer press → deselect cascade, not drawing
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(readSeededAnnotations(queryClient)).toHaveLength(0);
  });

  it("W14a: the SURVIVING double-click close still saves (>= 3 verts, spaced last pair)", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    const canvas = await mountCanvas();
    enterDrawing(THREE_VERTS); // last pair spaced > 0.005 → no duplicate-vertex undo

    act(() => {
      fireEvent.doubleClick(canvas);
    });
    expect(areaRows()).toHaveLength(1);
    expect((areaRows()[0].data as { vertices: unknown }).vertices).toEqual(THREE_VERTS);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
  });

  it("W14b: the SURVIVING Enter-keydown close still saves", async () => {
    seedPolygonState([], [polygonItem({ id: 6 })]);
    await mountCanvas();
    enterDrawing(THREE_VERTS);

    act(() => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    expect(areaRows()).toHaveLength(1);
    expect((areaRows()[0].data as { vertices: unknown }).vertices).toEqual(THREE_VERTS);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
  });
});

describe("takeoff polygon seam topology pins (pre-move: the polygon identity still lives in the overlay)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("pins the polygon identity in the surviving takeoffPlacement branch", () => {
    expect(count(AO, 'if (activeItem.shape === "polygon") {')).toBe(1);
    expect(count(AO, "if (dist < 15) {")).toBe(1);
    expect(count(AO, "const firstV = toolAtDown.polygonVertices[0];")).toBe(1);
    // The residual mousedown Math.sqrt census (HitTestBehaviorFreeze owns the whole-file pin).
    expect(count(AO, "Math.sqrt")).toBe(1);
    // All three savePolygon call sites pre-move: mousedown (moves), dblclick + Enter (stay).
    expect(count(AO, "savePolygon();")).toBe(3);
    // The factory takeoffDrawing group does NOT yet carry savePolygon.
    expect(count(AO, "takeoffDrawing: { setPolygonDrawingMode, addPolygonVertex, saveLinearPolyline },")).toBe(1);
    expect(existsSync(join(process.cwd(), "src/components/viewer/tools/takeoffPolygon.ts"))).toBe(false);
  });
});
