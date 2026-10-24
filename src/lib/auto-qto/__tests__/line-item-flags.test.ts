// [tag-mapping v2 2026-10-24] AutoQtoTab review-step helpers: flags (verbatim) + certificate.
import { describe, expect, it } from "vitest";
import { lineItemCertificate, qtoLineItemFlags, scheduleColumnRoles } from "../line-item-flags";

describe("qtoLineItemFlags", () => {
  it("keeps the v1 flags and adds qty-mismatch from a MISMATCH certificate", () => {
    expect(qtoLineItemFlags([])).toEqual(["not-found"]);
    expect(qtoLineItemFlags([{ confidenceTier: "medium", confidence: 1 }, { confidenceTier: "low", confidence: 1 }])).toEqual(["medium-confidence", "low-confidence"]);
    expect(qtoLineItemFlags([{ confidence: 0.9 }])).toEqual(["low-confidence"]); // pre-Phase-2 fuzzy fallback
    const schedule = { headers: ["MARK", "QTY"], rows: [{ MARK: "D-1", QTY: "3" }, { MARK: "D-2", QTY: "1" }], tagColumn: "MARK" };
    const roles = scheduleColumnRoles(schedule);
    const cert = lineItemCertificate("D-1", schedule.rows[0], roles, [{ pageNumber: 1 }]);
    expect(cert?.verdict).toBe("MISMATCH");
    expect(qtoLineItemFlags([{ confidenceTier: "high", confidence: 1 }], cert)).toEqual(["qty-mismatch"]);
    expect(lineItemCertificate("D-2", schedule.rows[1], roles, [{ pageNumber: 4 }])?.verdict).toBe("MATCH");
  });
  it("no certificate without a quantity column", () => {
    const schedule = { headers: ["TAG", "FINISH"], rows: [{ TAG: "P-1", FINISH: "PAINT" }], tagColumn: "TAG" };
    expect(lineItemCertificate("P-1", schedule.rows[0], scheduleColumnRoles(schedule), [])).toBeNull();
  });
});
