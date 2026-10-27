// @vitest-environment node
// [table pipeline WP-2.E] The parse-engine contract (PLAN §2.1): zod round-trips and caps, the zod
// schemas agree with the hand-written types (compile-time), capability versions, and the stubs throw.
// Every string here is synthetic (rule 12).
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import * as barrel from "@/lib/parse-engine";
import { runParseEngine } from "@/lib/parse-engine/engine";
import { applyOps } from "@/lib/parse-engine/ops";
import {
  zCorrectionOp,
  zCorrectionOps,
  zParseRequest,
  zRegionDataExt,
  zRegionLinks,
  zStructureModel,
  zStructureParagraphDoc,
  zStructureTableModel,
} from "@/lib/parse-engine/schema";
import {
  PARSE_ENGINE_CAPS,
  PARSE_ENGINE_VERSION,
  ParseEngineNotImplementedError,
  type CorrectionOp,
  type EnginePageEvidence,
  type ParseRequest,
  type ParseResult,
  type RegionDataExt,
  type RegionLinks,
  type StructureParagraphDoc,
  type StructureTableModel,
} from "@/lib/parse-engine/types";
import { CAPABILITY_VERSIONS, staleCapabilities } from "@/lib/parse-engine/version";

// ── compile-time: schema output ≡ hand-written type (both directions) ────────────────────────────
expectTypeOf<z.infer<typeof zParseRequest>>().toEqualTypeOf<ParseRequest>();
expectTypeOf<z.infer<typeof zCorrectionOp>>().toEqualTypeOf<CorrectionOp>();
expectTypeOf<z.infer<typeof zStructureTableModel>>().toEqualTypeOf<StructureTableModel>();
expectTypeOf<z.infer<typeof zStructureParagraphDoc>>().toEqualTypeOf<StructureParagraphDoc>();
expectTypeOf<z.infer<typeof zRegionLinks>>().toEqualTypeOf<RegionLinks>();
expectTypeOf<z.infer<typeof zRegionDataExt>>().toEqualTypeOf<RegionDataExt>();

const para: StructureParagraphDoc = {
  v: 1, kind: "notes", bbox: [0.1, 0.6, 0.4, 0.8],
  title: { text: "QX NOTES", src: "header-band", conf: 0.9 },
  blocks: [{ id: "b1", header: "QX NOTES", headerNorm: "QX NOTES", b: [0.1, 0.6, 0.4, 0.62] }],
  paragraphs: [
    { id: "p1", blockId: "b1", key: "1", keyPath: ["1"], keyNorm: "1", depth: 0, text: "LOREM IPSUM\nDOLOR", b: [0.1, 0.62, 0.4, 0.66], lineCount: 2 },
    { id: "p2", blockId: "b1", key: null, keyPath: [], keyNorm: "", depth: 0, text: "SIT AMET", b: [0.1, 0.66, 0.4, 0.68], lineCount: 1 },
  ],
  sources: { segment: ["hanging-indent", "layout"] },
  quality: { conf: 0.8, agreement: 0.9, flags: [] },
};

const table: StructureTableModel = {
  v: 1, kind: "schedule", bbox: [0.1, 0.1, 0.5, 0.4], parts: [[0.55, 0.1, 0.95, 0.4]],
  title: { text: "QX SCHEDULE", src: "header-band", conf: 0.95 }, classId: "door",
  rows: [
    { id: "r1", y0: 0.1, y1: 0.13, role: "header" },
    { id: "r2", y0: 0.13, y1: 0.16, role: "body", key: { kind: "shape-text", text: "QX-10", shapeClass: "hexagon", shapeBbox: [0.1, 0.13, 0.12, 0.15], textSource: "inside" } },
    { id: "r3", y0: 0.16, y1: 0.18, role: "section" },
    { id: "r4", y0: 0.18, y1: 0.21, part: 1, role: "body", key: { kind: "symbol", shapeBbox: [0.55, 0.18, 0.57, 0.2] } },
  ],
  cols: [
    { id: "c1", x0: 0.1, x1: 0.2, label: "MARK", labelRaw: "MARK", role: "tag" },
    { id: "c2", x0: 0.2, x1: 0.5, label: "MARK (2)", labelRaw: "MARK", group: "TYPE", role: "qty" },
  ],
  cells: [
    { row: "r2", col: "c1", text: "QX-10", src: "shape-centres" },
    { row: "r2", col: "c2", text: "LOREM\nIPSUM", src: "textract-cells", b: [0.2, 0.13, 0.5, 0.16], conf: 0.9 },
    { row: "r3", col: "c1", cs: 2, text: "SECTION", src: "edit", csi: [{ code: "08 71 00", description: "QX", src: "engine" }] },
  ],
  headerRows: 1,
  tag: { col: "c1", src: "shape", shapeClass: "hexagon", pattern: "QX-##", scope: "sheet" },
  notes: para,
  sources: { rows: ["shape-centres", "ocr-lines"], cols: ["x-starts"] },
  quality: { conf: 0.9, agreement: 0.8, flags: ["section-rows:1"] },
};

const ops: CorrectionOp[] = [
  { op: "pin-source", axis: "rows", method: "textract-cells" },
  { op: "pin-source", axis: "cols", method: null },
  { op: "set-lines", axis: "rows", at: [0.1, 0.13, 0.16] },
  { op: "move-line", axis: "cols", after: "c1", at: 0.21 },
  { op: "add-line", axis: "rows", at: 0.17 },
  { op: "remove-line", axis: "rows", after: "r2" },
  { op: "user-boxes", rows: [[0.1, 0.1, 0.5, 0.13]], cols: [] },
  { op: "set-header-rows", n: 2 },
  { op: "set-tag-col", col: null },
  { op: "set-tag-scope", scope: "project" },
  { op: "set-col-role", col: "c2", role: "qty" },
  { op: "set-col-role", col: "c2", role: null },
  { op: "rename-col", col: "c2", label: "QTY" },
  { op: "edit-cell", row: "r2", col: "c2", text: "LOREM" },
  { op: "merge-cells", row: "r3", col: "c1", rs: 1, cs: 2 },
  { op: "set-row-key", row: "r2", text: "QX-11" },
  { op: "split-paragraph", p: "p1", atLine: 1 },
  { op: "merge-paragraph", p: "p2" },
  { op: "set-paragraph-key", p: "p2", key: "2" },
  { op: "mark-block-header", lineIndex: 0 },
  { op: "set-csi", target: { row: "r2" }, codes: [{ code: "08 71 00", description: "QX", src: "user" }] },
  { op: "set-title", text: "QX SCHEDULE" },
  { op: "set-kind", kind: "keynote", classId: "keynotes" },
];

const links: RegionLinks = {
  origin: "workspace", revision: 3, viewHash: "abc123", proposalId: "schedules.v1:p4:0.1,0.1,0.5,0.4",
  continues: "sr-schedule-5-100-100-500-400", acceptedAt: "2026-10-27T00:00:00.000Z", acceptedBy: 7,
};

const request: ParseRequest = {
  page: 4, bbox: [0.1, 0.1, 0.5, 0.4], kind: "schedule", budget: "instant",
  parts: [[0.55, 0.1, 0.95, 0.4], [0.1, 0.5, 0.5, 0.7]],
  hints: { proposalId: "x", headerRows: 1, tagCol: 0, expectedCols: 5, tatr: false, allowPaidTextract: false },
  prior: table,
};

describe("parse-engine contract: zod round-trips", () => {
  it("a schedule model with continuation parts, a NOTES block, sections and spans round-trips", () => {
    expect(zStructureModel.parse(table)).toEqual(table);
    expect(zStructureTableModel.parse(table).notes).toEqual(para);
  });

  it("a paragraph model round-trips; models are told apart by kind", () => {
    expect(zStructureModel.parse(para)).toEqual(para);
    expect(zStructureTableModel.safeParse(para).success).toBe(false);
    expect(zStructureParagraphDoc.safeParse(table).success).toBe(false);
  });

  it("every correction op round-trips (incl. set-lines and set-col-role)", () => {
    for (const op of ops) expect(zCorrectionOp.parse(op)).toEqual(op);
    expect(zCorrectionOps.parse(ops)).toEqual(ops);
    expect(new Set(ops.map((o) => o.op)).size).toBe(21); // every op kind in §2.1
  });

  it("a request with parts and a prior, region links with continues, and the data extension round-trip", () => {
    expect(zParseRequest.parse(request)).toEqual(request);
    expect(zRegionLinks.parse(links)).toEqual(links);
    const ext: RegionDataExt = { structure: table, links, recipe: { request, origin: "proposal" }, ops };
    expect(zRegionDataExt.parse(ext)).toEqual(ext);
  });
});

describe("parse-engine contract: refusals and caps", () => {
  it("unknown keys, LTWH-looking boxes and bad enums are refused", () => {
    expect(zParseRequest.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(zParseRequest.safeParse({ ...request, bbox: [0.5, 0.1, 0.2, 0.3] }).success).toBe(false); // x1 < x0
    expect(zParseRequest.safeParse({ ...request, bbox: [0.1, 0.1, 1.2, 0.3] }).success).toBe(false);
    expect(zParseRequest.safeParse({ ...request, budget: "free" }).success).toBe(false);
    expect(zCorrectionOp.safeParse({ op: "set-col-role", col: "c1", role: "price" }).success).toBe(false);
    expect(zCorrectionOp.safeParse({ op: "set-lines", axis: "diag", at: [] }).success).toBe(false);
    expect(zCorrectionOp.safeParse({ op: "set-lines", axis: "rows", at: [1.5] }).success).toBe(false);
    expect(zCorrectionOp.safeParse({ op: "set-csi", target: {}, codes: [] }).success).toBe(false);
    expect(zCorrectionOp.safeParse({ op: "set-csi", target: { row: "r1", p: "p1" }, codes: [] }).success).toBe(false);
    expect(zCorrectionOp.safeParse({ op: "drop-table" }).success).toBe(false);
    expect(zRegionLinks.safeParse({ ...links, continues: "" }).success).toBe(false);
  });

  it(`parts are capped at ${PARSE_ENGINE_CAPS.parts}`, () => {
    const box: [number, number, number, number] = [0.1, 0.1, 0.2, 0.2];
    expect(zParseRequest.safeParse({ ...request, parts: Array(PARSE_ENGINE_CAPS.parts).fill(box) }).success).toBe(true);
    expect(zParseRequest.safeParse({ ...request, parts: Array(PARSE_ENGINE_CAPS.parts + 1).fill(box) }).success).toBe(false);
    expect(zStructureTableModel.safeParse({ ...table, parts: Array(PARSE_ENGINE_CAPS.parts + 1).fill(box) }).success).toBe(false);
  });

  it("rows, cols, cells and cell text are capped", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, y0: 0.1, y1: 0.2, role: "body" as const }));
    const cols = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, x0: 0.1, x1: 0.2, label: "X", labelRaw: "X" }));
    const cells = (n: number) => Array.from({ length: n }, () => ({ row: "r1", col: "c1", text: "", src: "edit" as const }));
    expect(zStructureTableModel.safeParse({ ...table, rows: rows(PARSE_ENGINE_CAPS.rows) }).success).toBe(true);
    expect(zStructureTableModel.safeParse({ ...table, rows: rows(PARSE_ENGINE_CAPS.rows + 1) }).success).toBe(false);
    expect(zStructureTableModel.safeParse({ ...table, cols: cols(PARSE_ENGINE_CAPS.cols) }).success).toBe(true);
    expect(zStructureTableModel.safeParse({ ...table, cols: cols(PARSE_ENGINE_CAPS.cols + 1) }).success).toBe(false);
    expect(zStructureTableModel.safeParse({ ...table, cells: cells(PARSE_ENGINE_CAPS.cells) }).success).toBe(true);
    expect(zStructureTableModel.safeParse({ ...table, cells: cells(PARSE_ENGINE_CAPS.cells + 1) }).success).toBe(false);
    const long = "Q".repeat(PARSE_ENGINE_CAPS.cellText + 1);
    expect(zStructureTableModel.safeParse({ ...table, cells: [{ row: "r1", col: "c1", text: long, src: "edit" }] }).success).toBe(false);
    expect(zCorrectionOp.safeParse({ op: "edit-cell", row: "r1", col: "c1", text: long }).success).toBe(false);
  });

  it("paragraphs and paragraph text are capped, also inside a schedule's notes", () => {
    const p = (text: string) => ({ ...para.paragraphs[0], text });
    const many = Array.from({ length: PARSE_ENGINE_CAPS.paragraphs + 1 }, (_, i) => ({ ...para.paragraphs[0], id: `p${i + 1}` }));
    expect(zStructureParagraphDoc.safeParse({ ...para, paragraphs: many }).success).toBe(false);
    expect(zStructureParagraphDoc.safeParse({ ...para, paragraphs: [p("Q".repeat(PARSE_ENGINE_CAPS.paragraphText))] }).success).toBe(true);
    expect(zStructureParagraphDoc.safeParse({ ...para, paragraphs: [p("Q".repeat(PARSE_ENGINE_CAPS.paragraphText + 1))] }).success).toBe(false);
    expect(zStructureTableModel.safeParse({ ...table, notes: { ...para, paragraphs: many } }).success).toBe(false);
  });

  it(`ops are capped at ${PARSE_ENGINE_CAPS.ops}`, () => {
    const op: CorrectionOp = { op: "set-header-rows", n: 1 };
    expect(zCorrectionOps.safeParse(Array(PARSE_ENGINE_CAPS.ops).fill(op)).success).toBe(true);
    expect(zCorrectionOps.safeParse(Array(PARSE_ENGINE_CAPS.ops + 1).fill(op)).success).toBe(false);
    expect(zRegionDataExt.safeParse({ ops: Array(PARSE_ENGINE_CAPS.ops + 1).fill(op) }).success).toBe(false);
  });
});

describe("parse-engine contract: versions and stubs", () => {
  it("every capability starts at version 1; stale capabilities are the ones stamped below current", () => {
    expect(PARSE_ENGINE_VERSION).toBe("pe/1.0.0");
    expect(Object.keys(CAPABILITY_VERSIONS).sort()).toEqual(
      ["cells", "cols", "csi", "evidence", "headers", "kind", "paragraphs", "refs", "rows", "tagColumn", "tagMap", "title"],
    );
    expect(Object.values(CAPABILITY_VERSIONS).every((v) => v === 1)).toBe(true);
    expect(staleCapabilities({ rows: 0, cols: 1 })).toEqual(["rows"]);
    expect(staleCapabilities({})).toEqual([]);
    expect(staleCapabilities(undefined)).toEqual([]);
  });

  it("runParseEngine and applyOps are typed stubs that throw NotImplemented", async () => {
    const ev = { v: 1, page: 1 } as unknown as EnginePageEvidence;
    await expect(runParseEngine(ev, request)).rejects.toBeInstanceOf(ParseEngineNotImplementedError);
    await expect(runParseEngine(ev, request)).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    expect(() => applyOps({} as ParseResult, ops)).toThrow(ParseEngineNotImplementedError);
    expectTypeOf(runParseEngine).returns.resolves.toEqualTypeOf<ParseResult>();
  });

  it("the barrel re-exports the contract, versions, stubs and the 2.0b primitives", () => {
    for (const name of ["PARSE_ENGINE_VERSION", "CAPABILITY_VERSIONS", "runParseEngine", "applyOps", "wordsToLines", "assembleText", "wordsIn", "ltwhToMinMax", "ParseEngineNotImplementedError"]) {
      expect(barrel, name).toHaveProperty(name);
    }
  });
});
