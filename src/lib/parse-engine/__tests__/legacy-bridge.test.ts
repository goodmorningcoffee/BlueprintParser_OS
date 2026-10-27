// @vitest-environment node
// [table pipeline WP-3.H] The legacy bridge: `legacyView` / `viewHash` (legacy-view.ts) and
// `readStructure` / `fromLegacy` (read.ts). Synthetic data only (rule 12).

import { describe, expect, it } from "vitest";
import { uniqueHeaders } from "@/lib/table-headers";
import {
  canonicalJson,
  dedupeHeaderLabels,
  legacyPart,
  legacyView,
  viewHash,
  type LegacyGridView,
  type LegacyKeynoteView,
  type LegacyNotesView,
  type LegacySpecView,
} from "../legacy-view";
import {
  fromLegacy,
  itemKeyNorm,
  LIFTED_FLAG,
  LIFTED_GEOMETRY_FLAG,
  readStructure,
  sectionNorm,
  specSectionOf,
  splitLeadingKey,
  TRUNCATED_FLAG,
} from "../read";
import type { StructureParagraphDoc, StructureTableModel } from "../types";

const BOX: [number, number, number, number] = [0.1, 0.2, 0.5, 0.6];

const scheduleData = {
  headers: ["MARK", "WIDTH", "MATERIAL"],
  rows: [
    { MARK: "D1", WIDTH: "3'-0\"", MATERIAL: "ALPHA" },
    { MARK: "D2", WIDTH: "2'-8\"", MATERIAL: "BETA" },
  ],
  tagColumn: "MARK",
  rowCount: 2,
  columnCount: 3,
  colBoundaries: [0.1, 0.2, 0.3, 0.5],
  rowBoundaries: [0.2, 0.3, 0.45, 0.6],
};
const scheduleRegion = { id: "pr-1", type: "schedule", category: "door-schedule", bbox: BOX, confidence: 0.9, data: scheduleData };

function asTable(m: unknown): StructureTableModel {
  return m as StructureTableModel;
}
function asDoc(m: unknown): StructureParagraphDoc {
  return m as StructureParagraphDoc;
}
const bodyKeys = (m: StructureTableModel) => m.rows.filter((r) => r.role !== "header").map((r) => (r.key && "text" in r.key ? r.key.text : null));

describe("dedupeHeaderLabels (K06)", () => {
  it("matches lib/table-headers uniqueHeaders on every case", () => {
    const cases: string[][] = [
      ["A", "B"], ["TYPE", "TYPE", "TYPE"], ["X", "X (2)", "X"], ["", "  ", "A"], ["A (2)", "A", "A"], [],
    ];
    for (const c of cases) expect(dedupeHeaderLabels(c)).toEqual(uniqueHeaders(c));
  });
});

describe("fromLegacy: schedules", () => {
  it("lifts the grid with stored geometry, tag column and row keys", () => {
    const m = asTable(fromLegacy(scheduleRegion));
    expect(m.kind).toBe("schedule");
    expect(m.headerRows).toBe(1);
    expect(m.cols.map((c) => [c.label, c.x0, c.x1])).toEqual([["MARK", 0.1, 0.2], ["WIDTH", 0.2, 0.3], ["MATERIAL", 0.3, 0.5]]);
    expect(m.rows.map((r) => [r.role, r.y0, r.y1])).toEqual([["header", 0.2, 0.3], ["body", 0.3, 0.45], ["body", 0.45, 0.6]]);
    expect(m.tag).toEqual({ col: "c0", src: "user", scope: "project" });
    expect(bodyKeys(m)).toEqual(["D1", "D2"]);
    expect(m.quality.flags).toEqual([LIFTED_FLAG]);
    expect(m.quality.conf).toBe(0.9);
  });

  it("spreads geometry evenly and flags it when boundaries are missing or do not fit", () => {
    const m = asTable(fromLegacy({ ...scheduleRegion, data: { ...scheduleData, colBoundaries: undefined, rowBoundaries: [0.2, 0.6] } }));
    expect(m.quality.flags).toContain(LIFTED_GEOMETRY_FLAG);
    expect(m.cols[0].x0).toBeCloseTo(0.1);
    expect(m.cols[2].x1).toBeCloseTo(0.5);
    expect(m.rows[2].y1).toBeCloseTo(0.6);
  });

  it("keeps both duplicate-header columns (labels deduped, raw label kept)", () => {
    const m = asTable(fromLegacy({ ...scheduleRegion, data: { headers: ["TYPE", "TYPE"], rows: [{ TYPE: "X" }] } }));
    expect(m.cols.map((c) => [c.label, c.labelRaw])).toEqual([["TYPE", "TYPE"], ["TYPE (2)", "TYPE"]]);
  });

  it("truncates over-cap grids and flags them", () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ A: String(i) }));
    const m = asTable(fromLegacy({ ...scheduleRegion, data: { headers: ["A"], rows } }));
    expect(m.rows).toHaveLength(500);
    expect(m.quality.flags).toContain(TRUNCATED_FLAG);
  });

  it("returns null when nothing is liftable", () => {
    expect(fromLegacy({ ...scheduleRegion, data: { foo: 1 } })).toBeNull();
    expect(fromLegacy({ ...scheduleRegion, data: null })).toBeNull();
  });
});

describe("fromLegacy: the three keynote shapes", () => {
  it("Manual/Auto: Key/Description grid + keynotes[] + isPageSpecific", () => {
    const m = asTable(fromLegacy({
      id: "k1", type: "keynote", bbox: BOX,
      data: {
        headers: ["Key", "Description"], rows: [{ Key: "1", Description: "ALPHA" }, { Key: "2", Description: "BETA" }],
        tagColumn: "Key", keynotes: [{ key: "1", description: "ALPHA" }, { key: "2", description: "BETA" }], isPageSpecific: true,
      },
    }));
    expect(m.kind).toBe("keynote");
    expect(m.tag?.scope).toBe("sheet");
    expect(bodyKeys(m)).toEqual(["1", "2"]);
  });

  it("Guided: Column N headers, no keynotes[] → no printed header row, tag = first column", () => {
    const m = asTable(fromLegacy({
      id: "k2", type: "keynote", bbox: BOX,
      data: { headers: ["Column 1", "Column 2"], rows: [{ "Column 1": "A1", "Column 2": "GAMMA" }] },
    }));
    expect(m.headerRows).toBe(0);
    expect(m.rows).toHaveLength(1);
    expect(m.tag?.col).toBe("c0");
    expect(bodyKeys(m)).toEqual(["A1"]);
  });

  it("bare keynotes[] list (no grid); isPageSpecific false → project scope", () => {
    const m = asTable(fromLegacy({
      id: "k3", type: "keynote", bbox: BOX,
      data: { keynotes: [{ key: "K-01", description: "DELTA" }], isPageSpecific: false },
    }));
    expect(m.cols.map((c) => c.label)).toEqual(["Key", "Description"]);
    expect(m.tag?.scope).toBe("project");
    expect(bodyKeys(m)).toEqual(["K-01"]);
  });
});

describe("fromLegacy: the notes shapes", () => {
  const notes = (data: unknown) => asDoc(fromLegacy({ id: "n", type: "notes", bbox: BOX, data }));

  it("{Key, Note}", () => {
    const d = notes({ headers: ["Key", "Note"], rows: [{ Key: "1", Note: "ALPHA" }, { Key: "2", Note: "BETA" }], tagColumn: "Key", tableName: "GENERAL NOTES" });
    expect(d.kind).toBe("notes");
    expect(d.paragraphs.map((p) => [p.key, p.keyNorm, p.text])).toEqual([["1", "1", "ALPHA"], ["2", "2", "BETA"]]);
    expect(d.blocks[0].headerNorm).toBe("GENERAL NOTES");
  });

  it("{Key, Value}", () => {
    const d = notes({ headers: ["Key", "Value"], rows: [{ Key: "AB", Value: "ALPHA BETA" }], tagColumn: "Key" });
    expect(d.paragraphs.map((p) => [p.key, p.text])).toEqual([["AB", "ALPHA BETA"]]);
  });

  it("Column N (no key column): a leading printed key is split off", () => {
    const d = notes({ headers: ["Column 1"], rows: [{ "Column 1": "3. GAMMA" }, { "Column 1": "plain lead-in" }] });
    expect(d.paragraphs.map((p) => [p.key, p.text])).toEqual([["3", "GAMMA"], [null, "plain lead-in"]]);
    expect(d.paragraphs[1].keyNorm).toBe("");
  });

  it("{Key, Note, ColN}: the extra columns join the note text", () => {
    const d = notes({ headers: ["Key", "Note", "Column 3"], rows: [{ Key: "4", Note: "DELTA", "Column 3": "EPSILON" }], tagColumn: "Key" });
    expect(d.paragraphs.map((p) => [p.key, p.text])).toEqual([["4", "DELTA EPSILON"]]);
  });

  it("pre-Stage-3 {title, notes: string[]}", () => {
    const d = notes({ title: "NOTES", notes: ["1. ALPHA", "(2) BETA", "A. GAMMA", "no key"] });
    expect(d.paragraphs.map((p) => p.key)).toEqual(["1", "2", "A", null]);
    expect(d.title?.text).toBe("NOTES");
  });

  it("uses stored row boundaries for paragraph bands when they fit", () => {
    const d = notes({ headers: ["Key", "Note"], rows: [{ Key: "1", Note: "A" }, { Key: "2", Note: "B" }], rowBoundaries: [0.2, 0.3, 0.6] });
    expect(d.paragraphs.map((p) => [p.b[1], p.b[3]])).toEqual([[0.2, 0.3], [0.3, 0.6]]);
    expect(d.quality.flags).not.toContain(LIFTED_GEOMETRY_FLAG);
  });
});

describe("fromLegacy: spec sections and legends", () => {
  it("re-splits a flattened spec body into the 1.01 › A › 1 hierarchy", () => {
    const d = asDoc(fromLegacy({
      id: "s", type: "spec", bbox: BOX,
      data: { sections: [{ sectionHeader: "SECTION 08 71 00 - ALPHA", body: "1.01 GENERAL\nA. FIRST ITEM\ncontinued line\n1. SUB ITEM\nB. SECOND" }] },
    }));
    expect(d.kind).toBe("spec");
    expect(d.spec?.section).toBe("08 71 00");
    expect(d.paragraphs.map((p) => [p.keyPath, p.keyNorm, p.depth])).toEqual([
      [["1.01"], "1.01", 0], [["1.01", "A"], "1.01.A", 1], [["1.01", "A", "1"], "1.01.A.1", 2], [["1.01", "B"], "1.01.B", 1],
    ]);
    expect(d.paragraphs[1].text).toBe("FIRST ITEM\ncontinued line");
  });

  it("legend symbols[] → symbol-keyed rows", () => {
    const m = asTable(fromLegacy({ id: "l", type: "legend", bbox: BOX, data: { symbols: [{ yoloClass: "circle", description: "ALPHA" }] } }));
    expect(m.kind).toBe("legend");
    expect(m.rows[1].key).toMatchObject({ kind: "symbol", yoloClass: "circle" });
  });
});

describe("key helpers", () => {
  it("itemKeyNorm", () => {
    expect(["K-01", "(4)", "A.", "2.3", " 1 ", "", null].map(itemKeyNorm)).toEqual(["K01", "4", "A", "2.3", "1", "", ""]);
  });
  it("specSectionOf / sectionNorm", () => {
    expect(specSectionOf("SECTION 087100 ALPHA")).toBe("08 71 00");
    expect(specSectionOf("no number")).toBeNull();
    expect(sectionNorm("08 71 00")).toBe("087100");
  });
  it("splitLeadingKey", () => {
    expect(splitLeadingKey("12) ALPHA")).toEqual({ key: "12", rest: "ALPHA" });
    expect(splitLeadingKey("K-01 BETA")).toEqual({ key: "K-01", rest: "BETA" });
    expect(splitLeadingKey("ALPHA")).toEqual({ key: null, rest: "ALPHA" });
  });
});

describe("legacyView (E-5)", () => {
  it("round-trips a classic schedule: every consumer-read field survives lift → view", () => {
    const v = legacyView(fromLegacy(scheduleRegion)!) as LegacyGridView;
    expect(v.headers).toEqual(scheduleData.headers);
    expect(v.rows).toEqual(scheduleData.rows);
    expect(v.tagColumn).toBe("MARK");
    expect([v.rowCount, v.columnCount]).toEqual([2, 3]);
    expect(v.colBoundaries).toEqual(scheduleData.colBoundaries);
    expect(v.rowBoundaries).toEqual(scheduleData.rowBoundaries);
  });

  it("dedupes header labels so duplicate columns keep their own key (K06)", () => {
    const m = asTable(fromLegacy({ ...scheduleRegion, data: { headers: ["TYPE", "TYPE"], rows: [{ TYPE: "X" }] } }));
    m.cells.find((c) => c.row === "r1" && c.col === "c1")!.text = "Y";
    const v = legacyView(m) as LegacyGridView;
    expect(v.headers).toEqual(["TYPE", "TYPE (2)"]);
    expect(v.rows).toEqual([{ TYPE: "X", "TYPE (2)": "Y" }]);
  });

  it("keynote → Manual/Auto shape with keynotes[] and isPageSpecific", () => {
    const m = fromLegacy({ id: "k", type: "keynote", bbox: BOX, data: { keynotes: [{ key: "1", description: "ALPHA" }], isPageSpecific: true } })!;
    const v = legacyView(m) as LegacyKeynoteView;
    expect(v.headers).toEqual(["Key", "Description"]);
    expect(v.keynotes).toEqual([{ key: "1", description: "ALPHA" }]);
    expect(v.isPageSpecific).toBe(true);
  });

  it("notes → NotesData {Key, Note}", () => {
    const m = fromLegacy({ id: "n", type: "notes", bbox: BOX, data: { headers: ["Key", "Note"], rows: [{ Key: "1", Note: "ALPHA" }], tagColumn: "Key", tableName: "N" } })!;
    const v = legacyView(m) as LegacyNotesView;
    expect(v).toMatchObject({ headers: ["Key", "Note"], rows: [{ Key: "1", Note: "ALPHA" }], tagColumn: "Key", rowCount: 1, columnCount: 2, tableName: "N" });
  });

  it("spec → SpecData sections with the keys restored in the body", () => {
    const body = "1.01 GENERAL\nA. FIRST";
    const m = fromLegacy({ id: "s", type: "spec", bbox: BOX, data: { sections: [{ sectionHeader: "SECTION 08 71 00", body }] } })!;
    const v = legacyView(m) as LegacySpecView;
    expect(v.sections).toEqual([{ sectionHeader: "SECTION 08 71 00", body }]);
  });
});

describe("viewHash and readStructure", () => {
  const model = fromLegacy(scheduleRegion)!;
  const projection = legacyView(model);
  const links = { origin: "workspace" as const, revision: 2, viewHash: viewHash(projection), acceptedAt: "2026-10-27T00:00:00Z", proposalId: "p-1" };
  const committed = { id: "sr-1", type: "schedule", bbox: BOX, data: { ...projection, structure: model, links } };

  it("is deterministic, key-order independent, and ignores the engine extension keys", () => {
    const shuffled = Object.fromEntries(Object.entries(projection).reverse());
    expect(viewHash(shuffled)).toBe(viewHash(projection));
    expect(viewHash(committed.data)).toBe(viewHash(projection));
    expect(viewHash(projection)).toMatch(/^vh1:[0-9a-f]{28}$/);
    expect(Object.keys(legacyPart(committed.data)).sort()).toEqual(Object.keys(projection).sort());
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe('{"a":[1,{"c":2}],"b":1}');
  });

  it("returns the committed structure while the projection still hashes to links.viewHash", () => {
    const r = readStructure(committed);
    expect(r.origin).toBe("workspace");
    expect(r.editedInClassic).toBe(false);
    expect(r.model).toBe(model);
    expect(r.links?.proposalId).toBe("p-1");
  });

  it("a classic edit after commit → lifted from legacy, origin classic, editedInClassic", () => {
    const edited = { ...committed, data: { ...committed.data, rows: [{ MARK: "D9", WIDTH: "", MATERIAL: "" }] } };
    const r = readStructure(edited);
    expect(r.origin).toBe("classic");
    expect(r.editedInClassic).toBe(true);
    expect(bodyKeys(asTable(r.model))).toEqual(["D9"]);
  });

  it("a classic save (no structure) → fromLegacy, origin classic, not flagged edited", () => {
    const r = readStructure(scheduleRegion);
    expect(r).toMatchObject({ origin: "classic", editedInClassic: false });
    expect(asTable(r.model).kind).toBe("schedule");
  });

  it("structure without links is not trusted", () => {
    const r = readStructure({ ...committed, data: { ...projection, structure: model } });
    expect(r.origin).toBe("classic");
  });
});
