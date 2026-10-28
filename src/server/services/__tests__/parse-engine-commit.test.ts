// @vitest-environment node
// [table pipeline WP-3.G] The commit's pure halves: op landing (C3-m1), rebase row counts, ids, text-region keys,
// page CSI that shrinks (K50), and tags on accept (keys, scope, rows, legacy retirement; C3-M2, K05).
// All strings are synthetic (rule 12).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null })); // the service graph reaches next-auth (as parse-engine-run.test.ts)
import type { CorrectionOp, StructureParagraphDoc, StructureTableModel } from "@/lib/parse-engine/types";
import {
  changedRows,
  lostOps,
  mintRegionId,
  opRefs,
  parseCommitBody,
  parseTextRegionKey,
  regionRevision,
  viewChangedSince,
} from "@/server/services/parse-engine/commit";
import { isPageOwnedCsi, pageCsiAfterRegionChange } from "@/server/services/parse-engine/page-csi";
import {
  acceptTagPlan,
  buildAcceptTagRows,
  legacyTagIdsToRetire,
  matchAcceptTags,
  type AcceptTagSource,
} from "@/server/services/parse-engine/accept-tags";
import { isYoloTagRow, yoloTagServerKey } from "@/lib/parse-engine/tag-key";
import type { CsiCode } from "@/types";

const Q = { conf: 1, agreement: 1, flags: [] as string[] };

function keynote(over: Partial<StructureTableModel> = {}): StructureTableModel {
  return {
    v: 1, kind: "keynote", bbox: [0.7, 0.7, 0.95, 0.9], headerRows: 1,
    rows: [
      { id: "r0", y0: 0.7, y1: 0.72, role: "header" },
      { id: "r1", y0: 0.72, y1: 0.75, role: "body", csi: [{ code: "09 91 23", description: "Synthetic paint", src: "engine" }] },
      { id: "r2", y0: 0.75, y1: 0.78, role: "body" },
      { id: "r3", y0: 0.78, y1: 0.8, role: "section" },
    ],
    cols: [
      { id: "c2", x0: 0.75, x1: 0.95, label: "NOTE", labelRaw: "NOTE" },
      { id: "c1", x0: 0.7, x1: 0.75, label: "KEY", labelRaw: "KEY" },
    ],
    cells: [
      { row: "r0", col: "c1", text: "KEY", src: "ocr-lines" },
      { row: "r1", col: "c1", text: " QZ7 ", src: "ocr-lines" },
      { row: "r1", col: "c2", text: "LOREM\nIPSUM", src: "ocr-lines" },
      { row: "r2", col: "c1", text: "QZ8", src: "ocr-lines" },
      { row: "r3", col: "c1", text: "SECTION", src: "ocr-lines" },
    ],
    tag: { col: "c1", src: "header", scope: "sheet" },
    sources: { rows: ["ocr-lines"], cols: ["x-starts"] },
    quality: Q,
    ...over,
  };
}

const notes: StructureParagraphDoc = {
  v: 1, kind: "notes", bbox: [0.1, 0.1, 0.4, 0.4],
  blocks: [{ id: "b1", header: "GENERAL NOTES", headerNorm: "GENERAL NOTES", b: [0.1, 0.1, 0.4, 0.12] }],
  paragraphs: [
    { id: "p1", blockId: "b1", key: "1", keyPath: ["1"], keyNorm: "1", depth: 0, text: "Lorem", b: [0.1, 0.12, 0.4, 0.15], lineCount: 1 },
    { id: "p2", blockId: "b1", key: "2", keyPath: ["2"], keyNorm: "2", depth: 0, text: "Ipsum", b: [0.1, 0.15, 0.4, 0.18], lineCount: 1 },
  ],
  sources: { segment: ["hanging-indent"] }, quality: Q,
};

describe("commit: ops that no longer land (C3-m1)", () => {
  it("names the ids each op reads", () => {
    expect(opRefs({ op: "edit-cell", row: "r1", col: "c2", text: "x" })).toEqual({ rows: ["r1"], cols: ["c2"], paragraphs: [] });
    expect(opRefs({ op: "move-line", axis: "cols", after: "c1", at: 0.5 })).toEqual({ rows: [], cols: ["c1"], paragraphs: [] });
    expect(opRefs({ op: "set-tag-col", col: null })).toEqual({ rows: [], cols: [], paragraphs: [] });
    expect(opRefs({ op: "set-csi", target: { p: "p2" }, codes: [] })).toEqual({ rows: [], cols: [], paragraphs: ["p2"] });
    expect(opRefs({ op: "pin-source", axis: "rows", method: "ocr-lines" })).toEqual({ rows: [], cols: [], paragraphs: [] });
  });

  it("an op on an id the re-parse lost is reported; ids an earlier op minted (present after the ops) are not", () => {
    const base = keynote();
    const after = keynote({ rows: [...keynote().rows, { id: "r9", y0: 0.8, y1: 0.82, role: "body" }] });
    const ops: CorrectionOp[] = [
      { op: "add-line", axis: "rows", at: 0.81 },
      { op: "edit-cell", row: "r9", col: "c2", text: "new" },
      { op: "edit-cell", row: "r1", col: "c2", text: "ok" },
      { op: "set-row-key", row: "r44", text: "gone" },
      { op: "rename-col", col: "c7", label: "gone" },
      { op: "merge-paragraph", p: "p1" },
    ];
    expect(lostOps(base, after, ops)).toEqual([
      { index: 3, op: "set-row-key" },
      { index: 4, op: "rename-col" },
      { index: 5, op: "merge-paragraph" },
    ]);
    expect(lostOps(notes, notes, [{ op: "set-paragraph-key", p: "p2", key: "3" }])).toEqual([]);
  });
});

describe("commit: rebase row count", () => {
  it("counts moved, re-texted, added and removed rows; null without the draft's model", () => {
    const prev = keynote();
    const moved = keynote({
      rows: [prev.rows[0], { ...prev.rows[1], y1: 0.76 }, prev.rows[2], { id: "r4", y0: 0.8, y1: 0.82, role: "body" }],
      cells: prev.cells.map((c) => (c.row === "r2" ? { ...c, text: "QZ9" } : c)),
    });
    // r1 moved, r2 re-texted, r4 added, r3 removed
    expect(changedRows(prev, moved)).toBe(4);
    expect(changedRows(prev, prev)).toBe(0);
    expect(changedRows(undefined, prev)).toBeNull();
    expect(changedRows(notes, { ...notes, paragraphs: [notes.paragraphs[0]] })).toBe(1);
  });
});

describe("commit: ids, revisions, keys, body", () => {
  it("mints a kind-aware id from the q3 box", () => {
    expect(mintRegionId("schedule", 3, [0.12345, 0.2, 0.5, 0.6])).toBe("sr-schedule-3-0.123_0.200_0.500_0.600");
    expect(mintRegionId("notes", 3, [0.12345, 0.2, 0.5, 0.6])).not.toBe(mintRegionId("schedule", 3, [0.12345, 0.2, 0.5, 0.6]));
  });

  it("a classic region is revision 0; a workspace region reads links.revision", () => {
    expect(regionRevision({ data: { headers: [] } })).toBe(0);
    expect(regionRevision({ data: { links: { revision: 4 } } })).toBe(4);
    expect(regionRevision({ data: { links: { revision: -1 } } })).toBe(0);
  });

  it("a classic edit after the last workspace save is a changed view (PLAN §1.1 row 7); a sent viewHash decides alone", () => {
    const saved = { data: { headers: ["K"], links: { revision: 2, viewHash: "vh1:a" } } };
    expect(viewChangedSince(saved, "vh1:a", undefined)).toBe(false); // untouched workspace region
    expect(viewChangedSince(saved, "vh1:b", undefined)).toBe(true);  // edited in a classic panel, draft cannot know
    expect(viewChangedSince(saved, "vh1:b", "vh1:b")).toBe(false);   // the draft was (re)loaded on that edit
    expect(viewChangedSince(saved, "vh1:b", "vh1:a")).toBe(true);
    expect(viewChangedSince({ data: { headers: ["K"] } }, "vh1:c", undefined)).toBe(false); // classic region: revision 0 rules
    expect(viewChangedSince({ data: { headers: ["K"] } }, "vh1:c", "vh1:d")).toBe(true);
  });

  it("parses the content key of a text region (WP-3.F's `tr:${type}:${q2}`) and refuses junk", () => {
    expect(parseTextRegionKey("tr:notes-numbered:0.10,0.20,0.40,0.50")).toEqual({ type: "notes-numbered", b: [0.1, 0.2, 0.4, 0.5] });
    expect(parseTextRegionKey("tr:notes-numbered:0.40,0.20,0.10,0.50")).toBeNull();
    expect(parseTextRegionKey("notes-numbered:0.1,0.2,0.4,0.5")).toBeNull();
  });

  it("drops fields the server computes (a forged machine snapshot), requires a revision with a regionId", () => {
    const recipe = { origin: "proposal", request: { page: 1, bbox: [0.1, 0.1, 0.4, 0.4], budget: "instant" } };
    const body = parseCommitBody({ recipe, ops: [], machine: { kind: "spec" }, label: { verdict: "correct" } });
    expect(body).not.toHaveProperty("machine");
    expect(body).not.toHaveProperty("label");
    expect(() => parseCommitBody({ recipe, regionId: "parsed-1" })).toThrow(/revision/);
    expect(() => parseCommitBody({ recipe: { ...recipe, request: { ...recipe.request, budget: "free" } } })).toThrow(/Invalid commit/);
  });
});

describe("page CSI that shrinks (K50)", () => {
  const code = (c: string, extra: Partial<CsiCode> = {}): CsiCode => ({ code: c, description: "d", division: "", trade: "", ...extra });

  it("drops a removed region's code that nothing else carries; keeps trigger-bearing, YOLO and shared codes", () => {
    const existing = [
      code("08 11 13"),                                                    // only the removed region → dropped
      code("09 91 23", { triggers: [] }),                                   // text detection (triggers array) → kept
      code("22 40 00", { description: "From YOLO class config" }),          // YOLO class → kept
      code("23 05 00"),                                                    // another region still carries it → kept
      code("26 05 00"),                                                    // not the removed region's → untouched
    ];
    const out = pageCsiAfterRegionChange(existing, [code("081113"), code("09 91 23"), code("22 40 00"), code("23 05 00")], [[code("23 05 00")]]);
    expect(out.map((c) => c.code)).toEqual(["09 91 23", "22 40 00", "23 05 00", "26 05 00"]);
  });

  it("a replacement keeps the codes the new region carries and merges its new ones", () => {
    const out = pageCsiAfterRegionChange([code("08 11 13"), code("08 71 00")], [code("08 11 13"), code("08 71 00")], [], [code("08 71 00"), code("10 14 00")]);
    expect(out.map((c) => c.code)).toEqual(["08 71 00", "10 14 00"]);
    expect(isPageOwnedCsi(code("1", { triggers: [] }))).toBe(true);
    expect(isPageOwnedCsi(code("1"))).toBe(false);
  });
});

describe("tags on accept (C3-M2)", () => {
  const w = (text: string, x: number, y: number) => ({ text, confidence: 99, bbox: [x, y, 0.02, 0.01] });
  const source: AcceptTagSource = {
    annotations: [],
    pages: [
      { pageNumber: 1, drawingNumber: "A-101", pageIntelligence: null, textractData: { lines: [], tables: [], words: [w("QZ7", 0.3, 0.3), w("QZ7", 0.4, 0.5), w("QZ8", 0.2, 0.2)] } },
      { pageNumber: 2, drawingNumber: "A-102", pageIntelligence: null, textractData: { lines: [], tables: [], words: [w("QZ7", 0.3, 0.3)] } },
    ],
  };

  it("plans the body-row keys (trimmed, deduped; header and section rows skipped); notes map none", () => {
    const plan = acceptTagPlan(keynote(), 1);
    expect(plan).toMatchObject({ kind: "keynote", page: 1, scope: "sheet", itemType: "text-only" });
    expect(plan!.keys).toEqual([
      { rowId: "r1", text: "QZ7", description: "LOREM IPSUM", csi: ["09 91 23"] },
      { rowId: "r2", text: "QZ8", description: "", csi: [] },
    ]);
    expect(acceptTagPlan(notes, 1)).toBeNull();
    expect(acceptTagPlan(keynote({ kind: "schedule", tag: undefined }), 1)).toBeNull();
    expect(acceptTagPlan(keynote({ kind: "schedule", tag: { col: "c1", src: "header", scope: "project" } }), 1)!.scope).toBe("project");
    expect(acceptTagPlan(keynote({ kind: "schedule", tag: { col: "c1", src: "header", scope: "sheet" } }), 1)!.scope).toBe("sheet");
    const shaped = acceptTagPlan(keynote({ tag: { col: "c1", src: "shape", shapeClass: "circle", scope: "sheet" } }), 1)!;
    expect(shaped).toMatchObject({ itemType: "yolo-with-inner-text", shapeClass: "circle" });
    const keyed = keynote({ rows: keynote().rows.map((r) => (r.id === "r2" ? { ...r, key: { kind: "shape-text" as const, text: "QZ5", shapeClass: "circle", shapeBbox: [0.7, 0.75, 0.72, 0.77] as [number, number, number, number], textSource: "inside" as const } } : r)) });
    expect(acceptTagPlan(keyed, 1)!.keys.map((k) => k.text)).toEqual(["QZ7", "QZ5"]);
  });

  it("a keynote maps on THIS sheet only; a schedule maps across the project", () => {
    const sheet = matchAcceptTags(acceptTagPlan(keynote(), 1)!, source);
    expect(sheet.results.QZ7.map((m) => m.pageNumber)).toEqual([1, 1]);
    expect(sheet.results.QZ8.map((m) => m.pageNumber)).toEqual([1]);
    const project = matchAcceptTags(acceptTagPlan(keynote({ kind: "schedule", tag: { col: "c1", src: "header", scope: "project" } }), 1)!, source);
    expect(project.results.QZ7.map((m) => m.pageNumber).sort()).toEqual([1, 1, 2]);
  });

  it("builds linked rows the viewer keeps, keyed per region; 0-hit keys are counted, not written", () => {
    const plan = acceptTagPlan(keynote(), 1)!;
    const { tags, summary } = buildAcceptTagRows({ plan, results: { QZ7: matchAcceptTags(plan, source).results.QZ7, QZ8: [] } }, "sr-keynote-1-x");
    expect(summary).toEqual({ keys: 2, tags: 1, hits: 2, none: 1, noneKeys: ["QZ8"], scope: "sheet" });
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      id: "sr-keynote-1-x:r1", tagText: "QZ7", source: "keynote", scope: "page", pageNumber: 1, description: "LOREM IPSUM",
      csiCodes: ["09 91 23"], links: { regionId: "sr-keynote-1-x", rowId: "r1", kind: "keynote" },
    });
    expect(isYoloTagRow(tags[0])).toBe(true);
    expect(yoloTagServerKey(tags[0])).toBe("keynote|page|1|sr-keynote-1-x|QZ7|");
    const legend = buildAcceptTagRows({ plan: { ...plan, kind: "legend" }, results: { QZ7: [{ pageNumber: 1, annotationId: -1, bbox: [0, 0, 0.1, 0.1], confidence: 1 }] } }, "r-l");
    expect(legend.tags[0]).toMatchObject({ source: "keynote", links: { kind: "legend" } });
  });

  it("retires only the replaced classic table's unlinked rows (id prefix + key)", () => {
    const plan = acceptTagPlan(keynote(), 1)!;
    const rows = [
      { id: "keynote-1-QZ7-100", source: "keynote", tagText: "qz7" },
      { id: "keynote-2-QZ7-100", source: "keynote", tagText: "QZ7" },       // another sheet
      { id: "keynote-1-QZ9-100", source: "keynote", tagText: "QZ9" },       // not a key of this table
      { id: "keynote-1-QZ8-100", source: "keynote", tagText: "QZ8", links: { regionId: "other" } }, // linked
      { id: "schedule-1-QZ8-100", source: "schedule", tagText: "QZ8" },     // other source
    ];
    expect(legacyTagIdsToRetire(rows, plan)).toEqual(["keynote-1-QZ7-100"]);
  });
});
