// @vitest-environment node
// [table pipeline WP-3.F] Content-keyed text-region verdicts, the inbox kind table and the ≥ 3-keys rule
// (PLAN §2.1, K30, C2-m5, C2-m8). All strings are synthetic.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  countParagraphKeys,
  findTextRegionVerdict,
  isLegendKeyValue,
  kindFamily,
  matchingTextRegionVerdictKeys,
  storedTextRegionVerdicts,
  textRegionInboxKind,
  textRegionKey,
  textRegionMinMax,
} from "../text-region-verdicts";

const AT = "2026-10-27T00:00:00.000Z";

describe("matchingTextRegionVerdictKeys (verify LOW-4)", () => {
  it("lists the exact key and every same-type verdict at IoU ≥ .7, never another type or a far block", () => {
    const b = [0.1, 0.1, 0.4, 0.3] as [number, number, number, number];
    const verdicts = {
      [textRegionKey("notes-numbered", b)]: { verdict: "reject" as const, type: "notes-numbered", b, at: AT },
      "tr:notes-numbered:0.11,0.10,0.40,0.30": { verdict: "reject" as const, type: "notes-numbered", b: [0.11, 0.1, 0.4, 0.3] as [number, number, number, number], at: AT },
      "tr:spec-dense-columns:0.10,0.10,0.40,0.30": { verdict: "reject" as const, type: "spec-dense-columns", b, at: AT },
      "tr:notes-numbered:0.60,0.60,0.90,0.80": { verdict: "reject" as const, type: "notes-numbered", b: [0.6, 0.6, 0.9, 0.8] as [number, number, number, number], at: AT },
    };
    expect(matchingTextRegionVerdictKeys(verdicts, "notes-numbered", b)).toEqual([
      "tr:notes-numbered:0.10,0.10,0.40,0.30", "tr:notes-numbered:0.11,0.10,0.40,0.30",
    ]);
  });
});

describe("text-region content key", () => {
  it("is type + MinMax box at two decimals, so a re-OCR wobble keeps the key and a different block does not", () => {
    expect(textRegionKey("notes-numbered", [0.1, 0.2, 0.5, 0.6])).toBe("tr:notes-numbered:0.10,0.20,0.50,0.60");
    expect(textRegionKey("notes-numbered", [0.1001, 0.2002, 0.4999, 0.6])).toBe("tr:notes-numbered:0.10,0.20,0.50,0.60");
    expect(textRegionKey("spec-dense-columns", [0.1, 0.2, 0.5, 0.6])).not.toBe(textRegionKey("notes-numbered", [0.1, 0.2, 0.5, 0.6]));
  });

  it("converts the stored LTWH box at the edge (E-4)", () => {
    expect(textRegionMinMax({ bbox: [0.1, 0.2, 0.3, 0.4] })).toEqual([0.1, 0.2, 0.4, 0.6000000000000001]);
    expect(textRegionMinMax({ bbox: [0.1, 0.2, 0.3] })).toBeNull();
  });
});

describe("findTextRegionVerdict (IoU ≥ .7, same type)", () => {
  const verdicts = {
    "tr:notes-numbered:0.10,0.10,0.50,0.50": { verdict: "reject" as const, type: "notes-numbered", b: [0.1, 0.1, 0.5, 0.5] as [number, number, number, number], at: AT },
  };

  it("matches the exact key, a slightly moved box, and never another type or a different block", () => {
    expect(findTextRegionVerdict(verdicts, "notes-numbered", [0.1, 0.1, 0.5, 0.5])?.verdict).toBe("reject");
    expect(findTextRegionVerdict(verdicts, "notes-numbered", [0.11, 0.1, 0.51, 0.52])?.key).toBe("tr:notes-numbered:0.10,0.10,0.50,0.50");
    expect(findTextRegionVerdict(verdicts, "notes-key-value", [0.1, 0.1, 0.5, 0.5])).toBeNull();
    expect(findTextRegionVerdict(verdicts, "notes-numbered", [0.1, 0.6, 0.5, 0.9])).toBeNull();
  });

  it("reads only well-formed stored entries", () => {
    const pi = { textRegionVerdicts: { ...verdicts, bad: { verdict: "maybe" }, worse: null } };
    expect(Object.keys(storedTextRegionVerdicts(pi))).toEqual(["tr:notes-numbered:0.10,0.10,0.50,0.50"]);
    expect(storedTextRegionVerdicts({ textRegionVerdicts: [] })).toEqual({});
    expect(storedTextRegionVerdicts(null)).toEqual({});
  });
});

describe("the ≥ 3-keys rule (C2-m5) and the kind table (C2-m8)", () => {
  it("counts line-opening numbered keys; measurements and scales are not keys", () => {
    expect(countParagraphKeys("1. LOREM IPSUM\n2. DOLOR SIT\n3) AMET\n(4) QUX")).toBe(4);
    expect(countParagraphKeys("2.5 MM GAP\n1:50 SCALE\n10 MM")).toBe(0);
    expect(countParagraphKeys("1. LOREM\n1. LOREM AGAIN")).toBe(1);
    expect(countParagraphKeys(undefined)).toBe(0);
  });

  it("maps every TextRegion type", () => {
    expect(textRegionInboxKind({ type: "notes-numbered" })).toBe("notes");
    expect(textRegionInboxKind({ type: "spec-dense-columns" })).toBe("spec");
    expect(textRegionInboxKind({ type: "schedule-table" })).toBe("schedule");
    expect(textRegionInboxKind({ type: "schedule-table", classifiedLabels: { tier1: "KEYNOTE" } })).toBe("keynote");
    expect(textRegionInboxKind({ type: "unknown" })).toBeNull();
    expect(textRegionInboxKind({ type: "notes-key-value", classifiedLabels: { tier1: "ABBREVIATIONS" } })).toBe("legend");
    expect(textRegionInboxKind({ type: "notes-key-value", containedText: "QX LOREM\nZZY IPSUM\nAB DOLOR" })).toBe("legend");
    expect(textRegionInboxKind({ type: "notes-key-value", containedText: "1 LOREM\n2 IPSUM\n3 DOLOR" })).toBe("notes");
  });

  it("a paragraph is a notes item only with numbered items and ≥ 3 keys from containedText or rowCount", () => {
    const three = "1. LOREM\n2. IPSUM\n3. DOLOR";
    expect(textRegionInboxKind({ type: "paragraph", hasNumberedItems: true, containedText: three })).toBe("notes");
    expect(textRegionInboxKind({ type: "paragraph", hasNumberedItems: true, rowCount: 3 })).toBe("notes");
    expect(textRegionInboxKind({ type: "paragraph", hasNumberedItems: true, containedText: "1. LOREM\n2. IPSUM", rowCount: 2 })).toBeNull();
    expect(textRegionInboxKind({ type: "paragraph", hasNumberedItems: false, containedText: three, rowCount: 9 })).toBeNull();
  });

  it("legend detection uses the grid's key column when present", () => {
    expect(isLegendKeyValue({ grid: { headers: ["Key", "Note"], rows: [{ Key: "QX" }, { Key: "ZY" }, { Key: "1" }] } })).toBe(true);
    expect(isLegendKeyValue({ grid: { headers: ["Key", "Note"], rows: [{ Key: "1" }, { Key: "2" }, { Key: "QX" }] } })).toBe(false);
  });

  it("families keep tables and text apart", () => {
    expect(["schedule", "keynote", "legend"].map((k) => kindFamily(k as never))).toEqual(["table", "table", "table"]);
    expect(["notes", "spec"].map((k) => kindFamily(k as never))).toEqual(["text", "text"]);
  });
});

describe("client-safe import purity (E-8)", () => {
  it("text-region-verdicts imports only ./types and ./geometry", () => {
    const file = join(process.cwd(), "src/lib/parse-engine/text-region-verdicts.ts");
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((f) => f.fileName);
    expect(imports.sort()).toEqual(["./geometry", "./types"]);
  });
});
