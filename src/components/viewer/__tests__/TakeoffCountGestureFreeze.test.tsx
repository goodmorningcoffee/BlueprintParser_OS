// @vitest-environment jsdom
//
// [refactor jul17 P3.2] EXECUTABLE behavior freeze for the COUNT identity of the legacy
// takeoffPlacement mousedown branch, landed test-only at parent b4c486b BEFORE the takeoffCount
// controller extraction.
//
// Why this file exists (TAKEOFF_COUNT_IMPL/RECON_CENSUS.md): AO:1746-1863 is ONE legacy branch
// serving THREE controller identities discriminated by activeItem.shape (polygon / linear /
// count-as-residual-else). The count identity — existing-marker select loop (center distance
// strict < 14, takeoff-source only) + half-size 0.005 clamped-bbox placement + optimistic
// persistCreate with the transient "Failed to save marker" publication — has NO executable
// oracle: TakeoffCountFreeze.test.tsx is the CountTab PANEL net (never mounts the overlay), and
// AnnotationOverlayLifecyclePublicationsFreeze exercises only the polygon/linear identities.
// The load-bearing behaviors frozen here through the PRODUCTION mousedown handler:
//   (1) the branch prelude — activeItem resolution from COMPONENT takeoffItems by the PRESS
//       snapshot's activeTakeoffItemId; !activeItem returns SILENTLY (no invalidate, no
//       stopPropagation, tail authority retained); resolved items run
//       invalidateToolTailAuthority() + stopPropagation() exactly once BEFORE shape dispatch;
//   (2) select-before-place: ANY takeoff-source annotation whose ANISOTROPIC pixel center
//       (cx by PROPS width, cy by height) is strictly < 14px away wins selection in
//       pageAnnotations ARRAY ORDER; non-takeoff sources are transparent even at distance 0;
//       exactly 14 falls through to placement. selectedId is COMPONENT useState (not store), so
//       selection is witnessed through the production Delete-keydown path: its listener only
//       attaches while selectedId !== null, and Delete removes exactly the selected row —
//       press→Delete→row-gone proves select; press→Delete-inert proves not-selected (W1 is the
//       positive control that keeps the inert form non-vacuous);
//   (3) placement: bbox = [max(0,nx-.005), max(0,ny-.005), min(1,nx+.005), min(1,ny+.005)]
//       with the exact CountMarkerData literal, name from the item, source "takeoff";
//   (4) the optimistic persistCreate seam: demo never touches either network channel (temp
//       negative id); non-demo failure keeps the row (alert-and-keep) and publishes the exact
//       "Failed to save marker: <message>" through the transient bucket-fill error channel.
//       persistCreate wraps non-Error rejections into Error(String(caught)) BEFORE onError, so
//       the bare-fallback ternary branch is direct-net territory (commit 2), not overlay
//       territory;
//   (5) the polygon/linear identities stay SINGLE-EXECUTION contrasts (one vertex, one
//       invalidation, one stop) — post-move these witness that the controller's eligible-DECLINE
//       re-enters the surviving legacy branch without doubling the prelude.
//
// The final describe pins the PRE-move source topology; the extraction commit rewrites ONLY that
// describe to the post-move topology (count identity absent from the overlay, controller file is
// the sole home, factory carries the takeoffItems/mutations/transientError capabilities).

import { readFileSync } from "node:fs";
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

const PUBLIC_ID = "takeoff-count-fixture";
const HS = 0.005; // mirrors the production half-size so expected bboxes share the exact doubles

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

function countItem(over: Partial<ClientTakeoffItem> & { id: number }): ClientTakeoffItem {
  return { name: "Door", shape: "circle", color: "#ef4444", size: 10, sortOrder: 0, groupId: null, ...over };
}

// Existing count marker on the NON-SQUARE 200×100 canvas: bbox center (0.4, 0.3) → pixel center
// (80, 30). The TRANSPOSED center (width/height swapped in the cx/cy scaling) would be (40, 60) —
// 50px away, so a press there discriminates transposition (witness W2).
const MARKER: ClientAnnotation = {
  id: 100,
  pageNumber: 1,
  name: "Door",
  bbox: [0.35, 0.25, 0.45, 0.35],
  note: null,
  source: "takeoff",
  data: { type: "count-marker", shape: "circle", color: "#ef4444", takeoffItemId: 5 } as never,
};

// Source bait: a USER markup whose center (150, 80) sits at distance ZERO from witness W4's
// press — the select loop must skip it (source !== "takeoff") and place a marker instead.
// Deliberately source "user", NOT "yolo": yolo rows are confidence/visibility-filtered OUT of
// pageAnnotations by default (a yolo bait would never reach the loop — mutation-probe finding),
// while user markups pass the pageAnnotations filter unconditionally.
const USER_BAIT: ClientAnnotation = {
  id: 101,
  pageNumber: 1,
  name: "Bait Markup",
  bbox: [0.7, 0.75, 0.8, 0.85],
  note: null,
  source: "user",
  data: null,
};

function seedCountState(
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
    activeTakeoffItemId: over.activeTakeoffItemId === undefined ? 5 : over.activeTakeoffItemId,
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

function press(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
  act(() => {
    fireEvent.mouseDown(canvas, { clientX, clientY, button: 0, detail: 1 });
  });
}

function markerRows(): ClientAnnotation[] {
  return readSeededAnnotations(queryClient).filter(
    (a) => (a.data as { type?: string } | null)?.type === "count-marker",
  );
}

describe("takeoff count gesture freeze (real overlay, production mousedown)", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("W1: a press strictly inside 14px of a takeoff marker center selects it and places nothing", async () => {
    seedCountState([MARKER], [countItem({ id: 5 })]);
    const canvas = await mountCanvas();

    press(canvas, 93, 30); // dist from (80,30) = 13 < 14
    expect(readSeededAnnotations(queryClient)).toHaveLength(1); // no new row
    expect(parentMouseDown).not.toHaveBeenCalled(); // prelude stopped propagation
    expect(useToolStore.getState()._drawing).toBe(false);
    // Selection witnessed through the production Delete path (header note): the selected marker
    // — and ONLY it — is removed. A phantom placement would leave a second row behind.
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(readSeededAnnotations(queryClient)).toHaveLength(0);
  });

  it("W2: the center is anisotropic (cx by width, cy by height) — the transposed center places instead of selecting", async () => {
    seedCountState([MARKER], [countItem({ id: 5 })]);
    const canvas = await mountCanvas(); // 200×100: true center (80,30); transposed would be (40,60)

    press(canvas, 40, 60); // 50px from the true center
    expect(readSeededAnnotations(queryClient)).toHaveLength(2); // placement ran, no select
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(readSeededAnnotations(queryClient)).toHaveLength(2); // nothing selected → Delete inert
  });

  it("W3: exactly 14px away is NOT a select (strict <) — placement runs", async () => {
    seedCountState([MARKER], [countItem({ id: 5 })]);
    const canvas = await mountCanvas();

    press(canvas, 94, 30); // dist from (80,30) is exactly 14
    expect(readSeededAnnotations(queryClient)).toHaveLength(2); // placement, not select
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(readSeededAnnotations(queryClient)).toHaveLength(2);
  });

  it("W4: a non-takeoff annotation at distance zero is transparent to the select loop", async () => {
    seedCountState([MARKER, USER_BAIT], [countItem({ id: 5 })]);
    const canvas = await mountCanvas();

    press(canvas, 150, 80); // USER_BAIT center exactly; MARKER is 86px away
    expect(readSeededAnnotations(queryClient)).toHaveLength(3); // placement ran
    expect(readSeededAnnotations(queryClient).find((a) => a.id === 101)).toEqual(USER_BAIT);
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(readSeededAnnotations(queryClient)).toHaveLength(3); // bait was never selected
  });

  it("W5: placement lands the exact half-size bbox, item name/color, and count-marker data", async () => {
    seedCountState([], [countItem({ id: 5 })]);
    const canvas = await mountCanvas();

    press(canvas, 120, 70); // norm (0.6, 0.7)
    const rows = readSeededAnnotations(queryClient);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBeLessThan(0); // optimistic temp id
    expect(row.pageNumber).toBe(1);
    expect(row.name).toBe("Door");
    expect(row.source).toBe("takeoff");
    expect(row.note).toBeNull();
    // Expected values share the production arithmetic so the doubles are bit-identical.
    expect(row.bbox).toEqual([
      Math.max(0, 120 / 200 - HS),
      Math.max(0, 70 / 100 - HS),
      Math.min(1, 120 / 200 + HS),
      Math.min(1, 70 / 100 + HS),
    ]);
    expect(row.data).toEqual({
      type: "count-marker",
      shape: "circle",
      color: "#ef4444",
      takeoffItemId: 5,
    });
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useToolStore.getState()._drawing).toBe(false); // no deferred gesture started
  });

  it("W6: corner presses witness both clamp ends of the half-size bbox", async () => {
    seedCountState([], [countItem({ id: 5 })]);
    const canvas = await mountCanvas();

    press(canvas, 0, 0);
    press(canvas, 200, 100);
    const [origin, extent] = readSeededAnnotations(queryClient);
    expect(origin.bbox).toEqual([0, 0, 0 + HS, 0 + HS]); // Math.max(0, -0.005) floors
    expect(extent.bbox).toEqual([1 - HS, 1 - HS, 1, 1]); // Math.min(1, 1.005) ceilings
  });

  it("W7: demo placement never touches either network channel and keeps the temp id", async () => {
    seedCountState([], [countItem({ id: 5 })], { isDemo: true });
    const canvas = await mountCanvas();

    press(canvas, 120, 70);
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(readSeededAnnotations(queryClient)[0].id).toBeLessThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("W8: non-demo failure keeps the optimistic row and publishes the exact transient marker error", async () => {
    seedCountState([], [countItem({ id: 5 })], { isDemo: false });
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    const canvas = await mountCanvas();

    press(canvas, 120, 70);
    // Optimistic row is synchronous; the POST carries the caller's exact draft spread.
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(persistFetchMock).toHaveBeenCalledWith("/api/annotations", {
      projectId: PUBLIC_ID,
      pageNumber: 1,
      name: "Door",
      bbox: [
        Math.max(0, 120 / 200 - HS),
        Math.max(0, 70 / 100 - HS),
        Math.min(1, 120 / 200 + HS),
        Math.min(1, 70 / 100 + HS),
      ],
      source: "takeoff",
      data: {
        type: "count-marker",
        shape: "circle",
        color: "#ef4444",
        takeoffItemId: 5,
      },
    });
    await waitFor(() =>
      expect(useToolStore.getState().bucketFillError).toBe("Failed to save marker: boom"),
    );
    // Alert-and-keep: the rejection leaves the temp row in place (no rollback opt-in).
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(readSeededAnnotations(queryClient)[0].id).toBeLessThan(0);
  });

  it("W9: the branch prelude invalidates tail authority on BOTH the select and the placement path", async () => {
    seedCountState([MARKER], [countItem({ id: 5 })]);
    const canvas = await mountCanvas();

    const selectToken = claimToolTailAuthority({});
    const selectCancelled = vi.fn();
    registerToolTailCancellation(selectToken, selectCancelled);
    press(canvas, 93, 30); // select path
    expect(ownsToolTailAuthority(selectToken)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(selectCancelled).toHaveBeenCalledTimes(1);

    const placeToken = claimToolTailAuthority({});
    const placeCancelled = vi.fn();
    registerToolTailCancellation(placeToken, placeCancelled);
    press(canvas, 150, 80); // placement path
    expect(ownsToolTailAuthority(placeToken)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(placeCancelled).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "null active id", activeTakeoffItemId: null },
    { label: "id not in items", activeTakeoffItemId: 999 },
  ])("W10 ($label): unresolved activeItem returns silently — no invalidate, no stop, no work", async ({ activeTakeoffItemId }) => {
    seedCountState([MARKER], [countItem({ id: 5 })], { activeTakeoffItemId });
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 120, 70);
    expect(parentMouseDown).toHaveBeenCalledTimes(1); // NO stopPropagation on the silent return
    expect(ownsToolTailAuthority(token)).toBe(true); // tail authority RETAINED
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).not.toHaveBeenCalled();
    expect(readSeededAnnotations(queryClient)).toHaveLength(1); // no placement
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(readSeededAnnotations(queryClient)).toHaveLength(1); // no selection took either
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");
  });

  it.each([
    { label: "polygon", shape: "polygon" as const },
    { label: "linear", shape: "linear" as const },
  ])("W11/W12 ($label): the sibling identity runs its prelude and vertex append exactly once", async ({ shape }) => {
    seedCountState([], [countItem({ id: 6, shape })], { activeTakeoffItemId: 6 });
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);

    press(canvas, 50, 50); // idle → drawing, ONE vertex at (0.25, 0.5)
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(useToolStore.getState().polygonVertices).toEqual([{ x: 0.25, y: 0.5 }]);
    expect(parentMouseDown).not.toHaveBeenCalled(); // exactly one stopPropagation
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1); // exactly one prelude invalidation
    expect(readSeededAnnotations(queryClient)).toHaveLength(0); // count path never ran
  });

  it("W13: without the takeoffPlacement activation the same press never places a marker", async () => {
    seedCountState([MARKER], [countItem({ id: 5 })], { activeTool: null });
    const canvas = await mountCanvas();

    press(canvas, 120, 70); // empty-canvas pointer press → deselect cascade, not placement
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(useToolStore.getState().bucketFillError).toBeNull();
  });
});

describe("takeoff count seam topology pins (post-move: controller registered, count identity extracted)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const CTRL = readFileSync(
    join(process.cwd(), "src/components/viewer/tools/takeoffCount.ts"),
    "utf8",
  );
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("pins the count identity fully extracted from the overlay", () => {
    expect(count(AO, "// Count marker placement")).toBe(0);
    expect(count(AO, "const hs = 0.005;")).toBe(0);
    expect(count(AO, "if (dist < 14) {")).toBe(0);
    expect(count(AO, 'type: "count-marker",')).toBe(0);
    expect(count(AO, "Failed to save marker")).toBe(0);
    expect(count(AO, "void persistCreate(")).toBe(4); // savePolygon/bucket/saveLinear/markup-save
    // The factory carries the three takeoffCount-proven capabilities exactly once each.
    expect(count(AO, "mutations: { annotations: { persistCreate } },")).toBe(1);
    expect(count(AO, "transientError: { publish: publishTransientBucketFillError },")).toBe(1);
    expect(count(AO, "\n          takeoffItems,")).toBe(1); // factory field; dep-array entry is mid-line
  });

  it("pins the surviving legacy branch: resolution, silent return, prelude, terminal claim only", () => {
    const branch = AO.indexOf('if (activeTool?.kind === "takeoffPlacement") {');
    expect(branch).toBeGreaterThan(-1);
    const slice = AO.slice(branch, AO.indexOf("// Keynote YOLO picking"));
    const resolution = slice.indexOf("takeoffItems.find((t) => t.id === toolAtDown.activeTakeoffItemId)");
    const silentReturn = slice.indexOf("if (!activeItem) return;");
    const invalidate = slice.indexOf("invalidateToolTailAuthority();");
    const stop = slice.indexOf("e.stopPropagation();");
    // [refactor jul17 P3.2] The polygon identity moved to tools/takeoffPolygon.ts (fifth
    // registration) — the LAST identity out. The branch keeps the !activeItem silent return
    // (its only reachable path) plus the prelude + terminal return as the always-claims
    // contract for the residual (unreachable) partition (TAKEOFF_POLYGON_IMPL/RECON_CENSUS.md
    // §2, option a).
    const polygon = slice.indexOf('if (activeItem.shape === "polygon") {');
    const linear = slice.indexOf('if (activeItem.shape === "linear") {');
    const residual = slice.indexOf("All three takeoff identities live behind the registry seam");
    expect(resolution).toBeGreaterThan(-1);
    expect(silentReturn).toBeGreaterThan(resolution);
    expect(invalidate).toBeGreaterThan(silentReturn);
    expect(stop).toBeGreaterThan(invalidate);
    expect(polygon).toBe(-1); // extracted — the overlay no longer discriminates polygon
    expect(linear).toBe(-1); // extracted — the overlay no longer discriminates linear
    expect(residual).toBeGreaterThan(stop); // the unreachable-partition comment + terminal return
  });

  it("pins the controller as the sole home of the count gesture", () => {
    expect(count(CTRL, 'press.toolAtDown.activeTool?.kind === "takeoffPlacement"')).toBe(1);
    expect(count(CTRL, "if (!activeItem) return false;")).toBe(1);
    expect(count(CTRL, 'if (activeItem.shape === "polygon" || activeItem.shape === "linear") return false;')).toBe(1);
    expect(count(CTRL, "invalidateToolTailAuthority();")).toBe(1);
    expect(count(CTRL, "event.stopPropagation();")).toBe(1);
    expect(count(CTRL, "if (dist < 14) {")).toBe(1);
    expect(count(CTRL, "const hs = 0.005;")).toBe(1);
    expect(count(CTRL, "void mutations.annotations.persistCreate(")).toBe(1);
    expect(count(CTRL, "Failed to save marker")).toBe(2); // template + bare fallback literal
    // The claim/decline values are pinned BEHAVIORALLY in TakeoffCountControllerFreeze.test.ts.
  });
});
