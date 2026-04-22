import { describe, it, expect } from "vitest";
import { isWholeWordMatch } from "@/lib/text-match-utils";

describe("isWholeWordMatch", () => {
  it("matches whole words", () => {
    expect(isWholeWordMatch("DOOR SCHEDULE", "DOOR")).toBe(true);
    expect(isWholeWordMatch("please see the door schedule", "DOOR")).toBe(true);
  });

  it("does NOT match partials — the whole point of the quick win", () => {
    expect(isWholeWordMatch("INDOOR TEMPERATURE", "DOOR")).toBe(false);
    expect(isWholeWordMatch("OUTDOOR AIR", "DOOR")).toBe(false);
    expect(isWholeWordMatch("DOORWAY SPECS", "DOOR")).toBe(false);
    expect(isWholeWordMatch("RESCHEDULE FOR MONDAY", "SCHEDULE")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isWholeWordMatch("door schedule", "DOOR")).toBe(true);
    expect(isWholeWordMatch("DOOR SCHEDULE", "door")).toBe(true);
    expect(isWholeWordMatch("Door Schedule", "DOOR")).toBe(true);
  });

  it("matches multi-word phrases with boundaries at both ends", () => {
    expect(isWholeWordMatch("GENERAL NOTES HEADING", "GENERAL NOTES")).toBe(true);
    expect(isWholeWordMatch("GENERALNOTESHEAD", "GENERAL NOTES")).toBe(false);
  });

  it("handles keywords ending in non-word chars (e.g. 'NOTES:')", () => {
    expect(isWholeWordMatch("NOTES: 1. See spec", "NOTES:")).toBe(true);
    expect(isWholeWordMatch("  NOTES:  ", "NOTES:")).toBe(true);
  });

  it("escapes special regex chars in the keyword", () => {
    expect(isWholeWordMatch("see section 03.10.00", "03.10.00")).toBe(true);
    expect(isWholeWordMatch("see section 03a10b00", "03.10.00")).toBe(false);
  });

  it("returns false for empty keyword", () => {
    expect(isWholeWordMatch("anything here", "")).toBe(false);
  });

  it("door + schedule appearing separately still requires both to be tested independently", () => {
    // This is the canonical case: the keyword list ["DOOR", "SCHEDULE"] is
    // meant to be checked one-by-one by the caller, each independently.
    // Both should whole-word match regardless of adjacency.
    const text = "see door on plan A-8 and schedule on plan A-9";
    expect(isWholeWordMatch(text, "DOOR")).toBe(true);
    expect(isWholeWordMatch(text, "SCHEDULE")).toBe(true);
  });
});
