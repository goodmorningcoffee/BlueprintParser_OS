// [refactor jul10 P2.2④] TAKEOFF MIGRATION FREEZE NET, part 2/3 — AreaTab / LinearTab /
// ViewAllPanel / BucketFillAssignDialog.
//
// Written GREEN against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte after
// the takeoff domain migrates to the TanStack Query cache (P2_DESIGN/TAKEOFF_IMPL/SPEC.md). The
// single sanctioned divergence point is the SHARED `seedTakeoff` helper (src/test/seed-takeoff.ts).
// See TakeoffCountFreeze.test.tsx for the full doctrine header (ordering-pin idiom §6.3,
// backing-agnostic store-assert discipline, two mock channels); this file only adds:
//
//  - TA/TL smokes are WRITTEN FROM SOURCE, not copied from CountTab: AreaTab's group-create
//    failure channel is the INLINE `groupError` state (AreaTab:94,:600) — NOT window.alert;
//    LinearTab's is alert (LinearTab:206). Freezing the per-tab channel blocks a "unify error
//    UX" drive-by during the consumer rewrite (§4.7/§4.8).
//  - [DETECTOR jul10 closer] TA-4/TL-3 demo-guards + TA-5/TL-4 optimistic rename-group
//    canaries: mutation testing (wf_5d3c6afd-bf0) proved Area/Linear handler conversions were
//    TEST-INVISIBLE to the CountTab TC pins (M6/M9 stayed green — TC cases never mount these
//    tabs) and demo-never-writes (workspace HARD invariant) had no executable pin here. Both
//    are pinned per-tab now; coverage is PER-CONSUMER (useTakeoff.ts header, SPEC §9 errata).
//  - ViewAllPanel VA-1/VA-2 pin the 3-level expansion read (Takeoffs→kind→group→rows incl. the
//    missing-group "Ungrouped" fallback, ViewAllPanel:403) and the cache-item × zustand
//    hiddenTakeoffItemIds join (eye toggle → line-through). Known pre-existing nested-<button>
//    React warning on expand — do NOT fix in ④, do NOT assert console cleanliness (SPEC §8.7).
//  - BucketFillAssignDialog is mounted DIRECTLY with a pendingPolygon prop (SPEC §6.2,
//    probe-verified); BF-3 pins the frozen NUMERIC-projectId POST body quirk (:27,:77 — owner
//    item SPEC §8.3) so an accidental publicId "fix" fails loudly.
//  - DrawingPreviewLayer and AnnotationOverlay are NOT mounted (canvas — SPEC §6.5 exclusion
//    rows; their read paths ride the C2 hook/bridge suite + tsc + perf protocol + e2e).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUiStore } from "@/stores/uiStore";
import { useToolStore } from "@/stores/toolStore";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { persistFetch } from "@/lib/client-persist";
import { TWENTY_COLORS } from "@/types";
import type { ClientAnnotation, ClientTakeoffItem, TakeoffGroup } from "@/types";
import AreaTab from "../AreaTab";
import LinearTab from "../LinearTab";
import ViewAllPanel from "../ViewAllPanel";
import BucketFillAssignDialog from "../BucketFillAssignDialog";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: vi.fn() };
});
const persistFetchMock = vi.mocked(persistFetch);

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function item(over: Partial<ClientTakeoffItem> & { id: number; name: string }): ClientTakeoffItem {
  return { shape: "circle", color: "#ef4444", size: 10, sortOrder: 0, groupId: null, ...over };
}
function group(over: Partial<TakeoffGroup> & { id: number; name: string }): TakeoffGroup {
  return { kind: "count", color: null, csiCode: null, sortOrder: 0, ...over };
}
// Takeoff-sourced annotation for the demo-guard sweep asserts (TA-4/TL-3). `type` matches the
// host tab's data shape ("area-polygon" / "linear-polyline"); the delete sweep itself only
// matches source+takeoffItemId, but fixtures stay honest against what each tab renders.
function takeoffAnn(id: number, takeoffItemId: number, name: string, type: string): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name,
    bbox: [0, 0, 0.1, 0.1],
    note: null,
    source: "takeoff",
    data: { type, takeoffItemId, vertices: PENDING_POLYGON.vertices } as never,
  };
}
function unrelatedAnn(id: number, name: string): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name,
    bbox: [0.4, 0.4, 0.5, 0.5],
    note: null,
    source: "yolo",
    data: null,
  };
}

// Shared pending polygon for the BF cases — shape of toolStore.bucketFillPendingPolygon.
const PENDING_POLYGON = {
  vertices: [
    { x: 0.1, y: 0.1 },
    { x: 0.3, y: 0.1 },
    { x: 0.2, y: 0.3 },
  ],
  method: "raster",
  bbox: [0.1, 0.1, 0.3, 0.3] as [number, number, number, number],
  areaSqUnits: 12.5,
  unit: "ft",
};

const fetchMock = vi.fn();
const alertMock = vi.fn();

beforeEach(() => {
  qc = new QueryClient(); // pure defaults, matching production Providers.tsx
  resetProjectData();
  // [DETECTOR jul10 closer] P2.5 resetProjectData now clears hiddenTakeoffItemIds and
  // bucketFillPendingPolygon. Repeat both destination values explicitly so VA-2/BF fixture
  // preconditions remain visible and cannot depend on a preceding case.
  setViewerStoreStateForTest({
    publicId: "pid",
    isDemo: false,
    hiddenTakeoffItemIds: new Set<number>(),
    bucketFillError: null,
    bucketFillPendingPolygon: null,
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in takeoff freeze test: ${url}`);
  });
  persistFetchMock.mockReset();
  alertMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockCreateItemPost(response: Promise<unknown>) {
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/takeoff-items") {
      throw new Error(`unexpected raw fetch in takeoff freeze test: ${url}`);
    }
    return response;
  });
}

// ─── AreaTab ─────────────────────────────────────────────────────────────────────────────────

describe("AreaTab — seeded items + groups render (TA-1)", () => {
  it("polygon item under its area group; default ScaleStatus shows 'Set Scale'", async () => {
    seedTakeoff(
      qc,
      [item({ id: 7, name: "Carpet", shape: "polygon", groupId: 5 })],
      [group({ id: 5, name: "Div 09", kind: "area" })],
    );
    render(<AreaTab />, { wrapper });

    await waitFor(() => expect(screen.getByText("Carpet")).toBeInTheDocument());
    expect(screen.getByText("Div 09")).toBeInTheDocument();
    expect(screen.getByText("Set Scale")).toBeInTheDocument(); // uncalibrated default renders fine
  });
});

describe("AreaTab — create item is server-first (TA-2)", () => {
  it("no row until the POST resolves; shape pinned 'polygon'", async () => {
    seedTakeoff(qc, [], []);
    const d = deferred<Response>();
    mockCreateItemPost(d.promise as Promise<unknown>);
    render(<AreaTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Area Item" }));
    fireEvent.change(screen.getByPlaceholderText("Area item name..."), { target: { value: "Tile" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // ── SPEC §6.3 mock-call-anchored interleaving idiom (server-first) ──
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/takeoff-items");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "pid",
      name: "Tile",
      shape: "polygon",
      color: TWENTY_COLORS[0],
    });
    expect(screen.getAllByText("Tile")).toHaveLength(1); // form PREVIEW only — no row yet
    expect(screen.getByRole("button", { name: "..." })).toBeInTheDocument(); // creating spinner

    d.resolve({ ok: true, json: async () => item({ id: 42, name: "Tile", shape: "polygon" }) } as Response);

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Area item name...")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Tile")).toBeInTheDocument(); // the ROW now
  });
});

describe("AreaTab — group-create failure is INLINE groupError, not alert (TA-3)", () => {
  it("rejection message renders under the group form; window.alert NOT called", async () => {
    seedTakeoff(qc, [], []);
    persistFetchMock.mockRejectedValueOnce(new Error("duplicate group"));
    render(<AreaTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name (e.g. Division 09)"), {
      target: { value: "Div 09" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // the per-tab frozen error channel (AreaTab:94,:600) — NOT the Count/Linear alert
    await waitFor(() => expect(screen.getByText("duplicate group")).toBeInTheDocument());
    expect(alertMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Div 09")).not.toBeInTheDocument(); // no header landed
  });
});

// [DETECTOR jul10 closer] TA-4: demo-never-writes is a workspace HARD invariant and was
// test-invisible in this tab (only TC-2/TC-13/BF-2 pinned it, none of which mount AreaTab).
// One case drives all four demo write paths through the DOM and pins ZERO network on BOTH
// channels + the local effects (temp ids, annotation sweep/name-sync).
describe("AreaTab — demo NEVER writes (TA-4)", () => {
  it("rename+delete+create item and create group all land locally; ZERO calls on either channel", async () => {
    setViewerStoreStateForTest({ isDemo: true });
    seedAnnotations(qc, [
      takeoffAnn(100, 7, "Carpet", "area-polygon"),
      // cross-domain bait: a non-takeoff annotation must SURVIVE the demo delete sweep
      { id: 101, pageNumber: 1, name: "door_single", bbox: [0, 0, 0.1, 0.1], note: null, source: "yolo", data: null },
    ]);
    seedTakeoff(
      qc,
      [item({ id: 7, name: "Carpet", shape: "polygon", groupId: 5 })],
      [group({ id: 5, name: "Div 09", kind: "area" })],
    );
    render(<AreaTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Carpet")).toBeInTheDocument());

    // rename item — demo branch: local write + annotation name-sync, NO PUT
    fireEvent.doubleClick(screen.getByText("Carpet"));
    const renameInput = screen.getByDisplayValue("Carpet");
    fireEvent.change(renameInput, { target: { value: "Carpet 2" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Carpet 2")).toBeInTheDocument());
    expect(readSeededAnnotations(qc)[0].name).toBe("Carpet 2"); // demo name-sync ran

    // delete item — demo branch: local remove + sweep, NO DELETE (sole row → title unique)
    fireEvent.click(screen.getByTitle("Delete item and all polygons"));
    await waitFor(() => expect(screen.queryByText("Carpet 2")).not.toBeInTheDocument());
    // sweep kept the yolo bait, dropped the takeoff marker (annotations stay zustand in ④)
    await waitFor(() =>
      expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([101]),
    );

    // create item — demo branch: local temp (id: -Date.now()), NO POST
    fireEvent.click(screen.getByRole("button", { name: "+ Add Area Item" }));
    fireEvent.change(screen.getByPlaceholderText("Area item name..."), { target: { value: "Demo Tile" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("Demo Tile")).toBeInTheDocument());
    await waitFor(() => expect(useToolStore.getState().activeTakeoffItemId).toBeLessThan(0));

    // create group — demo branch: local temp group, NO POST
    fireEvent.click(screen.getByRole("button", { name: "+ New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name (e.g. Division 09)"), {
      target: { value: "Demo G" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("Demo G")).toBeInTheDocument());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });
});

describe("AreaTab — non-demo item writes preserve captured VALUE-REPLACE semantics", () => {
  it("rename and delete each overwrite an annotation that arrives while persistence awaits", async () => {
    const rename = deferred<unknown>();
    const remove = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(rename.promise).mockReturnValueOnce(remove.promise);
    seedTakeoff(qc, [item({ id: 7, name: "Carpet", shape: "polygon" })], []);
    seedAnnotations(qc, [
      takeoffAnn(100, 7, "Carpet", "area-polygon"),
      unrelatedAnn(101, "stable-area-yolo"),
    ]);
    render(<AreaTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Carpet")).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText("Carpet"));
    const input = screen.getByDisplayValue("Carpet");
    fireEvent.change(input, { target: { value: "Carpet 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/takeoff-items/7",
        { name: "Carpet 2" },
        "PUT",
      ),
    );

    // [refactor jul11 P2.2⑥] Faithful migration pin: AreaTab closes over the render's
    // annotation array before await. The concurrent row demonstrably lands, then the old
    // array is VALUE-REPLACED on success. A functional Query updater would preserve 102 and
    // silently change today's lost-update behavior (ANNOTATIONS-W1).
    await act(async () => {
      seedAnnotations(qc, [...readSeededAnnotations(qc), unrelatedAnn(102, "concurrent-area-rename")]);
    });
    expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([100, 101, 102]);
    rename.resolve({ success: true });

    await waitFor(() => expect(screen.getByText("Carpet 2")).toBeInTheDocument());
    await waitFor(() =>
      expect(readSeededAnnotations(qc).map((a) => [a.id, a.name])).toEqual([
        [100, "Carpet 2"],
        [101, "stable-area-yolo"],
      ]),
    );

    fireEvent.click(screen.getByTitle("Delete item and all polygons"));
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/takeoff-items/7",
        undefined,
        "DELETE",
      ),
    );
    await act(async () => {
      seedAnnotations(qc, [...readSeededAnnotations(qc), unrelatedAnn(103, "concurrent-area-delete")]);
    });
    expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([100, 101, 103]);
    remove.resolve({ success: true });

    await waitFor(() => expect(screen.queryByText("Carpet 2")).not.toBeInTheDocument());
    await waitFor(() => expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([101]));
  });
});

// [DETECTOR jul10 closer] TA-5: optimistic-conversion canary. Mutation M6 (flipping an AreaTab
// optimistic op to server-first) stayed GREEN against the original freeze — the TC-8/9 pins
// never mount this tab. This pins the SPEC §6.3 optimistic contract (a): DOM changed while the
// deferred PUT is STILL pending; a server-first conversion of handleRenameGroup fails here.
describe("AreaTab — rename group is optimistic (TA-5)", () => {
  it("new name in DOM while the PUT is pending; resolved auto-CSI row stays IGNORED", async () => {
    seedTakeoff(qc, [], [group({ id: 5, name: "Div 09", kind: "area" })]);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<AreaTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Div 09")).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText("Div 09"));
    const input = screen.getByDisplayValue("Div 09");
    fireEvent.change(input, { target: { value: "Div 10" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // optimistic pin (a): rename visible while the deferred is STILL pending
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-groups/5", { name: "Div 10" }, "PUT"),
    );
    await waitFor(() => expect(screen.getByText("Div 10")).toBeInTheDocument());
    expect(alertMock).not.toHaveBeenCalled();

    // groups PUT auto-fills csiCode and returns the full row — the client ignores it (TC-8
    // pins this on CountTab; asserted per-tab here so a reconcile drive-by fails locally too)
    d.resolve(group({ id: 5, name: "Div 10", kind: "area", csiCode: "09 00 00" }));
    await act(async () => {}); // drain the settle past the notify horizon
    await act(async () => {});
    expect(screen.queryByText("09 00 00")).not.toBeInTheDocument(); // NO csi badge surfaced
    expect(screen.getByText("Div 10")).toBeInTheDocument();
  });
});

// ─── LinearTab ───────────────────────────────────────────────────────────────────────────────

describe("LinearTab — seeded render + server-first create (TL-1)", () => {
  it("seeded linear item renders; create lands only after the POST resolves", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Wall Framing", shape: "linear" })], []);
    const d = deferred<Response>();
    mockCreateItemPost(d.promise as Promise<unknown>);
    render(<LinearTab />, { wrapper });

    await waitFor(() => expect(screen.getByText("Wall Framing")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ Add Linear Item" }));
    fireEvent.change(screen.getByPlaceholderText("Linear item name (e.g., Wall Framing)..."), {
      target: { value: "Pipe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // ── SPEC §6.3 mock-call-anchored interleaving idiom (server-first) ──
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/takeoff-items");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "pid",
      name: "Pipe",
      shape: "linear",
      color: TWENTY_COLORS[2], // LinearTab's default formColor differs from Count/Area — from source
    });
    expect(screen.getAllByText("Pipe")).toHaveLength(1); // form PREVIEW only — no row yet
    expect(screen.getByRole("button", { name: "..." })).toBeInTheDocument();

    d.resolve({ ok: true, json: async () => item({ id: 43, name: "Pipe", shape: "linear" }) } as Response);

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Linear item name (e.g., Wall Framing)..."),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Pipe")).toBeInTheDocument();
  });
});

describe("LinearTab — group-create failure is ALERT (TL-2)", () => {
  it("rejection alerts 'Failed to create group:' (unlike AreaTab's inline channel)", async () => {
    seedTakeoff(qc, [], []);
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<LinearTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name (e.g. Division 03)"), {
      target: { value: "Div 03" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to create group: boom"));
    expect(screen.queryByText("Div 03")).not.toBeInTheDocument();
  });
});

// [DETECTOR jul10 closer] TL-3: demo-never-writes pin for LinearTab — same rationale as TA-4
// (HARD invariant, previously test-invisible in this tab).
describe("LinearTab — demo NEVER writes (TL-3)", () => {
  it("rename+delete+create item and create group all land locally; ZERO calls on either channel", async () => {
    setViewerStoreStateForTest({ isDemo: true });
    seedAnnotations(qc, [
      takeoffAnn(100, 7, "Wall Framing", "linear-polyline"),
      // cross-domain bait: a non-takeoff annotation must SURVIVE the demo delete sweep
      { id: 101, pageNumber: 1, name: "door_single", bbox: [0, 0, 0.1, 0.1], note: null, source: "yolo", data: null },
    ]);
    seedTakeoff(
      qc,
      [item({ id: 7, name: "Wall Framing", shape: "linear", groupId: 5 })],
      [group({ id: 5, name: "Div 26", kind: "linear" })],
    );
    render(<LinearTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Wall Framing")).toBeInTheDocument());

    // rename item — demo branch: local write + annotation name-sync, NO PUT
    fireEvent.doubleClick(screen.getByText("Wall Framing"));
    const renameInput = screen.getByDisplayValue("Wall Framing");
    fireEvent.change(renameInput, { target: { value: "Wall Framing 2" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Wall Framing 2")).toBeInTheDocument());
    expect(readSeededAnnotations(qc)[0].name).toBe("Wall Framing 2"); // demo name-sync

    // delete item — demo branch: local remove + sweep, NO DELETE (sole row → title unique)
    fireEvent.click(screen.getByTitle("Delete item and all lines"));
    await waitFor(() => expect(screen.queryByText("Wall Framing 2")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([101]),
    );

    // create item — demo branch: local temp (id: -Date.now()), NO POST
    fireEvent.click(screen.getByRole("button", { name: "+ Add Linear Item" }));
    fireEvent.change(screen.getByPlaceholderText("Linear item name (e.g., Wall Framing)..."), {
      target: { value: "Demo Pipe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("Demo Pipe")).toBeInTheDocument());
    await waitFor(() => expect(useToolStore.getState().activeTakeoffItemId).toBeLessThan(0));

    // create group — demo branch: local temp group, NO POST
    fireEvent.click(screen.getByRole("button", { name: "+ New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name (e.g. Division 03)"), {
      target: { value: "Demo G" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("Demo G")).toBeInTheDocument());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });
});

describe("LinearTab — non-demo item writes preserve captured VALUE-REPLACE semantics", () => {
  it("rename and delete each overwrite an annotation that arrives while persistence awaits", async () => {
    const rename = deferred<unknown>();
    const remove = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(rename.promise).mockReturnValueOnce(remove.promise);
    seedTakeoff(qc, [item({ id: 7, name: "Wall Framing", shape: "linear" })], []);
    seedAnnotations(qc, [
      takeoffAnn(100, 7, "Wall Framing", "linear-polyline"),
      unrelatedAnn(101, "stable-linear-yolo"),
    ]);
    render(<LinearTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Wall Framing")).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText("Wall Framing"));
    const input = screen.getByDisplayValue("Wall Framing");
    fireEvent.change(input, { target: { value: "Wall Framing 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/takeoff-items/7",
        { name: "Wall Framing 2" },
        "PUT",
      ),
    );

    // Same deliberately captured-array contract as Area/Count. Keep this witness distinct:
    // the three tabs own separate handlers, so a missed LinearTab migration must fail locally.
    await act(async () => {
      seedAnnotations(qc, [...readSeededAnnotations(qc), unrelatedAnn(102, "concurrent-linear-rename")]);
    });
    expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([100, 101, 102]);
    rename.resolve({ success: true });

    await waitFor(() => expect(screen.getByText("Wall Framing 2")).toBeInTheDocument());
    await waitFor(() =>
      expect(readSeededAnnotations(qc).map((a) => [a.id, a.name])).toEqual([
        [100, "Wall Framing 2"],
        [101, "stable-linear-yolo"],
      ]),
    );

    fireEvent.click(screen.getByTitle("Delete item and all lines"));
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/takeoff-items/7",
        undefined,
        "DELETE",
      ),
    );
    await act(async () => {
      seedAnnotations(qc, [...readSeededAnnotations(qc), unrelatedAnn(103, "concurrent-linear-delete")]);
    });
    expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([100, 101, 103]);
    remove.resolve({ success: true });

    await waitFor(() => expect(screen.queryByText("Wall Framing 2")).not.toBeInTheDocument());
    await waitFor(() => expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([101]));
  });
});

// [DETECTOR jul10 closer] TL-4: optimistic-conversion canary for LinearTab — same rationale as
// TA-5 (mutation M9 on this tab's handlers stayed green against the original freeze).
describe("LinearTab — rename group is optimistic (TL-4)", () => {
  it("new name in DOM while the PUT is pending; resolved auto-CSI row stays IGNORED", async () => {
    seedTakeoff(qc, [], [group({ id: 5, name: "Div 26", kind: "linear" })]);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<LinearTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Div 26")).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText("Div 26"));
    const input = screen.getByDisplayValue("Div 26");
    fireEvent.change(input, { target: { value: "Div 27" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // optimistic pin (a): rename visible while the deferred is STILL pending
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-groups/5", { name: "Div 27" }, "PUT"),
    );
    await waitFor(() => expect(screen.getByText("Div 27")).toBeInTheDocument());
    expect(alertMock).not.toHaveBeenCalled();

    d.resolve(group({ id: 5, name: "Div 27", kind: "linear", csiCode: "26 00 00" }));
    await act(async () => {}); // drain the settle past the notify horizon
    await act(async () => {});
    expect(screen.queryByText("26 00 00")).not.toBeInTheDocument(); // NO csi badge surfaced
    expect(screen.getByText("Div 27")).toBeInTheDocument();
  });
});

// ─── ViewAllPanel ────────────────────────────────────────────────────────────────────────────

describe("ViewAllPanel — Takeoffs tree renders seeded items+groups (VA-1)", () => {
  it("3-level expansion: kind → group → rows; missing-group item under 'Ungrouped'", async () => {
    seedTakeoff(
      qc,
      [
        item({ id: 1, name: "Widget A", groupId: 5 }),
        // groupId points at a group that doesn't exist → the "Ungrouped" fallback (ViewAllPanel:403)
        item({ id: 2, name: "Widget B", groupId: 999 }),
      ],
      [group({ id: 5, name: "Group A" })],
    );
    render(<ViewAllPanel />, { wrapper });

    fireEvent.click(screen.getByText("Takeoffs"));
    await waitFor(() => expect(screen.getByText("count")).toBeInTheDocument());
    fireEvent.click(screen.getByText("count"));
    await waitFor(() => expect(screen.getByText("Group A")).toBeInTheDocument());
    expect(screen.getByText("Ungrouped")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Group A"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Widget A" })).toBeInTheDocument());
    fireEvent.click(screen.getByText("Ungrouped"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Widget B" })).toBeInTheDocument());
  });
});

describe("ViewAllPanel — eye toggle joins takeoff rows with zustand visibility (VA-2)", () => {
  it("row eye → hiddenTakeoffItemIds (STAYS zustand in ④) → strike-through on the row", async () => {
    seedTakeoff(qc, [item({ id: 1, name: "Widget A" })], []);
    render(<ViewAllPanel />, { wrapper });

    fireEvent.click(screen.getByText("Takeoffs"));
    await waitFor(() => expect(screen.getByText("count")).toBeInTheDocument());
    fireEvent.click(screen.getByText("count"));
    await waitFor(() => expect(screen.getByText("Ungrouped")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Ungrouped"));

    const nameBtn = await screen.findByRole("button", { name: "Widget A" });
    expect(nameBtn).not.toHaveClass("line-through");

    // the row eye is scoped inside the row div (SubHeader eyes share the same aria-label)
    const row = nameBtn.parentElement as HTMLElement;
    fireEvent.click(within(row).getByLabelText("Hide"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Widget A" })).toHaveClass("line-through"),
    );
    expect(useUiStore.getState().hiddenTakeoffItemIds.has(1)).toBe(true);
  });
});

// ─── BucketFillAssignDialog ──────────────────────────────────────────────────────────────────

describe("BucketFillAssignDialog — lists polygon-shape items only (BF-1)", () => {
  it("area item listed; count item filtered out", async () => {
    seedTakeoff(
      qc,
      [item({ id: 7, name: "Carpet", shape: "polygon" }), item({ id: 8, name: "Door", shape: "circle" })],
      [],
    );
    render(
      <BucketFillAssignDialog pendingPolygon={PENDING_POLYGON} width={800} height={600} cssScale={1} />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Carpet" })).toBeInTheDocument());
    expect(screen.queryByText("Door")).not.toBeInTheDocument();
  });
});

describe("BucketFillAssignDialog — demo create&assign is local-only (BF-2)", () => {
  it("negative temp item + local annotation commit; ZERO calls on either channel", async () => {
    setViewerStoreStateForTest({ isDemo: true, bucketFillPendingPolygon: PENDING_POLYGON, pageNumber: 3 });
    seedTakeoff(qc, [], []);
    render(
      <BucketFillAssignDialog pendingPolygon={PENDING_POLYGON} width={800} height={600} cssScale={1} />,
      { wrapper },
    );

    // no polygon items → the create form is open by default
    fireEvent.change(screen.getByPlaceholderText("New item name"), { target: { value: "Room A" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & Assign" }));

    // temp item added → the (still-mounted, prop-driven) dialog now lists it
    await waitFor(() => expect(screen.getByRole("button", { name: "Room A" })).toBeInTheDocument());
    // commitBucketFillToItem ran its LOCAL branch: annotation appended, pending polygon consumed
    const anns = readSeededAnnotations(qc);
    expect(anns).toHaveLength(1);
    expect(anns[0].source).toBe("takeoff");
    expect((anns[0].data as { takeoffItemId?: number }).takeoffItemId).toBeLessThan(0); // demo temp id
    expect(anns[0].pageNumber).toBe(3);
    expect(useToolStore.getState().bucketFillPendingPolygon).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});

describe("BucketFillAssignDialog — non-demo create is server-first with the NUMERIC projectId (BF-3)", () => {
  it("nothing added pre-release; POST body carries dbId 123 (frozen quirk); commit chain fires", async () => {
    setViewerStoreStateForTest({ projectId: 123, bucketFillPendingPolygon: PENDING_POLYGON, pageNumber: 2 });
    seedTakeoff(qc, [], []);
    seedAnnotations(qc, []);
    const d = deferred<Response>();
    const annotationSave = deferred<unknown>();
    mockCreateItemPost(d.promise as Promise<unknown>);
    persistFetchMock.mockReturnValueOnce(annotationSave.promise);
    render(
      <BucketFillAssignDialog pendingPolygon={PENDING_POLYGON} width={800} height={600} cssScale={1} />,
      { wrapper },
    );

    fireEvent.change(screen.getByPlaceholderText("New item name"), { target: { value: "Room B" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & Assign" }));

    // ── SPEC §6.3 mock-call-anchored interleaving idiom (server-first) ──
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/takeoff-items");
    const body = JSON.parse(String(init.body));
    // THE frozen quirk (owner item SPEC §8.3): BF POSTs the NUMERIC dbId to the SAME endpoint
    // CountTab feeds the publicId. Preserved verbatim — an accidental "fix" fails here.
    expect(body.projectId).toBe(123);
    expect(body).toEqual({ projectId: 123, name: "Room B", shape: "polygon", color: expect.any(String) });
    expect(screen.queryByRole("button", { name: "Room B" })).not.toBeInTheDocument(); // nothing added yet
    expect(screen.getByRole("button", { name: "Creating..." })).toBeInTheDocument(); // pre-release signal

    d.resolve({
      ok: true,
      json: async () => item({ id: 42, name: "Room B", shape: "polygon", size: 24 }),
    } as Response);

    // server row added to the list, then the commit chain (commitBucketFillToItem) POSTs the
    // annotation via persistFetch — publicId-keyed (contrast the numeric body above)
    await waitFor(() => expect(screen.getByRole("button", { name: "Room B" })).toBeInTheDocument());
    await waitFor(() => expect(persistFetchMock).toHaveBeenCalledTimes(1));
    expect(persistFetchMock).toHaveBeenCalledWith(
      "/api/annotations",
      expect.objectContaining({ projectId: "pid", pageNumber: 2, name: "Room B", source: "takeoff" }),
    );
    // [refactor jul11 P2.2⑥] The takeoff item is server-first, but the chained annotation
    // commit is deliberately optimistic. Pending is consumed and a temp row is visible while
    // its own POST is unresolved; a server-first rewrite of the hoisted ⑥ action fails here.
    expect(readSeededAnnotations(qc)).toHaveLength(1);
    expect(readSeededAnnotations(qc)[0].id).toBeLessThan(0);
    expect(useToolStore.getState().bucketFillPendingPolygon).toBeNull();

    annotationSave.resolve({ id: 900 });
    // annotation committed against the SERVER item id, then re-id'd from the annotations response
    await waitFor(() => expect(readSeededAnnotations(qc)[0]?.id).toBe(900));
    expect((readSeededAnnotations(qc)[0].data as { takeoffItemId?: number }).takeoffItemId).toBe(42);
  });
});

describe("BucketFillAssignDialog — direct existing-item G6 boundary", () => {
  it("no publicId keeps the clicked existing-item fill local, consumes pending, and makes no request", async () => {
    // Set the empty id BEFORE both helpers: under the cache backing this fixture and hoisted action must
    // address the same pre-bootstrap query key, not the default test key "pid".
    setViewerStoreStateForTest({
      publicId: "",
      bucketFillPendingPolygon: PENDING_POLYGON,
      pageNumber: 4,
    });
    seedTakeoff(qc, [item({ id: 7, name: "Existing Room", shape: "polygon" })], []);
    seedAnnotations(qc, []);
    render(
      <BucketFillAssignDialog pendingPolygon={PENDING_POLYGON} width={800} height={600} cssScale={1} />,
      { wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Existing Room" }));

    const anns = readSeededAnnotations(qc);
    expect(anns).toHaveLength(1);
    expect(anns[0].id).toBeLessThan(0);
    expect((anns[0].data as { takeoffItemId?: number }).takeoffItemId).toBe(7);
    expect(useToolStore.getState().bucketFillPendingPolygon).toBeNull();
    expect(useToolStore.getState().bucketFillError).toMatch(/NOT saved/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("persistence failure keeps the optimistic clicked-item fill and surfaces the error", async () => {
    setViewerStoreStateForTest({ bucketFillPendingPolygon: PENDING_POLYGON, pageNumber: 5 });
    seedTakeoff(qc, [item({ id: 7, name: "Existing Room", shape: "polygon" })], []);
    seedAnnotations(qc, []);
    const save = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(save.promise);
    render(
      <BucketFillAssignDialog pendingPolygon={PENDING_POLYGON} width={800} height={600} cssScale={1} />,
      { wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Existing Room" }));
    await waitFor(() => expect(persistFetchMock).toHaveBeenCalledTimes(1));

    const optimisticId = readSeededAnnotations(qc)[0]?.id;
    expect(optimisticId).toBeLessThan(0);
    expect(useToolStore.getState().bucketFillPendingPolygon).toBeNull();

    save.reject(new Error("annotation service offline"));

    await waitFor(() =>
      expect(useToolStore.getState().bucketFillError).toMatch(/NOT saved.*annotation service offline/),
    );
    // NO rollback is the faithful existing policy. The exact temp row survives for the session.
    expect(readSeededAnnotations(qc).map((ann) => ann.id)).toEqual([optimisticId]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
