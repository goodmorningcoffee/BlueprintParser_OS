// [fix 2026-10-24 admin-ui T1b] Which pending shape-parse shapes still need the client Save?
import { describe, expect, it } from "vitest";
import type { ClientAnnotation, KeynoteShapeData } from "@/types";
import { BBOX_MATCH_TOLERANCE, unsavedShapeKeynotes, unsavedShapeKeynotesByPage } from "@/lib/shape-parse-unsaved";

const shape = (over: Partial<KeynoteShapeData> = {}): KeynoteShapeData => ({
  shape: "circle",
  text: "A1",
  bbox: [0.123456789, 0.2, 0.3, 0.4],
  ...over,
});

const row = (over: Partial<ClientAnnotation> = {}): ClientAnnotation => ({
  id: 1,
  pageNumber: 1,
  name: "circle",
  bbox: [0.123456789, 0.2, 0.3, 0.4],
  note: null,
  source: "shape-parse",
  data: { modelName: "shape-parse", confidence: 0.9 },
  ...over,
});

describe("unsavedShapeKeynotes", () => {
  it("every shape is unsaved when the page holds no shape-parse annotation", () => {
    const shapes = [shape(), shape({ shape: "diamond", bbox: [0.5, 0.5, 0.6, 0.6] })];
    expect(unsavedShapeKeynotes(shapes, 1, [row({ source: "yolo" }), row({ pageNumber: 2 })])).toEqual(shapes);
    expect(unsavedShapeKeynotes([], 1, [row()])).toEqual([]);
  });

  it("a shape already stored on its page (same type, bbox within float4 tolerance) is saved; text is ignored", () => {
    const stored = row({ bbox: [0.12345679, 0.2, 0.3, 0.4], data: { modelName: "shape-parse", text: "re-OCR'd", confidence: 0.9 } });
    const pending = [shape(), shape({ shape: "hexagon" }), shape({ bbox: [0.123456789, 0.2, 0.3, 0.4 + 2 * BBOX_MATCH_TOLERANCE] })];
    expect(unsavedShapeKeynotes(pending, 1, [stored])).toEqual([pending[1], pending[2]]);
  });

  it("unsavedShapeKeynotesByPage drops pages with nothing left to save", () => {
    const keynotes = { 1: [shape()], 2: [shape({ bbox: [0.5, 0.5, 0.6, 0.6] })], 3: null, 4: [] };
    expect(unsavedShapeKeynotesByPage(keynotes, [row()])).toEqual({ 2: [shape({ bbox: [0.5, 0.5, 0.6, 0.6] })] });
    expect(unsavedShapeKeynotesByPage(keynotes, [row({ pageNumber: 2, bbox: [0.5, 0.5, 0.6, 0.6] })])).toEqual({ 1: [shape()] });
  });
});
