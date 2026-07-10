// [refactor jul10 P2.2⑤] Hook suite for the annotation-groups query facade (variant b,
// eager-loader-seeded) — born CACHE-FORM at C2 (SPEC §6.4; the new code is app-unused until C3).
// P2_DESIGN/ANNGROUPS_IMPL/SPEC.md is authoritative.
//
// WHAT THIS SUITE IS: the E6 identity pins are THE canvas-sacred crux — they enforce
// notification parity (zero added AnnotationOverlay renders) by pinning the §3.2
// sub-reference-memoized derivation profile. Each is mutation-detectable: inline-derive,
// value-replace updaters, a select conversion, and memo-dep widening ALL fail them.
// Config pins enforce E5/E8 (the observer adds NO fetches, ever) behaviorally where possible.
//
// Timing rule (RECIPE gotcha): read post-write state via `await waitFor`, never synchronously
// after bare `act` (RQ notify is a macrotask). Render-count asserts flush via
// `await act(async () => {})` before reading (mock-call-anchored idiom, ④ §6.3).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useAnnotationGroups,
  seedAnnotationGroupsCache,
  deriveGroupIndexes,
  type AnnotationGroupsPayload,
} from "@/queries/useAnnotationGroups";
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import type { AnnotationGroup, AnnotationGroupMembership } from "@/types";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
function freshClient() {
  return new QueryClient(); // pure defaults, matching production Providers.tsx; hook pins its own retry:false
}

function grp(over: Partial<AnnotationGroup> & { id: number; name: string }): AnnotationGroup {
  return {
    projectId: 1,
    csiCode: null,
    notes: null,
    color: null,
    isActive: true,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}
const pair = (annotationId: number, groupId: number): AnnotationGroupMembership => ({
  annotationId,
  groupId,
});

const KEY_P = queryKeys.annotationGroups.all("P");

// Fail-loud fetch: the groups observer must NEVER fetch (E5 — seed + staleTime ∞ + initialData).
// Tests that deliberately force the dormant queryFn (via invalidateQueries) install their own mock.
const fetchMock = vi.fn();

beforeEach(() => {
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({ publicId: "P", isDemo: false });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected fetch in useAnnotationGroups suite: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

// ─── seedAnnotationGroupsCache (the loader write) ────────────────────────────────────────────

describe("seedAnnotationGroupsCache", () => {
  it("seeds the raw payload verbatim under the exact publicId-keyed tuple; other publicIds untouched", () => {
    const client = freshClient();
    const groups = [grp({ id: 1, name: "A" })];
    const memberships = [pair(10, 1)];
    seedAnnotationGroupsCache(client, "P", { groups, memberships });

    expect(client.getQueryData(["project", "P", "annotationGroups"])).toEqual({
      groups,
      memberships,
    });
    expect(client.getQueryData(queryKeys.annotationGroups.all("OTHER"))).toBeUndefined();
  });

  it("E3 failed-GET-clears pin: seed(null) over previously-seeded rows → empty BOTH halves", () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", {
      groups: [grp({ id: 1, name: "A" })],
      memberships: [pair(10, 1)],
    });
    // The loader calls this with null when groupsRes is !ok/unparseable. Old code RETAINED the
    // previously-shown groups on a same-project failed reload — E3c sanctioned clear-on-fail.
    // A conditional-seed regression (skip on null) fails here.
    seedAnnotationGroupsCache(client, "P", null);
    expect(client.getQueryData(KEY_P)).toEqual({ groups: [], memberships: [] });
  });

  it("E3d atomic both-fields: a half-present payload seeds the OTHER half [] (no partial-stale mix)", () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", {
      groups: [grp({ id: 1, name: "A" })],
      memberships: [pair(10, 1)],
    });
    // Old per-field conditionals could retain one stale half; the atomic replace cannot.
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 2, name: "B" })] });
    expect(client.getQueryData(KEY_P)).toEqual({
      groups: [grp({ id: 2, name: "B" })],
      memberships: [],
    });
    seedAnnotationGroupsCache(client, "P", { memberships: [pair(11, 2)] });
    expect(client.getQueryData(KEY_P)).toEqual({ groups: [], memberships: [pair(11, 2)] });
  });
});

// ─── deriveGroupIndexes (the old hydrateGroupMemberships loop, exported for unit pins) ───────

describe("deriveGroupIndexes", () => {
  it("builds BOTH directions: forward annId→Set<groupId> and reverse groupId→Set<annId> (M:N)", () => {
    const { annotationGroupMemberships, groupMembers } = deriveGroupIndexes([
      pair(10, 1),
      pair(11, 1),
      pair(10, 2), // ann 10 in two groups — M:N
    ]);
    expect(annotationGroupMemberships[10]).toEqual(new Set([1, 2]));
    expect(annotationGroupMemberships[11]).toEqual(new Set([1]));
    expect(groupMembers[1]).toEqual(new Set([10, 11]));
    expect(groupMembers[2]).toEqual(new Set([10]));
    expect(annotationGroupMemberships[99]).toBeUndefined(); // non-member: absent, not empty Set
  });

  it("duplicate pairs collapse (Set dedup) — the callers' dup-guard stays redundant-safe", () => {
    const { annotationGroupMemberships, groupMembers } = deriveGroupIndexes([
      pair(10, 1),
      pair(10, 1),
    ]);
    expect(annotationGroupMemberships[10]).toEqual(new Set([1]));
    expect(groupMembers[1]).toEqual(new Set([10]));
  });

  it("empty pairs → both records empty (matches the old zustand inits)", () => {
    const out = deriveGroupIndexes([]);
    expect(out.annotationGroupMemberships).toEqual({});
    expect(out.groupMembers).toEqual({});
  });

  it("round-trip order preservation: GroupActionsBar's flatten→derive keeps per-annotation group order, new group LAST (first-group-wins stability)", () => {
    // The create/add handlers flatten the CURRENT forward index via Object.entries × Set
    // iteration, append the new group's pairs, then hydrate — SPEC §3.3 proved the round-trip
    // preserves per-annotation Set insertion order so existing outline colors never flip.
    const initial = deriveGroupIndexes([pair(10, 2), pair(10, 1), pair(20, 1)]);

    // — the GroupActionsBar create-handler flatten idiom, verbatim —
    const pairs: { annotationId: number; groupId: number }[] = [];
    for (const [aidStr, groupSet] of Object.entries(initial.annotationGroupMemberships)) {
      const aid = Number(aidStr);
      for (const gid of groupSet) pairs.push({ annotationId: aid, groupId: gid });
    }
    for (const aid of [10, 30]) pairs.push({ annotationId: aid, groupId: 7 }); // new group 7

    const rebuilt = deriveGroupIndexes(pairs);
    // per-annotation group ORDER preserved: ann 10 still iterates 2-then-1, new group appended last
    expect([...rebuilt.annotationGroupMemberships[10]]).toEqual([2, 1, 7]);
    expect([...rebuilt.annotationGroupMemberships[20]]).toEqual([1]);
    expect([...rebuilt.annotationGroupMemberships[30]]).toEqual([7]);
    expect(rebuilt.groupMembers[7]).toEqual(new Set([10, 30]));
  });
});

// ─── facade reads + writes ───────────────────────────────────────────────────────────────────

describe("useAnnotationGroups — reads and writes", () => {
  it("fresh client: reads initialData-empty on all three fields; success/idle — zero fetches", async () => {
    const { result } = renderHook(() => useAnnotationGroups(), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(result.current.annotationGroups).toEqual([]);
    expect(result.current.annotationGroupMemberships).toEqual({});
    expect(result.current.groupMembers).toEqual({});
    await new Promise((r) => setTimeout(r, 50)); // settle window — a mount fetch would land here
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seed→read round-trip: a pre-mount loader-style seed is what the hook renders, indexes derived", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", {
      groups: [grp({ id: 1, name: "A", color: "#f00" })],
      memberships: [pair(10, 1), pair(11, 1)],
    });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });

    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));
    expect(result.current.annotationGroups[0].name).toBe("A");
    expect(result.current.annotationGroupMemberships[10]).toEqual(new Set([1]));
    expect(result.current.groupMembers[1]).toEqual(new Set([10, 11]));
    expect(fetchMock).not.toHaveBeenCalled(); // E5: no dup GET at reveal
  });

  it("upsert APPEND parity: unknown id appends (findIndex -1 → spread-push, old store verbatim)", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 1, name: "A" })], memberships: [] });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));

    act(() => result.current.upsertAnnotationGroup(grp({ id: 2, name: "B" })));
    await waitFor(() =>
      expect(result.current.annotationGroups.map((g) => g.id)).toEqual([1, 2]),
    );
  });

  it("upsert REPLACE parity: known id replaces IN PLACE (index + order preserved)", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", {
      groups: [grp({ id: 1, name: "A" }), grp({ id: 2, name: "B" })],
      memberships: [],
    });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(2));

    act(() => result.current.upsertAnnotationGroup(grp({ id: 1, name: "A-renamed" })));
    await waitFor(() =>
      expect(result.current.annotationGroups.map((g) => g.name)).toEqual(["A-renamed", "B"]),
    );
    expect(result.current.annotationGroups.map((g) => g.id)).toEqual([1, 2]); // no reorder
  });

  it("hydrate is a raw-pairs REPLACE (old pairs gone, not merged)", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", {
      groups: [grp({ id: 1, name: "A" })],
      memberships: [pair(10, 1)],
    });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.groupMembers[1]).toEqual(new Set([10])));

    act(() => result.current.hydrateGroupMemberships([pair(20, 1)]));
    await waitFor(() => expect(result.current.groupMembers[1]).toEqual(new Set([20])));
    expect(result.current.annotationGroupMemberships[10]).toBeUndefined();
  });

  it("write-into-undefined-entry creates the entry (the `old ?? EMPTY` belt, SPEC §6.4)", async () => {
    const client = freshClient();
    const { result, unmount } = renderHook(() => useAnnotationGroups(), {
      wrapper: makeWrapper(client),
    });
    const captured = result.current.upsertAnnotationGroup; // closed over key("P")
    unmount();
    client.removeQueries({ queryKey: KEY_P, exact: true }); // entry now truly absent

    captured(grp({ id: 5, name: "born-into-void" }));
    expect(client.getQueryData<AnnotationGroupsPayload>(KEY_P)).toEqual({
      groups: [grp({ id: 5, name: "born-into-void" })],
      memberships: [],
    });
  });

  it("CREATE-SEQUENCE pin: upsert→hydrate in ONE sync block leaves BOTH halves present (verdict 5 — fails on value-replace)", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", {
      groups: [grp({ id: 1, name: "existing" })],
      memberships: [pair(10, 1)],
    });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));

    // == GroupActionsBar's create handler post-POST tail: upsert(server group) then
    // hydrate(full rebuilt pairs), same handler, same sync block. A value-replace hydrate
    // (writing a pre-POST snapshot object) would DELETE the just-upserted group.
    act(() => {
      result.current.upsertAnnotationGroup(grp({ id: 2, name: "created" }));
      result.current.hydrateGroupMemberships([pair(10, 1), pair(11, 2), pair(12, 2)]);
    });

    await waitFor(() =>
      expect(result.current.annotationGroups.map((g) => g.id)).toEqual([1, 2]),
    );
    expect(result.current.groupMembers[2]).toEqual(new Set([11, 12]));
    expect(result.current.groupMembers[1]).toEqual(new Set([10])); // carryover intact
  });

  it("rollback verbatim: optimistic upsert then upsert(captured old row) restores it byte-equal (ViewAllPanel toggle-failure path)", async () => {
    const client = freshClient();
    const original = grp({ id: 1, name: "A", isActive: true, color: "#f00" });
    seedAnnotationGroupsCache(client, "P", { groups: [original], memberships: [] });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));

    act(() => result.current.upsertAnnotationGroup({ ...original, isActive: false })); // optimistic
    await waitFor(() => expect(result.current.annotationGroups[0].isActive).toBe(false));

    act(() => result.current.upsertAnnotationGroup(original)); // rollback with the captured `g`
    await waitFor(() => expect(result.current.annotationGroups).toEqual([original]));
  });

  it("two-publicId isolation: switching publicId swaps entries; a write to A never touches B", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "A", { groups: [grp({ id: 1, name: "a1" })], memberships: [] });
    seedAnnotationGroupsCache(client, "B", { groups: [grp({ id: 2, name: "b1" })], memberships: [] });

    useViewerStore.setState({ publicId: "A" });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups.map((g) => g.id)).toEqual([1]));

    act(() => result.current.upsertAnnotationGroup(grp({ id: 7, name: "a2" })));
    await waitFor(() => expect(result.current.annotationGroups.map((g) => g.id)).toEqual([1, 7]));

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(result.current.annotationGroups.map((g) => g.id)).toEqual([2]));
    // A's entry (incl. the client write) retained per-key while B is active
    expect(
      client.getQueryData<AnnotationGroupsPayload>(queryKeys.annotationGroups.all("A"))?.groups.map((g) => g.id),
    ).toEqual([1, 7]);
    expect(fetchMock).not.toHaveBeenCalled(); // switching projects fetches nothing (seeded world)
  });

  it("E2 captured-key pin: an action captured before a project switch writes the OLD key, never the current one", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "A", { groups: [], memberships: [] });
    seedAnnotationGroupsCache(client, "B", { groups: [grp({ id: 2, name: "b1" })], memberships: [] });

    useViewerStore.setState({ publicId: "A" });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toEqual([]));
    const capturedUpsert = result.current.upsertAnnotationGroup; // closed over key("A")

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(result.current.annotationGroups.map((g) => g.id)).toEqual([2]));

    act(() => capturedUpsert(grp({ id: 9, name: "late-landing" }))); // in-flight handler lands "late"

    // B's VIEW is untouched (the old global-singleton store would show the leak here)…
    expect(result.current.annotationGroups.map((g) => g.id)).toEqual([2]);
    // …because the write landed under A's key.
    expect(
      client.getQueryData<AnnotationGroupsPayload>(queryKeys.annotationGroups.all("A"))?.groups.map((g) => g.id),
    ).toEqual([9]);
  });
});

// ─── config pins (E5/E8: the observer adds NO fetches, ever) ─────────────────────────────────

describe("useAnnotationGroups — config", () => {
  it("E5 fetchCount-0: seed+mount fetches NOTHING (no dup GET at reveal; initialData+staleTime ∞+seed)", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 1, name: "A" })], memberships: [] });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("staleTime ∞: a SECOND observer mount (ViewAllPanel-toggle analog) triggers no refetch", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 1, name: "A" })], memberships: [] });
    const first = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(first.result.current.annotationGroups).toHaveLength(1));

    const second = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(second.result.current.annotationGroups).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled(); // qto's staleTime:0 would refetch here — do NOT copy it

    second.unmount();
    const third = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) }); // panel re-open
    await waitFor(() => expect(third.result.current.annotationGroups).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demo: enabled false — zero fetches, reads empty (GET is allowDemo server-side; the gate is the ONLY thing keeping demo groups invisible)", async () => {
    useViewerStore.setState({ isDemo: true });
    const { result } = renderHook(() => useAnnotationGroups(), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(result.current.annotationGroups).toEqual([]);
    expect(result.current.annotationGroupMemberships).toEqual({});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("empty publicId: enabled false — zero fetches, reads empty", async () => {
    useViewerStore.setState({ publicId: "" });
    const { result } = renderHook(() => useAnnotationGroups(), {
      wrapper: makeWrapper(freshClient()),
    });
    expect(result.current.annotationGroups).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no refetch on window focus (E8: the focus-GET-races-optimistic-toggle window stays closed)", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 1, name: "A" })], memberships: [] });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no refetch on reconnect (E8)", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 1, name: "A" })], memberships: [] });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));

    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gcTime ∞: the entry survives a full observer-less day (disabled-variant fake timers, qto §6.4 idiom)", () => {
    // ⚠️ RTL@16 + full fake timers deadlock waitFor — this test uses NO waitFor and a
    // DISABLED query (isDemo → enabled:false) so no fetch/notify races the fake clock.
    vi.useFakeTimers();
    try {
      const client = freshClient();
      useViewerStore.setState({ isDemo: true });
      const payload = { groups: [grp({ id: 1, name: "survivor" })], memberships: [pair(10, 1)] };
      seedAnnotationGroupsCache(client, "P", payload);

      const first = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
      expect(first.result.current.annotationGroups).toHaveLength(1);
      first.unmount(); // GC timer armed (Infinity = never fires)

      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(client.getQueryData<AnnotationGroupsPayload>(KEY_P)?.groups).toHaveLength(1);

      const second = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
      expect(second.result.current.annotationGroups).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("networkMode 'always' + retry:false: a FORCED refetch fires even 'offline' and attempts exactly once", async () => {
    // The queryFn is dormant in production (E5) — invalidateQueries is the only way to run it.
    // Pins fire-and-fail parity: default networkMode 'online' would PAUSE (zero calls) while
    // offline; default retry(3) would re-attempt at +1s (qto DETECTOR closer: the window must
    // outlast query-core's first 1000ms retry delay).
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 1, name: "kept" })], memberships: [] });
    fetchMock.mockImplementation(() => Promise.reject(new Error("down")));
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));

    onlineManager.setOnline(false);
    act(() => {
      void client.invalidateQueries({ queryKey: KEY_P });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // fired despite offline
    await new Promise((r) => setTimeout(r, 1250));
    expect(fetchMock).toHaveBeenCalledTimes(1); // single attempt — no retry
    expect(result.current.annotationGroups).toHaveLength(1); // failed fetch keeps cached rows
  });

  it("dormant queryFn contract: if forced, non-ok resolves to EMPTY (old loader's net 'no groups this open')", async () => {
    const client = freshClient();
    seedAnnotationGroupsCache(client, "P", { groups: [grp({ id: 1, name: "old" })], memberships: [pair(10, 1)] });
    fetchMock.mockImplementation((url: unknown) => {
      // the ONE sanctioned route — anything else stays fail-loud
      if (!String(url).startsWith("/api/annotation-groups?projectId=P")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(1));

    act(() => {
      void client.invalidateQueries({ queryKey: KEY_P });
    });
    await waitFor(() => expect(result.current.annotationGroups).toEqual([]));
    expect(result.current.annotationGroupMemberships).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── E6 identity pins (THE canvas-sacred crux — notification/identity parity, SPEC §3.2) ─────

describe("useAnnotationGroups — E6 identity profile", () => {
  const seedBase = (client: QueryClient) =>
    seedAnnotationGroupsCache(client, "P", {
      groups: [grp({ id: 1, name: "A", color: "#f00" }), grp({ id: 2, name: "B" })],
      memberships: [pair(10, 1), pair(11, 1), pair(10, 2)],
    });

  it("E6-1: unrelated-key write → ZERO notifications; host rerender → ALL identities unchanged (catches inline-derive/select conversions)", async () => {
    const client = freshClient();
    seedBase(client);
    let renders = 0;
    const { result, rerender } = renderHook(
      () => {
        renders++;
        return useAnnotationGroups();
      },
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(2));

    const before = result.current;
    const rendersBefore = renders;

    // unrelated-key write (a takeoff facade write on the same client — the real adjacency)
    act(() => {
      client.setQueryData(queryKeys.takeoff.items("P"), [{ id: 1 }]);
    });
    await act(async () => {}); // flush RQ's setTimeout(0) notify, if any were scheduled
    expect(renders).toBe(rendersBefore); // per-key observers + tracked props: NOT notified

    rerender(); // host rerender, no data change
    expect(result.current.annotationGroups).toBe(before.annotationGroups);
    expect(result.current.annotationGroupMemberships).toBe(before.annotationGroupMemberships);
    expect(result.current.groupMembers).toBe(before.groupMembers);
  });

  it("E6-2: groups-only upsert → Set-index identities PRESERVED, annotationGroups fresh (catches value-replace + memo-dep widening)", async () => {
    const client = freshClient();
    seedBase(client);
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(2));

    const groupsBefore = result.current.annotationGroups;
    const fwdBefore = result.current.annotationGroupMemberships;
    const revBefore = result.current.groupMembers;

    // the eye-toggle/rename shape: touches ONLY the groups half
    act(() => result.current.upsertAnnotationGroup(grp({ id: 2, name: "B-renamed" })));
    await waitFor(() => expect(result.current.annotationGroups[1].name).toBe("B-renamed"));

    expect(result.current.annotationGroups).not.toBe(groupsBefore); // fresh (old-world parity)
    // memberships sub-reference untouched → memo skipped → Set indexes keep IDENTITY
    expect(result.current.annotationGroupMemberships).toBe(fwdBefore);
    expect(result.current.groupMembers).toBe(revBefore);
  });

  it("E6-3: memberships-only hydrate → annotationGroups identity PRESERVED, indexes re-derived correctly", async () => {
    const client = freshClient();
    seedBase(client);
    const { result } = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(2));

    const groupsBefore = result.current.annotationGroups;
    act(() => result.current.hydrateGroupMemberships([pair(20, 2)]));
    await waitFor(() => expect(result.current.groupMembers[2]).toEqual(new Set([20])));

    expect(result.current.annotationGroups).toBe(groupsBefore); // groups half untouched
    expect(result.current.annotationGroupMemberships[10]).toBeUndefined(); // replace, not merge
  });

  it("E6-4: byte-identical reseed (poll returning unchanged data) → zero notifications, full identity unchanged (E4)", async () => {
    const client = freshClient();
    seedBase(client);
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useAnnotationGroups();
      },
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => expect(result.current.annotationGroups).toHaveLength(2));

    const before = result.current;
    const rendersBefore = renders;

    // the ProcessingView poll shape: load() re-fires and re-seeds identical bytes
    act(() => seedBase(client)); // fresh objects, equal content → replaceEqualDeep dedups at raw level
    await act(async () => {});

    expect(renders).toBe(rendersBefore); // ZERO observer notifications
    expect(result.current.annotationGroups).toBe(before.annotationGroups);
    expect(result.current.annotationGroupMemberships).toBe(before.annotationGroupMemberships);
    expect(result.current.groupMembers).toBe(before.groupMembers);
  });

  it("E6-5: derivation multiplicity — once per MOUNTED CONSUMER per memberships change, never per-render", async () => {
    const client = freshClient();
    seedBase(client);
    // two always-mounted-consumer analogs (AnnotationOverlay-via-hook + GroupActionsBar)
    const a = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    const b = renderHook(() => useAnnotationGroups(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(a.result.current.annotationGroups).toHaveLength(2));
    await waitFor(() => expect(b.result.current.annotationGroups).toHaveLength(2));

    act(() => a.result.current.hydrateGroupMemberships([pair(30, 1)]));
    await waitFor(() => expect(a.result.current.groupMembers[1]).toEqual(new Set([30])));
    await waitFor(() => expect(b.result.current.groupMembers[1]).toEqual(new Set([30])));

    // per-consumer memo caches: each mounted consumer derives its OWN index objects…
    expect(a.result.current.groupMembers).not.toBe(b.result.current.groupMembers);

    // …and the memo holds across subsequent host rerenders (an inline-derive regression would
    // mint fresh identities every render and fail these)
    const aIdx = a.result.current.groupMembers;
    const bIdx = b.result.current.groupMembers;
    a.rerender();
    b.rerender();
    expect(a.result.current.groupMembers).toBe(aIdx);
    expect(b.result.current.groupMembers).toBe(bIdx);
  });
});
