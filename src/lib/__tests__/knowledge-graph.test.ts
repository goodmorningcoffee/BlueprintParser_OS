// @vitest-environment node
// [graph T8 2026-10-24] Knowledge graph v1 (src/lib/knowledge-graph): sheet-number normalisation,
// reference resolution (exact / prefix / ambiguous / unresolved / self), detail titles + stacked
// callouts, tables ↔ tags ↔ CSI, revision_of, the tag-family hook, and the storage shapes
// (summary, index, derived keys). Every example here is measured against the builder, not prose.
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeGraph,
  graphIndex,
  graphIndexObjectKey,
  graphLinesFromTextract,
  graphObjectKey,
  graphWordsFromTextract,
  isKnowledgeGraph,
  normaliseDetailNumber,
  normaliseSheetNumber,
  pageInputFromStored,
  parseDetailSlash,
  sheetNeighbourhood,
  storedGraphSummary,
  summarizeGraph,
  type GraphPageInput,
  type HasCsiEdge,
  type ReferenceEdge,
} from "@/lib/knowledge-graph";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const bbox = (l: number, t: number, w = 0.02, h = 0.01): [number, number, number, number] => [l, t, w, h];

function page(pageNumber: number, drawingNumber: string | null, extra: Partial<GraphPageInput> = {}): GraphPageInput {
  return { pageNumber, drawingNumber, ...extra };
}

const refs = (edges: ReturnType<typeof buildKnowledgeGraph>["edges"]) => edges.filter((e): e is ReferenceEdge => e.type === "references");

describe("sheet numbers", () => {
  it("normalises separators, case and a zero decimal; rejects prose", () => {
    for (const raw of ["E-300", "E300", "E 300", "e-300", "E-300.00", "E_300"]) expect(normaliseSheetNumber(raw)).toBe("E300");
    expect(normaliseSheetNumber("A101.01")).toBe("A101.01");
    expect(normaliseSheetNumber("FA-001.00")).toBe("FA001");
    expect(normaliseSheetNumber("T001.04")).toBe("T001.04");
    expect(normaliseSheetNumber("GSQ22")).toBe("GSQ22");
    for (const raw of ["", "SEE", "WALL SECTION", "12", "ABCD-1", null, undefined]) expect(normaliseSheetNumber(raw)).toBeNull();
  });
  it("detail numbers and the slash form", () => {
    expect(normaliseDetailNumber("03")).toBe("3");
    expect(normaliseDetailNumber("a")).toBe("A");
    expect(normaliseDetailNumber("123")).toBeNull();
    expect(parseDetailSlash("3/A-501")).toEqual({ detail: "3", sheet: "A-501" });
    expect(parseDetailSlash("A / A501.01")).toEqual({ detail: "A", sheet: "A501.01" });
    expect(parseDetailSlash("3/A")).toBeNull();
  });
});

describe("buildKnowledgeGraph — references", () => {
  const pages: GraphPageInput[] = [
    page(1, "A-100", {
      crossRefs: [
        { sourceText: "SEE SHEET E300", targetDrawing: "E300", refType: "sheet", bbox: bbox(0.1, 0.1), confidence: 0.85 },
        { sourceText: "3/A-501", targetDrawing: "A-501", refType: "detail", detail: "3", bbox: bbox(0.2, 0.2), confidence: 0.8 },
        { sourceText: "SEE SHEET Z-999", targetDrawing: "Z-999", refType: "sheet", bbox: bbox(0.3, 0.3), confidence: 0.85 },
        { sourceText: "REFER TO A-101", targetDrawing: "A-101", refType: "refer", bbox: bbox(0.4, 0.4), confidence: 0.85 },
      ],
      textAnnotations: [
        // the same E300 reference seen by the second extractor → one edge, seen=2
        { type: "sheet-ref", text: "SEE SHEET E-300", bbox: bbox(0.1, 0.1), confidence: 90, meta: { sheetNumber: "E-300" } },
        { type: "detail-ref", text: "5/A-100", bbox: bbox(0.5, 0.5), confidence: 88, meta: { detail: "5", sheet: "A-100" } },
      ],
    }),
    page(2, "E-300.00"),
    page(3, "A-501", { lines: [{ text: "3 WALL SECTION", bbox: bbox(0.1, 0.9, 0.2) }, { text: "1 ALL DIMENSIONS ARE TO FACE OF STUD", bbox: bbox(0.1, 0.5, 0.3) }] }),
    page(4, "A101.01"),
    page(5, "A101.02"),
  ];
  const graph = buildKnowledgeGraph({ publicId: "p1", pages }, { now: NOW });
  const edges = refs(graph.edges);
  const byTarget = (key: string, detail?: string) => edges.find((e) => e.targetKey === key && e.detail === detail)!;

  it("resolves across separators and a zero decimal, merging two extractors into one edge", () => {
    const e = byTarget("E300");
    expect(e.status).toBe("resolved");
    expect(e.to).toBe("sheet:2");
    expect(e.seen).toBe(2);
    expect(e.provenance.map((p) => p.extractor).sort()).toEqual(["crossRefs", "text-annotations"]);
    expect(e.confidence).toBe(0.9); // max(0.85, 90/100)
  });

  it("detail refs land on a (detail, sheet) node; a title on the sheet makes detailFound true", () => {
    const e = byTarget("A501", "3");
    expect(e.status).toBe("resolved");
    expect(e.kind).toBe("detail");
    expect(e.to).toBe("detail:3:3");
    expect(e.detailFound).toBe(true);
    const detail = graph.nodes.find((n) => n.id === "detail:3:3");
    expect(detail).toMatchObject({ type: "detail", origin: "title", label: "3 WALL SECTION" });
    expect(graph.edges.find((x) => x.type === "defined_in" && x.from === "detail:3:3")?.to).toBe("sheet:3");
    // the numbered general note is NOT a detail title
    expect(graph.nodes.find((n) => n.id === "detail:3:1")).toBeUndefined();
  });

  it("a self detail ref creates the detail node as reference-target with detailFound=false", () => {
    const e = byTarget("A100", "5");
    expect(e).toMatchObject({ status: "resolved", self: true, detailFound: false, to: "detail:1:5" });
    expect(graph.nodes.find((n) => n.id === "detail:1:5")).toMatchObject({ origin: "reference-target" });
  });

  it("keeps an unresolved reference as an edge with to:null, and an ambiguous prefix match lists candidates", () => {
    expect(byTarget("Z999")).toMatchObject({ status: "unresolved", to: null });
    const amb = byTarget("A101");
    expect(amb.status).toBe("ambiguous");
    expect(amb.to).toBeNull();
    expect(amb.candidates).toEqual(["sheet:4", "sheet:5"]);
  });

  it("a prefix match on exactly one sheet resolves with reduced confidence", () => {
    const g = buildKnowledgeGraph({ publicId: "p", pages: [
      page(1, "A-100", { crossRefs: [{ sourceText: "REFER TO A-101", targetDrawing: "A-101", refType: "refer", bbox: bbox(0, 0), confidence: 0.8 }] }),
      page(2, "A101.01"),
    ] }, { now: NOW });
    expect(refs(g.edges)[0]).toMatchObject({ status: "resolved", to: "sheet:2", confidence: 0.72 });
  });

  it("is deterministic: same input, same ids and order", () => {
    const again = buildKnowledgeGraph({ publicId: "p1", pages }, { now: NOW });
    expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
  });
});

describe("buildKnowledgeGraph — stacked callouts (\"3 over A-501\")", () => {
  // Word geometry: the number sits directly above the sheet number, centres aligned.
  const words = (num: string, sheet: string, l = 0.5, t = 0.5) => [
    { text: num, bbox: bbox(l, t, 0.01, 0.01) },
    { text: sheet, bbox: bbox(l - 0.01, t + 0.012, 0.03, 0.01) },
    { text: "7", bbox: bbox(0.9, 0.9, 0.01, 0.01) }, // a lone number: no sheet below it → nothing
  ];
  it("naming another sheet is a detail reference; naming its own sheet defines the detail", () => {
    const g = buildKnowledgeGraph({ publicId: "p", pages: [
      page(1, "A-100", { words: words("3", "A-501") }),
      page(2, "A-501", { words: words("3", "A-501", 0.2, 0.2) }),
    ] }, { now: NOW });
    const e = refs(g.edges);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ from: "sheet:1", kind: "detail", detail: "3", targetKey: "A501", status: "resolved", to: "detail:2:3", detailFound: true });
    expect(e[0].provenance[0]).toMatchObject({ extractor: "stacked-callout", page: 1 });
    expect(g.nodes.find((n) => n.id === "detail:2:3")).toMatchObject({ origin: "stacked-title" });
  });
  it("graphWordsFromTextract keeps only the two token shapes; graphLinesFromTextract only title-shaped lines", () => {
    expect(graphWordsFromTextract([{ text: "3", bbox: bbox(0, 0) }, { text: "A-501", bbox: bbox(0, 0) }, { text: "WALL", bbox: bbox(0, 0) }])).toHaveLength(2);
    expect(graphWordsFromTextract([{ text: "WALL", bbox: bbox(0, 0) }])).toBeNull();
    expect(graphLinesFromTextract([{ text: "3 WALL SECTION", bbox: bbox(0, 0) }, { text: "GENERAL NOTES", bbox: bbox(0, 0) }])).toHaveLength(1);
  });
});

describe("buildKnowledgeGraph — tables, tags, keynotes, CSI, revisions, families", () => {
  const pages: GraphPageInput[] = [
    page(1, "A-600", {
      parsedRegions: [{
        id: "pr1", type: "schedule", category: "door-schedule", bbox: bbox(0.1, 0.1, 0.5, 0.3),
        csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors", division: "08" }],
        data: { headers: ["MARK", "TYPE"], rows: [{ MARK: "D-01", TYPE: "HM" }, { MARK: "D-02", TYPE: "WD" }], tagColumn: "MARK" },
      }, {
        id: "kn", type: "keynote-table", category: "keynote-table", bbox: bbox(0.6, 0.1, 0.3, 0.3),
        data: { keynotes: [{ key: "K1", description: "Patch wall" }] },
      }],
      classifiedTables: [{ id: "ct1", category: "finish-schedule", bbox: bbox(0.1, 0.5, 0.4, 0.2), confidence: 0.6 }],
      regionsV2: { regions: [{ id: "v2a", kind: "table", className: "door schedule", bbox: [0.1, 0.1, 0.6, 0.4], nameScore: 0.8 }, { id: "v2b", kind: "notes", className: "UNCLASSIFIED", bbox: [0, 0, 0.1, 0.1], nameScore: 0.2 }] },
      csiCodes: [{ code: "08 11 13", description: "Hollow Metal Doors", division: "08", confidence: 0.9, triggers: [{ text: "hollow metal", bbox: bbox(0.2, 0.2) }] }],
    }),
    page(2, "A-101", {
      textAnnotations: [
        { type: "door-window-tag", text: "D-01", bbox: bbox(0.3, 0.3), confidence: 80 },
        { type: "door-window-tag", text: "D-01", bbox: bbox(0.6, 0.6), confidence: 80 },
        { type: "equipment-tag", text: "EF-1", bbox: bbox(0.7, 0.7), confidence: 80, csiTags: [{ code: "23 34 00", division: "23" }] },
        { type: "sheet-number", text: "A-101", bbox: bbox(0.95, 0.95), confidence: 90 }, // its own number: not a reference
      ],
      keynotes: [{ shape: "hexagon", text: "K1", bbox: [0.4, 0.4, 0.42, 0.42] }, { shape: "hexagon", text: "K1", bbox: [0.5, 0.5, 0.52, 0.52] }],
    }),
    page(3, "A-101", { duplicateOf: 2, hidden: true }),
  ];
  const graph = buildKnowledgeGraph({ publicId: "p2", pages, tagFamilies: [{ key: "D-##", label: "Doors", members: [{ page: 2, text: "D-01" }, { page: 9, text: "D-77" }] }] }, { now: NOW });
  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edge = (type: string, from: string, to?: string) => graph.edges.find((e) => e.type === type && e.from === from && (to === undefined || e.to === to));

  it("builds table nodes from all three sources (only table-like v2 kinds) and rows from parsed data", () => {
    expect(graph.nodes.filter((n) => n.type === "table").map((n) => n.id).sort()).toEqual(["table:1:ct:ct1", "table:1:pr:kn", "table:1:pr:pr1", "table:1:v2:v2a"]);
    expect(node("table:1:pr:pr1:row:0")).toMatchObject({ type: "table_row", tag: "D-01", label: "D-01" });
    expect(node("table:1:pr:kn:row:0")).toMatchObject({ type: "table_row", tag: "K1" });
    expect(edge("inside", "table:1:pr:pr1", "sheet:1")).toBeTruthy();
  });

  it("tags dedupe per page with a count, schedule to their row, and inherit CSI as propagated/low trust", () => {
    expect(node("tag:2:D-01")).toMatchObject({ type: "tag", count: 2, tagType: "door-window-tag" });
    expect(edge("scheduled_as", "tag:2:D-01", "table:1:pr:pr1:row:0")).toBeTruthy();
    const csi = edge("has_csi", "tag:2:D-01", "csi:08 11 13") as HasCsiEdge;
    expect(csi).toMatchObject({ method: "propagated", trust: 0.3 });
    const direct = edge("has_csi", "tag:2:EF-1", "csi:23 34 00") as HasCsiEdge;
    expect(direct).toMatchObject({ method: "span", trust: 0.6 });
    expect(graph.nodes.filter((n) => n.type === "tag")).toHaveLength(2); // sheet-number is not a tag
  });

  it("keynote codes count occurrences and schedule to the legend row; sheets and tables carry span CSI", () => {
    expect(node("keynote:2:K1")).toMatchObject({ type: "keynote_code", count: 2 });
    expect(edge("scheduled_as", "keynote:2:K1", "table:1:pr:kn:row:0")).toBeTruthy();
    expect(edge("has_csi", "sheet:1", "csi:08 11 13")).toMatchObject({ method: "span", trust: 0.9 });
    expect((edge("has_csi", "sheet:1", "csi:08 11 13") as HasCsiEdge).provenance[0]).toMatchObject({ extractor: "csiCodes", text: "hollow metal" });
    expect(edge("has_csi", "table:1:pr:pr1", "csi:08 11 13")).toMatchObject({ method: "span", trust: 0.7 });
    expect(node("csi:08 11 13")).toMatchObject({ type: "csi_code", division: "08" });
  });

  it("revision_of: same number (later → earlier) and the admin duplicate mark merge onto one edge", () => {
    const rev = graph.edges.filter((e) => e.type === "revision_of");
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ from: "sheet:3", to: "sheet:2", basis: "same-number", confidence: 0.9 });
    expect(rev[0].provenance.map((p) => p.extractor)).toEqual(["title-block", "duplicateOf"]);
    expect(node("sheet:3")).toMatchObject({ hidden: true });
  });

  it("tag families come only through the hook; unknown members are ignored", () => {
    expect(node("tag_family:D-##")).toMatchObject({ type: "tag_family", label: "Doors" });
    expect(edge("is_a", "tag:2:D-01", "tag_family:D-##")).toBeTruthy();
    expect(graph.edges.filter((e) => e.type === "is_a")).toHaveLength(1);
  });

  it("a reference to a sheet number shared by two pages resolves to the visible one", () => {
    const g = buildKnowledgeGraph({ publicId: "p", pages: [
      page(1, "G-001", { crossRefs: [{ sourceText: "SEE SHEET A-101", targetDrawing: "A-101", refType: "sheet", bbox: bbox(0, 0), confidence: 0.8 }] }),
      page(2, "A-101"), page(3, "A-101", { hidden: true, duplicateOf: 2 }),
    ] }, { now: NOW });
    expect(refs(g.edges)[0]).toMatchObject({ status: "resolved", to: "sheet:2", candidates: ["sheet:2", "sheet:3"] });
  });
});

describe("storage shapes", () => {
  const pages: GraphPageInput[] = [
    page(1, "A-100", { crossRefs: [
      { sourceText: "SEE SHEET E300", targetDrawing: "E300", refType: "sheet", bbox: bbox(0.1, 0.1), confidence: 0.85 },
      { sourceText: "SEE SHEET Z-9", targetDrawing: "Z-9", refType: "sheet", bbox: bbox(0.1, 0.2), confidence: 0.85 },
    ] }),
    page(2, "E-300"),
  ];
  const graph = buildKnowledgeGraph({ publicId: "p3", pages }, { now: NOW });

  it("summary counts nodes/edges/resolution and per-sheet degree; never an S3 key", () => {
    const s = summarizeGraph(graph, 1234);
    expect(s).toMatchObject({ v: 1, stored: "s3", bytes: 1234, computedAt: NOW.toISOString() });
    expect(s.nodes).toEqual({ project: 1, sheet: 2 });
    expect(s.edges).toEqual({ inside: 2, references: 2 });
    expect(s.references).toEqual({ total: 2, resolved: 1, unresolved: 1, ambiguous: 0, self: 0, detailFound: 0, detailMissing: 0 });
    expect(s.sheets).toEqual([{ page: 1, number: "A-100", out: 2, in: 0, unresolved: 1 }, { page: 2, number: "E-300", out: 0, in: 1, unresolved: 0 }]);
    expect(s.unresolvedTop).toEqual([{ target: "Z-9", count: 1 }]);
    expect(JSON.stringify(s)).not.toContain("/graph/");
    expect(storedGraphSummary({ knowledgeGraph: s })).toEqual(s);
    expect(storedGraphSummary({ knowledgeGraph: { v: 2 } })).toBeNull();
    expect(storedGraphSummary(null)).toBeNull();
  });

  it("index gives per-page refers-to / referenced-by with page numbers and the unresolved queue", () => {
    const idx = graphIndex(graph);
    expect(idx.pages[1].refersTo).toEqual([
      { page: 2, sheet: "E300", kind: "sheet", status: "resolved", confidence: 0.85, seen: 1, text: "SEE SHEET E300" },
      { page: null, sheet: "Z-9", kind: "sheet", status: "unresolved", confidence: 0.85, seen: 1, text: "SEE SHEET Z-9" },
    ]);
    expect(idx.pages[2].referencedBy).toEqual([{ page: 1, sheet: "A-100", kind: "sheet", status: "resolved", confidence: 0.85, seen: 1, text: "SEE SHEET E300" }]);
    expect(idx.unresolved).toEqual([{ fromPage: 1, fromSheet: "A-100", sheet: "Z-9", status: "unresolved", confidence: 0.85, text: "SEE SHEET Z-9" }]);
    expect(idx.counts).toEqual({ nodes: 3, edges: 4 });
  });

  it("neighbourhood of a sheet: its edges and the nodes at the other ends", () => {
    const n = sheetNeighbourhood(graph, 2)!;
    expect(n.nodes.map((x) => x.id).sort()).toEqual(["project:p3", "sheet:1", "sheet:2"]);
    expect(n.edges.map((e) => e.type).sort()).toEqual(["inside", "references"]);
    expect(sheetNeighbourhood(graph, 99)).toBeNull();
  });

  it("derived S3 keys and the graph type guard", () => {
    expect(graphObjectKey("co/proj")).toBe("co/proj/graph/knowledge-graph.v1.json");
    expect(graphIndexObjectKey("co/proj")).toBe("co/proj/graph/knowledge-graph.v1.index.json");
    expect(isKnowledgeGraph(graph)).toBe(true);
    expect(isKnowledgeGraph({ v: 1 })).toBe(false);
  });

  it("pageInputFromStored narrows a stored row (annotations filtered to refs + tags, hidden from duplicateOf)", () => {
    const input = pageInputFromStored({
      pageNumber: 4, drawingNumber: "M-1", name: "HVAC",
      pageIntelligence: { crossRefs: [{ sourceText: "x", targetDrawing: "A-1", refType: "sheet", bbox: bbox(0, 0) }], duplicateOf: { pageNumber: 2, hiddenAt: "2026-10-24" }, classification: { discipline: "Mechanical" } },
      textAnnotations: { annotations: [{ type: "phone", text: "555", bbox: bbox(0, 0) }, { type: "sheet-ref", text: "SEE A-1", bbox: bbox(0, 0) }, { type: "equipment-tag", text: "EF-1", bbox: bbox(0, 0) }] },
      csiCodes: "not-an-array", keynotes: null,
    });
    expect(input).toMatchObject({ pageNumber: 4, hidden: true, duplicateOf: 2, name: "HVAC", csiCodes: null, keynotes: null });
    expect(input.textAnnotations?.map((a) => a.type)).toEqual(["sheet-ref", "equipment-tag"]);
    expect(input.crossRefs).toHaveLength(1);
  });
});
