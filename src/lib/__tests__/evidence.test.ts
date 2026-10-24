// @vitest-environment node
// [evidence T4 2026-10-24] The per-page evidence layer (src/lib/evidence): text fusion rules from
// research/text/REPORT.md §7.2, the persisted summary, and its first consumer (LLM page context).
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_HOLE_CAP,
  EVIDENCE_VERSION,
  buildEvidenceContextSection,
  buildEvidenceSummary,
  fuseText,
  getPageEvidence,
  isYoloTextDetection,
  normaliseOcrConfidence,
  qYolo,
  sameEvidence,
  storedPageEvidence,
  summarizePageEvidence,
  type EvidenceDetectionInput,
} from "@/lib/evidence";
import { buildPageIntelligenceSection } from "@/lib/context-builder";
import { computePageZones } from "@/lib/page-zones";
import type { TextractPageData, TextractWord } from "@/types";

/** Word in LTWH, as Textract stores it. */
const word = (text: string, l: number, t: number, w = 0.03, h = 0.01, confidence = 90): TextractWord => ({
  text, confidence, bbox: [l, t, w, h],
});
const ytext = (minX: number, minY: number, maxX: number, maxY: number, confidence = 0.7): EvidenceDetectionInput => ({
  name: "text_box", modelName: "yolo_text", confidence, minX, minY, maxX, maxY,
});
const box = (minX: number, minY: number, maxX: number, maxY: number, confidence = 0.7) => ({
  bbox: [minX, minY, maxX, maxY] as [number, number, number, number], confidence,
});
const ocr = (words: TextractWord[], tables: TextractPageData["tables"] = undefined): TextractPageData => ({
  lines: [], words, ...(tables ? { tables } : {}),
});
const NOW = new Date("2026-10-24T12:00:00.000Z");

describe("calibration", () => {
  it("q(c_yolo) is the measured step curve", () => {
    expect([0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.95].map(qYolo)).toEqual([0.66, 0.7, 0.8, 0.89, 0.94, 0.98, 0.98]);
  });
  it("OCR confidence 0-100 → 0-1; tolerates 0-1 rows and junk", () => {
    expect(normaliseOcrConfidence(90)).toBeCloseTo(0.9);
    expect(normaliseOcrConfidence(0.4)).toBeCloseTo(0.4);
    expect(normaliseOcrConfidence(-5)).toBe(0);
    expect(normaliseOcrConfidence(Number.NaN)).toBe(0);
    expect(normaliseOcrConfidence(250)).toBe(1);
  });
});

describe("fuseText — OCR authoritative, yolo_text a locator and hole-finder", () => {
  it("word centre inside a box → both, p = 1 − (1 − c_ocr)(1 − q); outside → ocr, p = c_ocr", () => {
    const words = [word("DOOR", 0.1, 0.1, 0.04, 0.01, 40), word("NOTE", 0.5, 0.5)];
    const f = fuseText(words, [box(0.09, 0.095, 0.15, 0.115, 0.7)]);
    expect(f.items[0]).toMatchObject({ text: "DOOR", source: "both", cYolo: 0.7 });
    expect(f.items[0].pText).toBeCloseTo(1 - 0.6 * 0.06); // the report's 0.4 × 0.7 worked example ≈ 0.96
    expect(f.items[1]).toMatchObject({ source: "ocr", cYolo: null, pText: 0.9 });
    expect(f.counts).toEqual({ ocrWords: 2, both: 1, ocrOnly: 1, yoloTextBoxes: 1, holes: 0, fragments: 0 });
  });

  it("centre-in, not IoU: a loose box that holds the centre still matches; edge is inclusive", () => {
    const f = fuseText([word("A", 0.2, 0.2, 0.02, 0.01)], [box(0.21, 0.205, 0.4, 0.4)]);
    expect(f.items[0].source).toBe("both");
  });

  it("several boxes over one word keep the highest confidence", () => {
    const f = fuseText([word("A", 0.2, 0.2)], [box(0.19, 0.19, 0.25, 0.22, 0.4), box(0.2, 0.2, 0.24, 0.215, 0.85)]);
    expect(f.items[0].cYolo).toBe(0.85);
  });

  it("a box with no word centre far from any word is a hole with p = q(c_yolo)", () => {
    const f = fuseText([word("A", 0.1, 0.1)], [box(0.6, 0.6, 0.63, 0.61, 0.55)]);
    expect(f.holes).toEqual([{ bbox: [0.6, 0.6, 0.63, 0.61], cYolo: 0.55, pText: 0.8 }]);
  });

  it("fragment test: same line and touching a read word in x → merged, not a hole", () => {
    // word spans x .10–.14, y .10–.11; box just right of it on the same line, no word centre inside.
    const f = fuseText([word("CONCR", 0.1, 0.1, 0.04, 0.01)], [box(0.142, 0.1, 0.16, 0.11)]);
    expect(f.counts).toMatchObject({ holes: 0, fragments: 1 });
    // same x, one line lower → a hole.
    const g = fuseText([word("CONCR", 0.1, 0.1, 0.04, 0.01)], [box(0.142, 0.13, 0.16, 0.14)]);
    expect(g.counts).toMatchObject({ holes: 1, fragments: 0 });
  });

  it("stays ~linear on a dense page (3.5k words × 6k boxes)", () => {
    const words: TextractWord[] = [];
    for (let i = 0; i < 3500; i++) words.push(word(`w${i}`, (i % 70) / 70, Math.floor(i / 70) / 50, 0.01, 0.005));
    const boxes = [];
    for (let i = 0; i < 6000; i++) boxes.push(box((i % 100) / 100, Math.floor(i / 100) / 60, (i % 100) / 100 + 0.008, Math.floor(i / 100) / 60 + 0.004));
    const t0 = performance.now();
    const f = fuseText(words, boxes);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(f.counts.ocrWords).toBe(3500);
    expect(f.counts.yoloTextBoxes).toBe(6000);
  });
});

describe("getPageEvidence", () => {
  it("only yolo_text word boxes fuse; yolo_medium's text_box and legacy rows without a model do not", () => {
    expect(isYoloTextDetection({ name: "text_box", modelName: "yolo_text" })).toBe(true);
    expect(isYoloTextDetection({ name: "text_box_2", modelName: "yolo_text" })).toBe(true);
    expect(isYoloTextDetection({ name: "text_box", modelName: "yolo_medium" })).toBe(false);
    expect(isYoloTextDetection({ name: "text_box" })).toBe(false);
    expect(isYoloTextDetection({ name: "door", modelName: "yolo_text" })).toBe(false);
    const ev = getPageEvidence({
      textract: ocr([word("A", 0.1, 0.1)]),
      detections: [{ name: "text_box", modelName: "yolo_medium", minX: 0.5, minY: 0.5, maxX: 0.6, maxY: 0.6, confidence: 0.9 }],
    });
    expect(ev.holes).toEqual([]);
    expect(ev.counts.yoloTextBoxes).toBe(0);
  });

  it("per-model detection lists keep real confidences, sorted by model, legacy rows under 'unknown'", () => {
    const ev = getPageEvidence({
      textract: ocr([]),
      detections: [
        { name: "door", modelName: "yolo_precise", minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2, confidence: 0.61 },
        { name: "tables", modelName: "yolo_medium", minX: 0.5, minY: 0.1, maxX: 0.9, maxY: 0.4, confidence: 0.83 },
        { name: "circle", minX: 0.3, minY: 0.3, maxX: 0.31, maxY: 0.31 },
        { name: "bad", modelName: "yolo_medium", minX: 0.5, minY: 0.5, maxX: 0.4, maxY: 0.6, confidence: 1 },
      ],
    });
    expect(ev.detections.map((g) => g.modelName)).toEqual(["unknown", "yolo_medium", "yolo_precise"]);
    expect(ev.detections[1].detections).toEqual([{ name: "tables", bbox: [0.5, 0.1, 0.9, 0.4], confidence: 0.83, zone: "table" }]);
    expect(ev.detections[0].detections[0].confidence).toBe(0);
  });

  it("zones: detector title block puts its words and holes in title_block; passed-in zones win", () => {
    const tb: EvidenceDetectionInput = { name: "title_block", modelName: "yolo_medium", minX: 0.8, minY: 0.7, maxX: 1, maxY: 1, confidence: 0.9 };
    const ev = getPageEvidence({
      textract: ocr([word("A-101", 0.85, 0.9), word("NOTE", 0.3, 0.3)]),
      detections: [tb, ytext(0.9, 0.75, 0.93, 0.76)],
    });
    expect(ev.zones.source).toBe("detector");
    expect(ev.text.map((t) => t.zone)).toEqual(["title_block", "notes"]);
    expect(ev.holes[0].zone).toBe("title_block");
    const fixed = getPageEvidence({ textract: ocr([word("A-101", 0.85, 0.9)]), detections: [tb], zones: computePageZones([]) });
    expect(fixed.zones.source).toBe("fixed-fallback");
  });

  it("Textract TABLES become MinMax grids with dims, cells and zone", () => {
    const ev = getPageEvidence({
      textract: ocr([], [{
        bbox: [0.5, 0.1, 0.4, 0.3], rowCount: 2, colCount: 3,
        cells: [{ row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "MARK", bbox: [0.5, 0.1, 0.1, 0.05], confidence: 88 }],
      }]),
      detections: [{ name: "tables", modelName: "yolo_medium", minX: 0.49, minY: 0.09, maxX: 0.91, maxY: 0.41, confidence: 0.8 }],
    });
    expect(ev.tables).toHaveLength(1);
    expect(ev.tables[0]).toMatchObject({ rows: 2, cols: 3, zone: "table" });
    expect(ev.tables[0].bbox[2]).toBeCloseTo(0.9);
    expect(ev.tables[0].cells[0]).toMatchObject({ text: "MARK", row: 1, col: 1 });
    expect(ev.tables[0].cells[0].bbox[3]).toBeCloseTo(0.15);
  });
});

describe("summary (pageIntelligence.evidence)", () => {
  it("counts, channels, holes by zone, rounding, version + computedAt", () => {
    const s = buildEvidenceSummary({
      textract: ocr([word("A", 0.1, 0.1), word("B", 0.3, 0.3)]),
      detections: [ytext(0.09, 0.095, 0.14, 0.115, 0.9), ytext(0.5123456, 0.5, 0.53, 0.51, 0.61234)],
    }, NOW)!;
    expect(s).toMatchObject({
      v: EVIDENCE_VERSION,
      computedAt: "2026-10-24T12:00:00.000Z",
      zonesSource: "fixed-fallback",
      channels: { ocr: true, yoloText: true, layout: false },
      counts: { ocrWords: 2, both: 1, ocrOnly: 1, yoloTextBoxes: 2, holes: 1, fragments: 0, tables: 0, detections: { yolo_text: { text_box: 2 } } },
      holesByZone: { notes: 1 },
      holes: [{ bbox: [0.5123, 0.5, 0.53, 0.51], conf: 0.612, zone: "notes" }],
      holesTruncated: 0,
      tables: [],
    });
  });

  it(`caps holes at ${EVIDENCE_HOLE_CAP}, highest confidence first, and counts the rest`, () => {
    const dets: EvidenceDetectionInput[] = [];
    for (let i = 0; i < EVIDENCE_HOLE_CAP + 20; i++) {
      const x = (i % 40) / 40, y = Math.floor(i / 40) / 20;
      dets.push(ytext(x, y, x + 0.005, y + 0.004, i / 1000));
    }
    const s = buildEvidenceSummary({ textract: ocr([]), detections: dets }, NOW)!;
    expect(s.holes).toHaveLength(EVIDENCE_HOLE_CAP);
    expect(s.holesTruncated).toBe(20);
    expect(s.counts.holes).toBe(EVIDENCE_HOLE_CAP + 20);
    expect(s.holes[0].conf).toBeCloseTo((EVIDENCE_HOLE_CAP + 19) / 1000);
  });

  it("no OCR → null; sameEvidence ignores computedAt; storedPageEvidence rejects other versions / junk", () => {
    expect(buildEvidenceSummary({ textract: null })).toBeNull();
    const input = { textract: ocr([word("A", 0.1, 0.1)]) };
    const a = buildEvidenceSummary(input, NOW)!;
    const b = buildEvidenceSummary(input, new Date("2027-01-01T00:00:00Z"))!;
    expect(sameEvidence(a, b)).toBe(true);
    expect(sameEvidence(a, { ...b, counts: { ...b.counts, ocrWords: 9 } })).toBe(false);
    expect(sameEvidence(a, undefined)).toBe(false);
    // jsonb hands keys back in its own order — still the same evidence.
    const reordered = Object.fromEntries(Object.entries(b).reverse().map(([k, v]) =>
      [k, v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v]));
    expect(sameEvidence(a, reordered)).toBe(true);
    expect(storedPageEvidence({ evidence: a })).toBe(a);
    expect(storedPageEvidence({ evidence: { ...a, v: 99 } })).toBeUndefined();
    expect(storedPageEvidence({ evidence: "junk" })).toBeUndefined();
    expect(storedPageEvidence(null)).toBeUndefined();
  });

  it("summarizePageEvidence never carries per-word marks", () => {
    const ev = getPageEvidence({ textract: ocr([word("A", 0.1, 0.1)]) });
    expect(Object.keys(summarizePageEvidence(ev, NOW)).sort()).toEqual(
      ["channels", "computedAt", "counts", "holes", "holesByZone", "holesTruncated", "tables", "v", "zonesSource"],
    );
  });
});

describe("first consumer — LLM page context reads the stored summary", () => {
  const withTables = (n: number) => ocr([word("A", 0.1, 0.1)], Array.from({ length: n }, (_, i) => ({
    bbox: [0.1, 0.05 * i, 0.2, 0.04] as [number, number, number, number], rowCount: 4, colCount: 2, cells: [],
  })));

  it("no stored evidence → no section (pages processed before the layer existed are unchanged)", () => {
    expect(buildEvidenceContextSection({}, 3)).toBeNull();
    expect(buildEvidenceContextSection({ evidence: { v: 0 } }, 3)).toBeNull();
  });

  it("states holes by zone and OCR table grids; caps the table list", () => {
    const evidence = buildEvidenceSummary({
      textract: withTables(10),
      detections: [ytext(0.09, 0.095, 0.14, 0.115), ytext(0.6, 0.6, 0.62, 0.61)],
    }, NOW);
    const out = buildEvidenceContextSection({ evidence }, 4)!;
    expect(out.section.header).toBe("PAGE EVIDENCE — Page 4");
    expect(out.section.priority).toBe(5.2);
    expect(out.section.content).toContain("Text: 1 OCR words (100% also located by the text detector).");
    expect(out.section.content).toContain("Unread text: 1 spot(s) where the detector found text the OCR did not read (notes 1).");
    expect(out.section.content).toContain("OCR table grids: 10");
    expect(out.section.content).toContain("4 rows × 2 cols, 0 cells");
    expect(out.section.content).toContain("... (+2 more)");
    expect(out.summaryLine).toBe("Page evidence on Page 4: 1 unread text spot(s), 10 OCR table grid(s)");
  });

  it("without the text detector it says so and claims no holes", () => {
    const evidence = buildEvidenceSummary({ textract: withTables(0) }, NOW);
    const out = buildEvidenceContextSection({ evidence }, 1)!;
    expect(out.section.content).toBe("Text: 1 OCR words (text detector has not run on this page).\n");
  });

  it("buildPageIntelligenceSection carries the section", () => {
    const evidence = buildEvidenceSummary({ textract: withTables(1) }, NOW);
    const res = buildPageIntelligenceSection({ evidence }, 2)!;
    expect(res.sections.map((s) => s.header)).toEqual(["PAGE EVIDENCE — Page 2"]);
    expect(res.summaryLines).toEqual(["Page evidence on Page 2: 1 OCR table grid(s)"]);
  });
});
