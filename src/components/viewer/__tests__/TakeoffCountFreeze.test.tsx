// [refactor jul10 P2.2④] TAKEOFF MIGRATION FREEZE NET, part 1/3 — CountTab DEEP characterization.
//
// Written GREEN against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte after
// the takeoff domain (items + groups) migrates to the TanStack Query cache (variant a,
// bootstrap-seeded — P2_DESIGN/TAKEOFF_IMPL/SPEC.md). The single sanctioned divergence point is
// the SHARED `seedTakeoff` helper (src/test/seed-takeoff.ts): pre-migration it writes the zustand
// fields; post-migration it writes the two publicId-keyed cache entries. Every test body here
// stays identical.
//
// WHAT THESE CASES ARE (SPEC §3.2 write-semantics table): the takeoff domain has a SPLIT write
// ordering with NO rollback anywhere — creates/deletes/renames of ITEMS and group CREATION are
// server-then-store; group rename/delete, item move and edit-panel save are optimistic-then-server
// with alert-and-keep error UX. TC-1..TC-11 pin those orderings so a future uniform
// useMutation/rollback/reconcile conversion (TAKEOFF-W1, SPEC §3.4 — parked, owner sign-off
// required) fails LOUDLY here. That is this suite's purpose.
//
// Ordering-pin idiom (SPEC §6.3, MANDATORY VERBATIM): a naive fire→assert-absent false-passes
// post-migration because RQ notifies on a setTimeout(0) macrotask — so every server-first pin
// anchors past the notify horizon (waitFor on the MOCK call + one extra drained turn + a POSITIVE
// pre-release signal) before asserting absence. Same-tick DOM asserts after writes are BANNED;
// all post-write reads go through waitFor (SPEC §5-D1).
//
// Backing-agnostic discipline: NO assert reads getState().takeoffItems/takeoffGroups (those store
// fields are DELETED in the migrate commit). Store asserts are limited to fields that STAY
// zustand in ④: activeTakeoffItemId, annotations (domain ⑥), hiddenTakeoffItemIds.
//
// Harness (SPEC §6.2, probe-verified): TWO mock channels that must never be conflated — raw
// global fetch (create-item POST only, CountTab:78) vs the persistFetch module mock
// (importOriginal-spread, AutoQtoTab.test.tsx precedent) for every other write. window.alert IS
// frozen failure-path behavior; window.confirm gates group delete (TakeoffGroupSection:152).
// jest-dom imported per file (RECIPE gotcha). AnnotationOverlay is NEVER mounted (canvas,
// SPEC §6.5 exclusion). QueryClientProvider is in the wrapper NOW so the flip needs zero churn.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { persistFetch } from "@/lib/client-persist";
import { TWENTY_COLORS } from "@/types";
import type { ClientAnnotation, ClientTakeoffItem, TakeoffGroup } from "@/types";
import CountTab from "../CountTab";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: vi.fn() };
});
const persistFetchMock = vi.mocked(persistFetch);

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Controllable promise for the mock-call-anchored interleaving pins.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Full-shape fixtures (honest against the real types — a field rename breaks HERE).
function item(over: Partial<ClientTakeoffItem> & { id: number; name: string }): ClientTakeoffItem {
  return { shape: "circle", color: "#ef4444", size: 10, sortOrder: 0, groupId: null, ...over };
}
function group(over: Partial<TakeoffGroup> & { id: number; name: string }): TakeoffGroup {
  return { kind: "count", color: null, csiCode: null, sortOrder: 0, ...over };
}
function takeoffAnn(id: number, takeoffItemId: number, name: string): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name,
    bbox: [0, 0, 0.1, 0.1],
    note: null,
    source: "takeoff",
    data: { type: "count-marker", shape: "circle", color: "#ef4444", takeoffItemId } as never,
  };
}
function unrelatedAnn(id: number, name: string): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name,
    bbox: [0.2, 0.2, 0.3, 0.3],
    note: null,
    source: "yolo",
    data: null,
  };
}

const fetchMock = vi.fn();
const alertMock = vi.fn();
const confirmMock = vi.fn(() => true); // group delete goes through confirm() — frozen behavior

beforeEach(() => {
  // PURE-DEFAULTS client, matching production (Providers.tsx has no defaultOptions) — the freeze
  // net must run against production-equivalent client defaults (③ DETECTOR-closer rationale).
  qc = new QueryClient();
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({ publicId: "pid", isDemo: false });
  fetchMock.mockReset();
  // fail-loud default: only the create-item POST may use the raw channel, per-test overrides only
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in takeoff freeze test: ${url}`);
  });
  persistFetchMock.mockReset();
  alertMock.mockReset();
  confirmMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Route the raw-fetch channel at the create-item POST, everything else stays fail-loud.
function mockCreateItemPost(response: Promise<unknown>) {
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/takeoff-items") {
      throw new Error(`unexpected raw fetch in takeoff freeze test: ${url}`);
    }
    return response;
  });
}

// ─── TC-1: create item is SERVER-FIRST (W1) ──────────────────────────────────────────────────

describe("CountTab — create item is server-first (TC-1)", () => {
  it("no row until the POST resolves; the server row (id 42) then lands and activates", async () => {
    seedTakeoff(qc, [], []);
    const d = deferred<Response>();
    mockCreateItemPost(d.promise as Promise<unknown>);
    render(<CountTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Count Item" }));
    fireEvent.change(screen.getByPlaceholderText("Item name..."), { target: { value: "Door" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // ── SPEC §6.3 mock-call-anchored interleaving idiom (server-first) ──
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // mock fires AFTER any hypothetical optimistic write; waitFor drains ≥1 tick
    await act(async () => {}); // belt: drain one more turn
    // body pin: CountTab POSTs the PUBLIC id (uuid) — contrast BF-3's frozen numeric-projectId quirk
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/takeoff-items");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "pid",
      name: "Door",
      shape: "circle",
      color: TWENTY_COLORS[0],
    });
    // NOW meaningful: the only "Door" in the DOM is the form PREVIEW span — no item row, no footer
    expect(screen.getAllByText("Door")).toHaveLength(1);
    expect(screen.queryByText(/total across/)).not.toBeInTheDocument();
    // positive pre-release signal (defeats vacuity): the Create button shows the "..." spinner (CountTab:311)
    expect(screen.getByRole("button", { name: "..." })).toBeInTheDocument();

    d.resolve({ ok: true, json: async () => item({ id: 42, name: "Door" }) } as Response);

    // doubles as the imperative-write→subscribed-read case: the handler's add lands in the list
    await waitFor(() => expect(screen.getByText("0 total across 1 items")).toBeInTheDocument());
    expect(screen.queryByPlaceholderText("Item name...")).not.toBeInTheDocument(); // form closed
    expect(screen.getByText("Door")).toBeInTheDocument(); // the ROW now
    // server-id pin: the SERVER row (not a local temp) is activated (activeTakeoffItemId stays zustand in ④)
    await waitFor(() => expect(useViewerStore.getState().activeTakeoffItemId).toBe(42));
  });
});

// ─── TC-2: demo create is local-only ─────────────────────────────────────────────────────────

describe("CountTab — demo create never writes (TC-2)", () => {
  it("row immediate, negative temp id, ZERO calls on either mock channel", async () => {
    useViewerStore.setState({ isDemo: true });
    seedTakeoff(qc, [], []);
    render(<CountTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Count Item" }));
    fireEvent.change(screen.getByPlaceholderText("Item name..."), { target: { value: "Demo Door" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("0 total across 1 items")).toBeInTheDocument());
    expect(screen.getByText("Demo Door")).toBeInTheDocument();
    expect(useViewerStore.getState().activeTakeoffItemId).toBeLessThan(0); // id: -Date.now()
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});

// ─── TC-3: create non-ok → inline formError, NOT alert ───────────────────────────────────────

describe("CountTab — create failure is inline formError (TC-3)", () => {
  it("non-ok {error:{message}} envelope renders in the form; no alert, no row", async () => {
    seedTakeoff(qc, [], []);
    mockCreateItemPost(
      Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: "VALIDATION", message: "Color required" } }),
      }),
    );
    render(<CountTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Count Item" }));
    fireEvent.change(screen.getByPlaceholderText("Item name..."), { target: { value: "Door" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("Color required")).toBeInTheDocument());
    expect(alertMock).not.toHaveBeenCalled(); // this error channel is INLINE (CountTab:93), unlike W2-W7
    expect(screen.queryByText(/total across/)).not.toBeInTheDocument(); // no row landed
    expect(screen.getByPlaceholderText("Item name...")).toBeInTheDocument(); // form stays open for retry
  });
});

// ─── TC-4/TC-5: delete item is SERVER-FIRST (W2) + cross-domain annotation sweep ─────────────

describe("CountTab — delete item is server-first with annotation sweep (TC-4)", () => {
  it("row survives until the DELETE resolves; then row gone + takeoff-sourced markers filtered", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door" })], []);
    seedAnnotations(qc, [
      takeoffAnn(100, 7, "Door"),
      // cross-domain bait: a non-takeoff annotation must SURVIVE the sweep
      unrelatedAnn(101, "door_single"),
    ]);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Door")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Delete item and all markers"));

    // ── SPEC §6.3 anchored idiom: DELETE in flight, row STILL present (server-first) ──
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-items/7", undefined, "DELETE"),
    );
    await act(async () => {});
    expect(screen.getByText("Door")).toBeInTheDocument(); // positive pre-release signal: nothing removed yet

    // [refactor jul11 P2.2⑥] Load-bearing unpleasant parity: this handler captured the
    // render's annotation array before the await. A row arriving during the DELETE is visible
    // now, but the post-await VALUE-REPLACE intentionally overwrites it. Functionalizing this
    // cache write during ⑥ would be a behavior change, even though it would fix the lost update.
    await act(async () => {
      seedAnnotations(qc, [...readSeededAnnotations(qc), unrelatedAnn(102, "concurrent-delete")]);
    });
    expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([100, 101, 102]);

    d.resolve({ success: true });

    await waitFor(() => expect(screen.queryByText("Door")).not.toBeInTheDocument());
    // cross-domain (annotations stay zustand in ④): the takeoff marker was swept, the yolo one kept
    await waitFor(() =>
      expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([101]),
    );
  });
});

describe("CountTab — delete rejection keeps the row (TC-5)", () => {
  it("alert 'Failed to delete item:'; row and annotations untouched", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door" })], []);
    seedAnnotations(qc, [takeoffAnn(100, 7, "Door")]);
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Door")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Delete item and all markers"));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to delete item: boom"));
    expect(screen.getByText("Door")).toBeInTheDocument(); // server-first: nothing to roll back
    expect(readSeededAnnotations(qc)).toHaveLength(1);
  });
});

// ─── TC-6: rename item is SERVER-FIRST; client renders its LOCAL newName (W3) ────────────────

describe("CountTab — rename item is server-first, local newName rendered (TC-6)", () => {
  it("edit input stays mounted while the PUT is pending (setEditingId(null) is post-await)", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door" })], []);
    seedAnnotations(qc, [takeoffAnn(100, 7, "Door"), unrelatedAnn(101, "stable-yolo")]);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Door")).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText("Door"));
    const input = screen.getByDisplayValue("Door");
    fireEvent.change(input, { target: { value: "Door 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // ── SPEC §6.3 anchored idiom: PUT in flight, store NOT yet renamed ──
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-items/7", { name: "Door 2" }, "PUT"),
    );
    await act(async () => {});
    // positive pre-release signal: the edit input is STILL MOUNTED (CountTab:137 clears it post-await)
    expect(screen.getByDisplayValue("Door 2")).toBeInTheDocument();
    // NOW meaningful: no static row text carries the new name yet (input VALUES don't match text queries)
    expect(screen.queryByText("Door 2")).not.toBeInTheDocument();

    // Same captured-array contract as delete: prove the concurrent row really landed before
    // resolving, then require the faithful post-await value replacement to drop only that row.
    await act(async () => {
      seedAnnotations(qc, [...readSeededAnnotations(qc), unrelatedAnn(102, "concurrent-rename")]);
    });
    expect(readSeededAnnotations(qc).map((a) => a.id)).toEqual([100, 101, 102]);

    // items PUT returns {success:true}, NOT the row — the client renders its LOCAL newName (frozen)
    d.resolve({ success: true });

    await waitFor(() => expect(screen.getByText("Door 2")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("Door 2")).not.toBeInTheDocument(); // edit mode exited
    // annotation name-sync rode along; stable captured rows survive, the concurrent row does not
    await waitFor(() =>
      expect(readSeededAnnotations(qc).map((a) => [a.id, a.name])).toEqual([
        [100, "Door 2"],
        [101, "stable-yolo"],
      ]),
    );
  });
});

// ─── TC-7: create group is SERVER-FIRST (W4 — census line 29 omitted this; SPEC §8.6 erratum) ─

describe("CountTab — create group is server-first (TC-7)", () => {
  it("no header until the POST resolves", async () => {
    seedTakeoff(qc, [], []);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<CountTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name (e.g. Division 08)"), {
      target: { value: "Division 08" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // ── SPEC §6.3 anchored idiom ──
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-groups", {
        projectId: "pid",
        name: "Division 08",
        kind: "count",
      }),
    );
    await act(async () => {});
    expect(screen.queryByText("Division 08")).not.toBeInTheDocument(); // no header pre-release
    // positive pre-release signal: the group form still holds the typed name (cleared only on success)
    expect(screen.getByDisplayValue("Division 08")).toBeInTheDocument();

    d.resolve(group({ id: 5, name: "Division 08" }));

    await waitFor(() => expect(screen.getByText("Division 08")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("Division 08")).not.toBeInTheDocument(); // form closed
  });

  it("rejection: alert channel (CountTab, unlike AreaTab's inline groupError), no header", async () => {
    seedTakeoff(qc, [], []);
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<CountTab />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "+ New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name (e.g. Division 08)"), {
      target: { value: "Division 08" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to create group: boom"));
    expect(screen.queryByText("Division 08")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Division 08")).toBeInTheDocument(); // form NOT cleared on failure
  });
});

// ─── TC-8/TC-9: rename group is OPTIMISTIC; server's auto-CSI full-row response is IGNORED ───

describe("CountTab — rename group is optimistic and the server response is IGNORED (TC-8)", () => {
  it("new name in DOM while PUT pending; resolved csiCode does NOT surface as a badge", async () => {
    seedTakeoff(qc, [], [group({ id: 5, name: "Div 08" })]);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Div 08")).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText("Div 08"));
    const input = screen.getByDisplayValue("Div 08");
    fireEvent.change(input, { target: { value: "Div 09" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // optimistic pin (a): DOM changed while the deferred is STILL pending
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-groups/5", { name: "Div 09" }, "PUT"),
    );
    await waitFor(() => expect(screen.getByText("Div 09")).toBeInTheDocument());

    // groups PUT returns the FULL row and auto-fills csiCode on rename (svc:328-338) — the client
    // deliberately ignores it today (census red-flag 5). A future reconciling onSettled would
    // paint the cyan badge (TakeoffGroupSection:145-146) and fail here.
    d.resolve(group({ id: 5, name: "Div 09", csiCode: "09 00 00" }));
    await act(async () => {}); // drain the settle past the notify horizon
    await act(async () => {});

    expect(screen.queryByText("09 00 00")).not.toBeInTheDocument(); // NO csi badge
    expect(screen.getByText("Div 09")).toBeInTheDocument();
  });
});

describe("CountTab — rename group rejection keeps the new name, NO ROLLBACK (TC-9)", () => {
  it("alert 'Failed to rename group:' and the optimistic rename REMAINS", async () => {
    seedTakeoff(qc, [], [group({ id: 5, name: "Div 08" })]);
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Div 08")).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText("Div 08"));
    const input = screen.getByDisplayValue("Div 08");
    fireEvent.change(input, { target: { value: "Div 09" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to rename group: boom"));
    expect(screen.getByText("Div 09")).toBeInTheDocument(); // alert-and-KEEP
    expect(screen.queryByText("Div 08")).not.toBeInTheDocument();
  });
});

// ─── TC-10: delete group is OPTIMISTIC; two-key ungroup lands DOM-level (W6 / SPEC §5-D6) ────

describe("CountTab — delete group is optimistic; members re-home to Ungrouped (TC-10)", () => {
  it("header gone + item under 'Ungrouped' while DELETE pending; rejection keeps it gone", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door", groupId: 5 })], [group({ id: 5, name: "Div 08" })]);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Div 08")).toBeInTheDocument());
    expect(screen.queryByText("Ungrouped")).not.toBeInTheDocument(); // the item lives under the group

    fireEvent.click(screen.getByTitle("Delete group")); // goes through confirm() — stubbed true
    expect(confirmMock).toHaveBeenCalledTimes(1);

    // optimistic two-key ungroup, DOM-level: groups key loses the group AND the member item's
    // groupId nulls in the SAME action — the row re-homes to the "Ungrouped" section while the
    // DELETE is still in flight. (The half-state groupId:null contract itself is pinned in the
    // C2 hook suite; it is DOM-invisible here by design — CountTab:199 fallback.)
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-groups/5", undefined, "DELETE"),
    );
    await waitFor(() => expect(screen.queryByText("Div 08")).not.toBeInTheDocument());
    expect(screen.getByText("Ungrouped")).toBeInTheDocument();
    expect(screen.getByText("Door")).toBeInTheDocument();

    d.reject(new Error("boom"));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to delete group: boom"));
    expect(screen.queryByText("Div 08")).not.toBeInTheDocument(); // alert-and-KEEP, no rollback
    expect(screen.getByText("Ungrouped")).toBeInTheDocument();
    expect(screen.getByText("Door")).toBeInTheDocument();
  });
});

// ─── TC-11: move item is OPTIMISTIC and writes the ITEMS key (W7) ────────────────────────────

describe("CountTab — move item to group is optimistic (TC-11)", () => {
  it("item under the target group while PUT pending; rejection keeps it there", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door" })], [group({ id: 5, name: "Div 08" })]);
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Door")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Move to group..."));
    // the dropdown option is a BUTTON; the group header is a span — role discriminates
    fireEvent.click(screen.getByRole("button", { name: "Div 08" }));

    // optimistic pin (a): the PUT targets the ITEMS endpoint (move = updateTakeoffItem, not a
    // groups write — SPEC §2.3) and the now-empty "Ungrouped" section vanishes while it's pending
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-items/7", { groupId: 5 }, "PUT"),
    );
    await waitFor(() => expect(screen.queryByText("Ungrouped")).not.toBeInTheDocument());
    expect(screen.getByText("Door")).toBeInTheDocument(); // now rendered under Div 08

    d.reject(new Error("boom"));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to move item: boom"));
    expect(screen.queryByText("Ungrouped")).not.toBeInTheDocument(); // stays moved — no rollback
    expect(screen.getByText("Door")).toBeInTheDocument();
  });
});

// ─── TC-12: edit panel — onLiveUpdate pure-local; save optimistic with alert-and-keep (W8) ───

describe("CountTab — edit panel live update is pure-local, save is optimistic (TC-12)", () => {
  it("shape flip renders with ZERO fetch; save shows new name pre-release; reject keeps it", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door" })], []);
    const { container } = render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Door")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Edit item"));

    // (a) onLiveUpdate is PURE-LOCAL (CountTab:271 — zero fetch on either channel): the row icon
    // re-renders from the written item (circle svg → rect svg for "square")
    fireEvent.click(screen.getByRole("button", { name: "square" }));
    await waitFor(() => expect(container.querySelector("svg rect")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();

    // (b) save is OPTIMISTIC: store first, PUT after (CountTab:262→265)
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Door XL" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // optimistic pin (a): new name visible while the PUT is STILL pending (shape already equal
    // via the live update, so the PUT body is name-only)
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/takeoff-items/7", { name: "Door XL" }, "PUT"),
    );
    await waitFor(() => expect(screen.getByText("Door XL")).toBeInTheDocument());

    d.reject(new Error("disk full"));

    // optimistic pin (b): rejection → alert + the change REMAINS (this is what breaks a future
    // onError-rollback conversion)
    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to save item: disk full"));
    expect(screen.getByText("Door XL")).toBeInTheDocument();
  });
});

// ─── TC-13: demo group ops never touch the network ───────────────────────────────────────────

describe("CountTab — demo group create/rename/delete are local-only (TC-13)", () => {
  it("all three ops land in the DOM with ZERO calls on either channel", async () => {
    useViewerStore.setState({ isDemo: true });
    seedTakeoff(qc, [item({ id: -5, name: "Demo Door" })], []);
    render(<CountTab />, { wrapper });
    await waitFor(() => expect(screen.getByText("Demo Door")).toBeInTheDocument());

    // create (temp id: -Date.now())
    fireEvent.click(screen.getByRole("button", { name: "+ New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name (e.g. Division 08)"), {
      target: { value: "G1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("G1")).toBeInTheDocument());

    // rename (optimistic write, then the isDemo early-return skips the PUT)
    fireEvent.doubleClick(screen.getByText("G1"));
    const input = screen.getByDisplayValue("G1");
    fireEvent.change(input, { target: { value: "G2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("G2")).toBeInTheDocument());

    // delete (optimistic write, isDemo skips the DELETE)
    fireEvent.click(screen.getByTitle("Delete group"));
    await waitFor(() => expect(screen.queryByText("G2")).not.toBeInTheDocument());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});
