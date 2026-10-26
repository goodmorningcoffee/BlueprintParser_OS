// [TP-1 WP-1.A K11] A summary entry resolves to its own region, never to a same-category sibling.
// All names here are synthetic.
import { describe, expect, it } from "vitest";
import { findSummaryRegion, summaryTableName } from "@/lib/parsed-table-summary";

const FIRST = {
  id: "pr-first",
  type: "schedule",
  category: "door-schedule",
  data: { tableName: "DOOR SCHEDULE", headers: ["TAG"], rows: [{ TAG: "D1" }] },
};
const CONT = {
  id: "pr-cont",
  type: "schedule",
  category: "door-schedule",
  data: { tableName: "DOOR SCHEDULE (CONT.)", headers: ["TAG"], rows: [{ TAG: "D9" }] },
};
const NOTES = { id: "pr-notes", type: "notes", category: "door-schedule", data: {} };

describe("findSummaryRegion", () => {
  it("picks the continuation by id even though the first table shares its category", () => {
    expect(findSummaryRegion([FIRST, CONT], { name: "DOOR SCHEDULE (CONT.)", regionId: "pr-cont" }))
      .toBe(CONT);
  });

  it("an id that is gone resolves to nothing, not to a sibling", () => {
    expect(findSummaryRegion([FIRST, CONT], { name: "DOOR SCHEDULE", regionId: "pr-deleted" }))
      .toBeUndefined();
  });

  it("without an id (pre-TP-1 summaries) matches the name only, never the category", () => {
    expect(findSummaryRegion([FIRST, CONT], { name: "DOOR SCHEDULE (CONT.)" })).toBe(CONT);
    expect(findSummaryRegion([FIRST, CONT], { name: "OTHER SCHEDULE" })).toBeUndefined();
  });

  it("the fallback ignores non-table regions and uses the summary's own name rule", () => {
    expect(findSummaryRegion([NOTES], { name: "door-schedule" })).toBeUndefined();
    const unnamed = { id: "pr-u", type: "keynote", category: "keynote-table", data: {} };
    expect(summaryTableName(unnamed)).toBe("keynote-table");
    expect(findSummaryRegion([unnamed], { name: "keynote-table" })).toBe(unnamed);
    expect(summaryTableName({ id: "x" })).toBe("Unnamed Table");
  });

  it("tolerates a missing region list", () => {
    expect(findSummaryRegion(undefined, { name: "X", regionId: "a" })).toBeUndefined();
    expect(findSummaryRegion(null, { name: "X" })).toBeUndefined();
  });
});
