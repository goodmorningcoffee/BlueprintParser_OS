/**
 * csi-graph.test.ts — buildCsiGraph structural baseline.
 *
 * [refactor jul9 P2-A C1] Written as the FREEZE-FIRST baseline in commit C0
 * (SPEC_FINAL §6.2-2, C2-F4): node ids/order, edge set, cluster membership,
 * fingerprint, plus the Div-00 fallback label "Division 00" (the old local
 * table lacked "00").
 *
 * Commit C2 swapped the local table for the canonical 25-division map
 * (@/lib/csi-divisions). The STRUCTURE pinned here stayed byte-identical
 * through C2 (the map is only a label lookup at the node-name fallback);
 * the ONE sanctioned flip, re-pinned below, is the Div-00 label
 * "Division 00" → "Procurement" (ledger D-8) [C1 approval 2026-07-09].
 */
import { describe, it, expect } from "vitest";
import { buildCsiGraph } from "@/lib/csi-graph";
import type { CsiCode, PageIntelligence } from "@/types";

function code(c: string): CsiCode {
  const div = c.substring(0, 2);
  return {
    code: c,
    description: `fixture ${c}`,
    trade: `Trade ${div}`,
    division: `${div} 00 00`,
  };
}

/**
 * Fixture: 3 pages exercising every structural path —
 *  - co-occurrence edges (00|03, 00|05 on page 1; 03|05 on pages 1+2),
 *  - a cross-reference edge fan (page 3 [Div 23] "SEE S-101" → page 1's
 *    divisions 00/03/05),
 *  - the known "Structural" cluster (03+05 share both their pages,
 *    cohesion 1),
 *  - a Div-00 node (post-C2: named via the canonical map — ledger D-8).
 */
const PAGES = [
  {
    pageNumber: 1,
    drawingNumber: "S-101",
    csiCodes: [code("00 10 00"), code("03 30 00"), code("05 12 00")],
    pageIntelligence: null,
  },
  {
    pageNumber: 2,
    drawingNumber: "S-102",
    csiCodes: [code("03 30 00"), code("05 12 00"), code("03 35 00")],
    pageIntelligence: null,
  },
  {
    pageNumber: 3,
    drawingNumber: "M-101",
    csiCodes: [code("23 05 00")],
    pageIntelligence: {
      crossRefs: [
        {
          sourceText: "SEE S-101",
          targetDrawing: "S-101",
          refType: "sheet",
          bbox: [0, 0, 0.1, 0.1],
          confidence: 0.9,
        },
      ],
    } as PageIntelligence,
  },
];

describe("buildCsiGraph — structural fingerprint baseline (canonical map, post-C2)", () => {
  it("produces the pinned fingerprint", () => {
    const graph = buildCsiGraph(PAGES);
    expect(graph).not.toBeNull();
    expect(graph!.fingerprint).toBe("03:3,05:2,00:1,23:1");
  });

  it("produces the pinned node set (order: totalInstances desc, insertion-stable)", () => {
    const graph = buildCsiGraph(PAGES)!;
    expect(
      graph.nodes.map((n) => ({
        division: n.division,
        name: n.name,
        totalInstances: n.totalInstances,
        pageCount: n.pageCount,
        pages: n.pages,
      })),
    ).toEqual([
      { division: "03", name: "Concrete", totalInstances: 3, pageCount: 2, pages: [1, 2] },
      { division: "05", name: "Metals", totalInstances: 2, pageCount: 2, pages: [1, 2] },
      // [refactor jul9 P2-A C1] C2 RE-PIN [C1 approval 2026-07-09, D-8]:
      // was "Division 00" (fallback — the old local table had no "00" entry);
      // the canonical map names it "Procurement". The ONLY sanctioned delta
      // in this file — everything else is the untouched C0 structural pin.
      { division: "00", name: "Procurement", totalInstances: 1, pageCount: 1, pages: [1] },
      { division: "23", name: "HVAC", totalInstances: 1, pageCount: 1, pages: [3] },
    ]);
  });

  it("produces the pinned edge set (co-occurrence + cross-reference)", () => {
    const graph = buildCsiGraph(PAGES)!;
    expect(graph.edges).toHaveLength(6);
    expect(
      graph.edges.map((e) => `${e.source}|${e.target}|${e.type}|${e.weight}`),
    ).toEqual([
      "03|05|co-occurrence|2",
      "00|03|co-occurrence|1",
      "00|05|co-occurrence|1",
      "00|23|cross-reference|1",
      "03|23|cross-reference|1",
      "05|23|cross-reference|1",
    ]);
  });

  it("produces the pinned cluster membership (known 'Structural' cluster, cohesion 1)", () => {
    const graph = buildCsiGraph(PAGES)!;
    expect(graph.clusters).toEqual([
      { name: "Structural", divisions: ["03", "05"], cohesion: 1 },
    ]);
  });

  it("returns null when fewer than 2 divisions are present", () => {
    const graph = buildCsiGraph([
      {
        pageNumber: 1,
        drawingNumber: "A-101",
        csiCodes: [code("03 30 00")],
        pageIntelligence: null,
      },
    ]);
    expect(graph).toBeNull();
  });
});
