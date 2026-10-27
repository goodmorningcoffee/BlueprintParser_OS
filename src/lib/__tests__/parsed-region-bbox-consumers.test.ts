// [table pipeline WP-2.A] K04: a saved ParsedRegion.bbox is MinMax [x0,y0,x1,y1]. The composite
// classifier, the ensemble votes, the classifier-engine candidates and the knowledge graph each read
// it as LTWH, so a schedule at [.6,.1,.9,.4] became a zone [.6,.1,1.5,.5] and plan tags beside it
// were down-tiered. Every consumer now reads it through `parsedRegionMinMax`. Synthetic data only.
import { describe, expect, it } from "vitest";
import type { ClassifiedPageRegions, ParsedRegion, TextractPageData } from "@/types";
import { classifyPageRegions } from "@/lib/composite-classifier";
import { votesFromParsedRegions } from "@/lib/ensemble/vote-adapters";
import { collectCandidates } from "@/lib/classifier-engine/candidates";
import type { ClassifierPageInput, PageEvidence } from "@/lib/classifier-engine/evidence";
import type { ClassifierRecipe } from "@/lib/classifier-engine/types";
import { buildKnowledgeGraph } from "@/lib/knowledge-graph";
import type { GraphPageInput } from "@/lib/knowledge-graph/types";
import { allPagesScope, findOccurrences, type MatchContext } from "@/lib/tag-mapping";

const BOX: [number, number, number, number] = [0.6, 0.1, 0.9, 0.4];

function schedule(bbox: unknown = BOX, id = "pr1"): ParsedRegion {
  return {
    id, type: "schedule", category: "qx-schedule", bbox, confidence: 0.9,
    data: { headers: ["QK"], rows: [{ QK: "QX-1" }], tagColumn: "QK" },
  } as unknown as ParsedRegion;
}

describe("K04 — composite classifier", () => {
  it("a parsed schedule at [.6,.1,.9,.4] gives a table zone of the same box", () => {
    const regions = classifyPageRegions({ pageNumber: 1, yoloAnnotations: [], parsedRegions: [schedule()] });
    expect(regions.tables).toHaveLength(1);
    expect(regions.tables[0].bbox).toEqual(BOX);
    expect(regions.tables[0].sources).toEqual(["parsedRegions"]);
  });

  it("a malformed saved box contributes no zone instead of a NaN zone", () => {
    const regions = classifyPageRegions({
      pageNumber: 1, yoloAnnotations: [],
      parsedRegions: [schedule(null, "a"), schedule([0.1, 0.2, 0.3], "b"), schedule([0.1, Number.NaN, 0.3, 0.4], "c")],
    });
    expect(regions.tables).toEqual([]);
  });

  it("a plan tag at x = .95 beside the schedule is not down-tiered", () => {
    const words = [{ text: "QX-1", confidence: 0.99, bbox: [0.95, 0.2, 0.03, 0.015] as [number, number, number, number] }];
    const textractData: Record<number, TextractPageData> = { 1: { words, lines: [] } };
    const ctxFor = (regions: ClassifiedPageRegions): MatchContext => ({
      scope: allPagesScope(), isPageScoped: false, annotations: [], textractData,
      classifiedRegionsByPage: { 1: regions }, pattern: null,
    });
    const item = { itemType: "text-only" as const, label: "QX-1", text: "QX-1" };

    const regions = classifyPageRegions({ pageNumber: 1, yoloAnnotations: [], parsedRegions: [schedule()] });
    const [hit] = findOccurrences(item, ctxFor(regions));
    expect(hit.signals?.regionType).not.toBe("tables");
    expect(hit.dropReason).toBeUndefined();

    // Control: the pre-fix stretched zone does swallow the tag, so this test can tell the two apart.
    const stretched: ClassifiedPageRegions = {
      ...regions, tables: [{ ...regions.tables[0], bbox: [0.6, 0.1, 1.5, 0.5] }],
    };
    const [old] = findOccurrences(item, ctxFor(stretched));
    expect(old.signals?.regionType).toBe("tables");
    expect(old.dropReason).toBe("inside_table");
    expect(hit.score ?? 0).toBeGreaterThan(old.score ?? 0);
  });
});

describe("K04 — ensemble votes", () => {
  it("votes carry the saved MinMax box converted to LTWH (votes are LTWH)", () => {
    const votes = votesFromParsedRegions([schedule()]);
    expect(votes).toHaveLength(1);
    const [l, t, w, h] = votes[0].bbox;
    expect([l, t]).toEqual([0.6, 0.1]);
    expect(w).toBeCloseTo(0.3, 12);
    expect(h).toBeCloseTo(0.3, 12);
  });

  it("a region without a usable box casts no vote", () => {
    expect(votesFromParsedRegions([schedule(null), schedule([1, 2])])).toEqual([]);
  });
});

describe("K04 — classifier-engine parsed-regions candidates", () => {
  const recipe = { unit: "region", candidates: [{ type: "parsed-regions" }], scope: {} } as unknown as ClassifierRecipe;
  const page = { titleBlocks: [], words: [] } as unknown as PageEvidence;
  const input = (parsedRegions: ClassifierPageInput["parsedRegions"]) => ({ parsedRegions } as unknown as ClassifierPageInput);

  it("the candidate box is the saved box, not an LTWH re-read", () => {
    const out = collectCandidates(recipe, input([{ bbox: BOX }]), page);
    expect(out).toEqual([{ source: "parsed-regions", bbox: BOX, anchorBbox: BOX }]);
  });

  it("missing or degenerate boxes are skipped", () => {
    expect(collectCandidates(recipe, input([{ bbox: null }, { bbox: [0.5, 0.5, 0.4, 0.6] }, {}]), page)).toEqual([]);
  });
});

describe("K04 — knowledge graph table nodes", () => {
  const page = (parsedRegions: GraphPageInput["parsedRegions"]): GraphPageInput =>
    ({ pageNumber: 1, drawingNumber: "QX-100", parsedRegions } as unknown as GraphPageInput);

  it("the table node's LTWH box is the saved MinMax box converted, not the raw numbers", () => {
    const g = buildKnowledgeGraph({ publicId: "p", pages: [page([{ id: "pr1", type: "schedule", category: "qx-schedule", bbox: BOX }])] });
    const node = g.nodes.find((n) => n.id === "table:1:pr:pr1") as { bbox?: number[]; provenance?: Array<{ bbox?: number[] }> };
    expect(node).toBeDefined();
    const [l, t, w, h] = node.bbox ?? [];
    expect([l, t]).toEqual([0.6, 0.1]);
    expect(w).toBeCloseTo(0.3, 12);
    expect(h).toBeCloseTo(0.3, 12);
    expect(node.provenance?.[0]?.bbox).toEqual(node.bbox);
  });

  it("a region with no box keeps the zero box and no provenance box", () => {
    const g = buildKnowledgeGraph({ publicId: "p", pages: [page([{ id: "pr2", type: "schedule", category: "qx-schedule" }])] });
    const node = g.nodes.find((n) => n.id === "table:1:pr:pr2") as { bbox?: number[]; provenance?: Array<{ bbox?: number[] }> };
    expect(node.bbox).toEqual([0, 0, 0, 0]);
    expect(node.provenance?.[0]?.bbox).toBeUndefined();
  });
});
