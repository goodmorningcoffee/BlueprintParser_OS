// @vitest-environment node
// [table pipeline WP-3.C] Paragraph key grammar (K35), header grammar (K34), sheet keys (K67) and
// addresses (C2-M8). Pure modules; all text is synthetic pseudo-words (rule 12).
import { describe, expect, it } from "vitest";
import { normaliseSheetNumber } from "@/lib/knowledge-graph/sheet-number";
import {
  formatParagraphAddress,
  paragraphAddress,
  paragraphAddressId,
  sheetDistance,
  sheetKey,
  sheetOrdinal,
  sheetPrefix,
} from "../paragraphs/address";
import {
  countKeyedLines,
  formatSection,
  isGeneralNotesHeader,
  isKeyedLine,
  matchHeader,
  matchKey,
  normaliseHeader,
  normaliseKey,
  sectionNorm,
} from "../paragraphs/keys";

describe("matchKey (K35: a key is the whole first token)", () => {
  it("accepts punctuated numbers, letters, articles and hyphenated tags as strong keys", () => {
    expect(matchKey("1. ZFKMP SNIEV")).toMatchObject({ key: "1", cls: "number", strong: true, ordinal: 1, rest: "ZFKMP SNIEV" });
    expect(matchKey("(12) ZFKMP")).toMatchObject({ key: "12", cls: "number", strong: true, ordinal: 12 });
    expect(matchKey("3) ZFKMP")).toMatchObject({ key: "3", strong: true });
    expect(matchKey("4: ZFKMP")).toMatchObject({ key: "4", strong: true });
    expect(matchKey("A. ZFKMP")).toMatchObject({ key: "A", cls: "upper", strong: true, ordinal: 1 });
    expect(matchKey("b) ZFKMP")).toMatchObject({ key: "b", cls: "lower", strong: true, ordinal: 2 });
    expect(matchKey("1.01 ZFKMP")).toMatchObject({ key: "1.01", cls: "article", strong: true, ordinal: 101, group: "1" });
    expect(matchKey("2.02. ZFKMP")).toMatchObject({ key: "2.02", cls: "article", strong: true });
    expect(matchKey("K-01 ZFKMP")).toMatchObject({ key: "K-01", cls: "tag", strong: true, ordinal: 1, group: "K" });
    expect(matchKey("EF-10. ZFKMP")).toMatchObject({ key: "EF-10", cls: "tag", strong: true, ordinal: 10 });
  });

  it("bare numbers, one-decimal articles and bare tags are weak keys", () => {
    expect(matchKey("1 ZFKMP SNIEV")).toMatchObject({ key: "1", cls: "number", strong: false });
    expect(matchKey("2.3 ZFKMP")).toMatchObject({ key: "2.3", cls: "article", strong: false, ordinal: 230 });
    expect(matchKey("A1 ZFKMP")).toMatchObject({ key: "A1", cls: "tag", strong: false });
  });

  it("dimensions, scales and prose are not keys", () => {
    expect(matchKey("2.5 MM ZFKMP")).toMatchObject({ cls: "article", strong: false }); // weak: the segmenter needs sequence + column
    expect(matchKey("1:50 ZFKMP")).toBeNull();
    expect(matchKey("1/2 ZFKMP")).toBeNull();
    expect(matchKey("12.345 ZFKMP")).toBeNull();
    expect(matchKey("see note 4 zfkmp")).toBeNull();
    expect(matchKey("ZFKMP 1. SNIEV")).toBeNull();
    expect(matchKey("")).toBeNull();
    expect(matchKey("   ")).toBeNull();
    expect(matchKey("A-101 ZFKMP")).toMatchObject({ cls: "tag" }); // a sheet-coded note key is a tag; the resolver never sees it as a sheet
  });

  it("isKeyedLine / countKeyedLines count strong keys only (the §2.1 inbox rule)", () => {
    expect(isKeyedLine("1. ZFKMP")).toBe(true);
    expect(isKeyedLine("1 ZFKMP")).toBe(false);
    expect(countKeyedLines("1. A\n2. B\n2.5 MM C\n3) D")).toBe(3);
    expect(countKeyedLines(["(1) A", "ZFKMP", "A. B"])).toBe(2);
  });

  it("normaliseKey: upper-case, separators out, leading zeros out of pure numbers only", () => {
    expect(normaliseKey("(04)")).toBe("4");
    expect(normaliseKey("4.")).toBe("4");
    expect(normaliseKey("K-01")).toBe("K01");
    expect(normaliseKey("k 01")).toBe("K01");
    expect(normaliseKey("1.01")).toBe("1.01");
    expect(normaliseKey("a")).toBe("A");
    expect(normaliseKey(null)).toBe("");
    expect(normaliseKey("")).toBe("");
  });

  it("sectionNorm / formatSection round-trip", () => {
    expect(sectionNorm("08 71 00")).toBe("087100");
    expect(sectionNorm("087100")).toBe("087100");
    expect(sectionNorm("09 29 00.13")).toBe("09290013");
    expect(formatSection("087100")).toBe("08 71 00");
    expect(formatSection("09290013")).toBe("09 29 00.13");
    expect(sectionNorm(null)).toBe("");
  });
});

describe("matchHeader (K34: a header is a whole upper-case line)", () => {
  it("recognises notes, legend and spec headers", () => {
    expect(matchHeader("GENERAL NOTES")).toMatchObject({ kind: "notes", headerNorm: "GENERAL NOTES", continued: false });
    expect(matchHeader("ELECTRICAL NOTES:")).toMatchObject({ kind: "notes", headerNorm: "ELECTRICAL NOTES" });
    expect(matchHeader("NOTES")).toMatchObject({ kind: "notes" });
    expect(matchHeader("NOTE")).toMatchObject({ kind: "notes" });
    expect(matchHeader("KEYNOTES")).toMatchObject({ kind: "notes" });
    expect(matchHeader("KEY NOTE LEGEND")).toMatchObject({ kind: "legend" });
    expect(matchHeader("ABBREVIATIONS")).toMatchObject({ kind: "legend", headerNorm: "ABBREVIATIONS" });
    expect(matchHeader("SYMBOL LEGEND")).toMatchObject({ kind: "legend" });
    expect(matchHeader("SECTION 08 71 00 - ZFKMP SNIEV")).toMatchObject({ kind: "spec-section", section: "08 71 00" });
    expect(matchHeader("SECTION 092900.13 ZFKMP")).toMatchObject({ kind: "spec-section", section: "09 29 00.13" });
    expect(matchHeader("PART 2 - PRODUCTS")).toMatchObject({ kind: "spec-part", part: 2 });
    expect(matchHeader("END OF SECTION")).toMatchObject({ kind: "end-of-section" });
  });

  it("marks continued blocks and normalises the header without the mark (§1.7 rule 5)", () => {
    for (const h of ["GENERAL NOTES (CONT.)", "GENERAL NOTES (CONT'D)", "GENERAL NOTES (CONTINUED)", "GENERAL NOTES CONTINUED", "GENERAL NOTES - CONT'D", "GENERAL NOTES (CONT.):"]) {
      expect(matchHeader(h), h).toMatchObject({ kind: "notes", headerNorm: "GENERAL NOTES", continued: true });
    }
    expect(normaliseHeader("Electrical Notes (Cont.):")).toBe("ELECTRICAL NOTES");
  });

  it("does not open a header on a sentence, a mixed-case line, a keyed line or a long line (K34)", () => {
    expect(matchHeader("see note 4 zfkmp sniev")).toBeNull();
    expect(matchHeader("Notes: provide shims")).toBeNull();
    expect(matchHeader("NOTES: PROVIDE SHIMS")).toBeNull();
    expect(matchHeader("4. NOTES ARE TYPICAL")).toBeNull();
    expect(matchHeader("1.01 GENERAL NOTES")).toBeNull();
    expect(matchHeader("ZFKMP SNIEV HTJWZ DCZRP EJBC ZYSFM QTMYBW JHWUL ESEUS LOZC QEISL NOTES")).toBeNull(); // > 60 chars
    expect(matchHeader("ZFKMP ZYSFM SCHEDULE")).toBeNull();
    expect(matchHeader("CONTRACTOR SHALL VERIFY")).toBeNull();
  });

  it("isGeneralNotesHeader needs GENERAL and NOTES", () => {
    expect(isGeneralNotesHeader("GENERAL NOTES")).toBe(true);
    expect(isGeneralNotesHeader("GENERAL CONSTRUCTION NOTES")).toBe(true);
    expect(isGeneralNotesHeader("ELECTRICAL NOTES")).toBe(false);
    expect(isGeneralNotesHeader("GENERAL")).toBe(false);
    expect(isGeneralNotesHeader(null)).toBe(false);
  });
});

describe("sheetKey (K67: the KG grammar, widened)", () => {
  it("accepts A-101A, A.101 and 4-letter prefixes", () => {
    expect(sheetKey("A-101A")).toBe("A101A");
    expect(sheetKey("a-101a")).toBe("A101A");
    expect(sheetKey("A.101")).toBe("A101");
    expect(sheetKey("ABCD-101")).toBe("ABCD101");
    expect(sheetKey("ABCD101.02")).toBe("ABCD101.02");
    expect(sheetKey("A-101A.00")).toBe("A101A");
  });

  it("gives the KG key for every input the KG accepts (the two never drift)", () => {
    const inputs = ["E-300", "E300", "E 300", "e-300", "E-300.00", "E_300", "A101.01", "A-101.1", "FA-001", "T001.04", "GSQ22", "M-1", "S 0001.99"];
    for (const raw of inputs) {
      const kg = normaliseSheetNumber(raw);
      expect(kg, raw).not.toBeNull();
      expect(sheetKey(raw), raw).toBe(kg);
    }
  });

  it("returns null for prose, blanks and malformed numbers", () => {
    for (const raw of [null, undefined, "", "  ", "SEE SHEET", "101", "A", "A-", "A-12345", "A-101-B", "ABCDE-101", "A-101AAA", "eoe2 text"]) {
      expect(sheetKey(raw), String(raw)).toBeNull();
    }
  });

  it("prefix, ordinal and distance", () => {
    expect(sheetPrefix("A101A")).toBe("A");
    expect(sheetPrefix("ABCD101")).toBe("ABCD");
    expect(sheetPrefix("101")).toBeNull();
    expect(sheetOrdinal("A101")).toBe(101);
    expect(sheetOrdinal("A101.04")).toBeCloseTo(101.04, 6);
    expect(sheetOrdinal("A101A")).toBeCloseTo(101.001, 6);
    expect(sheetDistance("A101", "A501")).toBe(400);
    expect(sheetDistance("A101", "E101")).toBeNull();
    expect(sheetDistance("A101", null)).toBeNull();
  });
});

describe("paragraph addresses (C2-M8)", () => {
  const a = paragraphAddress({ planset: "ps1", page: 7, drawingNumber: "A-501", regionId: "sr-notes-7-abc", blockHeader: "ELECTRICAL NOTES", keyPath: ["3"], targetId: "p3" });

  it("is computed from the CURRENT drawing number, with p<page> when there is none", () => {
    expect(a).toEqual({ planset: "ps1", sheet: "A501", page: 7, regionId: "sr-notes-7-abc", blockHeader: "ELECTRICAL NOTES", keyPath: ["3"], targetId: "p3" });
    expect(paragraphAddress({ ...a, drawingNumber: null, page: 9 }).sheet).toBe("p9");
    expect(paragraphAddress({ ...a, drawingNumber: "cover" }).sheet).toBe("p7");
  });

  it("display, machine and spec forms", () => {
    expect(formatParagraphAddress(a)).toBe("A501 › ELECTRICAL NOTES › 3");
    expect(formatParagraphAddress(a, { sheetLabel: "A-501" })).toBe("A-501 › ELECTRICAL NOTES › 3");
    expect(formatParagraphAddress({ ...a, blockHeader: null })).toBe("A501 › 3");
    expect(formatParagraphAddress({ ...a, keyPath: [] })).toBe("A501 › ELECTRICAL NOTES › ¶");
    expect(formatParagraphAddress({ ...a, keyPath: ["2.3", "A"] }, { specSection: "08 71 00" })).toBe("08 71 00 › 2.3.A");
    expect(paragraphAddressId(a)).toBe("para:A501/ELECTRICAL NOTES/3");
    expect(paragraphAddressId({ ...a, blockHeader: "A/B NOTES", keyPath: ["1.01", "A"] })).toBe("para:A501/A%2FB NOTES/1.01/A");
    expect(paragraphAddressId({ ...a, blockHeader: null })).toBe("para:A501//3");
  });
});

// WP-3.C fix round (WP-3.C.VERIFY.md MED-5, LOW-1)
describe("verify-round grammar fixes", () => {
  it("MED-5: mixed-case SECTION / PART headers are spec headers; prose PART lines are not", () => {
    expect(matchHeader("SECTION 08 71 00 - Zfkmp Dczrp")).toMatchObject({ kind: "spec-section", section: "08 71 00", headerNorm: "SECTION 08 71 00 ZFKMP DCZRP" });
    expect(matchHeader("PART 1 - General")).toMatchObject({ kind: "spec-part", part: 1 });
    expect(matchHeader("PART 2 Products and Materials")).toMatchObject({ kind: "spec-part", part: 2 });
    expect(matchHeader("PART 1 of the work shall be zfkmp")).toBeNull();
    expect(matchHeader("General Notes")).toBeNull(); // K34 still holds for the notes grammar
  });
  it("MED-5: GENERAL NOTES - CONTINUED is a continued header", () => {
    expect(matchHeader("GENERAL NOTES - CONTINUED")).toMatchObject({ kind: "notes", continued: true, headerNorm: "GENERAL NOTES" });
    expect(matchHeader("GENERAL NOTES – CONT'D")).toMatchObject({ continued: true, headerNorm: "GENERAL NOTES" });
  });
  it("LOW-1: 4-letter prose before a number is not a sheet key; 4-letter disciplines with 3+ digits are", () => {
    for (const raw of ["NOTE 4", "PART 2", "TYPE 12", "ROOM 101", "DOOR 105", "ABCD-12"]) expect(sheetKey(raw), raw).toBeNull();
    expect(sheetKey("ABCD-101")).toBe("ABCD101");
  });
});

