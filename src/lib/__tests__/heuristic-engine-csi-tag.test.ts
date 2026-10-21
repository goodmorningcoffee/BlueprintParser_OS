// [csi-v2 S6] A rule's outputCsiCode is matched against the page's codes by csiDedupeKey, so the
// spaced rule code ("08 11 16", every built-in rule and every normalized admin entry) finds the
// legacy engine's UNSPACED stored code ("081116"). Measured on c6ad951: raw === never matched
// legacy pages, so csiTags stayed undefined.
import { describe, expect, it } from "vitest";
import { runHeuristicEngine, type HeuristicRule } from "@/lib/heuristic-engine";
import type { CsiCode } from "@/types";

const rule: HeuristicRule = {
  id: "t-door", name: "door", source: "custom", enabled: true,
  yoloRequired: [], yoloBoosters: [], yoloAvailabilityMode: "require",
  textKeywordsRequired: ["DOOR"], textKeywordsBoosters: [], textKeywordsMode: "any-required",
  overlapRequired: false, outputLabel: "door-schedule", outputCsiCode: "08 11 16", minConfidence: 0.01,
};
const run = (csiCodes: CsiCode[]) =>
  runHeuristicEngine([rule], { rawText: "DOOR SCHEDULE", csiCodes, pageNumber: 1 });

describe("heuristic outputCsiCode → csiTags across stored code formats", () => {
  const legacy: CsiCode = { code: "081116", description: "aluminum doors", trade: "Openings", division: "08 00 00" };
  const v2: CsiCode = { code: "08 11 16", description: "Aluminum Doors and Frames", trade: "Openings", division: "08 00 00" };

  it("the rule fires on this page (precondition)", () => {
    expect(run([])).toHaveLength(1);
  });
  it("matches the legacy unspaced code and tags it with the stored row verbatim", () => {
    expect(run([legacy])[0].csiTags).toEqual([legacy]);
  });
  it("matches the spaced v2 code", () => {
    expect(run([v2])[0].csiTags).toEqual([v2]);
  });
  it("a Level-5 sibling is NOT the rule's code", () => {
    expect(run([{ ...v2, code: "08 11 16.13" }])[0].csiTags).toBeUndefined();
  });
});
