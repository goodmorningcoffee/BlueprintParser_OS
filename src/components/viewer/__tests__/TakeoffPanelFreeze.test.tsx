// [refactor jul10 P2.2④] TAKEOFF MIGRATION FREEZE NET, part 3/3 — TakeoffPanel (CSV debounce +
// cross-source joins + gcTime survival).
//
// Written GREEN against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte after
// the takeoff domain migrates to the TanStack Query cache (P2_DESIGN/TAKEOFF_IMPL/SPEC.md). The
// single sanctioned divergence point is the SHARED `seedTakeoff` helper (src/test/seed-takeoff.ts).
// Doctrine header (ordering idiom, mock channels, backing-agnostic store asserts) lives in
// TakeoffCountFreeze.test.tsx.
//
// FAKE-TIMER DISCIPLINE (SPEC §6.2, mandatory for this file):
//   vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }) ONLY — full fake timers would
//   deadlock RQ notification flushing. Timers are installed for the WHOLE test (beforeEach) so
//   that post-migration timer work born anywhere in the flow (the RQ setTimeout(0) notify, the
//   gc timer scheduled when the last observer unmounts) is faked from birth — TP-4 is vacuous
//   otherwise.
//
//   waitFor/findBy are BANNED IN THIS FILE (and only here): @testing-library/react@16's
//   asyncWrapper awaits `new Promise(r => setTimeout(r, 0))` and only auto-advances it under a
//   `jest` global (pure.js:83-99) — under vitest fake timers every RTL waitFor therefore hangs
//   until the test times out (probe-verified in this harness). The suite-wide "post-write reads
//   go through waitFor" rule exists to keep asserts past the RQ notify horizon (SPEC §5-D1);
//   in this file that barrier is `advance(ms)` = act-wrapped vi.advanceTimersByTimeAsync, which
//   deterministically flushes the faked setTimeout(0) notify (plus microtasks) BEFORE every
//   post-write assert. Same-tick asserts remain banned: no DOM assert here precedes an advance.
//
// Mount notes: takeoffTab defaults "count" (viewerStore:1059) so AutoQtoTab (TakeoffPanel:463)
// never mounts → no domain-② GET is tripped. The export-CSV button is AVOIDED
// (URL.createObjectURL absent in jsdom, TakeoffPanel:260); the View modal path never touches it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useToolStore } from "@/stores/toolStore";
import { seedTakeoff } from "@/test/seed-takeoff";
import { persistFetch } from "@/lib/client-persist";
import type { ClientTakeoffItem } from "@/types";
import TakeoffPanel from "../TakeoffPanel";
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

function item(over: Partial<ClientTakeoffItem> & { id: number; name: string }): ClientTakeoffItem {
  return { shape: "circle", color: "#ef4444", size: 10, sortOrder: 0, groupId: null, ...over };
}

const fetchMock = vi.fn();
const alertMock = vi.fn();

// THE post-write read barrier of this file (see header): advances faked timers inside act so any
// timer-scheduled React work (incl. the post-migration RQ notify flush) commits before the
// caller's next assert. advance(0) flushes the whole t+0 macrotask horizon + microtasks.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// The CSV modal's grid is the only <table> in the panel — scope queries there ("Door" etc. also
// render in the CountTab list below the modal).
function grid() {
  return within(screen.getByRole("table"));
}

beforeEach(() => {
  qc = new QueryClient(); // pure defaults, matching production Providers.tsx
  resetProjectData();
  setViewerStoreStateForTest({ publicId: "pid", isDemo: false });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in takeoff freeze test: ${url}`);
  });
  persistFetchMock.mockReset();
  alertMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Open the View (editable CSV) modal and commit one cell edit: click cell → change → blur.
// EditableGrid commits ONCE per blur/Enter — one commit = one debounce timer (TakeoffPanel:199).
// (EditableGrid's own focus setTimeout(30) is faked too; it null-guards after unmount.)
async function openModal() {
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  await advance(0);
  expect(screen.getByText("Takeoff Items")).toBeInTheDocument();
}
async function editCell(cellText: string, newValue: string) {
  fireEvent.click(grid().getByText(cellText));
  await advance(0);
  const input = grid().getByDisplayValue(cellText);
  fireEvent.change(input, { target: { value: newValue } });
  fireEvent.blur(input);
}

// ─── TP-1: CSV cell edit — optimistic write + 500ms-debounced single-column raw-fetch PUT ────

describe("TakeoffPanel — CSV edit debounces one single-column PUT; failures are console-only (TP-1)", () => {
  it("no PUT at 499ms; exactly one {name} PUT at 500ms; reject → NO alert, value stays", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door" })], []);
    // the debounced save uses the RAW fetch channel (TakeoffPanel:200), .catch(console.error)
    fetchMock.mockImplementation((url: unknown) => {
      if (url !== "/api/takeoff-items/7") {
        throw new Error(`unexpected raw fetch in takeoff freeze test: ${url}`);
      }
      return Promise.reject(new Error("db down"));
    });
    render(<TakeoffPanel />, { wrapper });
    await advance(0);
    expect(screen.getByText("Quantity Takeoff")).toBeInTheDocument();

    await openModal();
    await editCell("Door", "Door Renamed");

    // optimistic: the grid shows the new value (write flushed by the advance) while NO network fired
    await advance(0);
    expect(grid().getByText("Door Renamed")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(499);
    expect(fetchMock).not.toHaveBeenCalled(); // still inside the 500ms debounce window

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // fires exactly at 500ms
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/takeoff-items/7");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Door Renamed" }); // SINGLE-column body

    // rejection settles: console-only error channel — NO alert, NO reconcile, value stays
    await advance(0);
    expect(alertMock).not.toHaveBeenCalled();
    expect(grid().getByText("Door Renamed")).toBeInTheDocument();
  });
});

// ─── TP-2: the one-timer-per-itemId coalescing quirk ─────────────────────────────────────────

describe("TakeoffPanel — same-row second edit <500ms CANCELS the first column's PUT (TP-2)", () => {
  it("Name then Color on row 7 → ONE PUT with {color} only; the name PUT never fires", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door", color: "#ef4444" })], []);
    fetchMock.mockImplementation((url: unknown) => {
      if (url !== "/api/takeoff-items/7") {
        throw new Error(`unexpected raw fetch in takeoff freeze test: ${url}`);
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    });
    render(<TakeoffPanel />, { wrapper });
    await advance(0);

    await openModal();
    await editCell("Door", "Door 2"); // Item Name edit → timer 1 (fires 500ms later)
    await advance(300); // inside timer 1's window
    await editCell("#ef4444", "#123456"); // Color edit on the SAME row → clearTimeout(timer 1)

    await advance(500); // timer 2 (color) fires; timer 1 (name) was cancelled at +300

    // the frozen data-loss quirk (TakeoffPanel:198-205): one timer per itemId + single-column
    // body means the Name PUT was CANCELLED ENTIRELY — the rename is optimistic-only, never saved
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ color: "#123456" });
    // both optimistic updates still render
    expect(grid().getByText("Door 2")).toBeInTheDocument();
    expect(grid().getByText("#123456")).toBeInTheDocument();
  });
});

// ─── TP-3: active-status-bar cross-source join ───────────────────────────────────────────────

describe("TakeoffPanel — active status bar joins takeoff items with zustand activeTakeoffItemId (TP-3)", () => {
  it("seeded item + active id → status bar renders the item name and Stop", async () => {
    seedTakeoff(qc, [item({ id: 7, name: "Door" })], []);
    useToolStore.setState({ activeTakeoffItemId: 7 }); // STAYS zustand in ④ — the join at :44
    render(<TakeoffPanel />, { wrapper });
    await advance(0);

    // "Door" renders twice: the status bar + the CountTab row — the pair proves the join resolved
    expect(screen.getAllByText("Door")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });
});

// ─── TP-4: demo temp survives unmount + >5min idle (the DOM-level gcTime pin) ────────────────

describe("TakeoffPanel — demo temp survives panel unmount across >5min (TP-4)", () => {
  it("create temp → unmount → advance 6min → remount SAME QueryClient → temp still renders", async () => {
    // Post-migration discriminator: with the panel unmounted there are ZERO takeoff observers, so
    // a finite gcTime (RQ default 5min) would garbage-collect the cache entry and the remount
    // would show initialData [] — only gcTime:Infinity (SPEC §2.1, correctness) keeps this green.
    // The gc timer is born during unmount, i.e. UNDER the faked setTimeout — which is why this
    // file installs fake timers in beforeEach, not mid-test. Pre-migration zustand trivially
    // persists; byte-identical test either way.
    setViewerStoreStateForTest({ isDemo: true });
    seedTakeoff(qc, [], []);
    const view = render(<TakeoffPanel />, { wrapper });
    await advance(0);

    // demo temp via the REAL CountTab handler (negative id, no fetch)
    fireEvent.click(screen.getByRole("button", { name: "+ Add Count Item" }));
    fireEvent.change(screen.getByPlaceholderText("Item name..."), { target: { value: "Demo Temp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await advance(0);
    // twice: the item row + the active status bar (demo create activates the temp, CountTab:69)
    expect(screen.getAllByText("Demo Temp")).toHaveLength(2);

    view.unmount(); // panel closed — no takeoff read surface mounted anywhere
    // clear the active pointer (zustand, survives unmount) so the remount asserts the ROW only —
    // AutoQtoTab Q-7 precedent
    useToolStore.setState({ activeTakeoffItemId: null });

    await advance(6 * 60 * 1000); // > the 5min default gcTime a forgotten Infinity would fall back to

    render(<TakeoffPanel />, { wrapper }); // SAME QueryClient — same session, panel reopened
    await advance(0);
    expect(screen.getByText("Demo Temp")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});
