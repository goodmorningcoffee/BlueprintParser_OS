// [tag-mapping v2 2026-10-24] Completeness certificate: schedule qty vs counted instances.
import { describe, expect, it } from "vitest";
import { buildCompletenessCertificate, certificateLabel } from "../certificate";

const inst = (...pages: number[]) => pages.map((pageNumber) => ({ pageNumber }));
const drawingNumbers = { 1: "A-101", 2: "A-102", 3: null };

describe("buildCompletenessCertificate", () => {
  it("MATCH when the quantity equals the count, with per-sheet counts", () => {
    const c = buildCompletenessCertificate({ tag: "D-1", quantityRaw: "3", grid: "qty", instances: inst(1, 1, 2), drawingNumbers });
    expect(c).toMatchObject({ verdict: "MATCH", expected: 3, found: 3, grain: "project", bySheet: { "A-101": 2, "A-102": 1 } });
    expect(certificateLabel(c)).toBe("qty 3/3");
  });
  it("MISMATCH otherwise", () => {
    const c = buildCompletenessCertificate({ tag: "D-1", quantityRaw: "(4)", grid: "qty", instances: inst(1, 3), drawingNumbers });
    expect(c).toMatchObject({ verdict: "MISMATCH", expected: 4, found: 2, bySheet: { "A-101": 1, p3: 1 } });
    expect(certificateLabel(c)).toBe("qty 2≠4");
  });
  it("NO-QTY for an enumerating grid or an unparseable cell (presence still recorded)", () => {
    expect(buildCompletenessCertificate({ tag: "P-1", quantityRaw: "4", grid: "enumerating", instances: inst(1, 1), drawingNumbers })).toMatchObject({ verdict: "NO-QTY", expected: null, found: 2 });
    expect(buildCompletenessCertificate({ tag: "P-1", quantityRaw: "SEE NOTE", grid: "qty", instances: inst(1), drawingNumbers })).toMatchObject({ verdict: "NO-QTY", found: 1 });
    expect(certificateLabel(buildCompletenessCertificate({ tag: "P-1", grid: "qty", instances: [], drawingNumbers }))).toBeNull();
  });
  it("sheet grain when the row names a project sheet: only that sheet's count is compared", () => {
    const c = buildCompletenessCertificate({ tag: "D-1", quantityRaw: "2", sheetRaw: "A101", grid: "qty", instances: inst(1, 1, 2), drawingNumbers });
    expect(c).toMatchObject({ verdict: "MATCH", grain: "sheet", sheet: "A-101", expected: 2, found: 2, bySheet: { "A-101": 2, "A-102": 1 } });
  });
});
