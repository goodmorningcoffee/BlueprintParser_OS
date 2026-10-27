// @vitest-environment node
// [table pipeline WP-3.C] §1.7 reference resolution on a hand-built index (synthetic ids and headers only).
import { describe, expect, it } from "vitest";
import { blocksSliceOf, keyLookupVariants, kindHintFromPhrase, orderCandidates, resolveReference, splitKeyPath } from "../paragraphs/resolve";
import type { StructureIndexKeyEntry, StructureIndexRegion } from "../types";
import type { ReferenceQuery, ResolvedCandidate, ResolverIndex } from "../types-paragraphs";

const region = (regionId: string, kind: StructureIndexRegion["kind"], bbox: StructureIndexRegion["bbox"], origin: StructureIndexRegion["origin"] = "workspace"): StructureIndexRegion => ({
  regionId, kind, title: regionId.toUpperCase(), bbox, rows: 0, origin,
});
const e = (regionId: string, kind: StructureIndexKeyEntry[1], targetId: string, header: string | null): StructureIndexKeyEntry => [regionId, kind, targetId, header];

/**
 * p1 A-101  SHEET NOTES 1-2 (classic region) + keynote legend rows 3, 12
 * p2 A-501  ELECTRICAL NOTES 1-7 + GENERAL NOTES 3-4 + a schedule with footnote 3
 * p3 A-502  ELECTRICAL NOTES (CONT.) 8-10 + spec section 08 71 00 (2.3, 2.3.A)
 * p4 E-101  GENERAL NOTES 3
 * p5 G-001  "GENERAL NOTES" sheet: 3, 9
 * p6 A-503  nothing keyed
 * p7 A-901  GENERAL NOTES 3
 */
function makeIndex(withBlocks = true): ResolverIndex {
  const idx: ResolverIndex = {
    sheets: [
      { page: 1, raw: "A-101", title: "FLOOR PLAN" },
      { page: 2, raw: "A-501", title: "DETAILS" },
      { page: 3, raw: "A-502", title: "DETAILS" },
      { page: 4, raw: "E-101", title: "POWER PLAN" },
      { page: 5, raw: "G-001", title: "GENERAL NOTES" },
      { page: 6, raw: "A-503", title: "DETAILS" },
      { page: 7, raw: "A-901", title: "DETAILS" },
    ],
    regions: {
      "1": [region("sr-notes-1", "notes", [0.6, 0.1, 0.9, 0.4], "classic"), region("pr-keynote-1", "keynote", [0.6, 0.5, 0.9, 0.8])],
      "2": [region("sr-notes-2", "notes", [0.6, 0.1, 0.9, 0.5]), region("sr-gen-2", "notes", [0.6, 0.6, 0.9, 0.9]), region("sr-sched-2", "schedule", [0.1, 0.1, 0.5, 0.5])],
      "3": [region("sr-notes-3", "notes", [0.6, 0.1, 0.9, 0.3]), region("sr-spec-3", "spec", [0.1, 0.1, 0.5, 0.9])],
      "4": [region("sr-notes-4", "notes", [0.6, 0.1, 0.9, 0.5])],
      "5": [region("sr-gen-5", "notes", [0.1, 0.1, 0.9, 0.9])],
      "7": [region("sr-gen-7", "notes", [0.1, 0.1, 0.9, 0.9])],
    },
    keys: {
      "1": { "1": [e("sr-notes-1", "notes", "p1", "SHEET NOTES")], "2": [e("sr-notes-1", "notes", "p2", "SHEET NOTES")], "3": [e("pr-keynote-1", "keynote", "r1", null)], "12": [e("pr-keynote-1", "keynote", "r3", null)] },
      "2": {
        "1": [e("sr-notes-2", "notes", "p1", "ELECTRICAL NOTES")],
        "2": [e("sr-notes-2", "notes", "p2", "ELECTRICAL NOTES")],
        "3": [e("sr-notes-2", "notes", "p3", "ELECTRICAL NOTES"), e("sr-gen-2", "notes", "p3", "GENERAL NOTES"), e("sr-sched-2", "schedule", "p1", "NOTES")],
        "4": [e("sr-notes-2", "notes", "p4", "ELECTRICAL NOTES"), e("sr-gen-2", "notes", "p4", "GENERAL NOTES")],
        "5": [e("sr-notes-2", "notes", "p5", "ELECTRICAL NOTES")],
        "6": [e("sr-notes-2", "notes", "p6", "ELECTRICAL NOTES")],
        "7": [e("sr-notes-2", "notes", "p7", "ELECTRICAL NOTES")],
        "A": [e("sr-sched-2", "schedule", "r2", null)],
      },
      "3": {
        "8": [e("sr-notes-3", "notes", "p8", "ELECTRICAL NOTES")],
        "9": [e("sr-notes-3", "notes", "p9", "ELECTRICAL NOTES")],
        "10": [e("sr-notes-3", "notes", "p10", "ELECTRICAL NOTES")],
        "2.3": [e("sr-spec-3", "spec", "p5", "PART 2 PRODUCTS")],
        "A": [e("sr-spec-3", "spec", "p6", "PART 2 PRODUCTS"), e("sr-spec-3", "spec", "p9", "PART 3 EXECUTION")],
        "2.3.A": [e("sr-spec-3", "spec", "p6", "PART 2 PRODUCTS")],
      },
      "4": { "3": [e("sr-notes-4", "notes", "p3", "GENERAL NOTES")] },
      "5": { "3": [e("sr-gen-5", "notes", "p3", "GENERAL NOTES")], "9": [e("sr-gen-5", "notes", "p9", "GENERAL NOTES")] },
      "7": { "3": [e("sr-gen-7", "notes", "p3", "GENERAL NOTES")] },
    },
    specSections: { "087100": [[3, "sr-spec-3"]] },
  };
  if (withBlocks) {
    idx.blocks = {
      "2": [
        { regionId: "sr-notes-2", blockId: "b1", headerNorm: "ELECTRICAL NOTES" },
        { regionId: "sr-gen-2", blockId: "b1", headerNorm: "GENERAL NOTES" },
      ],
      "3": [{ regionId: "sr-notes-3", blockId: "b1", headerNorm: "ELECTRICAL NOTES", continued: true }],
    };
  }
  return idx;
}

const q = (page: number, key: string, kind: ReferenceQuery["kind"] = "note", extra: Partial<ReferenceQuery> = {}): ReferenceQuery => ({ page, key, kind, ...extra });
const hit = (o: ReturnType<typeof resolveReference>) => (o.status === "resolved" ? [o.hit.page, o.hit.regionId, o.hit.targetId, o.level] : o);

describe("resolveReference: explicit sheet (rule 2)", () => {
  const idx = makeIndex();
  it("resolves on the page whose current drawing number has the same sheet key, in any spelling", () => {
    for (const sheet of ["A-501", "A501", "a 501", "A-501.00"]) {
      expect(hit(resolveReference(q(1, "5", "note", { sheet }), idx)), sheet).toEqual([2, "sr-notes-2", "p5", "explicit-sheet"]);
    }
  });
  it("an unknown sheet is unresolved with no fallback page", () => {
    expect(resolveReference(q(1, "5", "note", { sheet: "A-999" }), idx)).toEqual({ status: "unresolved", reason: "no-sheet", fallbackPages: [] });
  });
  it("a sheet with no such key names its page for the read-time fallback", () => {
    expect(resolveReference(q(1, "77", "note", { sheet: "A-503" }), idx)).toEqual({ status: "unresolved", reason: "no-candidates", fallbackPages: [6] });
  });
  it("two blocks with the same key on the named sheet are ambiguous", () => {
    const o = resolveReference(q(1, "4", "note", { sheet: "A-501" }), idx);
    expect(o.status).toBe("ambiguous");
    if (o.status === "ambiguous") expect(o.candidates.map((c) => c.regionId)).toEqual(["sr-gen-2", "sr-notes-2"]);
  });
  it("the explicit sheet wins over the mention's own sheet", () => {
    expect(hit(resolveReference(q(2, "1", "note", { sheet: "A-101" }), idx))).toEqual([1, "sr-notes-1", "p1", "explicit-sheet"]);
  });
});

describe("resolveReference: spec section (rule 3)", () => {
  const idx = makeIndex();
  it("finds the paragraph inside the section, by leaf key or by full path", () => {
    expect(hit(resolveReference(q(1, "2.3", "spec", { section: "08 71 00" }), idx))).toEqual([3, "sr-spec-3", "p5", "spec-section"]);
    expect(hit(resolveReference(q(1, "2.3.A", "spec", { section: "087100" }), idx))).toEqual([3, "sr-spec-3", "p6", "spec-section"]);
    expect(hit(resolveReference(q(1, "2.3 › A", "spec", { section: "08 71 00" }), idx))).toEqual([3, "sr-spec-3", "p6", "spec-section"]);
  });
  it("a bare leaf that appears twice in the section is ambiguous; a bare section resolves to the region", () => {
    const o = resolveReference(q(1, "A", "spec", { section: "08 71 00" }), idx);
    expect(o.status).toBe("ambiguous");
    expect(hit(resolveReference(q(1, "", "spec", { section: "08 71 00" }), idx))).toEqual([3, "sr-spec-3", "sr-spec-3", "spec-section"]);
  });
  it("an unknown section, or a known one without the paragraph", () => {
    expect(resolveReference(q(1, "2.3", "spec", { section: "09 91 23" }), idx)).toEqual({ status: "unresolved", reason: "no-section", fallbackPages: [] });
    expect(resolveReference(q(1, "9.9", "spec", { section: "08 71 00" }), idx)).toEqual({ status: "unresolved", reason: "no-candidates", fallbackPages: [3] });
  });
});

describe("resolveReference: bare references (rule 4)", () => {
  const idx = makeIndex();
  it("4a: a mention inside a schedule resolves to the schedule's own footnote first", () => {
    expect(hit(resolveReference(q(2, "3", "note", { b: [0.2, 0.2, 0.23, 0.21] }), idx))).toEqual([2, "sr-sched-2", "p1", "same-region"]);
    expect(hit(resolveReference(q(2, "3", "note", { regionId: "sr-sched-2" }), idx))).toEqual([2, "sr-sched-2", "p1", "same-region"]);
  });
  it("4a does not apply outside the schedule: the same key is then ambiguous across the sheet's notes and footnotes", () => {
    const o = resolveReference(q(2, "3", "note", { b: [0.7, 0.2, 0.72, 0.21] }), idx);
    expect(o.status).toBe("ambiguous");
    if (o.status === "ambiguous") {
      expect(o.level).toBe("same-sheet");
      expect(o.candidates.map((c) => `${c.regionId}/${c.targetId}`).sort()).toEqual(["sr-gen-2/p3", "sr-notes-2/p3", "sr-sched-2/p1"]);
    }
  });
  it("4b: same sheet", () => {
    expect(hit(resolveReference(q(2, "5"), idx))).toEqual([2, "sr-notes-2", "p5", "same-sheet"]);
    expect(hit(resolveReference(q(1, "2"), idx))).toEqual([1, "sr-notes-1", "p2", "same-sheet"]);
  });
  it("a keynote-legend row is not a note target, and a note is not a keynote target", () => {
    expect(hit(resolveReference(q(1, "12", "keynote"), idx))).toEqual([1, "pr-keynote-1", "r3", "same-sheet"]);
    expect(resolveReference(q(1, "1", "keynote"), idx)).toEqual({ status: "unresolved", reason: "no-candidates", fallbackPages: [1] });
    // "3" on A-101 is only a keynote row → a NOTE reference falls through to the GENERAL NOTES blocks of the A sheets
    const o = resolveReference(q(1, "3", "note"), idx);
    expect(o.status).toBe("ambiguous");
    if (o.status === "ambiguous") expect(o.candidates.map((c) => [c.page, c.regionId, c.level])).toEqual([[2, "sr-gen-2", "general-notes"], [7, "sr-gen-7", "general-notes"]]);
  });
  it("4c: general notes on the same discipline first, then the project's general sheets", () => {
    const o = resolveReference(q(1, "3", "general-note"), idx);
    expect(o.status === "ambiguous" && o.candidates.map((c) => c.page)).toEqual([2, 7]);
    // E-101 has no note 9 and no other E sheet: the G-001 GENERAL NOTES sheet answers
    expect(hit(resolveReference(q(4, "9"), idx))).toEqual([5, "sr-gen-5", "p9", "general-notes"]);
    // a GENERAL NOTES block on the mention's own sheet is level 4b, not 4c
    expect(hit(resolveReference(q(4, "3", "general-note"), idx))).toEqual([4, "sr-notes-4", "p3", "same-sheet"]);
  });
  it("unresolved bare references name the mention's page, then the general sheets, for the fallback", () => {
    // the general sheets in sheet order: A-501 (GENERAL NOTES block), A-901, E-101, G-001 (title)
    expect(resolveReference(q(6, "77"), idx)).toEqual({ status: "unresolved", reason: "no-candidates", fallbackPages: [6, 2, 7, 4, 5] });
    expect(resolveReference(q(6, "77", "spec"), idx)).toEqual({ status: "unresolved", reason: "no-candidates", fallbackPages: [6] });
  });
  it("origin follows the region's origin", () => {
    const o = resolveReference(q(1, "1"), idx);
    expect(o.status === "resolved" && o.hit.origin).toBe("classic");
    const o2 = resolveReference(q(2, "5"), idx);
    expect(o2.status === "resolved" && o2.hit.origin).toBe("committed");
  });
});

describe("resolveReference: (CONT.) chains (rule 5)", () => {
  it("a key printed on the continued block resolves from the sheet the block started on, and back", () => {
    const idx = makeIndex();
    expect(hit(resolveReference(q(2, "9"), idx))).toEqual([3, "sr-notes-3", "p9", "same-sheet"]);
    expect(hit(resolveReference(q(1, "9", "note", { sheet: "A-501" }), idx))).toEqual([3, "sr-notes-3", "p9", "explicit-sheet"]);
    expect(hit(resolveReference(q(3, "2"), idx))).toEqual([2, "sr-notes-2", "p2", "same-sheet"]);
  });
  it("the chain only joins the chained region, not the sheet's other blocks", () => {
    const idx = makeIndex();
    // note 4 from the continued ELECTRICAL NOTES is electrical note 4 on A-501; the GENERAL NOTES 4 there is not a candidate
    expect(hit(resolveReference(q(3, "4"), idx))).toEqual([2, "sr-notes-2", "p4", "same-sheet"]);
  });
  it("without a blocks slice there is no chain: note 9 from A-501 falls through to the G-001 general sheet", () => {
    const idx = makeIndex(false);
    expect(hit(resolveReference(q(2, "9"), idx))).toEqual([5, "sr-gen-5", "p9", "general-notes"]);
    expect(resolveReference(q(3, "2"), idx)).toMatchObject({ status: "unresolved", fallbackPages: [3, 2, 7, 4, 5] });
  });
  it("blocksSliceOf builds the slice from a committed document", () => {
    expect(
      blocksSliceOf("sr-x", {
        blocks: [
          { id: "b1", header: "GENERAL NOTES (CONT.)", headerNorm: "GENERAL NOTES", b: [0, 0, 1, 1], continued: true },
          { id: "b2", header: null, headerNorm: null, b: [0, 0, 1, 1] },
        ],
      }),
    ).toEqual([{ regionId: "sr-x", blockId: "b1", headerNorm: "GENERAL NOTES", continued: true }, { regionId: "sr-x", blockId: "b2", headerNorm: null }]);
  });
});

describe("rule 6 ordering and helpers", () => {
  it("ambiguous candidates: same discipline first, then nearest sheet number", () => {
    const idx = makeIndex();
    const o = resolveReference(q(6, "3"), idx); // A-503: GENERAL NOTES 3 on A-501 (2 away) and A-901 (398 away)
    expect(o.status).toBe("ambiguous");
    if (o.status === "ambiguous") expect(o.candidates.map((c) => c.page)).toEqual([2, 7]);
    const cands: ResolvedCandidate[] = [
      { page: 4, sheet: "E101", regionId: "r", kind: "notes", targetId: "p1", blockHeaderNorm: null, origin: "committed", level: "general-notes" },
      { page: 7, sheet: "A901", regionId: "r", kind: "notes", targetId: "p1", blockHeaderNorm: null, origin: "committed", level: "general-notes" },
      { page: 2, sheet: "A501", regionId: "r", kind: "notes", targetId: "p1", blockHeaderNorm: null, origin: "committed", level: "general-notes" },
      { page: 9, sheet: null, regionId: "r", kind: "notes", targetId: "p1", blockHeaderNorm: null, origin: "committed", level: "general-notes" },
    ];
    expect(orderCandidates(cands, "A503").map((c) => c.page)).toEqual([2, 7, 4, 9]);
    expect(orderCandidates(cands, null).map((c) => c.page)).toEqual([2, 4, 7, 9]);
  });
  it("kindHintFromPhrase (rule 1)", () => {
    expect(kindHintFromPhrase("SEE KEYNOTE 12")).toBe("keynote");
    expect(kindHintFromPhrase("see key note 4")).toBe("keynote");
    expect(kindHintFromPhrase("SECTION 08 71 00 PARA 2.3")).toBe("spec");
    expect(kindHintFromPhrase("PER SPEC 2.3")).toBe("spec");
    expect(kindHintFromPhrase("SEE GENERAL NOTE 3")).toBe("general-note");
    expect(kindHintFromPhrase("SEE GEN. NOTES 3")).toBe("general-note");
    expect(kindHintFromPhrase("SEE NOTE 3/A-501")).toBe("note");
  });
  it("keyLookupVariants", () => {
    expect(keyLookupVariants("4")).toEqual(["4"]);
    expect(keyLookupVariants("(4)")).toEqual(["4"]);
    expect(keyLookupVariants("K-01")).toEqual(["K01"]);
    expect(keyLookupVariants("2.3")).toEqual(["2.3"]);
    expect(keyLookupVariants("2.3.A")).toEqual(["2.3.A", "A"]);
    expect(keyLookupVariants("1.01 › A › 1")).toEqual(["1.01.A.1", "1"]);
    expect(splitKeyPath("2.3.A")).toEqual(["2.3", "A"]);
    expect(splitKeyPath("1.01/A/1")).toEqual(["1.01", "A", "1"]);
    expect(keyLookupVariants("")).toEqual([]);
  });
  it("is deterministic", () => {
    const idx = makeIndex();
    const a = JSON.stringify(resolveReference(q(2, "3"), idx));
    const b = JSON.stringify(resolveReference(q(2, "3"), makeIndex()));
    expect(a).toBe(b);
  });
});
