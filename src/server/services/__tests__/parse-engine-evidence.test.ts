// @vitest-environment node
// [table pipeline WP-2.E] buildPageEvidence (the pure half of the one page-evidence loader): every box
// MinMax (E-4), words carry a line id, Textract cells are 0-based with spans and header flags, tag
// shapes come from yolo_primitive and the classical parse with their key text, the sheet key and the
// census channel are carried, and the hash is deterministic and region-local (E-7).
// Geometry and words are synthetic (rule 12).
import { describe, expect, it } from "vitest";
import { buildPageEvidence, regionEvidenceHash, toClassifierPageInput, type PageEvidenceRow } from "@/server/services/parse-engine/evidence";
import type { TextractWord } from "@/types";

const w = (text: string, x: number, y: number, wd = 0.03, h = 0.01, confidence = 90): TextractWord => ({ text, confidence, bbox: [x, y, wd, h] });

function row(over: Partial<PageEvidenceRow> = {}): PageEvidenceRow {
  return {
    pageNumber: 3,
    drawingNumber: " QX-101A ",
    keynotes: [{ shape: "square", text: "31", bbox: [0.6, 0.6, 0.62, 0.62] }],
    csiCodes: [],
    words: [
      w("QXMARK", 0.1, 0.1), w("LOREM", 0.2, 0.1),
      w("QX-1", 0.101, 0.13, 0.018, 0.01, 99), w("IPSUM", 0.2, 0.131),
      w("DOLOR", 0.2, 0.15),
      w("FAR", 0.9, 0.9),
      { text: "BAD", confidence: 50, bbox: [NaN, 0, 0, 0] } as TextractWord,
    ],
    tables: [{
      bbox: [0.1, 0.1, 0.2, 0.06], rowCount: 2, colCount: 2,
      cells: [
        { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "", bbox: [0.1, 0.1, 0.1, 0.02], confidence: 90, hdr: true },
        { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: "", bbox: [0.2, 0.1, 0.1, 0.02], confidence: 90 },
        { row: 2, col: 1, rowSpan: 1, colSpan: 1, text: "", bbox: [0.1, 0.12, 0.1, 0.02], confidence: 90 },
      ],
      merged: [{ r: 2, c: 1, rs: 1, cs: 2 }],
    }],
    layout: [{ k: "table", b: [0.1, 0.1, 0.3, 0.16] }, { k: "bogus", b: [0, 0, 1, 1] }, { k: "text", b: [1, 2] }],
    pageZones: undefined,
    regionsV2: undefined,
    parsedRegions: [{ bbox: [0.1, 0.1, 0.2, 0.06] }],
    channels: { v: 1, kind: "vector" },
    classifierProposals: {
      engineVersion: "clf/1", recipes: { "schedules.v1": 1 },
      proposals: [{
        id: "schedules.v1:p3:x", recipeId: "schedules.v1", recipeVersion: 1, engineVersion: "clf/1", pageNumber: 3,
        bbox: [0.1, 0.1, 0.3, 0.16], target: "table", p: 0.9, classId: null, className: "Other", group: null, nameP: 0.2, margin: 0,
        displayName: "Other", detectWhy: [], nameWhy: [], features: {}, tableP: 0.8,
        tagMap: { column: { source: "yolo", shapeClass: "hexagon", n: 1, gapCv: null, textInside: 1 }, rows: [{ tag: "QX-1", shapeClass: "hexagon", shapeBbox: [0.1, 0.128, 0.12, 0.142], rowBbox: [0.1, 0.128, 0.3, 0.142], rowText: "IPSUM" }], truncated: false },
      }],
    },
    yolo: [
      { name: "hexagon", minX: 0.1, minY: 0.128, maxX: 0.12, maxY: 0.142, data: { confidence: 0.8, modelName: "yolo_primitive" } },
      { name: "circle", minX: 0.5, minY: 0.5, maxX: 0.52, maxY: 0.52, data: { confidence: 0.7, modelName: "yolo_primitive" } },
      { name: "grid", minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.16, data: { confidence: 0.6, modelName: "yolo_primitive" } },
      { name: "tables", minX: 0.1, minY: 0.1, maxX: 0.3, maxY: 0.16, data: { confidence: 0.9, modelName: "yolo_medium" } },
      { name: "degenerate", minX: 0.4, minY: 0.4, maxX: 0.4, maxY: 0.5, data: null },
    ],
    ...over,
  };
}

describe("buildPageEvidence", () => {
  const ev = buildPageEvidence(row());

  it("words: MinMax boxes, 0..1 confidence, a line id; malformed boxes dropped; lines split at 1.2 × height gaps", () => {
    expect(ev.words.map((x) => x.t)).toEqual(["QXMARK", "LOREM", "QX-1", "IPSUM", "DOLOR", "FAR"]);
    expect(ev.words[0].b).toEqual([0.1, 0.1, 0.13, 0.11]);
    expect(ev.words[2].conf).toBeCloseTo(0.99);
    // QXMARK and LOREM sit on one visual row but 0.07 apart (> 1.2 × 0.01): two lines.
    expect(ev.words[0].lineId).not.toBe(ev.words[1].lineId);
    for (const [i, x] of ev.words.entries()) expect(ev.lines[x.lineId].wordIdx).toContain(i);
    expect(ev.lines.flatMap((l) => l.wordIdx).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("layout: only well-formed blocks of the five kinds", () => {
    expect(ev.layout).toEqual([{ k: "table", b: [0.1, 0.1, 0.3, 0.16] }]);
    expect(buildPageEvidence(row({ layout: null })).layout).toBeUndefined();
  });

  it("textract tables: MinMax, 0-based r/c, header flag, MERGED_CELL span applied to its anchor cell", () => {
    expect(ev.textractTables).toHaveLength(1);
    const t = ev.textractTables[0];
    expect(t.b[2]).toBeCloseTo(0.3);
    expect(t.b[3]).toBeCloseTo(0.16);
    expect(t.cells.map((c) => [c.r, c.c, c.rs, c.cs, c.hdr ?? false])).toEqual([[0, 0, 1, 1, true], [0, 1, 1, 1, false], [1, 0, 1, 2, false]]);
  });

  it("shapes: yolo_primitive tags with the text inside, classical shapes with the crop read; primitives and other detections apart", () => {
    expect(ev.shapes).toEqual([
      { b: [0.1, 0.128, 0.12, 0.142], cls: "hexagon", src: "yolo", text: "QX-1", textSrc: "inside" },
      { b: [0.5, 0.5, 0.52, 0.52], cls: "circle", src: "yolo", text: null, textSrc: null },
      { b: [0.6, 0.6, 0.62, 0.62], cls: "square", src: "classical", text: "31", textSrc: "crop" },
    ]);
    expect(ev.primitives).toEqual([{ b: [0.1, 0.1, 0.3, 0.16], cls: "grid" }]);
    expect(ev.detections).toEqual([{ b: [0.1, 0.1, 0.3, 0.16], model: "yolo_medium", cls: "tables", conf: 0.9 }]);
  });

  it("proposals: anchor box, class (null kept), p / tableP and the stored tag-map rows without row text", () => {
    expect(ev.proposals).toEqual([{
      id: "schedules.v1:p3:x", b: [0.1, 0.1, 0.3, 0.16], classId: null, p: 0.9, tableP: 0.8,
      tagMap: { rows: [{ tag: "QX-1", shapeClass: "hexagon", shapeBbox: [0.1, 0.128, 0.12, 0.142], rowBbox: [0.1, 0.128, 0.3, 0.142] }] },
    }]);
  });

  it("sheet: the trimmed drawing number and its key (accepts the A-101A grammar, K67); census channel kind", () => {
    expect(ev.sheet).toEqual({ raw: "QX-101A", key: "QX101A" });
    expect(ev.channelKind).toBe("vector");
    expect(buildPageEvidence(row({ drawingNumber: null, channels: null })).sheet).toEqual({ raw: null, key: null });
    expect(buildPageEvidence(row({ channels: null })).channelKind).toBeNull();
  });

  it("is deterministic and the hash moves only with evidence near the region", () => {
    const again = buildPageEvidence(row());
    expect(JSON.stringify(again)).toBe(JSON.stringify(ev));
    expect(ev.evidenceHash).toMatch(/^[0-9a-f]{40}$/);
    const moved = buildPageEvidence(row({ words: [...(row().words as TextractWord[]).slice(0, 5), w("FAR", 0.91, 0.9)] }));
    expect(moved.evidenceHash).not.toBe(ev.evidenceHash);
    const region = [0.05, 0.05, 0.35, 0.2];
    expect(regionEvidenceHash(moved, region)).toBe(regionEvidenceHash(ev, region));
    expect(regionEvidenceHash(moved, [0.85, 0.85, 1, 1])).not.toBe(regionEvidenceHash(ev, [0.85, 0.85, 1, 1]));
  });

  it("toClassifierPageInput carries the raw slices and the census channel kind", () => {
    const input = toClassifierPageInput(ev);
    expect(input.pageNumber).toBe(3);
    expect(input.channelKind).toBe("vector");
    expect(input.detections).toHaveLength(5);
    expect(input.detections[0]).toEqual({ name: "hexagon", minX: 0.1, minY: 0.128, maxX: 0.12, maxY: 0.142, confidence: 0.8, modelName: "yolo_primitive" });
    expect(input.detections[4]).toEqual({ name: "degenerate", minX: 0.4, minY: 0.4, maxX: 0.4, maxY: 0.5, confidence: 0, modelName: undefined });
    expect(input.textractData?.words).toHaveLength(7); // raw, malformed word included, as the loaders pass it
    expect(input.drawingNumber).toBe(" QX-101A ");
    expect(input.regionsV2).toBeDefined(); // computed: none stored and the page has detections
    expect(input.parsedRegions).toEqual([{ bbox: [0.1, 0.1, 0.2, 0.06] }]);
  });

  it("an un-OCR'd page gives empty word and table lists and a null textractData", () => {
    const bare = buildPageEvidence(row({ words: null, tables: null, layout: null, yolo: [] }));
    expect(bare.words).toEqual([]);
    expect(bare.textractTables).toEqual([]);
    expect(toClassifierPageInput(bare).textractData).toBeNull();
    expect(toClassifierPageInput(bare).regionsV2).toBeUndefined();
  });
});
