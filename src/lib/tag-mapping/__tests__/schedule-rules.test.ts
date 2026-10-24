// [tag-mapping v2 2026-10-24] labelfactory schedule rules where tag mapping reads a parsed schedule.
import { describe, expect, it } from "vitest";
import { arbitrateColumnRoles, parseQuantity, splitSheetReferences } from "../schedule-rules";

const rows = (headers: string[], data: string[][]) => data.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));

describe("arbitrateColumnRoles — body arbitrates, headers nominate", () => {
  it("door schedule: MARK is the tag, QTY the quantity → qty grid", () => {
    const headers = ["MARK", "QTY", "TYPE", "WIDTH"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["D-101", "2", "A", "3'-0\""], ["D-102", "1", "B", "3'-0\""], ["D-103", "4", "A", "6'-0\""]]));
    expect(roles).toMatchObject({ tagColumn: "MARK", qtyColumn: "QTY", grid: "qty", drawingList: false });
  });

  it("a 'NO.' header full of integers is the quantity, not the tag; the tag comes from the body", () => {
    const headers = ["NO.", "SYMBOL", "DESCRIPTION"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["4", "L1", "LIGHT"], ["2", "L2", "LIGHT"], ["6", "L3", "FAN"]]));
    expect(roles.qtyColumn).toBe("NO.");
    expect(roles.tagColumn).toBe("SYMBOL");
  });

  it("fix round 1: a door schedule with no QTY header has NO quantity column — ROOM / WIDTH / HEIGHT / HW SET are integers too", () => {
    const headers = ["DOOR", "ROOM", "WIDTH", "HEIGHT", "HW SET"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["101", "101", "36", "84", "3"], ["102", "104", "36", "84", "1"], ["103", "107", "42", "84", "2"]]), { preferredTagColumn: "DOOR" });
    expect(roles).toMatchObject({ tagColumn: "DOOR", qtyColumn: null, grid: "enumerating" });
  });

  it("fix round 1: a 'NO.' column of marks (101, 102, 103) is not a quantity; small integers under a tag header never are", () => {
    const headers = ["NO.", "SYMBOL", "DESCRIPTION"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["101", "L1", "LIGHT"], ["102", "L2", "LIGHT"], ["103", "L3", "FAN"]]));
    expect(roles.qtyColumn).toBeNull();
    const windows = ["WINDOW", "TYPE", "SILL"];
    const r2 = arbitrateColumnRoles(windows, rows(windows, [["W1", "4", "30"], ["W2", "2", "30"], ["W3", "6", "36"]]));
    expect(r2).toMatchObject({ tagColumn: "WINDOW", qtyColumn: null, grid: "enumerating" });
  });

  it("without a quantity column the grid is enumerating (presence only)", () => {
    const headers = ["TAG", "FINISH"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["P-1", "PAINT"], ["P-2", "PAINT"], ["WD-1", "OAK"]]));
    expect(roles).toMatchObject({ tagColumn: "TAG", qtyColumn: null, grid: "enumerating" });
  });

  it("lettered marks beat letter-only beat digits when the body decides", () => {
    const headers = ["A", "B", "C"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["1", "W", "W1"], ["2", "D", "W2"], ["3", "P", "W3"]]));
    expect(roles.tagColumn).toBe("C");
  });

  it("the user's preferred tag column wins when its body is tag-like", () => {
    const headers = ["ID", "MARK", "QTY"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["X1", "D-1", "1"], ["X2", "D-2", "2"], ["X3", "D-3", "3"]]), { preferredTagColumn: "ID" });
    expect(roles.tagColumn).toBe("ID");
  });

  it("sheet-number guard: a tag column made of project sheet numbers is a drawing list (no cardinality)", () => {
    const headers = ["SHEET NO.", "TITLE"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["A-101", "PLAN"], ["A-102", "RCP"], ["E-1", "POWER"]]), { sheetNumbers: ["A101", "A-102", "E1", "G-001"] });
    expect(roles.drawingList).toBe(true);
    expect(roles.grid).toBe("enumerating");
    expect(roles.tagColumn).toBe("SHEET NO.");
  });

  it("a SHEET column beside the tag enables per-sheet certificates", () => {
    const headers = ["MARK", "QTY", "SHEET"];
    const roles = arbitrateColumnRoles(headers, rows(headers, [["D-1", "2", "A-101"], ["D-2", "1", "A-102"]]), { sheetNumbers: ["A-101", "A-102"] });
    expect(roles.sheetColumn).toBe("SHEET");
    expect(roles.tagColumn).toBe("MARK");
  });
});

describe("parseQuantity / splitSheetReferences", () => {
  it("parses schedule quantity cells", () => {
    expect(parseQuantity("4")).toBe(4);
    expect(parseQuantity("(12)")).toBe(12);
    expect(parseQuantity("3 EA")).toBe(3);
    expect(parseQuantity("3'-0\"")).toBeNull();
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity(undefined)).toBeNull();
  });
  it("splits sheet references out of a tag list", () => {
    expect(splitSheetReferences(["D-1", "A101", "E-1"], ["A-101", "E1"])).toEqual({ tags: ["D-1"], sheetRefs: ["A101", "E-1"] });
  });
});
