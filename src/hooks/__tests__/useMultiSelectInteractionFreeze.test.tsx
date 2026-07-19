// [refactor jul10 P2.2⑤] ANNOTATION-GROUPS MIGRATION FREEZE NET, part 3/3 —
// useMultiSelectInteraction (renderHook — feasibility CONFIRMED, SPEC §6.2: the hook consumes
// only global zustand + React, no viewer context needed).
//
// Written GREEN against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte
// after the C3 flip (P2_DESIGN/ANNGROUPS_IMPL/SPEC.md). Single sanctioned divergence point:
// the SHARED `seedAnnotationGroups` helper. The QueryClientProvider wrapper + publicId are in
// place NOW (harmless pre-migration — chat/④ precedent) so the flip needs zero churn here.
//
// WHY THIS FILE MATTERS (SPEC §1.2/§7.3): this hook's SOLE importer is AnnotationOverlay, whose
// CANVAS-SACRED driver passes getGroupOutlineColor into the pure final group-ring helper.
// expandSelectionViaGroups separately drives marker-click sibling expansion.
// These cases pin the derived-index SEMANTICS the C2 `deriveGroupIndexes` must reproduce:
// forward index (annId→groupIds: membership lookups) and reverse index (groupId→annIds: sibling
// union) — the "pairs→Sets both directions" behavior, pinned through the hook because direct
// store-field asserts would die with the C3 field deletion (backing-agnostic discipline).
//
// PIN DISCIPLINE (SPEC §6.2 hook-freeze row): pin BEHAVIOR only — NEVER the return-object or
// callback identities (the hook returns a fresh literal + fresh `isSelected` closure every
// render :163-180; that's frozen AS-IS, §8.2 routes any memoization to phase-end review).
// Identity/notification-parity pins live in the C2 hook suite (E6), not here.
// Ordering caveat (§8.5): memberships have NO server orderBy — first-group-wins is pinned
// WITHIN-SESSION only, via explicit pairs insertion order.
// Post-write reads go through waitFor (RQ notify is a macrotask post-migration — ④ idiom).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { renderHook, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUiStore } from "@/stores/uiStore";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import type { AnnotationGroup } from "@/types";
import { useMultiSelectInteraction } from "@/hooks/useMultiSelectInteraction";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
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

const fetchMock = vi.fn();

beforeEach(() => {
  qc = new QueryClient(); // pure defaults, matching production Providers.tsx
  resetProjectData();
  // P2.5 resetProjectData clears UI selection but intentionally does not mutate QueryClient data;
  // seed the group entry explicitly so this cache cannot inherit another case's rows.
  setViewerStoreStateForTest({ publicId: "pid", isDemo: false, selectedAnnotationIds: new Set<number>() });
  seedAnnotationGroups(qc, [], []); // AFTER publicId
  fetchMock.mockReset();
  // fail-loud: this hook is READ-ONLY on the groups domain; post-migration this also pins that
  // mounting the observer fires ZERO fetches (seed + staleTime ∞ + initialData — SPEC §5-E5).
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected fetch in useMultiSelectInteraction freeze test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── H-1: groupIdToColor skips inactive AND colorless groups (:39-46) ────────────────────────

describe("useMultiSelectInteraction — getGroupOutlineColor honors active+colored only (H-1)", () => {
  it("active+colored → color; inactive (even colored) → null; colorless → null; non-member → null", async () => {
    seedAnnotationGroups(
      qc,
      [
        grp({ id: 1, name: "active-colored", color: "#ff0000" }),
        grp({ id: 2, name: "inactive-colored", color: "#00ff00", isActive: false }),
        grp({ id: 3, name: "active-colorless" }),
      ],
      [
        { annotationId: 10, groupId: 1 },
        { annotationId: 20, groupId: 2 },
        { annotationId: 30, groupId: 3 },
      ],
    );
    const { result } = renderHook(() => useMultiSelectInteraction(), { wrapper });

    await waitFor(() => expect(result.current.getGroupOutlineColor(10)).toBe("#ff0000"));
    // "grouped silently" contract: inactive groups keep members but lose the visual ring
    expect(result.current.getGroupOutlineColor(20)).toBeNull();
    expect(result.current.getGroupOutlineColor(30)).toBeNull(); // colorless never rings
    expect(result.current.getGroupOutlineColor(99)).toBeNull(); // no membership at all
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── H-2: expandSelectionViaGroups filters INACTIVE groups via activeGroupIds (:51-54/:103) ──

describe("useMultiSelectInteraction — sibling expansion skips inactive groups (H-2)", () => {
  it("clicking a member of an inactive group selects ONLY that member; membership-less id is a no-op", async () => {
    seedAnnotationGroups(
      qc,
      [grp({ id: 2, name: "inactive", color: "#00ff00", isActive: false })],
      [
        { annotationId: 20, groupId: 2 },
        { annotationId: 21, groupId: 2 }, // the sibling that must NOT be pulled in
      ],
    );
    const { result } = renderHook(() => useMultiSelectInteraction(), { wrapper });
    await waitFor(() => expect(result.current.selectionSize).toBe(0));

    act(() => result.current.expandSelectionViaGroups(20));
    // the clicked annotation is still added; the inactive group's siblings are filtered (:103)
    await waitFor(() =>
      expect([...useUiStore.getState().selectedAnnotationIds].sort((a, b) => a - b)).toEqual([20]),
    );

    // membership-less id: early return (:99) — selection untouched (no spurious set)
    act(() => result.current.expandSelectionViaGroups(99));
    await waitFor(() =>
      expect([...useUiStore.getState().selectedAnnotationIds].sort((a, b) => a - b)).toEqual([20]),
    );
  });
});

// ─── H-3: expansion is an ADDITIVE M:N union across ALL active groups (:96-111) ──────────────

describe("useMultiSelectInteraction — expansion unions siblings across groups, additively (H-3)", () => {
  it("member of two active groups pulls BOTH member sets; prior selection survives", async () => {
    seedAnnotationGroups(
      qc,
      [grp({ id: 1, name: "A", color: "#ff0000" }), grp({ id: 4, name: "B", color: "#0000ff" })],
      [
        // ann 10 belongs to BOTH groups (M:N); reverse index (groupMembers) supplies siblings
        { annotationId: 10, groupId: 1 },
        { annotationId: 11, groupId: 1 },
        { annotationId: 10, groupId: 4 },
        { annotationId: 12, groupId: 4 },
        { annotationId: 13, groupId: 4 },
      ],
    );
    useUiStore.setState({ selectedAnnotationIds: new Set([99]) }); // pre-existing selection
    const { result } = renderHook(() => useMultiSelectInteraction(), { wrapper });
    await waitFor(() => expect(result.current.selectionSize).toBe(1));

    act(() => result.current.expandSelectionViaGroups(10));

    await waitFor(() =>
      expect([...useUiStore.getState().selectedAnnotationIds].sort((a, b) => a - b)).toEqual([
        10, 11, 12, 13, 99,
      ]),
    );
  });
});

// ─── H-4: first-group-wins outline color, in pairs-insertion order (:148-161) ────────────────

describe("useMultiSelectInteraction — first-group-wins outline color (H-4)", () => {
  it("multi-group member takes the FIRST group's color in pairs order (within-session pin, §8.5)", async () => {
    seedAnnotationGroups(
      qc,
      [grp({ id: 1, name: "first", color: "#ff0000" }), grp({ id: 2, name: "second", color: "#00ff00" })],
      [
        { annotationId: 10, groupId: 1 }, // insertion order 1-then-2 → Set iteration yields 1 first
        { annotationId: 10, groupId: 2 },
      ],
    );
    const { result } = renderHook(() => useMultiSelectInteraction(), { wrapper });
    await waitFor(() => expect(result.current.getGroupOutlineColor(10)).toBe("#ff0000"));
  });

  it("falls THROUGH an inactive first group to the next active colored one", async () => {
    seedAnnotationGroups(
      qc,
      [
        grp({ id: 1, name: "first-inactive", color: "#ff0000", isActive: false }),
        grp({ id: 2, name: "second-active", color: "#00ff00" }),
      ],
      [
        { annotationId: 10, groupId: 1 },
        { annotationId: 10, groupId: 2 },
      ],
    );
    const { result } = renderHook(() => useMultiSelectInteraction(), { wrapper });
    // groupIdToColor has no entry for the inactive group → the loop falls through to #2 (:154-157)
    await waitFor(() => expect(result.current.getGroupOutlineColor(10)).toBe("#00ff00"));
  });
});
