// [table pipeline WP-3.A] Test helpers: synthetic page evidence for the row stage. All text is pseudo-text
// (rule 12); the fixture adapter reads the committed `*.synthetic.json` slices only.
import type { LegacySlice } from "@/lib/legacy-joins/legacy-paths";
import { ltwhToMinMax } from "../geometry";
import type { BboxMinMax, EnginePageEvidence, EngineProposal, EngineShape, EngineTextractCell, EngineWord } from "../types";

export type Box = [number, number, number, number];

/** A word of `t` at left `x`, centre `y`, height `h` (6 ‰ of the page per character). */
export const word = (t: string, x: number, y: number, h = 0.008): EngineWord =>
  ({ t, b: [x, y - h / 2, x + 0.006 * t.length, y + h / 2], conf: 0.99, lineId: 0 });

/** A tag shape of class `cls` centred at `(x, cy)`, `h` tall and wide. */
export const shape = (cy: number, x = 0.12, h = 0.016, cls = "circle", src: "yolo" | "classical" = "yolo", text: string | null = null): EngineShape =>
  ({ b: [x - h / 2, cy - h / 2, x + h / 2, cy + h / 2], cls, src, text, textSrc: text === null ? null : "crop" });

/** A Textract table over `rows` (each `[y0, y1]`) and `cols` (each `[x0, x1]`); `hdrRows` rows carry `hdr`. */
export function table(rows: readonly [number, number][], cols: readonly [number, number][], hdrRows = 0): EnginePageEvidence["textractTables"][number] {
  const cells: EngineTextractCell[] = [];
  rows.forEach(([y0, y1], r) => cols.forEach(([x0, x1], c) => cells.push({ r, c, rs: 1, cs: 1, b: [x0, y0, x1, y1], ...(r < hdrRows ? { hdr: true as const } : {}) })));
  const b: BboxMinMax = [Math.min(...cols.map((c) => c[0])), rows[0][0], Math.max(...cols.map((c) => c[1])), rows[rows.length - 1][1]];
  return { b, cells };
}

export function evidence(partial: Partial<EnginePageEvidence> & { words: EngineWord[] }): EnginePageEvidence {
  return {
    v: 1, page: 1, sheet: { raw: null, key: null }, channelKind: null,
    lines: [], textractTables: [], shapes: [], primitives: [], detections: [], proposals: [], evidenceHash: "test",
    ...partial,
  };
}

/** A stored proposal over `b` whose tag map anchors are `shapes` (their boxes; `rowBbox` as given or a stale top-of-shape band). */
export function proposalWithAnchors(id: string, b: BboxMinMax, anchors: readonly { b: BboxMinMax; tag: string | null; cls?: string }[], rowBbox?: BboxMinMax): EngineProposal {
  return {
    id, b, classId: "door-schedule", p: 0.9, tableP: 0.9,
    tagMap: { rows: anchors.map((a) => ({ tag: a.tag, shapeClass: a.cls ?? "circle", shapeBbox: a.b, rowBbox: rowBbox ?? [b[0], a.b[1], b[2], a.b[1] + (a.b[3] - a.b[1])] })) },
  };
}

/** Engine evidence from a committed synthetic fixture slice (LTWH → MinMax at the loader edge, E-4). */
export function evidenceFromFixture(s: LegacySlice & { page: { tables?: { bbox: Box; cells: { row: number; col: number; rowSpan: number; colSpan: number; bbox: Box }[] }[] } }): EnginePageEvidence {
  return evidence({
    words: s.page.words.map((w) => ({ t: w.text, b: ltwhToMinMax(w.bbox), conf: (w.confidence ?? 99) / 100, lineId: 0 })),
    textractTables: (s.page.tables ?? []).map((t) => ({
      b: ltwhToMinMax(t.bbox),
      cells: t.cells.map((c) => ({ r: c.row - 1, c: c.col - 1, rs: c.rowSpan, cs: c.colSpan, b: ltwhToMinMax(c.bbox) })),
    })),
    shapes: s.shapes.map((sh) => ({ b: sh.bbox, cls: sh.label, src: sh.source, text: sh.text ?? null, textSrc: sh.text ? "crop" : null })),
  });
}
