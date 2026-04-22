import { describe, it, expect } from "vitest";
import { matchTiers } from "@/lib/note-keyword-tiers";

describe("matchTiers", () => {
  it("returns no tiers for unrelated text", () => {
    expect(matchTiers("this is just free-flowing prose")).toEqual({
      tier1: undefined,
      tier2: undefined,
      trade: undefined,
    });
  });

  it("matches tier1 on 'NOTES'", () => {
    const m = matchTiers("GENERAL NOTES");
    expect(m.tier1).toBe("NOTES");
  });

  it("matches tier2 'GENERAL NOTES' before tier2 'GENERAL' (longer wins)", () => {
    const m = matchTiers("GENERAL NOTES:");
    expect(m.tier2).toBe("GENERAL NOTES");
  });

  it("matches tier2 'REFLECTED CEILING' for RCP pages", () => {
    const m = matchTiers("REFLECTED CEILING PLAN NOTES");
    expect(m.tier2).toBe("REFLECTED CEILING");
    expect(m.tier1).toBe("NOTES");
  });

  it("case-insensitive matching", () => {
    expect(matchTiers("door schedule").tier2).toBe("DOOR SCHEDULE");
    expect(matchTiers("Door Schedule").tier2).toBe("DOOR SCHEDULE");
    expect(matchTiers("DOOR SCHEDULE").tier2).toBe("DOOR SCHEDULE");
  });

  it("matches trade keyword independently of tier1/tier2", () => {
    const m = matchTiers("FIRE PROTECTION NOTES");
    expect(m.trade).toBe("FIRE PROTECTION");
    expect(m.tier1).toBe("NOTES");
  });

  it("all three tiers can match simultaneously", () => {
    const m = matchTiers("DOOR SCHEDULE — SEE SPECIFICATIONS PART 1");
    expect(m.tier1).toBeDefined();
    expect(m.tier2).toBeDefined();
    expect(m.trade).toBeDefined();
  });

  it("empty string returns no tiers", () => {
    expect(matchTiers("")).toEqual({
      tier1: undefined,
      tier2: undefined,
      trade: undefined,
    });
  });

  it("tier1 'SCHEDULE' fires on isolated SCHEDULE mentions", () => {
    expect(matchTiers("FINISH SCHEDULE").tier1).toBe("SCHEDULE");
    expect(matchTiers("FINISH SCHEDULE").tier2).toBe("FINISH SCHEDULE");
  });

  it("tier1 'SPECIFICATIONS' wins over substring 'SPECIFICATION'", () => {
    expect(matchTiers("DIVISION 03 SPECIFICATIONS").tier1).toBe("SPECIFICATIONS");
  });
});
