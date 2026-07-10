// [refactor jul10 P2.2⑤] ANNOTATION-GROUPS MIGRATION FREEZE NET, part 2/3 — ViewAllPanel
// groups section.
//
// Written GREEN against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte
// after the annotation-groups domain migrates to the TanStack Query cache
// (P2_DESIGN/ANNGROUPS_IMPL/SPEC.md). Single sanctioned divergence point: the SHARED
// `seedAnnotationGroups` helper; annotation rows ride `seedAnnotations` (⑥ owns its flip).
// See GroupActionsBarFreeze.test.tsx for the full doctrine header (anchored-ordering idiom,
// backing-agnostic asserts, probe rationale); this file adds the VAP-specific pins:
//
//  - CHANNEL SPLIT (SPEC §6.2 V-2): ALL ViewAllPanel group writes ride RAW global fetch
//    (:239/:266/:285) — persistFetch is NOT involved — and every VAP failure is CONSOLE-ONLY
//    (no window.alert). GroupActionsBar is the opposite on both counts. A future "unify the
//    error UX / persistence helper" drive-by must fail loudly here.
//  - ADOPT-vs-IGNORE ASYMMETRY (V-3 vs V-5): the SINGLE eye toggle re-upserts the server's
//    response row on ok (:273); the BULK toggle never reads response bodies (:294). Both are
//    FROZEN (GROUPS-W1 tier-2 unification is parked, owner sign-off required).
//  - BOTH bulk rollback branches (V-5): fulfilled-!ok AND rejected each roll back their own
//    group (:292-297); a reject-only mock would leave the !ok half untested.
//  - MASTER-EYE ADJACENCY (SPEC §6.2 V-6 / §8.6): the panel-header master eye ALSO drives
//    group PUTs through setGroupsActiveBulk (snapshot/restore, :193-203). Every case here
//    scopes eye clicks to the Groups SECTION header or a group ROW — never the master eye.
//    The master-eye path rides V-5's per-item semantics untested (unchanged shared helper) —
//    flagged for phase-end review, do not add cases casually.
//  - Demo inertness is NOT pinned here: all four VAP write sites are UNGUARDED and inert only
//    emergently (demo groups always empty — unreachable-surface exclusions, SPEC §7.1 tripwire).
//
// Known pre-existing nested-<button> React warning on TreeSection headers (④ §8.7) — do NOT
// fix, do NOT assert console cleanliness. console.error is spied (VAP's failure channel) and
// asserted by MESSAGE PREFIX only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import type { AnnotationGroup, ClientAnnotation } from "@/types";
import ViewAllPanel from "../ViewAllPanel";

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

// Row-scoping helpers. The group-name button carries title={g.name}; its parent div is the row
// (name/csi/count-badge/eye/pencil all siblings inside it). Re-query per use — rows remount on
// group writes.
const rowFor = (name: string) => screen.getByTitle(name).parentElement as HTMLElement;
// The Groups SECTION header button (TreeSection) — hosts the section eye. NEVER the master eye.
const groupsHeader = () => screen.getByText("Groups").closest("button") as HTMLElement;

function expandGroupsSection() {
  fireEvent.click(screen.getByText("Groups"));
}

const fetchMock = vi.fn();
const alertMock = vi.fn();
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

// Route PUTs per group id; everything else (incl. any post-migration domain GET — SPEC §5-E5)
// stays fail-loud. Returns the RequestInit list for body pins.
function mockGroupPuts(routes: Record<number, Promise<unknown>>) {
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    const m = /^\/api\/annotation-groups\/(\d+)$/.exec(String(url));
    if (m && init?.method === "PUT" && Number(m[1]) in routes) return routes[Number(m[1])];
    throw new Error(`unexpected raw fetch in anngroups freeze test: ${url}`);
  });
}

beforeEach(() => {
  qc = new QueryClient(); // pure defaults, matching production Providers.tsx
  useViewerStore.getState().resetProjectData();
  // Store-bleed guards — see GroupActionsBarFreeze beforeEach for the rationale (selection +
  // group fields are NOT in resetProjectData; hiddenTakeoffItemIds guard per ④ precedent).
  useViewerStore.setState({
    publicId: "pid",
    isDemo: false,
    selectedAnnotationIds: new Set<number>(),
    hiddenTakeoffItemIds: new Set<number>(),
  });
  seedAnnotationGroups(qc, [], []); // AFTER publicId
  seedAnnotations(qc, []);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in anngroups freeze test: ${url}`);
  });
  alertMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
  // VAP's failure channel — swallow output, assert by prefix. Also mutes the known
  // nested-<button> warning; console cleanliness is explicitly NOT asserted (④ §8.7).
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── V-1: render — inactive styling, csi badge, memberCount from the live-annotation join ────

describe("ViewAllPanel groups — seeded groups render with badges and inactive styling (V-1)", () => {
  it("csi badge, live-join member count (dangling pair dropped), (inactive) tag + eye states", async () => {
    seedAnnotations(qc, [ann(100), ann(101), ann(102)]);
    seedAnnotationGroups(
      qc,
      [
        grp({ id: 1, name: "Group A", color: "#ff0000", csiCode: "08 11 13" }),
        grp({ id: 2, name: "Group B", isActive: false }),
      ],
      [
        { annotationId: 100, groupId: 1 },
        { annotationId: 101, groupId: 1 },
        { annotationId: 102, groupId: 1 },
        // dangling pair: annotation 103 does NOT exist — the member badge is a LIVE join
        // against ⑥ annotations (ViewAllPanel:775-779), not the raw index size → stays 3.
        { annotationId: 103, groupId: 1 },
      ],
    );
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    expect(within(rowA).getByText("08 11 13")).toBeInTheDocument(); // csi badge (:807-808)
    expect(within(rowA).getByText("3")).toBeInTheDocument(); // memberCount badge (:810-812)
    expect(within(rowA).queryByText("(inactive)")).toBeNull();
    expect(within(rowA).getByLabelText("Hide")).toBeInTheDocument(); // active → eye offers Hide

    const rowB = rowFor("Group B");
    expect(within(rowB).getByText("(inactive)")).toBeInTheDocument(); // inactive styling (:803-805)
    expect(within(rowB).getByLabelText("Show")).toBeInTheDocument(); // inactive → eye offers Show
    expect(within(groupsHeader()).getByText("2")).toBeInTheDocument(); // section count = groups, not members
    expect(fetchMock).not.toHaveBeenCalled(); // render is read-only (and no domain GET post-migration)
  });
});

// ─── V-2: edit — raw-fetch PUT, server row adopted, CONSOLE-ONLY failure channel ─────────────

describe("ViewAllPanel groups — edit saves via raw fetch and adopts the server row (V-2)", () => {
  it("PUT body carries edited fields; dialog open while pending; server-marker name lands", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], []);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByTitle("Edit group"));
    const nameInput = await screen.findByDisplayValue("Group A");
    fireEvent.change(nameInput, { target: { value: "Group B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // ── anchored idiom (server-first: no upsert until the PUT resolves) ──
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/annotation-groups/1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Group B",
      notes: null,
      csiCode: null,
      color: "#ff0000",
      isActive: true,
    });
    await act(async () => {});
    expect(screen.getByDisplayValue("Group B")).toBeInTheDocument(); // dialog STILL open (:253 post-await)
    expect(screen.getByTitle("Group A")).toBeInTheDocument(); // row not yet renamed

    // marker field: server responds with a DIFFERENT name — :252 upserts data.group verbatim
    d.resolve({ ok: true, json: async () => ({ group: grp({ id: 1, name: "SRV-EDITED", color: "#ff0000" }) }) });

    await waitFor(() => expect(screen.getByTitle("SRV-EDITED")).toBeInTheDocument()); // adopted
    expect(screen.queryByTitle("Group A")).not.toBeInTheDocument(); // replaced, not appended
    expect(screen.queryByDisplayValue(/Group B|SRV-EDITED/)).not.toBeInTheDocument(); // dialog closed
  });

  it("rejection: CONSOLE-ONLY (no alert — the channel-split pin vs GAB) + dialog stays open", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], []);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByTitle("Edit group"));
    const nameInput = await screen.findByDisplayValue("Group A");
    fireEvent.change(nameInput, { target: { value: "Group B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    d.reject(new Error("boom"));

    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith("[ViewAllPanel] Edit group failed:", expect.any(Error)),
    );
    expect(alertMock).not.toHaveBeenCalled(); // VAP failures NEVER alert (:255)
    expect(screen.getByDisplayValue("Group B")).toBeInTheDocument(); // dialog stays open (:253 inside try)
    expect(screen.getByTitle("Group A")).toBeInTheDocument(); // no upsert happened
  });
});

// ─── V-3: single eye toggle — OPTIMISTIC flip, server row ADOPTED on ok (:273) ───────────────

describe("ViewAllPanel groups — single toggle is optimistic and ADOPTS the server row (V-3)", () => {
  it("(inactive) visible while PUT pending; ok response's marker name lands (adopt, contrast V-5)", async () => {
    seedAnnotations(qc, [ann(100)]);
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], [{ annotationId: 100, groupId: 1 }]);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByLabelText("Hide")); // active → toggling hides (isActive:false)

    // optimistic pin: the flip is visible while the deferred PUT is STILL pending (:264 pre-await)
    await waitFor(() => expect(screen.getByText("(inactive)")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/annotation-groups/1");
    expect(JSON.parse(String(init.body))).toEqual({ isActive: false }); // isActive-only body (:269)

    d.resolve({
      ok: true,
      json: async () => ({ group: grp({ id: 1, name: "SRV-MARKER", color: "#ff0000", isActive: false }) }),
    });

    // ok path RE-UPSERTS the server row (:273) — the marker name must surface
    await waitFor(() => expect(screen.getByTitle("SRV-MARKER")).toBeInTheDocument());
    expect(screen.getByText("(inactive)")).toBeInTheDocument(); // still inactive
    expect(alertMock).not.toHaveBeenCalled();
  });
});

// ─── V-4: single eye toggle failure — ROLLBACK to the captured row (:276), console-only ──────

describe("ViewAllPanel groups — single toggle rejection rolls back (V-4)", () => {
  it("optimistic (inactive) reverts to the captured pre-toggle row; console-only", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], []);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByLabelText("Hide"));

    await waitFor(() => expect(screen.getByText("(inactive)")).toBeInTheDocument()); // optimistic flip held while pending

    d.reject(new Error("boom"));

    // ROLLBACK pin: upsert(captured g) restores the ACTIVE row (:276) — deleting the rollback
    // line leaves "(inactive)" in the DOM and fails here (DETECTOR mutation §8.1).
    await waitFor(() => expect(screen.queryByText("(inactive)")).not.toBeInTheDocument());
    expect(screen.getByTitle("Group A")).toBeInTheDocument();
    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith("[ViewAllPanel] Toggle group active failed:", expect.any(Error)),
    );
    expect(alertMock).not.toHaveBeenCalled(); // console-only channel
  });
});

// ─── V-5: bulk toggle, mixed outcomes — BOTH rollback branches + response bodies IGNORED ─────

describe("ViewAllPanel groups — bulk toggle rolls back per-item and IGNORES bodies (V-5)", () => {
  it("[ok, fulfilled-!ok, rejected]: only the ok group stays flipped; no body adoption; fully silent", async () => {
    seedAnnotationGroups(
      qc,
      [grp({ id: 1, name: "G1" }), grp({ id: 2, name: "G2" }), grp({ id: 3, name: "G3" })],
      [],
    );
    const d1 = deferred<unknown>();
    const d2 = deferred<unknown>();
    const d3 = deferred<unknown>();
    mockGroupPuts({ 1: d1.promise, 2: d2.promise, 3: d3.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();
    await screen.findByTitle("G1");

    // the Groups SECTION eye — all three active → "Hide" → setGroupsActiveBulk(…, false).
    // Scoped to the section header: the panel MASTER eye drives the same helper through the
    // snapshot/restore path and must stay out of this case (V-6 adjacency note, file header).
    fireEvent.click(within(groupsHeader()).getByLabelText("Hide"));

    // optimistic pin: ALL THREE flip while every PUT is still pending (:282 pre-allSettled)
    await waitFor(() => expect(screen.getAllByText("(inactive)")).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(JSON.parse(String(call[1].body))).toEqual({ isActive: false });
    }

    // mixed settlement — BOTH rollback branches of :292-297 must fire:
    d1.resolve({
      ok: true, // stays flipped; body must be IGNORED (bulk never reads json — :294 asymmetry vs V-3)
      json: async () => ({ group: grp({ id: 1, name: "SRV-MARKER", isActive: false }) }),
    });
    d2.resolve({ ok: false }); // fulfilled-!ok → rollback (a reject-only mock leaves this half untested)
    d3.reject(new Error("boom")); // rejected → rollback

    await waitFor(() => expect(screen.getAllByText("(inactive)")).toHaveLength(1));
    expect(within(rowFor("G1")).getByText("(inactive)")).toBeInTheDocument(); // ok → kept flipped
    expect(within(rowFor("G2")).queryByText("(inactive)")).toBeNull(); // !ok → rolled back
    expect(within(rowFor("G3")).queryByText("(inactive)")).toBeNull(); // rejected → rolled back
    // adopt-vs-ignore pin: the ok body's marker must NOT surface anywhere
    expect(screen.queryByTitle("SRV-MARKER")).not.toBeInTheDocument();
    expect(screen.getByTitle("G1")).toBeInTheDocument(); // still the OPTIMISTIC row, not the server's
    // bulk is fully silent: no alert, and no console assert either (there is no catch — SPEC V-5)
    expect(alertMock).not.toHaveBeenCalled();
  });
});
