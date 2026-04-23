import { describe, it, expect } from "vitest";
import { bindSpecSections, bindSpecSectionsInRegion } from "../bind-sections";
import type { TextractLine } from "@/types";

function l(top: number, text: string): TextractLine {
  return {
    text,
    bbox: [0.1, top, 0.8, 0.02],
    confidence: 0.99,
    words: text.split(/\s+/).map((t, i) => ({
      text: t,
      bbox: [0.1 + i * 0.05, top, 0.04, 0.02],
      confidence: 0.99,
    })),
  };
}

describe("bindSpecSections", () => {
  it("returns undefined for empty input", () => {
    expect(bindSpecSections([])).toBeUndefined();
  });

  it("returns undefined when no strong headers match (unless sub-sections enabled)", () => {
    const lines = [l(0.1, "Random body text"), l(0.12, "More body text")];
    expect(bindSpecSections(lines)).toBeUndefined();
  });

  it("splits on PART 1 / PART 2 / PART 3 headers", () => {
    const lines = [
      l(0.10, "PART 1 - GENERAL"),
      l(0.12, "Scope of work applies to..."),
      l(0.14, "Related sections: 03 30 00."),
      l(0.18, "PART 2 - PRODUCTS"),
      l(0.20, "Manufacturers approved."),
      l(0.24, "PART 3 - EXECUTION"),
      l(0.26, "Install per manufacturer."),
    ];
    const result = bindSpecSections(lines);
    expect(result).toBeDefined();
    expect(result!.sections).toHaveLength(3);
    expect(result!.sections[0].sectionHeader).toBe("PART 1 - GENERAL");
    expect(result!.sections[0].body).toContain("Scope of work");
    expect(result!.sections[0].body).toContain("Related sections");
    expect(result!.sections[1].sectionHeader).toBe("PART 2 - PRODUCTS");
    expect(result!.sections[2].sectionHeader).toBe("PART 3 - EXECUTION");
  });

  it("matches SECTION <NN NN NN> headers", () => {
    const lines = [
      l(0.10, "SECTION 03 30 00"),
      l(0.12, "CAST-IN-PLACE CONCRETE"),
      l(0.16, "SECTION 09 29 00.13"),
      l(0.18, "Interior gypsum board shaft wall."),
    ];
    const result = bindSpecSections(lines);
    expect(result).toBeDefined();
    expect(result!.sections).toHaveLength(2);
    expect(result!.sections[0].sectionHeader).toBe("SECTION 03 30 00");
    expect(result!.sections[1].sectionHeader).toBe("SECTION 09 29 00.13");
  });

  it("matches GENERAL NOTES header (G-series drawings)", () => {
    const lines = [
      l(0.05, "GENERAL NOTES"),
      l(0.07, "1. All work shall conform to..."),
      l(0.09, "2. Coordinate with structural."),
    ];
    const result = bindSpecSections(lines);
    expect(result).toBeDefined();
    expect(result!.sections).toHaveLength(1);
    expect(result!.sections[0].sectionHeader).toMatch(/GENERAL NOTES/i);
  });

  it("matches GENERAL CONSTRUCTION NOTES header", () => {
    const lines = [l(0.05, "GENERAL CONSTRUCTION NOTES"), l(0.07, "Body content.")];
    const result = bindSpecSections(lines);
    expect(result).toBeDefined();
    expect(result!.sections[0].sectionHeader).toMatch(/GENERAL CONSTRUCTION NOTES/i);
  });

  it("treats body-before-first-header as preamble (empty header)", () => {
    const lines = [
      l(0.05, "Project preamble text here."),
      l(0.08, "PART 1 - GENERAL"),
      l(0.10, "Body."),
    ];
    const result = bindSpecSections(lines);
    expect(result).toBeDefined();
    expect(result!.sections).toHaveLength(2);
    expect(result!.sections[0].sectionHeader).toBe("");
    expect(result!.sections[0].body).toBe("Project preamble text here.");
    expect(result!.sections[1].sectionHeader).toBe("PART 1 - GENERAL");
  });

  it("opt-in sub-section mode splits 1.01 / 1.02 within a PART section", () => {
    const lines = [
      l(0.10, "PART 1 - GENERAL"),
      l(0.12, "1.01 SCOPE"),
      l(0.14, "Scope body."),
      l(0.16, "1.02 QUALITY ASSURANCE"),
      l(0.18, "QA body."),
    ];
    const result = bindSpecSections(lines, { includeSubSections: true });
    expect(result).toBeDefined();
    expect(result!.sections.length).toBeGreaterThanOrEqual(3);
    const headers = result!.sections.map((s) => s.sectionHeader);
    expect(headers).toContain("PART 1 - GENERAL");
    expect(headers).toContain("1.01 SCOPE");
    expect(headers).toContain("1.02 QUALITY ASSURANCE");
  });

  it("does NOT split on 1.01 sub-sections before any strong header in opt-in mode", () => {
    const lines = [l(0.10, "1.01 SCOPE"), l(0.12, "Body.")];
    // includeSubSections=true but sub-section match is gated on `anyStrongSeen`.
    // Without a PART/SECTION header ever seen, no sub-split fires — content
    // collapses into a single empty-header preamble section.
    const result = bindSpecSections(lines, { includeSubSections: true });
    expect(result).toBeDefined();
    expect(result!.sections).toHaveLength(1);
    expect(result!.sections[0].sectionHeader).toBe("");
  });

  it("populates rowBoundaries from each section's top Y", () => {
    const lines = [l(0.1, "PART 1"), l(0.12, "body"), l(0.2, "PART 2")];
    const result = bindSpecSections(lines);
    expect(result!.rowBoundaries).toHaveLength(2);
    expect(result!.rowBoundaries![0]).toBeCloseTo(0.1, 5);
    expect(result!.rowBoundaries![1]).toBeCloseTo(0.2, 5);
  });

  it("is case-insensitive on headers", () => {
    const lines = [l(0.1, "Part 1 - General"), l(0.12, "body")];
    const result = bindSpecSections(lines);
    expect(result).toBeDefined();
    expect(result!.sections[0].sectionHeader).toBe("Part 1 - General");
  });

  it("does not false-trigger on 'part 1' embedded mid-sentence", () => {
    const lines = [l(0.1, "Part 1 - GENERAL"), l(0.12, "See part 1 of the notes above.")];
    const result = bindSpecSections(lines);
    expect(result).toBeDefined();
    expect(result!.sections).toHaveLength(1);
    expect(result!.sections[0].body).toContain("See part 1 of the notes above");
  });
});

describe("bindSpecSectionsInRegion", () => {
  it("filters to lines inside the region before binding", () => {
    const inside = l(0.5, "PART 1 - GENERAL");
    const outside = l(0.1, "SECTION 03 30 00");
    const result = bindSpecSectionsInRegion([inside, outside], [0.0, 0.4, 1.0, 0.3]);
    expect(result).toBeDefined();
    expect(result!.sections).toHaveLength(1);
    expect(result!.sections[0].sectionHeader).toBe("PART 1 - GENERAL");
  });
});
