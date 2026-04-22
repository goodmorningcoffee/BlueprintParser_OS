import { describe, it, expect } from "vitest";
import { mergeCsiCodes, normalizeCsiCode, normalizeCsiCodes } from "@/lib/csi-utils";
import type { CsiCode } from "@/types";

describe("mergeCsiCodes", () => {
  it("adds new codes while deduping by code", () => {
    const existing: CsiCode[] = [
      { code: "08", description: "Openings", division: "08", trade: "" },
    ];
    const incoming = [
      { code: "08", description: "Openings (duplicate)" },
      { code: "09", description: "Finishes" },
    ];
    const merged = mergeCsiCodes(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].description).toBe("Openings");
    expect(merged[1].code).toBe("09");
  });

  it("derives division from code substring when not provided", () => {
    const merged = mergeCsiCodes([], [
      { code: "08 11 16", description: "Aluminum Doors" },
    ]);
    expect(merged[0].division).toBe("08");
    expect(merged[0].trade).toBe("");
  });

  it("returns a copy of existing when incoming is empty (no mutation)", () => {
    const existing: CsiCode[] = [
      { code: "03", description: "Concrete", division: "03", trade: "" },
    ];
    const merged = mergeCsiCodes(existing, []);
    expect(merged).toEqual(existing);
    expect(merged).not.toBe(existing);
  });
});

describe("normalizeCsiCode", () => {
  it("pads single-digit division to 2 chars", () => {
    expect(normalizeCsiCode("8")).toBe("08");
  });

  it("formats 6-digit numeric string with spaces", () => {
    expect(normalizeCsiCode("081116")).toBe("08 11 16");
  });

  it("strips punctuation variants", () => {
    expect(normalizeCsiCode("08-11-16")).toBe("08 11 16");
    expect(normalizeCsiCode("08.11.16")).toBe("08 11 16");
  });
});

describe("normalizeCsiCodes", () => {
  it("splits a comma-separated list and normalizes each entry", () => {
    expect(normalizeCsiCodes("8, 081116, 02 33 21")).toEqual([
      "08",
      "08 11 16",
      "02 33 21",
    ]);
  });
});
