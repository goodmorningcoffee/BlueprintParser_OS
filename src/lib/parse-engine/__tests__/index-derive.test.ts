// @vitest-environment node
// [table pipeline WP-3.H] The derived project structure index (index-derive.ts). Synthetic data only.

import { describe, expect, it } from "vitest";
import type { PageIntelligence, TextRegion } from "@/types";
import { deriveStructureIndex } from "../index-derive";
// [TP-3 integrate g2b] the inbox is WP-3.F's one derive (HIGH-1); 3.H's local copy and its kind table were
// removed, and these tests now pin the index's use of the shared functions.
import { deriveInboxForPage as deriveInbox, deriveInboxIndex, type InboxEntry } from "../inbox-derive";
import { countParagraphKeys, textRegionInboxKind as textRegionKind, textRegionKey } from "../text-region-verdicts";
import { legacyView, viewHash } from "../legacy-view";
import { fromLegacy } from "../read";
import { CAPABILITY_VERSIONS } from "../version";

const AT = "2026-10-27T00:00:00.000Z";
const pi = (v: Record<string, unknown>) => v as unknown as PageIntelligence;

const schedule = {
  id: "pr-1-a", type: "schedule", category: "door-schedule", bbox: [0.1, 0.1, 0.5, 0.4], confidence: 0.9, source: "user",
  data: { headers: ["MARK", "SIZE"], rows: [{ MARK: "D-1", SIZE: "X" }, { MARK: "D-2", SIZE: "Y" }, { MARK: "", SIZE: "Z" }], tagColumn: "MARK", tableName: "DOOR SCHEDULE", rowCount: 3, columnCount: 2 },
};
const notes = {
  id: "parsed-1", type: "notes", category: "general-notes", bbox: [0.6, 0.1, 0.9, 0.5], confidence: 0.8,
  data: { headers: ["Key", "Note"], rows: [{ Key: "1", Note: "ALPHA" }, { Key: "2", Note: "BETA" }], tagColumn: "Key", tableName: "GENERAL NOTES" },
};
const spec = {
  id: "parsed-2", type: "spec", category: "spec", bbox: [0.1, 0.5, 0.5, 0.9], confidence: 0.8,
  data: { sections: [{ sectionHeader: "SECTION 08 71 00 - ALPHA", body: "1.01 GENERAL\nA. ONE" }] },
};

/** One page's inbox through the shared derive (`prev` = the page's stored slice). */
const deriveInboxForPage = (p: PageIntelligence | null, prev?: InboxEntry[]) => deriveInbox({ page: 1, pageIntelligence: p, prev });

const tr = (over: Partial<TextRegion>): TextRegion => ({
  id: "region-0", type: "notes-numbered", bbox: [0.6, 0.1, 0.3, 0.4], confidence: 0.7, wordCount: 40, ...over,
});

describe("deriveStructureIndex", () => {
  it("a classic schedule appears in regions and its tag keys in keys (by page)", () => {
    const idx = deriveStructureIndex([{ pageNumber: 3, pageIntelligence: pi({ parsedRegions: [schedule] }) }], AT);
    expect(idx.v).toBe(1);
    expect(idx.at).toBe(AT);
    expect(idx.regions["3"]).toEqual([{
      regionId: "pr-1-a", kind: "schedule", title: "DOOR SCHEDULE", bbox: [0.1, 0.1, 0.5, 0.4], rows: 3, cols: 2, origin: "classic",
    }]);
    expect(idx.keys["3"]).toEqual({ D1: [["pr-1-a", "schedule", "r1", null]], D2: [["pr-1-a", "schedule", "r2", null]] });
  });

  it("notes paragraphs are keyed with their block header; spec sections are indexed", () => {
    const idx = deriveStructureIndex([{ pageNumber: 1, pageIntelligence: pi({ parsedRegions: [notes, spec] }) }], AT);
    expect(idx.keys["1"]["1"]).toEqual([["parsed-1", "notes", "p1", "GENERAL NOTES"]]);
    expect(idx.keys["1"]["2"]).toEqual([["parsed-1", "notes", "p2", "GENERAL NOTES"]]);
    expect(idx.keys["1"]["1.01.A"]).toEqual([["parsed-2", "spec", "p2", "SECTION 08 71 00 - ALPHA"]]);
    expect(idx.specSections).toEqual({ "087100": [[1, "parsed-2"]] });
  });

  it("a region removed from the page is gone on the next derive (nothing hand-written survives)", () => {
    const before = deriveStructureIndex([{ pageNumber: 1, pageIntelligence: pi({ parsedRegions: [schedule] }) }], AT);
    const after = deriveStructureIndex([{ pageNumber: 1, pageIntelligence: pi({ parsedRegions: [] }) }], AT);
    expect(Object.keys(before.regions)).toEqual(["1"]);
    expect(after).toEqual({ v: 1, at: AT, regions: {}, keys: {}, specSections: {}, inbox: { "1": [] } }); // the visible page stays keyed (WP-3.F)
  });

  it("is deterministic and orders pages numerically", () => {
    const pages = [
      { pageNumber: 10, pageIntelligence: pi({ parsedRegions: [schedule] }) },
      { pageNumber: 2, pageIntelligence: pi({ parsedRegions: [notes] }) },
    ];
    const a = deriveStructureIndex(pages, AT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(deriveStructureIndex(pages, AT)));
    expect(Object.keys(a.regions)).toEqual(["2", "10"]);
  });

  it("an engine region carries revision, proposal, continuation and stale capabilities; origin workspace", () => {
    const model = fromLegacy(schedule)!;
    const projection = legacyView(model);
    const links = { origin: "workspace", revision: 4, viewHash: viewHash(projection), acceptedAt: AT, proposalId: "prop-1", continues: "sr-x" };
    const engine = { engine: "pe/1.0.0", caps: { rows: CAPABILITY_VERSIONS.rows - 1 }, methods: [], budget: "instant", evidenceHash: "e", paramsHash: "p", at: AT };
    const region = { ...schedule, id: "sr-schedule-1-x", data: { ...projection, structure: model, links, engine } };
    const idx = deriveStructureIndex([{ pageNumber: 1, pageIntelligence: pi({ parsedRegions: [region] }) }], AT);
    expect(idx.regions["1"][0]).toMatchObject({ regionId: "sr-schedule-1-x", origin: "workspace", revision: 4, proposalId: "prop-1", continues: "sr-x", stale: ["rows"] });
  });

  it("TP-2 regions join their proposal through proposalVerdicts[pid].regionId (amended 2026-10-27)", () => {
    const idx = deriveStructureIndex([{
      pageNumber: 1,
      pageIntelligence: pi({ parsedRegions: [schedule], proposalVerdicts: { "schedule-kind:p1:a": { verdict: "accept", via: "parse", regionId: "pr-1-a" }, other: { verdict: "reject" } } }),
    }], AT);
    expect(idx.regions["1"][0].proposalId).toBe("schedule-kind:p1:a");
  });

  it("skips regions without an id or a finite box", () => {
    const idx = deriveStructureIndex([{ pageNumber: 1, pageIntelligence: pi({ parsedRegions: [{ ...schedule, id: undefined }, { ...schedule, bbox: [0, 0, 1] }] }) }], AT);
    expect(idx.regions).toEqual({});
  });
});

describe("textRegionKind (§2.1 table)", () => {
  it("maps each classifier type", () => {
    expect(textRegionKind(tr({ type: "notes-numbered" }))).toBe("notes");
    expect(textRegionKind(tr({ type: "spec-dense-columns" }))).toBe("spec");
    expect(textRegionKind(tr({ type: "schedule-table" }))).toBe("schedule");
    expect(textRegionKind(tr({ type: "schedule-table", classifiedLabels: { tier1: "KEYNOTE" } }))).toBe("keynote");
    expect(textRegionKind(tr({ type: "unknown" }))).toBeNull();
  });
  it("notes-key-value: LEGEND/ABBREVIATIONS tier or ≥ 60 % short non-numeric keys → legend", () => {
    expect(textRegionKind(tr({ type: "notes-key-value", classifiedLabels: { tier1: "ABBREVIATIONS" } }))).toBe("legend");
    const grid = (keys: string[]) => ({ headers: ["Key", "Value"], rows: keys.map((k) => ({ Key: k, Value: "v" })) });
    expect(textRegionKind(tr({ type: "notes-key-value", grid: grid(["AB", "CD", "EF", "1"]) }))).toBe("legend");
    expect(textRegionKind(tr({ type: "notes-key-value", grid: grid(["1", "2", "3", "AB"]) }))).toBe("notes");
  });
  it("paragraph: numbered with ≥ 3 keys from containedText or rowCount only", () => {
    const text = "1. ALPHA\n2. BETA\n3. GAMMA";
    expect(countParagraphKeys(text)).toBe(3);
    expect(textRegionKind(tr({ type: "paragraph", hasNumberedItems: true, containedText: text }))).toBe("notes");
    expect(textRegionKind(tr({ type: "paragraph", hasNumberedItems: true, containedText: "1. ALPHA\n2. BETA" }))).toBeNull();
    expect(textRegionKind(tr({ type: "paragraph", hasNumberedItems: true, rowCount: 4 }))).toBe("notes");
    expect(textRegionKind(tr({ type: "paragraph", hasNumberedItems: false, containedText: text }))).toBeNull();
  });
});

describe("deriveInboxForPage", () => {
  const B = [0.6, 0.1, 0.9, 0.5];
  it("lists text-region items with a content-keyed id and MinMax box", () => {
    const [item] = deriveInboxForPage(pi({ textRegions: [tr({ headerText: "GENERAL NOTES" })] }));
    expect(item).toEqual({
      id: textRegionKey("notes-numbered", B as [number, number, number, number]), origin: "text-region", kind: "notes", b: expect.any(Array),
      title: "GENERAL NOTES", p: 0.7, state: "todo", legacyId: "region-0", regionType: "notes-numbered",
    });
    item.b.forEach((v, i) => expect(v).toBeCloseTo(B[i], 12)); // LTWH → MinMax (0.6 + 0.3 is not exactly 0.9)
    expect(item.id).toBe("tr:notes-numbered:0.60,0.10,0.90,0.50");
  });

  it("a committed region over the text region marks it parsed (sourceTextRegionId or same-family IoU)", () => {
    expect(deriveInboxForPage(pi({ textRegions: [tr({})], parsedRegions: [{ ...notes, sourceTextRegionId: "region-0" }] }))[0]).toMatchObject({ state: "parsed", regionId: "parsed-1" });
    expect(deriveInboxForPage(pi({ textRegions: [tr({})], parsedRegions: [notes] }))[0]).toMatchObject({ state: "parsed", regionId: "parsed-1" });
    expect(deriveInboxForPage(pi({ textRegions: [tr({})], parsedRegions: [{ ...schedule, bbox: B }] }))[0].state).toBe("todo");
  });

  it("a content-keyed reject verdict wins; it survives renumbering (matched by type + IoU)", () => {
    const verdict = { verdict: "reject", type: "notes-numbered", b: [0.6, 0.1, 0.9, 0.5], at: AT };
    const page = pi({ textRegions: [tr({ id: "region-7" })], textRegionVerdicts: { "tr:x": verdict } });
    expect(deriveInboxForPage(page)[0].state).toBe("rejected");
    const otherType = pi({ textRegions: [tr({ id: "region-7" })], textRegionVerdicts: { "tr:x": { ...verdict, type: "spec-dense-columns" } } });
    expect(deriveInboxForPage(otherType)[0].state).toBe("todo");
  });

  it("legacy rejectedTextRegionIds: honoured, but IoU-checked against the box the stored slice bound it to", () => {
    const page = pi({ textRegions: [tr({ id: "region-0" })], rejectedTextRegionIds: ["region-0"] });
    const first = deriveInboxForPage(page);
    expect(first[0].state).toBe("rejected"); // first sight binds the reject to the current box
    expect(deriveInboxForPage(page, first)[0].state).toBe("rejected");
    const bound = (b: number[]) => [{ ...first[0], legacyRejectB: b as [number, number, number, number] }];
    expect(deriveInboxForPage(page, bound([0.6, 0.1, 0.9, 0.5]))[0].state).toBe("rejected");
    expect(deriveInboxForPage(page, bound([0, 0, 0.1, 0.1]))[0].state).toBe("todo"); // renumbered: not honoured
  });

  it("drops non-inbox types and malformed boxes", () => {
    expect(deriveInboxForPage(pi({ textRegions: [tr({ type: "unknown" }), tr({ bbox: [0, 0] as never })] }))).toEqual([]);
    expect(deriveInboxForPage(null)).toEqual([]);
  });

  it("the index carries the inbox by page", () => {
    const idx = deriveStructureIndex([{ pageNumber: 5, pageIntelligence: pi({ textRegions: [tr({})] }) }], AT);
    expect(idx.inbox["5"]).toHaveLength(1);
  });
});

describe("deriveInboxIndex", () => {
  it("is exactly the inbox slice of deriveStructureIndex (page order; every visible page keyed, an empty one included)", () => {
    const rows = [
      { pageNumber: 5, pageIntelligence: pi({ textRegions: [tr({ id: "region-1" })], rejectedTextRegionIds: ["region-1"] }) },
      { pageNumber: 2, pageIntelligence: pi({ textRegions: [tr({})], parsedRegions: [notes] }) },
      { pageNumber: 3, pageIntelligence: pi({ parsedRegions: [schedule] }) },
    ];
    const inbox = deriveInboxIndex(rows);
    expect(inbox).toEqual(deriveStructureIndex(rows, AT).inbox);
    expect(Object.keys(inbox)).toEqual(["2", "3", "5"]);
    expect(inbox["3"]).toEqual([]);
    expect(inbox["5"][0].state).toBe("rejected");
  });

  it("deriveStructureIndex carries the stored inbox (prevInbox) into the derive, as deriveInboxIndex does", () => {
    const page = { pageNumber: 4, pageIntelligence: pi({ textRegions: [tr({ id: "region-1" })], rejectedTextRegionIds: ["region-1"] }) };
    const stored = deriveStructureIndex([page], AT).inbox;
    expect(stored["4"][0].state).toBe("rejected");
    // A reprocess renumbers: region-1 now names a different block. The stored binding keeps the reject off it.
    const renumbered = { pageNumber: 4, pageIntelligence: pi({ textRegions: [tr({ id: "region-1", bbox: [0.1, 0.6, 0.2, 0.2] })], rejectedTextRegionIds: ["region-1"] }) };
    expect(deriveStructureIndex([renumbered], AT, stored).inbox["4"][0].state).toBe("todo");
    expect(deriveStructureIndex([renumbered], AT, stored).inbox).toEqual(deriveInboxIndex([renumbered], stored));
    expect(deriveStructureIndex([renumbered], AT).inbox["4"][0].state).toBe("rejected"); // without prevInbox the guard is lost
  });
});
