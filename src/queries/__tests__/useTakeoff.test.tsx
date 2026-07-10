// [refactor jul10 P2.2④] Tests for the takeoff query facade (qto/summaries-suite rigor — SPEC
// §6.4). Landed in the EXTRACT commit (C2, cache-form from birth): they define the target backing
// while the app still runs on zustand; the DOM freeze net (TakeoffCountFreeze/TakeoffTabsFreeze/
// TakeoffPanelFreeze, landed green pre-refactor) must stay green byte-for-byte across the C3 flip.
// This file pins the hook/helper semantics themselves: [] defaults, seed→read (incl. the v5
// setQueryData(undefined) no-op trap → the ?? [] guard, D3), each action vs its key, the TWO-KEY
// removeTakeoffGroup ungroup (FK-SET-NULL contract a DOM suite cannot see — CountTab/ViewAllPanel
// render half-state invisibly behind "Ungrouped" fallbacks), the D6 raw-subscriber sync-block pin
// (detects an inserted await between the two ungroup writes), captured-key writes (D2),
// two-publicId isolation (D5), staleTime/gcTime Infinity (SPEC §2.1 CORRECTNESS — no refetch path
// exists), and the readTakeoffItems bridge incl. same-tick read-after-write (AnnotationOverlay's
// handler-time reads depend on it).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  seedTakeoffCache,
  seedTakeoffFromBootstrap,
  readTakeoffItems,
  useTakeoffItems,
  useTakeoffGroups,
} from "@/queries/useTakeoff";
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ClientTakeoffItem, TakeoffGroup } from "@/types";

// Full-shape fixtures (freeze-suite discipline: honest against the real types).
function item(over: Partial<ClientTakeoffItem> & { id: number; name: string }): ClientTakeoffItem {
  return { shape: "circle", color: "#ef4444", size: 10, sortOrder: 0, groupId: null, ...over };
}
function group(over: Partial<TakeoffGroup> & { id: number; name: string }): TakeoffGroup {
  return { kind: "count", color: null, csiCode: null, sortOrder: 0, ...over };
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
function freshClient() {
  return new QueryClient(); // pure defaults, matching production Providers.tsx
}
// Both hooks under one renderHook — mirrors the dual-reader tabs (CountTab/AreaTab/LinearTab).
function useBoth() {
  return { items: useTakeoffItems(), groups: useTakeoffGroups() };
}

// ── seedTakeoffCache — the ONE production full-collection write helper (2 loaders) ────────────
describe("seedTakeoffCache (loader seed, both keys)", () => {
  it("undefined collections seed [] — the v5 setQueryData(undefined) silent-no-op trap (D3)", () => {
    const qc = new QueryClient();
    // pre-populate a "previous visit" entry under the SAME publicId: without `?? []` a demo/
    // omitted-field reload would silently RETAIN these rows (v5: `if (data === void 0) return`).
    seedTakeoffCache(qc, "p", [item({ id: 1, name: "Stale" })], [group({ id: 9, name: "Old G" })]);
    seedTakeoffCache(qc, "p", undefined, undefined);
    expect(qc.getQueryData(queryKeys.takeoff.items("p"))).toEqual([]);
    expect(qc.getQueryData(queryKeys.takeoff.groups("p"))).toEqual([]);
  });

  it("null collections seed [] (same coercion path)", () => {
    const qc = new QueryClient();
    seedTakeoffCache(qc, "p", null, null);
    expect(qc.getQueryData(queryKeys.takeoff.items("p"))).toEqual([]);
    expect(qc.getQueryData(queryKeys.takeoff.groups("p"))).toEqual([]);
  });

  it("present collections land verbatim under the exact publicId-keyed tuples; other publicIds untouched", () => {
    const qc = new QueryClient();
    const items = [item({ id: 1, name: "Door" })];
    const groups = [group({ id: 5, name: "Div 08" })];
    seedTakeoffCache(qc, "p-A", items, groups);
    // key shapes are exactly the documented tuples (queryKeys.ts ④)
    expect(queryKeys.takeoff.items("p-A")).toEqual(["project", "p-A", "takeoff", "items"]);
    expect(queryKeys.takeoff.groups("p-A")).toEqual(["project", "p-A", "takeoff", "groups"]);
    expect(qc.getQueryData(queryKeys.takeoff.items("p-A"))).toEqual(items);
    expect(qc.getQueryData(queryKeys.takeoff.groups("p-A"))).toEqual(groups);
    expect(qc.getQueryData(queryKeys.takeoff.items("p-B"))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.takeoff.groups("p-B"))).toBeUndefined();
  });

  it("re-seeding the same publicId REPLACES both entries (loader overwrite on re-open)", () => {
    const qc = new QueryClient();
    seedTakeoffCache(qc, "p", [item({ id: 1, name: "Old" })], [group({ id: 5, name: "Old G" })]);
    const nextItems = [item({ id: 2, name: "New" })];
    const nextGroups = [group({ id: 6, name: "New G" })];
    seedTakeoffCache(qc, "p", nextItems, nextGroups);
    expect(qc.getQueryData(queryKeys.takeoff.items("p"))).toEqual(nextItems);
    expect(qc.getQueryData(queryKeys.takeoff.groups("p"))).toEqual(nextGroups);
  });
});

// ── seedTakeoffFromBootstrap — the dashboard loader's field-mapping adapter ───────────────────
// [DETECTOR jul10 closer] Mutation testing showed deleting the loader's takeoff seed passed the
// whole suite — the payload-field→cache-key mapping was test-invisible. These cases pin the
// mapping itself (the loader keeps one trivial call: seedTakeoffFromBootstrap(qc, data.id, data)).
// The loader CALL is still not executable-pinned (page not cleanly jsdom-mountable) — known,
// accepted residual, named in the closer commit body.
describe("seedTakeoffFromBootstrap (loader field-mapping adapter)", () => {
  it("maps takeoffItems→items key and takeoffGroups→groups key (a field swap fails here)", () => {
    const qc = new QueryClient();
    const items = [item({ id: 1, name: "Door" })];
    const groups = [group({ id: 5, name: "Div 08" })];
    seedTakeoffFromBootstrap(qc, "p", { takeoffItems: items, takeoffGroups: groups });
    expect(qc.getQueryData(queryKeys.takeoff.items("p"))).toEqual(items);
    expect(qc.getQueryData(queryKeys.takeoff.groups("p"))).toEqual(groups);
  });

  it("omitted fields seed [] — demo bootstrap omits takeoff entirely (D3 via the ?? [] guard)", () => {
    const qc = new QueryClient();
    // previous-visit residue under the SAME publicId must be cleared, not retained
    seedTakeoffFromBootstrap(qc, "p", {
      takeoffItems: [item({ id: 1, name: "Stale" })],
      takeoffGroups: [group({ id: 9, name: "Old G" })],
    });
    seedTakeoffFromBootstrap(qc, "p", {});
    expect(qc.getQueryData(queryKeys.takeoff.items("p"))).toEqual([]);
    expect(qc.getQueryData(queryKeys.takeoff.groups("p"))).toEqual([]);
  });

  it("re-open REPLACES both entries; a field omitted on re-open lands [] (never merges/retains)", () => {
    const qc = new QueryClient();
    seedTakeoffFromBootstrap(qc, "p", {
      takeoffItems: [item({ id: 1, name: "Old" })],
      takeoffGroups: [group({ id: 5, name: "Old G" })],
    });
    seedTakeoffFromBootstrap(qc, "p", { takeoffItems: [item({ id: 2, name: "New" })] });
    expect(qc.getQueryData(queryKeys.takeoff.items("p"))).toEqual([item({ id: 2, name: "New" })]);
    expect(qc.getQueryData(queryKeys.takeoff.groups("p"))).toEqual([]);
  });
});

// ── useTakeoffItems / useTakeoffGroups — the cache-backed facade ──────────────────────────────
describe("useTakeoffItems / useTakeoffGroups", () => {
  beforeEach(() => {
    useViewerStore.getState().resetProjectData();
  });

  it("[] defaults: fresh client reads empty arrays on BOTH hooks; success/idle — the throwing queryFn never ran", () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });
    expect(result.current.items.takeoffItems).toEqual([]);
    expect(result.current.groups.takeoffGroups).toEqual([]);
    // enabled:false + initialData -> immediate success, idle; an error status here would mean the
    // throwing queryFn fired (the loader-seed contract was violated).
    for (const key of [queryKeys.takeoff.items("p-A"), queryKeys.takeoff.groups("p-A")]) {
      const q = client.getQueryCache().find({ queryKey: key })!;
      expect(q.state.status).toBe("success");
      expect(q.state.fetchStatus).toBe("idle");
    }
  });

  it("seed→read round-trip: a pre-mount loader-style seed is what both hooks render", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    const items = [item({ id: 1, name: "Door" }), item({ id: 2, name: "Window", groupId: 5 })];
    const groups = [group({ id: 5, name: "Div 08" })];
    seedTakeoffCache(client, "p-A", items, groups); // loader runs BEFORE consumers mount
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.items.takeoffItems).toEqual(items));
    await waitFor(() => expect(result.current.groups.takeoffGroups).toEqual(groups));
  });

  it("addTakeoffItem appends to the items key ONLY (store-action mirror)", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    seedTakeoffCache(client, "p-A", [item({ id: 1, name: "Door" })], [group({ id: 5, name: "G" })]);
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });
    const groupsBefore = client.getQueryData(queryKeys.takeoff.groups("p-A"));

    act(() => result.current.items.addTakeoffItem(item({ id: 2, name: "Window" })));
    await waitFor(() =>
      expect(result.current.items.takeoffItems.map((t) => t.id)).toEqual([1, 2]),
    );
    // groups entry untouched — not even identity churn (no groups-key write happened)
    expect(client.getQueryData(queryKeys.takeoff.groups("p-A"))).toBe(groupsBefore);
  });

  it("removeTakeoffItem filters by id (store-action mirror)", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    seedTakeoffCache(client, "p-A", [item({ id: 1, name: "Door" }), item({ id: 2, name: "Window" })], []);
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });

    act(() => result.current.items.removeTakeoffItem(1));
    await waitFor(() =>
      expect(result.current.items.takeoffItems.map((t) => t.id)).toEqual([2]),
    );
  });

  it("updateTakeoffItem map-merges the patch, preserving unlisted fields (store-action mirror)", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    seedTakeoffCache(client, "p-A", [item({ id: 1, name: "Door", size: 10, color: "#ef4444" })], []);
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });

    act(() => result.current.items.updateTakeoffItem(1, { name: "Door 2", size: 14 }));
    await waitFor(() => expect(result.current.items.takeoffItems[0].name).toBe("Door 2"));
    expect(result.current.items.takeoffItems[0]).toEqual(
      item({ id: 1, name: "Door 2", size: 14, color: "#ef4444" }), // color/shape/sortOrder survive
    );
  });

  it("addTakeoffGroup / updateTakeoffGroup write the groups key ONLY", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    seedTakeoffCache(client, "p-A", [item({ id: 1, name: "Door" })], []);
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });
    const itemsBefore = client.getQueryData(queryKeys.takeoff.items("p-A"));

    act(() => result.current.groups.addTakeoffGroup(group({ id: 5, name: "Div 08" })));
    await waitFor(() =>
      expect(result.current.groups.takeoffGroups.map((g) => g.id)).toEqual([5]),
    );
    act(() => result.current.groups.updateTakeoffGroup(5, { name: "Division 08" }));
    await waitFor(() =>
      expect(result.current.groups.takeoffGroups[0]).toEqual(group({ id: 5, name: "Division 08" })),
    );
    // items entry never touched by pure group ops (identity-stable — D4 topology argument)
    expect(client.getQueryData(queryKeys.takeoff.items("p-A"))).toBe(itemsBefore);
  });

  it("removeTakeoffGroup ungroups across BOTH keys: group gone AND member items groupId:null (FK-SET-NULL mirror)", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    seedTakeoffCache(
      client,
      "p-A",
      [item({ id: 1, name: "Member", groupId: 5 }), item({ id: 2, name: "Other", groupId: 7 })],
      [group({ id: 5, name: "Doomed" }), group({ id: 7, name: "Kept" })],
    );
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });

    act(() => result.current.groups.removeTakeoffGroup(5));
    // the read-both-keys pin: BOTH hook surfaces reflect the two-key write
    await waitFor(() =>
      expect(result.current.groups.takeoffGroups.map((g) => g.id)).toEqual([7]),
    );
    await waitFor(() =>
      expect(result.current.items.takeoffItems).toEqual([
        item({ id: 1, name: "Member", groupId: null }), // ungrouped (SET NULL mirror)
        item({ id: 2, name: "Other", groupId: 7 }), // foreign member untouched
      ]),
    );
  });

  it("D6 raw-subscriber pin: no render-equivalent boundary observes groups-final + items-stale (detects an inserted await)", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    seedTakeoffCache(
      client,
      "p-A",
      [item({ id: 1, name: "Member", groupId: 5 })],
      [group({ id: 5, name: "Doomed" })],
    );
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });

    // A raw QueryCache listener DOES fire synchronously between the facade's two setQueryData
    // calls (probe-confirmed). [DETECTOR jul10 closer] An earlier version of this comment
    // claimed "no production raw subscriber exists" — FALSE: ReactQueryDevtools
    // (Providers.tsx:22, dev-only behind NODE_ENV) IS a synchronous cache listener and DOES
    // observe the between-writes half-state in dev builds. Display-only, harmless — but it means
    // D6 is scoped to RENDERABLE FRAMES + SCHEDULED (notify-batched) OBSERVERS, never raw
    // listeners (SPEC §9.2 errata). No PRODUCTION-build raw subscriber exists; keep it that way.
    // The D6 contract is weaker and is what renders depend on: by the earliest
    // RENDER-EQUIVALENT boundary (the microtask queue — RQ's own notify is even later, a
    // setTimeout(0) macrotask), BOTH writes have landed. If someone inserts an await between the
    // ungroup's two writes, the microtask scheduled at the groups-final event runs at that await
    // boundary and catches items still stale.
    const groupsKeyJson = JSON.stringify(queryKeys.takeoff.groups("p-A"));
    // [DETECTOR jul10 closer] Tear-net DESIGN (do not simplify): the listener ANCHORS on the
    // groups-key write that removes group 5 (the delete-final write) and probes the ITEMS key one
    // microtask later — the earliest render-equivalent boundary. An inserted await between the
    // facade's two writes parks the items write behind that microtask, so `violations` catches
    // it. `sawGroupsFinal` is the POSITIVE CONTROL: if the anchor predicate ever stops matching
    // (key-tuple change, updater rewrite, fixture drift), the case fails on it instead of
    // vacuously passing with zero probes armed. Deliberately NOT caught here: the synchronous
    // between-writes window itself (raw listeners like devtools DO see it — header note above)
    // and a flipped write ORDER (items-first then groups is equally atomic and benign).
    let sawGroupsFinal = false; // positive control — without it the pin is vacuous
    const violations: string[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (JSON.stringify(event.query.queryKey) !== groupsKeyJson) return;
      const groupsNow =
        client.getQueryData<TakeoffGroup[]>(queryKeys.takeoff.groups("p-A")) ?? [];
      if (groupsNow.some((g) => g.id === 5)) return; // not the delete-final write
      sawGroupsFinal = true;
      queueMicrotask(() => {
        const itemsNow =
          client.getQueryData<ClientTakeoffItem[]>(queryKeys.takeoff.items("p-A")) ?? [];
        if (itemsNow.some((t) => t.groupId === 5)) {
          violations.push("observed groups-final + items-stale across a microtask boundary");
        }
      });
    });
    try {
      act(() => result.current.groups.removeTakeoffGroup(5));
      await act(async () => {}); // flush the microtask probe (and the RQ notify behind it)
      expect(sawGroupsFinal).toBe(true);
      expect(violations).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("two-publicId isolation: switching publicId swaps entries; a write to A never touches B (D5)", async () => {
    const client = freshClient();
    seedTakeoffCache(client, "A", [item({ id: 1, name: "A-item" })], [group({ id: 5, name: "A-g" })]);
    seedTakeoffCache(client, "B", [item({ id: 2, name: "B-item" })], [group({ id: 6, name: "B-g" })]);

    useViewerStore.setState({ publicId: "A" });
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.items.takeoffItems[0].name).toBe("A-item"));
    expect(result.current.groups.takeoffGroups[0].name).toBe("A-g");

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(result.current.items.takeoffItems[0].name).toBe("B-item"));
    expect(result.current.groups.takeoffGroups[0].name).toBe("B-g");

    act(() => result.current.items.updateTakeoffItem(2, { name: "B-item-v2" }));
    await waitFor(() => expect(result.current.items.takeoffItems[0].name).toBe("B-item-v2"));
    // A's rows persist untouched under the old key (gcTime Infinity retention — unobservable)
    expect(client.getQueryData(queryKeys.takeoff.items("A"))).toEqual([item({ id: 1, name: "A-item" })]);
  });

  it("D2 pin: an action captured before a project switch writes the OLD publicId's entry, never the current one", async () => {
    // Models the write-racing-a-project-switch window: a handler's post-await add runs with the
    // action instance rendered under project A while the store already points at B. The keyed
    // write lands under A — invisible in B's view (vs the old global store field, which leaked).
    const client = freshClient();
    useViewerStore.setState({ publicId: "A" });
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });
    const capturedAdd = result.current.items.addTakeoffItem; // closed over publicId "A"

    act(() => useViewerStore.setState({ publicId: "B" }));
    act(() => capturedAdd(item({ id: 42, name: "Late reconcile" })));

    expect(client.getQueryData(queryKeys.takeoff.items("A"))).toEqual([
      item({ id: 42, name: "Late reconcile" }),
    ]);
    // the mounted reader (now on B) never sees it — B's entry is the observer's initialData []
    await waitFor(() => expect(result.current.items.takeoffItems).toEqual([]));
    expect(client.getQueryData(queryKeys.takeoff.items("B"))).toEqual([]);
  });

  it("staleTime:Infinity — seeded entries are never stale while observed (both keys, defensive pin)", () => {
    useViewerStore.setState({ publicId: "A" });
    const client = freshClient();
    seedTakeoffCache(client, "A", [item({ id: 1, name: "Door" })], [group({ id: 5, name: "G" })]);
    renderHook(useBoth, { wrapper: makeWrapper(client) });
    for (const key of [queryKeys.takeoff.items("A"), queryKeys.takeoff.groups("A")]) {
      const q = client.getQueryCache().find({ queryKey: key })!;
      expect(q.isStale()).toBe(false);
    }
  });

  // gcTime:Infinity — chat T-A6 fake-timer mechanics (a synchronous unmount/remount would pass
  // for ANY gcTime; only advancing past a plausible finite value discriminates). CORRECTNESS
  // here, unlike ③'s faithfulness rationale: enabled:false + throwing queryFn = NO refetch path,
  // and the groups key's only observers are conditionally-mounted panels — a finite gcTime would
  // blank groups for REAL projects on panel reopen, and demo temp rows only exist in this cache.
  // No waitFor under fake timers (RTL@16 asyncWrapper hangs — TakeoffPanelFreeze header).
  it("gcTime:Infinity keeps BOTH entries alive across an observer gap even after an hour passes", () => {
    vi.useFakeTimers();
    try {
      const client = freshClient();
      const items = [item({ id: -123, name: "Demo temp" })];
      const groups = [group({ id: 5, name: "G" })];
      seedTakeoffCache(client, "A", items, groups);
      useViewerStore.setState({ publicId: "A" });

      const first = renderHook(useBoth, { wrapper: makeWrapper(client) });
      expect(first.result.current.items.takeoffItems).toEqual(items);
      expect(first.result.current.groups.takeoffGroups).toEqual(groups);
      first.unmount(); // last observers gone -> GC timers armed at gcTime (Infinity = never fire)

      vi.advanceTimersByTime(60 * 60 * 1000); // an hour of "panel closed"
      expect(client.getQueryData(queryKeys.takeoff.items("A"))).toEqual(items);
      expect(client.getQueryData(queryKeys.takeoff.groups("A"))).toEqual(groups);

      const second = renderHook(useBoth, { wrapper: makeWrapper(client) });
      expect(second.result.current.items.takeoffItems).toEqual(items);
      expect(second.result.current.groups.takeoffGroups).toEqual(groups);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── readTakeoffItems — the AnnotationOverlay getState() bridge (7 sync sites) ─────────────────
describe("readTakeoffItems bridge", () => {
  beforeEach(() => {
    useViewerStore.getState().resetProjectData();
  });

  it("empty cache → [] (never undefined — old always-an-array store-field parity)", () => {
    const qc = new QueryClient();
    expect(readTakeoffItems(qc, "nowhere")).toEqual([]);
  });

  it("seeded → the live rows under that publicId", () => {
    const qc = new QueryClient();
    const items = [item({ id: 1, name: "Door" })];
    seedTakeoffCache(qc, "p-A", items, []);
    expect(readTakeoffItems(qc, "p-A")).toEqual(items);
    expect(readTakeoffItems(qc, "p-B")).toEqual([]);
  });

  it("SYNC read-after-write in the SAME tick: a facade write is bridge-visible before any notify flush", () => {
    // AnnotationOverlay's handler-time reads (savePolygon, split-accept, bucket-fill pre-select…)
    // run synchronously after facade writes elsewhere in the same interaction. getQueryData reads
    // the live cache — only the REACT notification defers by a setTimeout(0) task (D1).
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    seedTakeoffCache(client, "p-A", [], []);
    const { result } = renderHook(useBoth, { wrapper: makeWrapper(client) });

    act(() => {
      result.current.items.addTakeoffItem(item({ id: 42, name: "Fresh" }));
      // same synchronous tick — deliberately BEFORE the setTimeout(0) notify:
      expect(readTakeoffItems(client, "p-A").map((t) => t.id)).toContain(42);
    });
  });
});
