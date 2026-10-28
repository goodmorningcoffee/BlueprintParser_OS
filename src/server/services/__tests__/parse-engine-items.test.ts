// @vitest-environment node
// [table pipeline WP-3.F] The workspace items merge (pure): joins, dedupe by IoU and kind family, the
// `tableP × p` sort, the low-confidence group (C3-m7, C2-m7), hidden pages via the derived index (C1-D6).
// All strings are synthetic.

import { describe, expect, it } from "vitest";
import type { ProposalSummaryItem } from "@/lib/classifier-engine/types";
import type { InboxEntry } from "@/lib/parse-engine/inbox-derive";
import { assembleAll, assembleGroup, LOW_CONFIDENCE_SCORE, lowCandidates, pageRegions } from "@/server/services/parse-engine/items";

const proposal = (id: string, b: [number, number, number, number], p: number, tableP?: number, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  id, origin: "proposal", kind: "schedule", b, title: `T-${id}`, p, state: "todo", proposalId: id, ...(tableP !== undefined ? { tableP } : {}), ...extra,
});
const text = (id: string, b: [number, number, number, number], extra: Partial<InboxEntry> = {}): InboxEntry => ({
  id, origin: "text-region", kind: "notes", b, title: `N-${id}`, p: 0.8, state: "todo", regionType: "notes-numbered", legacyId: `region-${id}`, ...extra,
});
const summary = (id: string, page: number, b: [number, number, number, number], p: number, extra: Partial<ProposalSummaryItem> = {}): ProposalSummaryItem => ({
  id, recipeId: "schedules.v1", pageNumber: page, bbox: b, target: "schedule", classId: "door", className: "Door", group: "arch",
  displayName: `Door ${id}`, p, nameP: 0.5, ...extra,
});

describe("assembleGroup", () => {
  it("sorts by tableP × p and folds items below the threshold into lowConfidence", () => {
    const g = assembleGroup(1, {
      entries: [
        proposal("a", [0, 0, 0.2, 0.2], 0.9, 0.5), // .45
        proposal("b", [0.3, 0, 0.5, 0.2], 0.6), // .6 (no table head → p)
        proposal("c", [0.6, 0, 0.8, 0.2], 0.9, 0.2), // .18 → low
      ],
      regions: [],
    });
    expect(g.items.map((i) => [i.id, i.score])).toEqual([["b", 0.6], ["a", 0.45]]);
    expect(g.lowConfidence.map((i) => i.id)).toEqual(["c"]);
    expect(LOW_CONFIDENCE_SCORE).toBeGreaterThan(0.18);
  });

  it("joins a proposal to its saved region (named, linked, or IoU) and does not list the region twice", () => {
    const regions = [
      { regionId: "parsed-1", kind: "schedule" as const, b: [0, 0, 0.2, 0.2] as [number, number, number, number], title: "R1", origin: "classic" as const },
      { regionId: "sr-2", kind: "schedule" as const, b: [0.7, 0.7, 0.9, 0.9] as [number, number, number, number], title: "R2", origin: "workspace" as const, proposalId: "b" },
      { regionId: "parsed-3", kind: "notes" as const, b: [0.3, 0.3, 0.5, 0.5] as [number, number, number, number], title: "R3", origin: "classic" as const },
    ];
    const g = assembleGroup(1, { entries: [proposal("a", [0, 0, 0.2, 0.21], 0.9), proposal("b", [0.1, 0.5, 0.3, 0.6], 0.9)], regions });
    const byKey = Object.fromEntries(g.items.map((i) => [i.id, i]));
    expect(byKey.a).toMatchObject({ state: "parsed", regionId: "parsed-1" });
    expect(byKey.b).toMatchObject({ state: "parsed", regionId: "sr-2" });
    // The notes region never joins a schedule proposal (kind family) and stays listed.
    expect(byKey["parsed-3"]).toMatchObject({ origin: "region", state: "parsed", regionOrigin: "classic" });
    expect(Object.keys(byKey).sort()).toEqual(["a", "b", "parsed-3"]);
  });

  it("keeps a rejected proposal rejected even when a region overlaps it", () => {
    const g = assembleGroup(1, {
      entries: [proposal("a", [0, 0, 0.2, 0.2], 0.9, undefined, { state: "rejected", verdict: "reject" })],
      regions: [{ regionId: "parsed-1", kind: "schedule", b: [0, 0, 0.2, 0.2], title: null, origin: "classic" }],
    });
    expect(g.items.find((i) => i.id === "a")?.state).toBe("rejected");
  });

  it("a text region overlapping a same-family proposal is one item; a table proposal never absorbs notes", () => {
    const notesProposal = { ...proposal("np", [0.1, 0.1, 0.5, 0.5], 0.9), kind: "notes" as const };
    const g = assembleGroup(1, {
      entries: [notesProposal, proposal("tp", [0.1, 0.1, 0.5, 0.5], 0.9), text("t1", [0.1, 0.1, 0.5, 0.52], { state: "rejected" })],
      regions: [],
    });
    expect(g.items.map((i) => i.id).sort()).toEqual(["np", "tp"]);
    expect(g.items.find((i) => i.id === "np")?.state).toBe("rejected"); // adopted the decided text state
    expect(g.items.find((i) => i.id === "tp")?.state).toBe("todo");
  });

  it("classifiedTables and ensembleRegions are always low confidence and dropped when a kept item covers them", () => {
    const low = lowCandidates({
      classifiedTables: [
        { bbox: [0.6, 0.6, 0.2, 0.2], category: "door-schedule", confidence: 0.9, headerText: "LOREM" },
        { bbox: [0, 0, 0.2, 0.2], category: "unknown-table", confidence: 0.9 },
        { bbox: [0.3, 0.3, 0.1, 0.1], category: "general-notes", confidence: 0.9 },
      ],
      ensembleRegions: [{ bbox: [0.3, 0.6, 0.1, 0.1], tableProbability: 0.95, category: "keynote-table" }],
    });
    expect(low.map((l) => [l.origin, l.kind])).toEqual([["classified-table", "schedule"], ["classified-table", "schedule"], ["ensemble", "keynote"]]);
    const g = assembleGroup(1, { entries: [proposal("a", [0, 0, 0.2, 0.2], 0.9)], regions: [], low });
    expect(g.items.map((i) => i.id)).toEqual(["a"]);
    expect(g.lowConfidence.map((i) => i.origin)).toEqual(["ensemble", "classified-table"]);
  });

  it("reads saved regions with their K58 / workspace links", () => {
    const regions = pageRegions({
      parsedRegions: [
        { id: "sr-1", type: "keynote", category: "keynote-table", bbox: [0, 0, 0.1, 0.1], data: { links: { origin: "workspace", proposalId: "p-1" } } },
        { id: "parsed-2", type: "notes", category: "general-notes", bbox: [0.2, 0.2, 0.3, 0.3], sourceTextRegionId: "region-4", data: {} },
        { id: "bad", bbox: [0, 0] },
      ],
    });
    expect(regions).toEqual([
      { regionId: "sr-1", kind: "keynote", b: [0, 0, 0.1, 0.1], title: "keynote-table", origin: "workspace", proposalId: "p-1" },
      { regionId: "parsed-2", kind: "notes", b: [0.2, 0.2, 0.3, 0.3], title: "general-notes", origin: "classic", sourceTextRegionId: "region-4" },
    ]);
  });
});

describe("assembleAll (scope=all, PJ only)", () => {
  const items = [summary("a", 1, [0, 0, 0.2, 0.2], 0.9, { tableP: 0.9, tagRows: 7 }), summary("h", 2, [0, 0, 0.2, 0.2], 0.9), summary("c", 3, [0, 0, 0.2, 0.2], 0.9, { verdict: "reject" })];

  it("with a derived index, its page keys are the visible set: a hidden duplicate page is absent", () => {
    const groups = assembleAll(items, {
      inbox: {
        "1": [{ ...proposal("a", [0, 0, 0.2, 0.2], 0.9), state: "parsed", regionId: "parsed-1" }, text("t", [0.5, 0.5, 0.9, 0.9])],
        "3": [],
      },
      regions: { "1": [{ regionId: "parsed-1", kind: "schedule", title: "R", bbox: [0, 0, 0.2, 0.2], rows: 3, origin: "classic" }] },
    });
    expect(groups.map((g) => g.page)).toEqual([1, 3]);
    const p1 = groups[0];
    expect(p1.items.find((i) => i.id === "a")).toMatchObject({ state: "parsed", regionId: "parsed-1", tableP: 0.9, tagRows: 7, title: "Door a" });
    expect(p1.items.map((i) => i.id).sort()).toEqual(["a", "t"]);
    expect(groups[1].items[0]).toMatchObject({ id: "c", state: "rejected" });
  });

  it("a page-unit proposal (whole-page box) is never an inbox item (verify LOW-6)", () => {
    const pageUnit = summary("pu", 1, [0, 0, 1, 1], 0.9, { target: "general-notes" });
    const groups = assembleAll([pageUnit], { inbox: { "1": [] }, regions: {} });
    expect(groups).toEqual([]);
  });

  it("without an index, lists the summary minus the hidden pages", () => {
    expect(assembleAll(items, null, new Set([2])).map((g) => g.page)).toEqual([1, 3]);
    expect(assembleAll(items, null).map((g) => g.page)).toEqual([1, 2, 3]);
  });
});
