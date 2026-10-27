// @vitest-environment node
// [table pipeline WP-3.A] Row fusion probes, one per §1.4 rule (R2–R8, R10–R12), on synthetic geometry; the
// committed synthetic fixtures for regime, parity and determinism. All text is pseudo-text (rule 12).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { methodOcrPositions } from "@/lib/services/table-parse";
import { CLUSTER_TOL_H, boundaryAgreement, fuseBoundaries, fuseRows, rowsInputFor } from "../fuse";
import { fuseRowsForParts, tokenOverlap } from "../parts";
import { legacyRowClusters, ocrLinesRows } from "../rows/ocr-lines";
import { loadSlices } from "./golden-harness";
import { evidence, evidenceFromFixture, proposalWithAnchors, shape, table, word, type Box } from "./rows-evidence-helpers";
import type { EngineWord } from "../types";

const BOX: Box = [0.1, 0.1, 0.6, 0.6];
const D = 0.012; // line pitch inside a 3-line row
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** A shape-tag schedule: a header line, then one 3-line description per centre; keys `D-10i` inside the shapes. */
function schedule(centres: readonly number[], opts: { missing?: readonly number[]; keyX?: number } = {}): { words: EngineWord[]; shapes: ReturnType<typeof shape>[] } {
  const words: EngineWord[] = [word("KEY", 0.105, 0.15), word("DESC", 0.2, 0.15)];
  const shapes: ReturnType<typeof shape>[] = [];
  centres.forEach((c, i) => {
    words.push(word(`D-10${i + 1}`, opts.keyX ?? 0.105, c), word(`R${i}A`, 0.2, c - D), word(`R${i}B QX`, 0.2, c), word(`R${i}C`, 0.2, c + D));
    if (!(opts.missing ?? []).includes(c)) shapes.push(shape(c));
  });
  return { words, shapes };
}

const bodyRows = (f: ReturnType<typeof fuseRows>) => f.rows.filter((r) => r.role === "body");
const keyText = (r: ReturnType<typeof fuseRows>["rows"][number]): string | null => (r.key && r.key.kind !== "symbol" ? r.key.text : null);

describe("fuseRows — shape regime (R2, R3, R10)", () => {
  it("R2: five centred shapes covering the body put the box in the shape regime; each 3-line description is one row, the header stays out", () => {
    const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
    const { words, shapes } = schedule(cs);
    const f = fuseRows(rowsInputFor(evidence({ words, shapes }), BOX));
    expect(f.regime).toBe("shape");
    expect(f.headerRows).toBe(1);
    expect(f.rows[0].role).toBe("header");
    const body = bodyRows(f);
    expect(body.map(keyText)).toEqual(["D-101", "D-102", "D-103", "D-104", "D-105"]);
    expect(body.map((r) => [r6(r.y0), r6(r.y1)])).toEqual([[0.175, 0.225], [0.225, 0.275], [0.275, 0.325], [0.325, 0.375], [0.375, 0.425]]);
    expect(f.sources).toEqual(["shape-centres"]);
    expect(f.shapeColumn?.shapes).toHaveLength(5);
    expect(f.flags).not.toContain("shape-missing");
  });

  it("R2: two shapes, or a column that covers few of the body lines, fall back to the cluster regime", () => {
    const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
    const two = schedule(cs);
    two.shapes = two.shapes.slice(0, 2);
    expect(fuseRows(rowsInputFor(evidence(two), BOX)).regime).toBe("cluster");
    // three shapes on the first three rows of an eight-row body: the span covers 9 of 25 lines (< 60 %)
    const long = schedule([0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55]);
    long.shapes = long.shapes.slice(0, 3);
    expect(fuseRows(rowsInputFor(evidence(long), BOX)).regime).toBe("cluster");
  });

  it("R10: a yolo and a classical read of the same bubble are ONE shape; an in-table shape column still counts", () => {
    const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
    const { words, shapes } = schedule(cs);
    const twins = shapes.map((s) => shape((s.b[1] + s.b[3]) / 2, 0.1205, 0.0158, "circle", "classical", null));
    const f = fuseRows(rowsInputFor(evidence({ words, shapes: [...shapes, ...twins] }), BOX));
    expect(f.regime).toBe("shape");
    expect(f.shapeColumn?.shapes).toHaveLength(5);
    expect(f.shapeColumn?.shapes.every((s) => s.both)).toBe(true);
    // the same column printed in the middle of the box (right of the .25 left share the classifier requires)
    const mid = schedule(cs, { keyX: 0.405 });
    mid.shapes = mid.shapes.map((s) => shape((s.b[1] + s.b[3]) / 2, 0.42));
    mid.words = mid.words.map((w) => (w.b[0] === 0.2 ? { ...w, b: [0.45, w.b[1], 0.45 + (w.b[2] - w.b[0]), w.b[3]] as Box } : w));
    const g = fuseRows(rowsInputFor(evidence(mid), BOX));
    expect(g.regime).toBe("shape");
    expect(bodyRows(g).map(keyText)).toEqual(["D-101", "D-102", "D-103", "D-104", "D-105"]);
  });
});

describe("fuseRows — R4 veto and its key-text exception, R5 snap and section rows", () => {
  it("R4: Textract cells that split every wrapped row into its lines are vetoed; the shapes keep five rows", () => {
    const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
    const { words, shapes } = schedule(cs);
    const lineRows = cs.flatMap((c) => [c - D, c, c + D]).map((y) => [y - 0.004, y + 0.004] as [number, number]);
    const t = table([[0.146, 0.154], ...lineRows], [[0.1, 0.18], [0.18, 0.5]]);
    const f = fuseRows(rowsInputFor(evidence({ words, shapes, textractTables: [t] }), BOX));
    expect(f.regime).toBe("shape");
    expect(bodyRows(f)).toHaveLength(5);
    expect(f.flags).not.toContain("shape-missing");
    const tx = f.alternatives.find((a) => a.method === "textract-cells")!;
    expect(tx.rows).toBe(16);
    expect(tx.agreement).toBeLessThan(0.7);
    expect(f.flags).toContain("rows-disagree");
  });

  it("R4 exception: a row whose shape is missing but whose key text fits the siblings survives the veto, flagged shape-missing", () => {
    // shapes at .2 .25 | (missing .3) | .37 .42 — Textract has one row per description, so its boundary at .275
    // falls inside the midpoint band [.225, .31] of the .25 shape; the sub-band below it holds the key D-103
    const cs = [0.2, 0.25, 0.3, 0.37, 0.42];
    const { words, shapes } = schedule(cs, { missing: [0.3] });
    const t = table([[0.146, 0.154], ...cs.map((c) => [c - 0.017, c + 0.017] as [number, number])], [[0.1, 0.18], [0.18, 0.5]]);
    const f = fuseRows(rowsInputFor(evidence({ words, shapes, textractTables: [t] }), BOX));
    expect(f.regime).toBe("shape");
    const body = bodyRows(f);
    expect(body.map(keyText)).toEqual(["D-101", "D-102", "D-103", "D-104", "D-105"]);
    expect(body[2].flags).toContain("shape-missing");
    expect(body[2].key?.kind).toBe("text");
    expect(body.map((r) => [r6(r.y0), r6(r.y1)])).toEqual([[0.175, 0.225], [0.225, 0.275], [0.275, 0.31], [0.31, 0.395], [0.395, 0.445]]);
    expect(body.filter((r) => r.flags.includes("shape-missing"))).toHaveLength(1);
    expect(f.flags).toContain("shape-missing");
  });

  it("R5 snap: a midpoint within 0.5 h of a Textract row edge moves onto it; textract-cells joins the sources", () => {
    const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
    const { words, shapes } = schedule(cs);
    // Textract rows end 2 ‰ below each midpoint (within .5 h = .004)
    const t = table([[0.146, 0.154], ...cs.map((c) => [c - 0.023, c + 0.027] as [number, number])], [[0.1, 0.18], [0.18, 0.5]]);
    const f = fuseRows(rowsInputFor(evidence({ words, shapes, textractTables: [t] }), BOX));
    const body = bodyRows(f);
    expect(body.slice(0, 4).map((r) => r6(r.y1))).toEqual([0.227, 0.277, 0.327, 0.377]);
    expect(f.sources).toEqual(["shape-centres", "textract-cells"]);
    expect(f.flags).not.toContain("rows-disagree");
  });

  it("R5 section rows: a key-less all-caps line spanning the box between two shapes gets its own band; the bands beside it are cut", () => {
    const cs = [0.2, 0.25, 0.3, 0.35];
    const { words, shapes } = schedule(cs);
    // a wide all-caps section title, starting at the tag column, between row 1 (.25) and row 2 (.3), where a
    // midpoint cut would swallow it
    words.push(word("SECTION TITLE ACROSS THE WHOLE TABLE WIDTH HERE", 0.105, 0.275));
    const f = fuseRows(rowsInputFor(evidence({ words, shapes }), BOX));
    expect(f.regime).toBe("shape");
    const sections = f.rows.filter((r) => r.role === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0].y0).toBeGreaterThan(0.262); // below row 1's last line
    expect(sections[0].y1).toBeLessThan(0.288); // above row 2's first line
    const i = f.rows.indexOf(sections[0]);
    expect(f.rows[i - 1].y1).toBe(sections[0].y0);
    expect(f.rows[i + 1].y0).toBe(sections[0].y1);
    expect(keyText(f.rows[i - 1])).toBe("D-102");
    expect(keyText(f.rows[i + 1])).toBe("D-103");
    expect(f.flags).toContain("section-rows:1");
    // a line of the same shape WITH a key in the tag column is a body row, not a section
    const g = schedule(cs);
    g.words.push(word("D-109", 0.105, 0.275), word("SECTION TITLE ACROSS THE WHOLE TABLE WIDTH HERE", 0.2, 0.275));
    expect(fuseRows(rowsInputFor(evidence(g), BOX)).rows.filter((r) => r.role === "section")).toHaveLength(0);
    // an all-caps line that starts in the DESCRIPTION column is a wrapped description's continuation, not a section
    const k = schedule(cs);
    k.words.push(word("WRAPPED ALL CAPS CONTINUATION LINE OF A DESCRIPTION", 0.2, 0.275));
    expect(fuseRows(rowsInputFor(evidence(k), BOX)).rows.filter((r) => r.role === "section")).toHaveLength(0);
  });
});

describe("fuseRows — R2 tag-column half and rows above the first shape (gold-measured cases)", () => {
  it("rows above the first live shape with key text of their own are body rows flagged shape-missing, not header rows", () => {
    // D-101 and D-102 have no shape (the detector missed the first two rows); Textract has one row per description
    const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
    const { words, shapes } = schedule(cs, { missing: [0.2, 0.25] });
    const t = table([[0.146, 0.154], ...cs.map((c) => [c - 0.017, c + 0.017] as [number, number])], [[0.1, 0.18], [0.18, 0.5]], 1);
    const f = fuseRows(rowsInputFor(evidence({ words, shapes, textractTables: [t] }), BOX));
    expect(f.regime).toBe("shape");
    expect(f.headerRows).toBe(1);
    expect(f.rows[0].role).toBe("header");
    const body = bodyRows(f);
    expect(body.map(keyText)).toEqual(["D-101", "D-102", "D-103", "D-104", "D-105"]);
    expect(body.slice(0, 2).every((r) => r.flags.includes("shape-missing"))).toBe(true);
    expect(body.slice(2).every((r) => !r.flags.includes("shape-missing"))).toBe(true);
  });

  it("a column of rectangles with repeated keys (table cells, check boxes) is not a tag column: Textract decides the rows", () => {
    const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
    const words: EngineWord[] = [word("KEY", 0.105, 0.15), word("DESC", 0.2, 0.15)];
    cs.forEach((c, i) => { words.push(word("X", 0.118, c), word(`R${i}A ZQ`, 0.2, c)); });
    const boxes = cs.map((c) => shape(c, 0.12, 0.016, "rectangle"));
    const t = table([[0.146, 0.154], ...cs.map((c) => [c - 0.02, c + 0.02] as [number, number])], [[0.1, 0.18], [0.18, 0.5]], 1);
    const f = fuseRows(rowsInputFor(evidence({ words, shapes: boxes, textractTables: [t] }), BOX));
    expect(f.regime).toBe("cluster");
    // the same column with distinct keys IS a tag column
    const g = words.map((w, i) => (w.t === "X" ? { ...w, t: `${i}`, b: w.b } : w));
    expect(fuseRows(rowsInputFor(evidence({ words: g, shapes: boxes, textractTables: [t] }), BOX)).regime).toBe("shape");
    // and shapes without text that Textract out-numbers do not anchor the rows
    const noText = words.filter((w) => w.t !== "X");
    const t2 = table([[0.146, 0.154], ...[0.2, 0.225, 0.25, 0.275, 0.3, 0.325, 0.35, 0.375, 0.4].map((c) => [c - 0.01, c + 0.01] as [number, number])], [[0.1, 0.18], [0.18, 0.5]], 1);
    expect(fuseRows(rowsInputFor(evidence({ words: noText, shapes: cs.map((c) => shape(c)), textractTables: [t2] }), BOX)).regime).toBe("cluster");
  });
});

describe("fuseRows — R6 anchors are a prior, not a vote", () => {
  const cs = [0.2, 0.25, 0.3, 0.35, 0.4];
  it("anchors fill in a missing live shape: anchors-only rows equal the shapes-only rows, and the anchor row is flagged", () => {
    const full = schedule(cs);
    const a = fuseRows(rowsInputFor(evidence(full), BOX));
    const partial = schedule(cs, { missing: [0.3] });
    const anchors = full.shapes.map((s, i) => ({ b: s.b, tag: `D-10${i + 1}` }));
    const ev = evidence({ ...partial, proposals: [proposalWithAnchors("p1", BOX, anchors)] });
    const b = fuseRows(rowsInputFor(ev, BOX, { proposalId: "p1" }));
    expect(b.regime).toBe("shape");
    expect(b.rowLines.map(r6)).toEqual(a.rowLines.map(r6));
    expect(bodyRows(b).map(keyText)).toEqual(bodyRows(a).map(keyText));
    const anchorRows = bodyRows(b).filter((r) => r.flags.includes("anchor"));
    expect(anchorRows).toHaveLength(1);
    expect(keyText(anchorRows[0])).toBe("D-103");
    // an anchor with a live shape at IoU ≥ .5 is dropped: the other four anchors added no row
    expect(bodyRows(b)).toHaveLength(5);
    // the owning proposal is found by IoU when no hint is given
    expect(fuseRows(rowsInputFor(ev, BOX)).rowLines.map(r6)).toEqual(a.rowLines.map(r6));
  });

  it("a stale top-of-shape rowBbox on the anchors changes nothing (only the shape-bbox centre is read)", () => {
    const partial = schedule(cs, { missing: [0.3] });
    const anchors = schedule(cs).shapes.map((s, i) => ({ b: s.b, tag: `D-10${i + 1}` }));
    const fresh = fuseRows(rowsInputFor(evidence({ ...partial, proposals: [proposalWithAnchors("p1", BOX, anchors)] }), BOX));
    const stale = fuseRows(rowsInputFor(evidence({ ...partial, proposals: [proposalWithAnchors("p1", BOX, anchors, [0.1, 0.9, 0.6, 0.95])] }), BOX));
    expect(stale.rows).toEqual(fresh.rows);
    expect(stale.rowLines).toEqual(fresh.rowLines);
  });

  it("anchors never vote: without shapes in the regime they add nothing (cluster regime)", () => {
    const none = schedule(cs);
    none.shapes = [];
    const anchors = schedule(cs).shapes.map((s, i) => ({ b: s.b, tag: `D-10${i + 1}` }));
    const f = fuseRows(rowsInputFor(evidence({ ...none, proposals: [proposalWithAnchors("p1", BOX, anchors)] }), BOX));
    expect(f.regime).toBe("cluster");
    expect(f.hypotheses.map((h) => h.method)).not.toContain("shape-centres");
  });
});

describe("fuseBoundaries — R7 weighted majority", () => {
  const H = 0.008;
  it("a boundary with textract + ocr-lines survives; one proposed by layout alone does not (θ = half the weights that ran)", () => {
    const out = fuseBoundaries([
      { method: "textract-cells", conf: 1, lines: [0.2, 0.3] },
      { method: "ocr-lines", conf: 0.8, lines: [0.2001, 0.3002] },
      { method: "layout", conf: 1, lines: [0.25] },
    ], CLUSTER_TOL_H * H);
    expect(out.map((b) => b.methods)).toEqual([["ocr-lines", "textract-cells"], ["ocr-lines", "textract-cells"]]);
    expect(out.map((b) => r6(b.at))[0]).toBeCloseTo(0.2, 3);
    // θ = .5 × (1 + .5 + .4) = .95; layout alone scores .4
    expect(out.every((b) => b.score >= 0.95)).toBe(true);
  });

  it("one vote per method per cluster, position = conf-weighted mean, survivors in order; a lone voter always survives", () => {
    const out = fuseBoundaries([{ method: "ocr-lines", conf: 0.6, lines: [0.3, 0.2, 0.2001] }], CLUSTER_TOL_H * H);
    expect(out).toHaveLength(2);
    expect(out[0].at).toBeCloseTo(0.20005, 9);
    expect(out[0].methods).toEqual(["ocr-lines"]);
    expect(fuseBoundaries([], 0.003)).toEqual([]);
  });

  it("cluster regime end to end: Textract rows and the lines agree → one row per line; a lone layout block edge is dropped", () => {
    // first-column words are NOT key-like, so hanging-indent casts no vote here
    const words: EngineWord[] = [0.2, 0.22, 0.24, 0.26, 0.28].flatMap((y, i) => [word(`ZQRA${i}`, 0.11, y), word(`B${i} C`, 0.2, y)]);
    const t = table([0.2, 0.22, 0.24, 0.26, 0.28].map((y) => [y - 0.007, y + 0.007] as [number, number]), [[0.1, 0.18], [0.18, 0.5]], 1);
    const f = fuseRows(rowsInputFor(evidence({ words, textractTables: [t], layout: [{ k: "text", b: [0.1, 0.19, 0.5, 0.25] }] }), BOX));
    expect(f.regime).toBe("cluster");
    expect(f.rows).toHaveLength(5);
    expect(f.headerRows).toBe(1);
    expect(f.rows[0].role).toBe("header");
    // layout agreed on the .25 boundary, so it is a source too; its lone .19 edge was dropped
    expect(f.sources).toEqual(["layout", "ocr-lines", "textract-cells"]);
    expect(f.rows.map((r) => r6(r.y1)).slice(0, 4)).toEqual([0.21, 0.23, 0.25, 0.27]);
    expect(f.rowLines.map(r6)).toEqual([0.193, 0.21, 0.23, 0.25, 0.27, 0.287]);
    expect(f.hypotheses.find((h) => h.method === "layout")?.rowLines).toEqual([0.19, 0.25]);
  });

  it("boundaryAgreement is a symmetric F1 at the tolerance", () => {
    expect(boundaryAgreement([0.2, 0.3], [0.2001, 0.3001], 0.003)).toBe(1);
    expect(boundaryAgreement([0.2, 0.3, 0.4, 0.5], [0.2, 0.3], 0.003)).toBeCloseTo(0.667, 3);
    expect(boundaryAgreement([], [0.2], 0.003)).toBe(0);
  });
});

describe("parts — R11 continuations", () => {
  it("a repeated header at the top of the second block is dropped; rows are appended in part order with their part index", () => {
    const header = (x: number, y: number) => [word("MARK", x, y), word("DESCRIPTION", x + 0.04, y)];
    const rowsA = [0.17, 0.19, 0.21].flatMap((y, i) => [word(`O-10${i + 1}`, 0.11, y), word(`ZFKMP SNIEV`, 0.15, y)]);
    const rowsB = [0.17, 0.19, 0.21].flatMap((y, i) => [word(`O-20${i + 1}`, 0.36, y), word(`NEKQKA KXB`, 0.4, y)]);
    const ev = evidence({ words: [...header(0.11, 0.15), ...rowsA, ...header(0.36, 0.15), ...rowsB] });
    const f = fuseRowsForParts(ev, [0.1, 0.14, 0.3, 0.22], [[0.35, 0.14, 0.55, 0.22]]);
    expect(f.rows.map((r) => r.part)).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(f.rows.filter((r) => r.part === 1)).toHaveLength(3);
    expect(f.flags).toContain("parts-headers-dropped:1");
    // a second block whose first row is NOT the header keeps all its rows
    const g = fuseRowsForParts(evidence({ words: [...header(0.11, 0.15), ...rowsA, ...rowsB] }), [0.1, 0.14, 0.3, 0.22], [[0.35, 0.14, 0.55, 0.22]]);
    expect(g.rows.filter((r) => r.part === 1)).toHaveLength(3);
    expect(g.flags).not.toContain("parts-headers-dropped:1");
  });

  it("tokenOverlap is the share of the reference tokens present", () => {
    expect(tokenOverlap("MARK DESCRIPTION SIZE", "MARK DESCRIPTION SIZE")).toBe(1);
    expect(tokenOverlap("MARK DESCRIPTION SIZE REMARKS TYPE", "MARK DESCRIPTION SIZE REMARKS")).toBe(0.8);
    expect(tokenOverlap("MARK DESCRIPTION", "O-101 ZFKMP")).toBe(0);
    expect(tokenOverlap("", "X")).toBe(0);
  });
});

describe("committed synthetic fixtures", () => {
  const slices = loadSlices(join(__dirname, "../__fixtures__"), ".synthetic.json");
  it("has the fixtures", () => expect(slices.length).toBeGreaterThanOrEqual(40));

  it("ocr-lines legacy mode: row clusters and boundaries byte-equal to methodOcrPositions on every fixture where it succeeds", () => {
    let compared = 0;
    let exact = 0;
    for (const s of slices) {
      const legacy = methodOcrPositions(s.page.words, s.region);
      const input = rowsInputFor(evidenceFromFixture(s), s.region);
      const hyp = ocrLinesRows(input, "legacy");
      if (legacy.error) {
        // the same bail-outs: too few words / clusters casts no vote (legacy fails later on columns or rows too)
        if (/too few words|too few row clusters/.test(legacy.error)) expect(hyp.error, s.id).toBeDefined();
        continue;
      }
      expect(hyp.error, s.id).toBeUndefined();
      // the LTWH → MinMax conversion at the loader edge (E-4) can move a centre by one ulp, so the comparison
      // is at 12 decimals; `exact` counts the fixtures where every boundary is byte-equal
      const r12 = (v: number): number => Number(v.toFixed(12));
      expect(hyp.rowLines!.map(r12), s.id).toEqual(legacy.rowBoundaries!.map(r12));
      if (hyp.rowLines!.every((v, i) => v === legacy.rowBoundaries![i])) exact++;
      const clusters = legacyRowClusters(input.words);
      expect(clusters.length, s.id).toBe(legacy.rowBoundaries!.length - 1);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(10);
    expect(exact).toBeGreaterThanOrEqual(1);
  });

  it("K13 / K27 shape fixtures run in the shape regime with one body row per shape; the centred 3-line descriptions stay whole", () => {
    const byId = new Map(slices.map((s) => [s.id, s]));
    for (const id of ["syn-sched-shapes-centred-3line", "syn-keynote-shapes", "syn-sched-shapes-hex", "syn-sched-shapes-tall-last"]) {
      const s = byId.get(id)!;
      const f = fuseRows(rowsInputFor(evidenceFromFixture(s), s.region));
      expect(f.regime, id).toBe("shape");
      expect(bodyRows(f).length, id).toBe(s.shapes.length);
    }
    const s = byId.get("syn-sched-shapes-centred-3line")!;
    const input = rowsInputFor(evidenceFromFixture(s), s.region);
    const f = fuseRows(input);
    const truth = (s as unknown as { truth: { rows: string[][] } }).truth.rows;
    bodyRows(f).forEach((r, i) => {
      const text = input.words.filter((w) => (w.b[1] + w.b[3]) / 2 >= r.y0 && (w.b[1] + w.b[3]) / 2 < r.y1 && w.b[0] > input.box[0] + 0.05).map((w) => w.t).join(" ");
      expect(text.split(" ").sort(), `${s.id} row ${i}`).toEqual(truth[i][1].split(" ").sort());
    });
  });

  it("is deterministic on every fixture (E-7): two runs are deep-equal", () => {
    for (const s of slices) {
      const ev = evidenceFromFixture(s);
      const a = fuseRows(rowsInputFor(ev, s.region));
      const b = fuseRows(rowsInputFor(ev, s.region));
      expect(JSON.stringify(b), s.id).toBe(JSON.stringify(a));
      expect(a.rowLines, s.id).toEqual([...a.rowLines].sort((p, q) => p - q));
      for (const r of a.rows) expect(r.y1, s.id).toBeGreaterThanOrEqual(r.y0);
    }
  });
});
