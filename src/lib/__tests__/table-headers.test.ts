// @vitest-environment node
// [table pipeline WP-2.0b] Header dedupe (K06): duplicate names must keep separate record keys.

import { describe, expect, it } from "vitest";
import { uniqueHeaders } from "@/lib/table-headers";

describe("uniqueHeaders", () => {
  it("keeps the first label and suffixes later duplicates X (2), X (3)", () => {
    expect(uniqueHeaders(["MARK", "TYPE", "MATERIAL", "TYPE", "MATERIAL", "TYPE"])).toEqual([
      "MARK", "TYPE", "MATERIAL", "TYPE (2)", "MATERIAL (2)", "TYPE (3)",
    ]);
  });

  it("two-tier DOOR/FRAME TYPE/MATERIAL keeps four columns as record keys", () => {
    const headers = uniqueHeaders(["TYPE", "MATERIAL", "TYPE", "MATERIAL"]);
    const row: Record<string, string> = {};
    ["d-t", "d-m", "f-t", "f-m"].forEach((v, i) => { row[headers[i]] = v; });
    expect(Object.keys(row)).toHaveLength(4);
    expect(Object.values(row)).toEqual(["d-t", "d-m", "f-t", "f-m"]);
  });

  it("never collides with a label printed with a suffix", () => {
    expect(uniqueHeaders(["X", "X (2)", "X"])).toEqual(["X", "X (2)", "X (3)"]);
    expect(uniqueHeaders(["X", "X", "X (2)"])).toEqual(["X", "X (3)", "X (2)"]);
  });

  it("names blank labels Column <n> by position, then dedupes", () => {
    expect(uniqueHeaders(["", "A", "  ", "Column 1"])).toEqual(["Column 1", "A", "Column 3", "Column 1 (2)"]);
  });

  it("is exact and case-sensitive, and leaves a unique list unchanged", () => {
    expect(uniqueHeaders(["Qty", "QTY", "qty"])).toEqual(["Qty", "QTY", "qty"]);
    expect(uniqueHeaders([])).toEqual([]);
    const input = ["A", "B"];
    expect(uniqueHeaders(input)).toEqual(input);
    expect(new Set(uniqueHeaders(["a", "a", "a", "a (2)", "a (3)", ""])).size).toBe(6);
  });
});
