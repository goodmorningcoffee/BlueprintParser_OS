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
import { useViewerStore } from "@/stores/viewerStore";
import { seedTakeoff } from "@/test/seed-takeoff";
import { persistFetch } from "@/lib/client-persist";
import { TWENTY_COLORS } from "@/types";
import type { ClientTakeoffItem, TakeoffGroup } from "@/types";
import AreaTab from "../AreaTab";
import LinearTab from "../LinearTab";
import ViewAllPanel from "../ViewAllPanel";
import BucketFillAssignDialog from "../BucketFillAssignDialog";

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

// Shared pending polygon for the BF cases — shape of viewerStore.bucketFillPendingPolygon.
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
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({ publicId: "pid", isDemo: false });
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
    expect(useViewerStore.getState().hiddenTakeoffItemIds.has(1)).toBe(true);
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
    useViewerStore.setState({ isDemo: true, bucketFillPendingPolygon: PENDING_POLYGON, pageNumber: 3 });
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
    const anns = useViewerStore.getState().annotations;
    expect(anns).toHaveLength(1);
    expect(anns[0].source).toBe("takeoff");
    expect((anns[0].data as { takeoffItemId?: number }).takeoffItemId).toBeLessThan(0); // demo temp id
    expect(anns[0].pageNumber).toBe(3);
    expect(useViewerStore.getState().bucketFillPendingPolygon).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});

describe("BucketFillAssignDialog — non-demo create is server-first with the NUMERIC projectId (BF-3)", () => {
  it("nothing added pre-release; POST body carries dbId 123 (frozen quirk); commit chain fires", async () => {
    useViewerStore.setState({ projectId: 123, bucketFillPendingPolygon: PENDING_POLYGON, pageNumber: 2 });
    seedTakeoff(qc, [], []);
    const d = deferred<Response>();
    mockCreateItemPost(d.promise as Promise<unknown>);
    persistFetchMock.mockResolvedValueOnce({ id: 900 }); // the /api/annotations POST settles ok
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
    // annotation committed against the SERVER item id, then re-id'd from the annotations response
    await waitFor(() => expect(useViewerStore.getState().annotations[0]?.id).toBe(900));
    expect((useViewerStore.getState().annotations[0].data as { takeoffItemId?: number }).takeoffItemId).toBe(42);
  });
});
