// [refactor jul10 P2.2⑤] ANNOTATION-GROUPS MIGRATION FREEZE NET, part 1/3 — GroupActionsBar.
//
// Written GREEN against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte
// after the annotation-groups domain (groups + M:N membership indexes) migrates to the TanStack
// Query cache (variant b, eager-loader-seeded — P2_DESIGN/ANNGROUPS_IMPL/SPEC.md is
// authoritative). The single sanctioned divergence point is the SHARED `seedAnnotationGroups`
// helper (src/test/seed-annotation-groups.ts); annotation rows ride the SHARED `seedAnnotations`
// helper (⑥ owns ITS flip). Every test body here stays identical across the C3 flip.
//
// WHAT THESE CASES ARE (SPEC §6.2 G-rows): GroupActionsBar's writes are ALL server-first with
// alert error UX — create (:56-92, full membership-index rebuild post-POST), add-to-existing
// (:94-119, dup-guarded rebuild), edit (:131-152, NO canPersist guard — do NOT add one), and
// the cross-domain mass-delete (:154-168, annotations removed via ⑥-zustand removeAnnotation;
// group indexes deliberately NOT pruned). Pinning the per-site ordering + error channels blocks
// a future uniform useMutation/rollback conversion (GROUPS-W1 — parked, owner sign-off) from
// landing silently (SPEC §5 tail tripwires).
//
// Ordering-pin idiom (④ §6.3, MANDATORY VERBATIM): every server-first pin anchors past the RQ
// notify horizon — waitFor on the MOCK call + one drained turn + a POSITIVE pre-release signal —
// because a naive fire→assert-absent false-passes post-migration (RQ notifies on a setTimeout(0)
// macrotask). Same-tick DOM asserts after writes are BANNED; post-write reads go through waitFor.
//
// Backing-agnostic discipline: NO assert reads getState().annotationGroups /
// .annotationGroupMemberships / .groupMembers (those store fields are DELETED in the C3 migrate
// commit). Membership-index effects are observed through the PROBE below; store asserts are
// limited to fields that STAY zustand in ⑤: selectedAnnotationIds (selection UI state) and
// annotations (domain ⑥ — the ⑥ migration owns revisiting those asserts, ④ precedent).
//
// THE PROBE: a renderHook(useMultiSelectInteraction) mounted alongside the bar, sharing the same
// QueryClientProvider `qc`. Pre-migration it reads the module-singleton zustand store (same one
// the bar writes); post-migration it reads the shared cache — the SAME production read path
// AnnotationOverlay uses, and it reproduces the always-mounted-observer topology (SPEC §1.2).
// `getGroupOutlineColor(annId)` is the backing-agnostic membership witness: non-null iff the
// forward index holds a pair into an ACTIVE, colored group.
//
// Harness (SPEC §6.2): TWO mock channels, never conflated — ALL GroupActionsBar writes ride the
// persistFetch module mock (importOriginal spread); raw global fetch stays FAIL-LOUD for the
// whole file (doubles, post-migration, as the zero-GETs pin: the facade's queryFn rides raw
// fetch and must never run — E5). window.alert IS frozen failure-path behavior here (contrast
// ViewAllPanel's console-only channel — the split is pinned in part 2/3). QueryClientProvider is
// in the wrapper NOW so the C3 flip needs zero churn (chat/④ precedent). jest-dom per file.
// AnnotationOverlay is NEVER mounted (canvas — its read path rides the probe + C2 hook suite +
// perf protocol).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, renderHook, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { persistFetch } from "@/lib/client-persist";
import { useMultiSelectInteraction } from "@/hooks/useMultiSelectInteraction";
import type { AnnotationGroup, ClientAnnotation } from "@/types";
import GroupActionsBar from "../GroupActionsBar";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: vi.fn() };
});
const persistFetchMock = vi.mocked(persistFetch);

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Controllable promise for the mock-call-anchored interleaving pins (④ idiom).
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
function ann(id: number): ClientAnnotation {
  return { id, pageNumber: 1, name: `ann-${id}`, bbox: [0, 0, 0.1, 0.1], note: null, source: "user", data: null };
}

// Backing-agnostic membership probe (see file header). Mount AFTER render() so cleanup order
// is irrelevant; reads always go through waitFor after writes (RQ notify is a macrotask).
function mountProbe() {
  return renderHook(() => useMultiSelectInteraction(), { wrapper });
}

const GROUP_NAME_PLACEHOLDER = "e.g. Division 08 doors, Tree protection group...";

const fetchMock = vi.fn();
const alertMock = vi.fn();

beforeEach(() => {
  // PURE-DEFAULTS client, matching production (Providers.tsx has no defaultOptions) — freeze
  // nets run against production-equivalent client defaults (③ DETECTOR-closer rationale).
  qc = new QueryClient();
  useViewerStore.getState().resetProjectData();
  // Store-bleed guards: resetProjectData clears `annotations` but NOT `selectedAnnotationIds`
  // (never in the reset block) and NOT the three group fields (the E3 reset omission — frozen,
  // do not "fix" the store). Selection resets here; groups reset through the seed helper so the
  // guard itself survives the C3 flip (post-flip it seeds an empty cache entry instead).
  useViewerStore.setState({ publicId: "pid", isDemo: false, selectedAnnotationIds: new Set<number>() });
  seedAnnotationGroups(qc, [], []); // AFTER publicId — the post-flip cache key derives from it
  fetchMock.mockReset();
  // fail-loud: NO GroupActionsBar write rides raw fetch (all persistFetch). Post-migration this
  // is also the zero-GETs tripwire — the groups queryFn must never run (SPEC §5-E5).
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in anngroups freeze test: ${url}`);
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

// ─── G-1: create group is SERVER-FIRST + full index rebuild + clearSelection ─────────────────

describe("GroupActionsBar — create group is server-first with full membership rebuild (G-1)", () => {
  it("dialog open+busy while POST pending; server row + rebuilt indexes land; selection clears (bar unmounts)", async () => {
    // Pre-existing group+membership: the create flow's rebuild loop (:72-78) must CARRY these
    // over — a rebuild that drops old pairs fails the (10)→"#ff0000" post-release assert.
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Existing", color: "#ff0000" })], [{ annotationId: 10, groupId: 1 }]);
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<GroupActionsBar />, { wrapper });
    const probe = mountProbe();

    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    fireEvent.change(screen.getByPlaceholderText(GROUP_NAME_PLACEHOLDER), { target: { value: "Doors" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // ── ④ §6.3 mock-call-anchored idiom (server-first) ──
    // body pin: POST carries the PUBLIC id + the selected ids in Set-insertion order
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/annotation-groups", {
        projectId: "pid",
        name: "Doors",
        notes: null, // "" trimmed → null (:63)
        csiCode: null,
        color: null,
        annotationIds: [20, 21],
      }),
    );
    await act(async () => {}); // belt: drain one more turn past the notify horizon
    // positive pre-release signals: dialog STILL open with the typed name; bar busy-disabled
    expect(screen.getByDisplayValue("Doors")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Group" })).toBeDisabled();
    expect(screen.getByText("2 selected")).toBeInTheDocument(); // clearSelection not yet run (:85 post-await)
    // NOW meaningful: no membership written yet (server-first), old membership untouched
    expect(probe.result.current.getGroupOutlineColor(20)).toBeNull();
    expect(probe.result.current.getGroupOutlineColor(10)).toBe("#ff0000");

    d.resolve({ group: grp({ id: 2, name: "Doors", color: "#00ff00" }) });

    // clearSelection ran → count < 2 → the whole bar (and its dialog) unmounts (:51-52)
    await waitFor(() => expect(screen.queryByText("2 selected")).not.toBeInTheDocument());
    expect(useViewerStore.getState().selectedAnnotationIds.size).toBe(0); // selection stays zustand in ⑤
    // full-rebuild effect (:69→:78): new pairs for BOTH selected ids AND the pre-existing pair
    await waitFor(() => expect(probe.result.current.getGroupOutlineColor(20)).toBe("#00ff00"));
    expect(probe.result.current.getGroupOutlineColor(21)).toBe("#00ff00");
    expect(probe.result.current.getGroupOutlineColor(10)).toBe("#ff0000"); // survived the rebuild
    expect(fetchMock).not.toHaveBeenCalled(); // raw channel silent (channel-conflation guard)
  });
});

// ─── G-2: create failure — alert channel, dialog STAYS OPEN, nothing written ─────────────────

describe("GroupActionsBar — create rejection alerts and keeps the dialog open (G-2)", () => {
  it("alert 'Failed to create group:'; dialog + fields + selection intact; no group landed", async () => {
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<GroupActionsBar />, { wrapper });
    const probe = mountProbe();

    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    fireEvent.change(screen.getByPlaceholderText(GROUP_NAME_PLACEHOLDER), { target: { value: "Doors" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to create group: boom"));
    // setShowCreateDialog(false) is INSIDE try (:80) — never reached → dialog stays open for retry
    expect(screen.getByDisplayValue("Doors")).toBeInTheDocument();
    expect(screen.getByText("2 selected")).toBeInTheDocument(); // selection kept
    // no group landed: "Add to…" still disabled (annotationGroups empty) + no membership
    expect(screen.getByRole("button", { name: "Add to…" })).toBeDisabled();
    expect(probe.result.current.getGroupOutlineColor(20)).toBeNull();
  });
});

// ─── G-3: add-to-existing is SERVER-FIRST (members POST → rebuild → clearSelection) ─────────

describe("GroupActionsBar — add-to-existing is server-first (G-3)", () => {
  it("picker stays open while POST pending; membership lands post-resolve; selection clears", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Existing", color: "#ff0000" })], [{ annotationId: 10, groupId: 1 }]);
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<GroupActionsBar />, { wrapper });
    const probe = mountProbe();

    fireEvent.click(screen.getByRole("button", { name: "Add to…" }));
    fireEvent.click(await screen.findByTitle("Add 2 to “Existing”"));

    // ── anchored idiom: members POST in flight ──
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/annotation-groups/1/members", {
        annotationIds: [20, 21],
      }),
    );
    await act(async () => {});
    // positive pre-release signal: picker STILL open (setShowAddPicker(false) is post-await :111)
    expect(screen.getByText("Add 2 to existing group")).toBeInTheDocument();
    expect(probe.result.current.getGroupOutlineColor(20)).toBeNull(); // server-first: nothing yet

    d.resolve({ success: true, addedCount: 2 });

    await waitFor(() => expect(screen.queryByText("2 selected")).not.toBeInTheDocument()); // clearSelection → bar unmounts
    await waitFor(() => expect(probe.result.current.getGroupOutlineColor(20)).toBe("#ff0000"));
    expect(probe.result.current.getGroupOutlineColor(21)).toBe("#ff0000");
    expect(probe.result.current.getGroupOutlineColor(10)).toBe("#ff0000"); // pre-existing pair survives the rebuild (:100-104)
  });

  it("rejection: alert 'Failed to add to group:'; picker stays open; selection kept", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Existing", color: "#ff0000" })], []);
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<GroupActionsBar />, { wrapper });
    const probe = mountProbe();

    fireEvent.click(screen.getByRole("button", { name: "Add to…" }));
    fireEvent.click(await screen.findByTitle("Add 2 to “Existing”"));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to add to group: boom"));
    expect(screen.getByText("Add 2 to existing group")).toBeInTheDocument(); // picker open (post-await close never ran)
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(probe.result.current.getGroupOutlineColor(20)).toBeNull(); // nothing written
  });
});

// ─── G-4: GAB edit — server-first PUT, ALERT error channel, dialog-stays-open pin ────────────
// NOTE (frozen quirk, SPEC verdict 9): handleEditSave (:131) has NO canPersist guard — inert in
// demo only EMERGENTLY (demo groups always empty → no picker rows → unreachable). Documented
// unreachable-surface exclusion; do NOT add a guard, do NOT extend G-6 to this path.

describe("GroupActionsBar — edit saves the SERVER row via the alert channel (G-4)", () => {
  it("PUT body carries the edited fields; resolved server row is upserted (replace, not append)", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Existing", color: "#ff0000" })], []);
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<GroupActionsBar />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Add to…" }));
    fireEvent.click(await screen.findByLabelText("Edit group Existing")); // picker closes, edit dialog opens
    const nameInput = await screen.findByDisplayValue("Existing");
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // ── anchored idiom ──
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith(
        "/api/annotation-groups/1",
        { name: "Renamed", notes: null, csiCode: null, color: "#ff0000", isActive: true },
        "PUT",
      ),
    );
    await act(async () => {});
    // positive pre-release signal: edit dialog STILL open (setEditingGroup(null) is post-await :145)
    expect(screen.getByDisplayValue("Renamed")).toBeInTheDocument();

    // marker field: the SERVER's row (different name) must land — :143 upserts data.group verbatim
    d.resolve({ group: grp({ id: 1, name: "SRV-EDITED", color: "#ff0000" }) });

    await waitFor(() => expect(screen.queryByDisplayValue("Renamed")).not.toBeInTheDocument()); // dialog closed
    // re-open the picker: the SERVER name is listed and the old row is REPLACED (findIndex upsert)
    fireEvent.click(screen.getByRole("button", { name: "Add to…" }));
    await waitFor(() => expect(screen.getByText("SRV-EDITED")).toBeInTheDocument());
    expect(screen.queryByText("Existing")).not.toBeInTheDocument();
  });

  it("rejection: alert 'Failed to save group:' (GAB channel — contrast VAP console-only) + dialog stays open", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Existing", color: "#ff0000" })], []);
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    persistFetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<GroupActionsBar />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Add to…" }));
    fireEvent.click(await screen.findByLabelText("Edit group Existing"));
    const nameInput = await screen.findByDisplayValue("Existing");
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith("Failed to save group: boom"));
    expect(screen.getByDisplayValue("Renamed")).toBeInTheDocument(); // dialog stays open (:145 inside try)
  });
});

// ─── G-5: mass delete — cross-domain sweep; group indexes NOT pruned (stale-but-harmless) ────

describe("GroupActionsBar — mass delete sweeps ⑥-zustand annotations, indexes stay stale (G-5)", () => {
  it("server-first batch-delete; annotations removed; membership indexes NOT pruned; selection clears", async () => {
    seedAnnotations(qc, [ann(10), ann(20), ann(21)]);
    seedAnnotationGroups(
      qc,
      [grp({ id: 1, name: "Existing", color: "#ff0000" })],
      [
        { annotationId: 10, groupId: 1 },
        { annotationId: 20, groupId: 1 },
      ],
    );
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    const d = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(d.promise);
    render(<GroupActionsBar />, { wrapper });
    const probe = mountProbe();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));

    // ── anchored idiom: DELETE in flight, nothing removed yet ──
    await waitFor(() =>
      expect(persistFetchMock).toHaveBeenCalledWith("/api/annotations/batch-delete", {
        projectId: "pid",
        annotationIds: [20, 21],
      }),
    );
    await act(async () => {});
    // positive pre-release signal: confirm modal busy-spinner text (:358)
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeInTheDocument();
    expect(useViewerStore.getState().annotations).toHaveLength(3); // server-first: no sweep yet

    d.resolve({ success: true });

    // annotations swept via ⑥-zustand removeAnnotation (:159); non-selected survivor kept
    await waitFor(() => expect(useViewerStore.getState().annotations.map((a) => a.id)).toEqual([10]));
    await waitFor(() => expect(screen.queryByText("2 selected")).not.toBeInTheDocument()); // clearSelection → bar unmounts
    // THE stale-index pin (SPEC §6.2 G-5): the deleted annotation's membership pair is NOT
    // pruned client-side — server FK cascades junctions; the draw loop keys on live
    // pageAnnotations so the stale pair is harmless. A future "cleanup" that prunes indexes
    // here is a behavior change and must fail THIS assert.
    expect(probe.result.current.getGroupOutlineColor(20)).toBe("#ff0000"); // stale-but-harmless
    expect(probe.result.current.getGroupOutlineColor(10)).toBe("#ff0000"); // live member untouched
  });
});

// ─── G-6: demo inertness — the THREE canPersist-guarded sites only ───────────────────────────
// The four UNGUARDED PUT sites (GAB-edit :131, VAP-edit/toggle/bulk) are unreachable-surface
// exclusions: production demo groups are ALWAYS empty (demo loader never seeds groups), so no
// picker/panel row exists to click. This test seeds a demo group ONLY to make the guarded
// add-to-existing path clickable — do NOT extend it to the edit pencil: that path WOULD fire a
// real PUT (the documented tripwire, SPEC §7.1).

describe("GroupActionsBar — demo never writes at the three guarded sites (G-6)", () => {
  it("create / add-to-existing / mass-delete: zero calls on BOTH channels, state untouched", async () => {
    useViewerStore.setState({ isDemo: true });
    seedAnnotations(qc, [ann(10), ann(20), ann(21)]);
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Demo Group", color: "#ff0000" })], []);
    useViewerStore.setState({ selectedAnnotationIds: new Set([20, 21]) });
    render(<GroupActionsBar />, { wrapper });

    // create attempt: canPersist (:57) returns before setBusy — dialog just sits there
    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    fireEvent.change(screen.getByPlaceholderText(GROUP_NAME_PLACEHOLDER), { target: { value: "Doors" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(screen.getByDisplayValue("Doors")).toBeInTheDocument(); // nothing happened
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // add-to-existing attempt (:95)
    fireEvent.click(screen.getByRole("button", { name: "Add to…" }));
    fireEvent.click(await screen.findByTitle("Add 2 to “Demo Group”"));
    await act(async () => {});
    expect(screen.getByText("Add 2 to existing group")).toBeInTheDocument(); // picker still open
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // mass-delete attempt (:155)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    await act(async () => {});
    await act(async () => {});

    expect(useViewerStore.getState().annotations).toHaveLength(3); // no sweep
    expect(screen.getByText("2 selected")).toBeInTheDocument(); // no clearSelection
    expect(persistFetchMock).not.toHaveBeenCalled(); // write channel silent
    expect(fetchMock).not.toHaveBeenCalled(); // raw channel silent (also: zero GETs post-migration)
    expect(alertMock).not.toHaveBeenCalled(); // guards return silently, no error UX
  });
});
