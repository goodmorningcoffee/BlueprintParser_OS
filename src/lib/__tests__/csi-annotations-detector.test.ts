/**
 * csi-annotations-detector.test.ts — [csi-v2 S6] the `csi-annotations` text detector reads the
 * tagger's v2 TRIGGERS (IMPLEMENTATION E8) instead of re-finding each description word-for-word.
 * Pure: no KB, no DB — the codes are hand-built in the stored CsiCode shape.
 */
import { describe, it, expect } from "vitest";
import { csiAnnotationsDetector } from "@/lib/detectors/csi-annotations";
import type { BboxLTWH, CsiCode, TextractWord } from "@/types";

const W = (text: string, x: number, y = 0.1): TextractWord => ({ text, confidence: 80, bbox: [x, y, 0.05, 0.02] });
const words = [W("5/8", 0.05), W("GWB", 0.11), W("ON", 0.17), W("STUDS", 0.23), W("09", 0.3, 0.5), W("29", 0.36, 0.5), W("092900", 0.5, 0.6)];
const detect = (csiCodes: CsiCode[]) => csiAnnotationsDetector.detect({ words, lines: [], csiCodes });
const box = (i: number): BboxLTWH => words[i].bbox;

const GYP: CsiCode = { code: "09 29 00", description: "Gypsum Board", trade: "Finishes", division: "09 00 00" };

describe("csi-annotations detector (v2 triggers)", () => {
  it("one annotation per emitted trigger, over the words whose boxes the trigger carries", () => {
    const code: CsiCode = { ...GYP, triggers: [{ text: "gwb", bbox: box(1), bboxes: [box(1)], tier: 1 }] };
    const anns = detect([code]).filter((a) => a.wordIndices.length && a.text === "GWB");
    expect(anns).toHaveLength(1);
    expect(anns[0]).toMatchObject({
      type: "csi-code", category: "csi", text: "GWB", wordIndices: [1], group: "09 00 00",
      meta: { code: "09 29 00", description: "Gypsum Board", trade: "Finishes", division: "09 00 00" },
    });
  });

  it("does NOT re-match the description: a title absent from the page yields no span annotation", () => {
    // pre-v2 the detector searched the words for "gypsum board"; v2 descriptions are 2018 titles
    // that rarely appear verbatim, so only triggers count
    const anns = detect([{ ...GYP, triggers: [] }]);
    expect(anns.filter((a) => a.meta?.description === "Gypsum Board" && a.text !== "092900")).toEqual([]);
  });

  it("skips non-emitted triggers (a BY OTHERS span); a pre-v2 union-only trigger maps by word centre", () => {
    const byOthers = { text: "gwb", bbox: box(1), bboxes: [box(1)], tier: 1 as const, emitted: false };
    expect(detect([{ ...GYP, triggers: [byOthers] }]).filter((a) => a.text === "GWB")).toEqual([]);
    const union: BboxLTWH = [0.1, 0.09, 0.2, 0.04]; // covers GWB, ON, STUDS
    const anns = detect([{ ...GYP, triggers: [{ text: "gwb on studs", bbox: union, tier: 2 }] }]);
    expect(anns.map((a) => a.wordIndices)).toContainEqual([1, 2, 3]);
  });

  it("still marks the printed code number", () => {
    const anns = detect([GYP]);
    expect(anns.map((a) => [a.text, a.wordIndices])).toEqual([["092900", [6]]]);
  });
});
