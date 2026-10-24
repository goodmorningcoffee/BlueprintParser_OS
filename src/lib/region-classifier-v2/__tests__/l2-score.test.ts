/**
 * l2-score.test.ts — the class-row scorer (port of regions_rc.py `l2`) and the notes fallback
 * checklist (regions_rc2.py `fallback`) against the shipped class table.
 */
import { describe, it, expect } from "vitest";
import { REGION_CLASS_TABLE, TABLE_ROWS, TEXT_ROWS } from "../classes";
import { fallbackClass, scoreRows, tokenize, type L2Context } from "../l2-score";

const ctx = (words: string[], extra: Partial<L2Context> = {}): L2Context => ({
  tokens: tokenize(words),
  text: ` ${words.map((w) => w.toUpperCase()).join(" ")} `,
  csiDivisions: [],
  titleBlockText: "",
  ...extra,
});

describe("tokenize", () => {
  it("upper-cases and splits on the Python TOK pattern", () => {
    const t = tokenize(["Door", "door,", "U-Value", "120/208V", "(E)"]);
    expect(t.get("DOOR")).toBe(2);
    expect(t.get("U-VALUE")).toBe(1);
    expect(t.get("120/208V")).toBe(1);
    expect(t.get("E")).toBe(1); // parentheses are not token characters
  });
});

describe("scoreRows — tables family", () => {
  const fam = REGION_CLASS_TABLE.tables;

  it("a door schedule header + trade words clears the bar; repeats saturate at sqrt(3)", () => {
    const r = scoreRows(ctx(["DOOR", "SCHEDULE", "DOOR", "DOOR", "DOOR", "FRAME", "HARDWARE"]), fam, TABLE_ROWS);
    expect(r.cls).toBe("door schedule");
    // DOOR SCHEDULE phrase 4 + DOOR 1.5·√3 + FRAME 1.5 + HARDWARE 1 + schedule word prior 1
    expect(r.best.score).toBeCloseTo(4 + 1.5 * Math.sqrt(3) + 1.5 + 1 + 1, 1);
    expect(r.best.hits[0]).toBe("DOOR SCHEDULE");
    expect(r.scheduleWord).toBe(true);
    expect(r.m).toBeGreaterThan(0.9);
  });

  it("below min_score or with one distinct keyword → no class, and m = .63 exactly at the bar", () => {
    const one = scoreRows(ctx(["DOOR", "DOOR", "DOOR", "DOOR"]), fam, TABLE_ROWS); // 1.5·√3 ≈ 2.6, 1 keyword
    expect(one.cls).toBeNull();
    expect(one.best.cls).toBe("door schedule");
    expect(1 - Math.exp(-fam.rules.min_score / fam.rules.min_score)).toBeCloseTo(0.632, 3);
  });

  it("priors: title block, sheet-level door detections, shape tags, and the drawing-list opt-out", () => {
    const base = scoreRows(ctx(["DOOR", "FRAME"]), fam, TABLE_ROWS).best;
    const tb = scoreRows(ctx(["DOOR", "FRAME"], { titleBlockText: "DOOR SCHEDULES" }), fam, TABLE_ROWS).best;
    expect(tb.score - base.score).toBeCloseTo(fam.rules.titleblock_weight, 5);
    const minus = scoreRows(ctx(["DOOR", "FRAME"], { titleBlockText: "ELECTRICAL" }), fam, TABLE_ROWS).best;
    expect(minus.score - base.score).toBeCloseTo(-fam.rules.titleblock_weight, 5);
    const sheet = scoreRows(ctx(["DOOR", "FRAME"], { sheetCounts: new Map([["door_single", 12]]) }), fam, TABLE_ROWS).best;
    expect(sheet.score - base.score).toBeCloseTo(fam.rules.sheet_yolo_weight!, 5);
    expect(sheet.priors).toContain("sheet has door_single ×12");
    const tags = scoreRows(ctx(["DOOR", "FRAME"], { tagShapes: 5 }), fam, TABLE_ROWS).best;
    expect(tags.score - base.score).toBeCloseTo(fam.rules.tag_weight!, 5);
    // drawing list: is_schedule false ⇒ the SCHEDULE word adds nothing to that row
    const dl = scoreRows(ctx(["SHEET", "INDEX", "SCHEDULE"]), fam, TABLE_ROWS);
    expect(dl.best.cls).toBe("drawing list");
    expect(dl.best.prior).toBe(0);
  });

  it("CSI divisions add csi_weight × share only with ≥ csi_min_codes codes inside", () => {
    const none = scoreRows(ctx(["WINDOW", "GLAZING"], { csiDivisions: ["08"] }), fam, TABLE_ROWS).best;
    expect(none.csi).toBe(0);
    const two = scoreRows(ctx(["WINDOW", "GLAZING"], { csiDivisions: ["08", "09"] }), fam, TABLE_ROWS).best;
    expect(two.cls).toBe("window schedule");
    expect(two.csi).toBeCloseTo(fam.rules.csi_weight * 0.5, 2);
  });

  it("ties break on class name (stable, like the Python sort key)", () => {
    const r = scoreRows(ctx([]), fam, TABLE_ROWS);
    expect(r.best.cls).toBe("HVAC equipment schedule"); // uppercase sorts first — same as Python
    expect(r.cls).toBeNull();
  });
});

describe("scoreRows — text family (min_keywords 1: a header alone decides)", () => {
  const fam = REGION_CLASS_TABLE.text;
  it("KEYNOTES names the box; GENERAL NOTES names general notes", () => {
    expect(scoreRows(ctx(["KEYNOTES"]), fam, TEXT_ROWS).cls).toBe("keynotes");
    expect(scoreRows(ctx(["GENERAL", "NOTES", "CONTRACTOR", "SHALL"]), fam, TEXT_ROWS).cls).toBe("general notes");
    expect(scoreRows(ctx(["SYMBOL", "LEGEND"]), fam, TEXT_ROWS).cls).toBe("symbol legend");
  });
});

describe("fallbackClass — the notes hierarchy checklist", () => {
  const F = REGION_CLASS_TABLE.text.fallback!;
  const input = (words: string[], extra: Partial<Parameters<typeof fallbackClass>[1]> = {}) => ({
    tokens: tokenize(words), wordCount: words.length, csiCount: 0, overlapsTable: false, ...extra,
  });
  it("table text first, then short label, then view title", () => {
    expect(fallbackClass(F, input(["A", "B"], { overlapsTable: true }))?.name).toBe("table text (see Tables tab)");
    expect(fallbackClass(F, input(["ROOM", "101"]))?.name).toBe("short label");
    const title = Array.from({ length: 12 }, (_, i) => (i === 0 ? "ENLARGED" : i === 1 ? "PLAN" : `W${i}`));
    expect(fallbackClass(F, input(title))?.name).toBe("view title / callout");
  });
  it("notes (untitled) needs ≥ 20 words and 3 note-ish hits; digits_share closes the list", () => {
    const notes = ["CONTRACTOR", "SHALL", "VERIFY", ...Array.from({ length: 20 }, (_, i) => `X${i}`)];
    expect(fallbackClass(F, input(notes))?.name).toBe("notes (untitled)");
    const digits = Array.from({ length: 12 }, (_, i) => `${i}`);
    expect(fallbackClass(F, input(digits))?.name).toBe("dimensions / data");
    const nothing = Array.from({ length: 12 }, (_, i) => `ZQ${"X".repeat(i)}`);
    expect(fallbackClass(F, input(nothing))).toBeNull();
  });
  it("labelClasses lists the page-label buckets", () => {
    expect(F.labelClasses).toContain("short label");
    expect(F.labelClasses).not.toContain("notes (untitled)");
    for (const name of F.labelClasses ?? []) expect(F.rules.map((r) => r.name)).toContain(name);
  });
});
