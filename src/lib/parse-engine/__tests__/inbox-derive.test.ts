// @vitest-environment node
// [table pipeline WP-3.F] One page's derived inbox slice (PLAN §2.1 inbox, §2.3; K30, K58, C2-M12).
// All strings are synthetic.

import { describe, expect, it } from "vitest";
import { deriveInboxForPage, deriveInboxIndex, foldedTextRegions, INBOX_DERIVE_PI_KEYS, legacyRejectHolds, proposalInboxKind, type InboxEntry } from "../inbox-derive";
import { textRegionKey } from "../text-region-verdicts";

const AT = "2026-10-27T00:00:00.000Z";
// Stored TextRegion boxes are LTWH.
const TR_A = { id: "region-0", type: "notes-numbered", bbox: [0.1, 0.1, 0.3, 0.2], confidence: 0.8, headerText: "LOREM NOTES", wordCount: 9 };
const TR_B = { id: "region-1", type: "notes-numbered", bbox: [0.6, 0.6, 0.3, 0.2], confidence: 0.7, headerText: "IPSUM NOTES", wordCount: 9 };
const KEY_A = textRegionKey("notes-numbered", [0.1, 0.1, 0.4, 0.30000000000000004]);
const PROPOSAL = {
  id: "schedules.v1:p1:abc", recipeId: "schedules.v1", recipeVersion: 1, pageNumber: 1, bbox: [0.5, 0.05, 0.95, 0.4],
  target: "schedule", p: 0.9, tableP: 0.8, classId: "door", className: "Door schedule", displayName: "Door schedule",
};
const PLAN_PROPOSAL = { ...PROPOSAL, id: "heuristics.v1:p1:cut", target: "section-cut", bbox: [0, 0, 1, 1] };
const REGION = { id: "parsed-1", type: "schedule", category: "synthetic", bbox: [0.5, 0.05, 0.95, 0.41], data: {} };

const derive = (pi: Record<string, unknown>, prev?: InboxEntry[]) => deriveInboxForPage({ page: 1, pageIntelligence: pi, prev });

describe("proposal kinds", () => {
  it("lists tables and notes blocks, never page units, plans or cuts", () => {
    expect(proposalInboxKind("schedule", "door")).toBe("schedule");
    expect(proposalInboxKind("keynote-table", null)).toBe("keynote");
    expect(proposalInboxKind("symbol-legend", null)).toBe("legend");
    expect(proposalInboxKind("general-notes", null)).toBe("notes");
    expect(proposalInboxKind("text-region", "keynotes")).toBe("keynote");
    expect(proposalInboxKind("text-region", "abbreviations")).toBe("legend");
    expect(proposalInboxKind("text-region", "general-notes")).toBe("notes");
    for (const t of ["section-cut", "typical-plan", "has-door-schedule", "notes-page"]) expect(proposalInboxKind(t, null)).toBeNull();
  });
});

describe("deriveInboxForPage", () => {
  it("proposal states: todo, rejected, and parsed through the K58 region link (WP-2.F)", () => {
    const base = { classifierProposals: { proposals: [PROPOSAL, PLAN_PROPOSAL] } };
    expect(derive(base)).toEqual([expect.objectContaining({ id: PROPOSAL.id, origin: "proposal", kind: "schedule", state: "todo", tableP: 0.8, classId: "door" })]);
    expect(derive({ ...base, proposalVerdicts: { [PROPOSAL.id]: { verdict: "reject" } } })[0]).toMatchObject({ state: "rejected", verdict: "reject" });
    // The save-time accept names a region that moved away from the box: the link still holds.
    const moved = { ...REGION, id: "parsed-far", bbox: [0.0, 0.8, 0.2, 0.95] };
    const linked = derive({ ...base, parsedRegions: [moved], proposalVerdicts: { [PROPOSAL.id]: { verdict: "accept", via: "parse", regionId: "parsed-far" } } });
    expect(linked[0]).toMatchObject({ state: "parsed", regionId: "parsed-far", verdict: "accept" });
  });

  it("falls back to IoU ≥ .5 with a same-family saved region; a deleted region returns the item to review", () => {
    const base = { classifierProposals: { proposals: [PROPOSAL] } };
    expect(derive({ ...base, parsedRegions: [REGION] })[0]).toMatchObject({ state: "parsed", regionId: "parsed-1" });
    expect(derive({ ...base, parsedRegions: [{ ...REGION, type: "notes" }] })[0]).toMatchObject({ state: "todo" });
    const gone = derive({ ...base, parsedRegions: [], proposalVerdicts: { [PROPOSAL.id]: { verdict: "accept", via: "parse", regionId: "parsed-1" } } });
    expect(gone[0]).toMatchObject({ state: "todo" });
    expect(gone[0].regionId).toBeUndefined();
  });

  it("text regions are content-keyed; a workspace verdict decides the state before any legacy id", () => {
    const pi = {
      textRegions: [TR_A, TR_B, { id: "region-2", type: "unknown", bbox: [0, 0, 0.1, 0.1] }],
      textRegionVerdicts: { [KEY_A]: { verdict: "reject", type: "notes-numbered", b: [0.1, 0.1, 0.4, 0.3], at: AT } },
    };
    const out = derive(pi);
    expect(out.map((e) => [e.id, e.state, e.legacyId])).toEqual([
      [KEY_A, "rejected", "region-0"],
      [textRegionKey("notes-numbered", [0.6, 0.6, 0.9, 0.8]), "todo", "region-1"],
    ]);
    expect(out[0]).toMatchObject({ origin: "text-region", kind: "notes", title: "LOREM NOTES", regionType: "notes-numbered" });
  });

  it("a legacy reject is honoured on first sight and while the recorded box still matches", () => {
    const pi = { textRegions: [TR_A, TR_B], rejectedTextRegionIds: ["region-0"] };
    const first = derive(pi);
    expect(first.find((e) => e.legacyId === "region-0")?.state).toBe("rejected");
    expect(derive(pi, first).find((e) => e.legacyId === "region-0")?.state).toBe("rejected");
  });

  it("a renumbered region-${i} does NOT hide the wrong item (C2-M12)", () => {
    const before = derive({ textRegions: [TR_A, TR_B], rejectedTextRegionIds: ["region-0"] });
    // A reprocess swapped the positional ids: region-0 is now block B.
    const renumbered = { textRegions: [{ ...TR_B, id: "region-0" }, { ...TR_A, id: "region-1" }], rejectedTextRegionIds: ["region-0"] };
    const after = derive(renumbered, before);
    expect(after.find((e) => e.legacyId === "region-0")).toMatchObject({ title: "IPSUM NOTES", state: "todo", legacyRejectB: [0.1, 0.1, 0.4, 0.30000000000000004] });
    // The binding is carried forward: a later derive does not re-bind the reject to the region that took the id.
    expect(derive(renumbered, after).find((e) => e.legacyId === "region-0")?.state).toBe("todo");
    // A second renumbering that gives the id back to block A makes the reject hold again.
    const back = derive({ textRegions: [TR_A, TR_B], rejectedTextRegionIds: ["region-0"] }, after);
    expect(back.find((e) => e.legacyId === "region-0")).toMatchObject({ title: "LOREM NOTES", state: "rejected" });
    expect(legacyRejectHolds("region-0", [0.6, 0.6, 0.9, 0.8], before)).toBe(false);
    expect(legacyRejectHolds("region-0", [0.1, 0.1, 0.4, 0.3], before)).toBe(true);
  });

  it("a promoted text region reads parsed (sourceTextRegionId, else IoU)", () => {
    const promoted = { id: "pr-1", type: "notes", category: "general-notes", bbox: [0.1, 0.1, 0.4, 0.3], sourceTextRegionId: "region-0", data: {} };
    expect(derive({ textRegions: [TR_A], parsedRegions: [promoted] })[0]).toMatchObject({ state: "parsed", regionId: "pr-1" });
  });

  it("is deterministic and tolerates malformed input", () => {
    const pi = { classifierProposals: { proposals: [PROPOSAL, null, { id: 3 }] }, textRegions: [TR_B, TR_A, "x"], parsedRegions: "nope" };
    expect(JSON.stringify(derive(pi))).toBe(JSON.stringify(derive(pi)));
    expect(derive(pi).map((e) => e.origin)).toEqual(["proposal", "text-region", "text-region"]);
    expect(deriveInboxForPage({ page: 1, pageIntelligence: null })).toEqual([]);
  });

  it("a text-region accept reads parsed only while a saved region carries it, else todo (verify LOW-1)", () => {
    const accept = { [KEY_A]: { verdict: "accept", type: "notes-numbered", b: [0.1, 0.1, 0.4, 0.3], at: AT } };
    expect(derive({ textRegions: [TR_A], textRegionVerdicts: accept })[0].state).toBe("todo");
    const region = { id: "pr-1", type: "notes", category: "general-notes", bbox: [0.1, 0.1, 0.4, 0.3], data: {} };
    expect(derive({ textRegions: [TR_A], textRegionVerdicts: accept, parsedRegions: [region] })[0]).toMatchObject({ state: "parsed", regionId: "pr-1" });
  });

  it("a page-unit proposal (whole-page box) is not an inbox item (verify LOW-6)", () => {
    const pageUnit = { ...PROPOSAL, id: "custom.v1:p1:page", target: "general-notes", bbox: [0, 0, 1, 1] };
    expect(derive({ classifierProposals: { proposals: [pageUnit, PROPOSAL] } }).map((e) => e.id)).toEqual([PROPOSAL.id]);
  });
});

describe("foldedTextRegions (the items fold rule, verify MED-2)", () => {
  it("returns the text regions whose best same-family proposal is the given one", () => {
    const notesP = { ...PROPOSAL, id: "regions.v1:p1:n", target: "text-region", classId: "general-notes", bbox: [0.1, 0.1, 0.4, 0.31] };
    const entries = derive({ classifierProposals: { proposals: [notesP, PROPOSAL] }, textRegions: [TR_A, TR_B] });
    expect(foldedTextRegions(entries, notesP.id).map((e) => e.legacyId)).toEqual(["region-0"]);
    expect(foldedTextRegions(entries, PROPOSAL.id)).toEqual([]); // a table proposal never hosts notes
  });
});

describe("deriveInboxIndex (the summaries pass, verify HIGH-1)", () => {
  it("keys every visible page it is given, an empty one included (the page keys are the visible set)", () => {
    const out = deriveInboxIndex([
      { pageNumber: 3, pageIntelligence: {} },
      { pageNumber: 1, pageIntelligence: { classifierProposals: { proposals: [PROPOSAL] } } },
    ]);
    expect(Object.keys(out)).toEqual(["1", "3"]);
    expect(out["3"]).toEqual([]);
    expect(out["1"].map((e) => e.id)).toEqual([PROPOSAL.id]);
  });

  it("carries the legacy-reject bindings of the stored inbox through a whole-index recompute", () => {
    const before = deriveInboxIndex([{ pageNumber: 1, pageIntelligence: { textRegions: [TR_A, TR_B], rejectedTextRegionIds: ["region-0"] } }]);
    const renumbered = { textRegions: [{ ...TR_B, id: "region-0" }, { ...TR_A, id: "region-1" }], rejectedTextRegionIds: ["region-0"] };
    const recomputed = deriveInboxIndex([{ pageNumber: 1, pageIntelligence: renumbered }], before);
    expect(recomputed["1"].find((e) => e.legacyId === "region-0")).toMatchObject({ title: "IPSUM NOTES", state: "todo" });
    // Without the stored inbox the binding is lost and the reject lands on the wrong block (why prevInbox is required).
    expect(deriveInboxIndex([{ pageNumber: 1, pageIntelligence: renumbered }])["1"].find((e) => e.legacyId === "region-0")?.state).toBe("rejected");
  });

  it("names the page keys it reads, for an in-lock projection", () => {
    expect([...INBOX_DERIVE_PI_KEYS].sort()).toEqual(
      ["classifierProposals", "parsedRegions", "proposalVerdicts", "rejectedTextRegionIds", "textRegionVerdicts", "textRegions"]);
  });
});
